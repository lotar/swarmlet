#!/usr/bin/env python3
"""Deterministic local-server tests for strict_ab_harness.py."""

import base64
import json
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import strict_ab_harness as harness


class FakeState:
    def __init__(
        self,
        *,
        truncate=False,
        mismatch_b=False,
        a_delay=0.01,
        b_delay=0.01,
        malformed=False,
        http_error=False,
        invalid_id=False,
        predicted_n_delta=0,
        non_finite=None,
    ):
        self.truncate = truncate
        self.mismatch_b = mismatch_b
        self.a_delay = a_delay
        self.b_delay = b_delay
        self.malformed = malformed
        self.http_error = http_error
        self.invalid_id = invalid_id
        self.predicted_n_delta = predicted_n_delta
        self.non_finite = non_finite
        self.active = 0
        self.max_active = 0
        self.request_count = 0
        self.lock = threading.Lock()


@contextmanager
def fake_completion_server(state):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers["content-length"])
            body = json.loads(self.rfile.read(length))
            with state.lock:
                state.active += 1
                state.request_count += 1
                state.max_active = max(state.max_active, state.active)
            try:
                is_b = self.path.startswith("/b/")
                time.sleep(state.b_delay if is_b else state.a_delay)
                count = body["n_predict"] - 1 if state.truncate else body["n_predict"]
                ids = list(range(100, 100 + count))
                content = "output:" + body["prompt"]
                if is_b and state.mismatch_b:
                    ids[-1] += 1
                    content += ":mismatch"
                response = {
                    "content": content,
                    "completion_probabilities": [{"id": token_id} for token_id in ids],
                    "timings": {
                        "predicted_n": body["n_predict"] + state.predicted_n_delta,
                        "predicted_per_second": body["n_predict"] / max(0.001, state.b_delay if is_b else state.a_delay),
                    },
                }
                if state.invalid_id:
                    response["completion_probabilities"][0]["id"] = True
                if state.non_finite is not None:
                    response["timings"]["predicted_per_second"] = state.non_finite
                encoded = b"{malformed" if state.malformed else json.dumps(response).encode("utf-8")
                self.send_response(500 if state.http_error else 200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            finally:
                with state.lock:
                    state.active -= 1

        def log_message(self, _format, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class StrictABHarnessTest(unittest.TestCase):
    def config(self, root, base_url, **overrides):
        values = {
            "a_url": base_url + "/a",
            "b_url": base_url + "/b",
            "out": Path(root),
            "corpus": ("alpha", "beta", "gamma", "delta"),
            "concurrency": 3,
            "tokens": 4,
            "warmup_waves": 0,
            "measured_waves": 1,
            "timeout_seconds": 2,
            "min_b_ratio": 0.1,
            "max_a_drift_pct": 100,
            "screen_label": "short-screen",
        }
        values.update(overrides)
        return harness.HarnessConfig(**values)

    def test_fixed_corpus_and_barrier_release_concurrent_requests(self):
        state = FakeState(a_delay=0.04, b_delay=0.04)
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            summary = harness.run_benchmark(self.config(root, url))

            self.assertEqual("pass", summary["status"])
            self.assertGreaterEqual(state.max_active, 3)
            self.assertEqual(12, state.request_count)  # four fixed prompts in each A/B/A arm
            for arm in ("A1", "B", "A2"):
                self.assertEqual(4, summary["arms"][arm]["measuredRequestCount"])
                self.assertEqual(4, summary["arms"][arm]["expectedMeasuredRequestCount"])
                self.assertLess(
                    summary["arms"][arm]["waveMetrics"][0]["maxBarrierReleaseSkewSeconds"],
                    0.05,
                )
            for corpus_index in range(4):
                hashes = [
                    summary["arms"][arm]["rows"][corpus_index]["hashes"]["requestSha256"]
                    for arm in ("A1", "B", "A2")
                ]
                self.assertEqual(1, len(set(hashes)))

    def test_truncated_token_ids_fail_exactness_and_are_saved(self):
        state = FakeState(truncate=True)
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            summary = harness.run_benchmark(
                self.config(root, url, corpus=("only",), concurrency=1, tokens=4)
            )

            self.assertEqual("fail", summary["status"])
            self.assertFalse(summary["checks"]["allResponsesExact"])
            self.assertIn("captured token ID count expected 4, got 3", summary["responseErrors"][0]["errors"])
            response_files = list((Path(root) / "responses").glob("*.json"))
            self.assertEqual(3, len(response_files))
            self.assertTrue(all(json.loads(path.read_text())["response"] for path in response_files))

    def test_mismatched_ids_and_content_fail_strict_parity(self):
        state = FakeState(mismatch_b=True)
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            summary = harness.run_benchmark(
                self.config(root, url, corpus=("only",), concurrency=1)
            )

            self.assertEqual("fail", summary["status"])
            self.assertTrue(summary["checks"]["allResponsesExact"])
            self.assertFalse(summary["checks"]["parity"])
            self.assertEqual(1, summary["parity"]["mismatchCount"])
            mismatch = summary["parity"]["mismatches"][0]
            self.assertNotEqual(mismatch["tokenIdsSha256"]["A1"], mismatch["tokenIdsSha256"]["B"])
            self.assertNotEqual(mismatch["contentSha256"]["A1"], mismatch["contentSha256"]["B"])

    def test_b_ratio_threshold_has_pass_and_fail_outcomes(self):
        state = FakeState(a_delay=0.06, b_delay=0.005)
        with tempfile.TemporaryDirectory() as pass_root, tempfile.TemporaryDirectory() as fail_root, fake_completion_server(state) as url:
            passing = harness.run_benchmark(
                self.config(
                    pass_root,
                    url,
                    corpus=("one", "two"),
                    concurrency=2,
                    min_b_ratio=1.5,
                    max_a_drift_pct=50,
                    screen_label="final",
                )
            )
            failing = harness.run_benchmark(
                self.config(
                    fail_root,
                    url,
                    corpus=("one", "two"),
                    concurrency=2,
                    min_b_ratio=50,
                    max_a_drift_pct=50,
                    screen_label="final",
                )
            )

            self.assertEqual("final", passing["screenLabel"])
            self.assertEqual("pass", passing["status"])
            self.assertTrue(passing["checks"]["bRatio"])
            self.assertGreater(passing["comparisons"]["bRatioAgainstArithmeticMeanA"], 1.5)
            self.assertEqual("fail", failing["status"])
            self.assertFalse(failing["checks"]["bRatio"])

    def test_warmup_is_included_in_strict_parity(self):
        state = FakeState(mismatch_b=True)
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            summary = harness.run_benchmark(
                self.config(root, url, corpus=("only",), concurrency=1, warmup_waves=1)
            )

            self.assertFalse(summary["checks"]["parity"])
            self.assertEqual({"warmup", "measured"}, {
                mismatch["phase"] for mismatch in summary["parity"]["mismatches"]
            })

    def test_a_drift_threshold_fails(self):
        state = FakeState(a_delay=0.005)
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            config = self.config(root, url, corpus=("only",), concurrency=1, max_a_drift_pct=10)
            original_run_arm = harness._run_arm

            def delayed_a2(arm, arm_url, arm_config):
                if arm == "A2":
                    state.a_delay = 0.08
                return original_run_arm(arm, arm_url, arm_config)

            harness._run_arm = delayed_a2
            try:
                summary = harness.run_benchmark(config)
            finally:
                harness._run_arm = original_run_arm

            self.assertEqual("fail", summary["status"])
            self.assertFalse(summary["checks"]["aDrift"])
            self.assertGreater(abs(summary["comparisons"]["aDriftPct"]), 10)

    def test_malformed_and_http_error_bodies_are_persisted_raw(self):
        for options, expected in (
            ({"malformed": True}, b"{malformed"),
            ({"http_error": True}, None),
        ):
            with self.subTest(options=options):
                state = FakeState(**options)
                with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
                    summary = harness.run_benchmark(
                        self.config(root, url, corpus=("only",), concurrency=1)
                    )
                    row = summary["arms"]["A1"]["rows"][0]
                    raw = base64.b64decode(row["responseBodyBase64"])
                    if expected is not None:
                        self.assertEqual(expected, raw)
                    else:
                        self.assertIn(b'"completion_probabilities"', raw)
                    self.assertEqual(harness.sha256_bytes(raw), row["responseBodySha256"])
                    saved = json.loads(next((Path(root) / "responses").glob("A1-*.json")).read_text())
                    self.assertEqual(row["responseBodyBase64"], saved["responseBodyBase64"])
                    self.assertFalse(summary["checks"]["allResponsesExact"])

    def test_non_finite_response_json_is_rejected_and_sealed_as_raw_evidence(self):
        for label, value in (
            ("NaN", float("nan")),
            ("Infinity", float("inf")),
            ("-Infinity", float("-inf")),
        ):
            with self.subTest(constant=label):
                state = FakeState(non_finite=value)
                with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
                    artifact = self._acquire(root, "A1", url, state)
                    row = artifact["result"]["rows"][0]
                    raw = base64.b64decode(row["responseBodyBase64"])

                    self.assertIn(label.encode("ascii"), raw)
                    self.assertEqual(harness.sha256_bytes(raw), row["responseBodySha256"])
                    self.assertIsNone(row["response"])
                    self.assertTrue(any(
                        "non-finite JSON constant is not permitted" in error
                        for error in row["validationErrors"]
                    ))
                    sealed = (Path(root) / "a1" / "arm.json").read_text()
                    self.assertEqual(artifact, json.loads(
                        sealed,
                        parse_constant=lambda constant: self.fail(
                            f"sealed artifact contains {constant}"
                        ),
                    ))

    def test_invalid_id_type_and_predicted_n_mismatch_fail_validation(self):
        for options, expected_error in (
            ({"invalid_id": True}, "completion_probabilities[0].id is not an integer"),
            ({"predicted_n_delta": -1}, "timings.predicted_n expected 4, got 3"),
        ):
            with self.subTest(options=options):
                state = FakeState(**options)
                with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
                    summary = harness.run_benchmark(
                        self.config(root, url, corpus=("only",), concurrency=1)
                    )
                    errors = summary["arms"]["A1"]["rows"][0]["validationErrors"]
                    self.assertIn(expected_error, errors)
                    if options.get("invalid_id"):
                        self.assertEqual(0, summary["arms"]["A1"]["waveMetrics"][0]["capturedTokens"])

    def test_nonempty_output_directory_is_rejected_without_requests(self):
        state = FakeState()
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            (Path(root) / "stale.txt").write_text("stale")
            with self.assertRaisesRegex(ValueError, "output directory is not empty"):
                harness.run_benchmark(self.config(root, url, corpus=("only",)))
            self.assertEqual(0, state.request_count)

    def _acquire(self, root, arm, url, state, **overrides):
        out = Path(root) / arm.lower()
        config = self.config(out, url, corpus=("only",), concurrency=1, **overrides)
        return harness.acquire_arm(arm, url + ("/b" if arm == "B" else "/a"), config)

    def test_split_cli_acquires_exactly_one_arm(self):
        state = FakeState()
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            exit_code = harness.main([
                "acquire",
                "--arm", "A1",
                "--url", url + "/a",
                "--out", str(Path(root) / "a1"),
                "--concurrency", "1",
                "--tokens", "2",
                "--warmup-waves", "0",
                "--measured-waves", "1",
            ])
            artifact = json.loads((Path(root) / "a1" / "arm.json").read_text())

            self.assertEqual(0, exit_code)
            self.assertEqual(len(harness.DEFAULT_CORPUS), state.request_count)
            self.assertEqual("A1", artifact["arm"])
            self.assertEqual(len(harness.DEFAULT_CORPUS), artifact["result"]["requestCount"])
            self.assertTrue(all(row["arm"] == "A1" for row in artifact["result"]["rows"]))

    def test_split_acquire_and_offline_compare_pass_and_fail(self):
        state = FakeState(a_delay=0.03, b_delay=0.003)
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            self._acquire(root, "A1", url, state)
            self._acquire(root, "B", url, state)
            self._acquire(root, "A2", url, state)
            request_count = state.request_count
            common = [
                "--a1-artifact", str(Path(root) / "a1"),
                "--b-artifact", str(Path(root) / "b"),
                "--a2-artifact", str(Path(root) / "a2"),
                "--max-a-drift-pct", "1000",
                "--screen-label", "final",
            ]
            passing_exit = harness.main([
                "compare", *common,
                "--out", str(Path(root) / "comparison-pass"),
                "--min-b-ratio", "1.2",
            ])
            failing_exit = harness.main([
                "compare", *common,
                "--out", str(Path(root) / "comparison-fail"),
                "--min-b-ratio", "100",
            ])
            passing = json.loads((Path(root) / "comparison-pass" / "summary.json").read_text())
            failing = json.loads((Path(root) / "comparison-fail" / "summary.json").read_text())

            self.assertEqual(request_count, state.request_count)  # comparison is offline
            self.assertEqual(0, passing_exit)
            self.assertEqual(2, failing_exit)
            self.assertEqual("pass", passing["status"])
            self.assertEqual("fail", failing["status"])
            self.assertFalse(failing["checks"]["bRatio"])
            self.assertTrue((Path(root) / "comparison-pass" / "summary.json").is_file())

    def test_tampered_artifact_configuration_is_rejected(self):
        state = FakeState()
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            self._acquire(root, "A1", url, state)
            artifact_path = Path(root) / "a1" / "arm.json"
            artifact = json.loads(artifact_path.read_text())
            artifact["configuration"]["tokens"] += 1
            artifact_path.write_text(json.dumps(artifact))

            with self.assertRaisesRegex(ValueError, "configuration fingerprint verification failed"):
                harness._load_arm_artifact(artifact_path, "A1")

    def test_tampered_artifact_result_is_rejected(self):
        state = FakeState()
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            self._acquire(root, "A1", url, state)
            artifact_path = Path(root) / "a1" / "arm.json"
            artifact = json.loads(artifact_path.read_text())
            artifact["result"]["rows"][0]["content"] = "tampered"
            artifact_path.write_text(json.dumps(artifact))

            with self.assertRaisesRegex(ValueError, "artifact payload verification failed"):
                harness._load_arm_artifact(artifact_path, "A1")

    def test_split_compare_rejects_configuration_mismatch(self):
        state = FakeState()
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            self._acquire(root, "A1", url, state)
            self._acquire(root, "B", url, state, tokens=3)
            self._acquire(root, "A2", url, state)
            with self.assertRaisesRegex(ValueError, "configuration fingerprints differ"):
                harness.compare_arm_artifacts(
                    a1_artifact=Path(root) / "a1",
                    b_artifact=Path(root) / "b",
                    a2_artifact=Path(root) / "a2",
                    out=Path(root) / "comparison",
                    min_b_ratio=0.1,
                    max_a_drift_pct=100,
                    screen_label="short-screen",
                )
            self.assertFalse((Path(root) / "comparison").exists())

    def test_cli_exit_code_tracks_failed_threshold(self):
        state = FakeState(a_delay=0.01, b_delay=0.01)
        with tempfile.TemporaryDirectory() as root, fake_completion_server(state) as url:
            exit_code = harness.main(
                [
                    "--a-url", url + "/a",
                    "--b-url", url + "/b",
                    "--out", root,
                    "--concurrency", "8",
                    "--tokens", "2",
                    "--warmup-waves", "0",
                    "--measured-waves", "1",
                    "--min-b-ratio", "50",
                    "--max-a-drift-pct", "100",
                ]
            )
            self.assertEqual(2, exit_code)
            self.assertEqual("fail", json.loads((Path(root) / "summary.json").read_text())["status"])


if __name__ == "__main__":
    unittest.main()
