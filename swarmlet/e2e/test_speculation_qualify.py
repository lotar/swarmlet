import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("speculation_qualify", Path(__file__).parent / "tools/speculation-qualify.py")
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


def artifact(active):
    rows = []
    for name, prompt in q.PROMPTS:
        response = {"stop": True, "tokens": [1, 2, 3], "content": "example", "model": "target-model"}
        counters = dict(zip(q.METRICS, [4, 2, 1] if active else [0, 0, 0]))
        rows.append({"name": name, "request": q.fixture_request(prompt),
                     "promptSha256": hashlib.sha256(prompt.encode()).hexdigest(),
                     "response": response, "responseSha256": q.digest(response),
                     "metricsBefore": dict.fromkeys(q.METRICS, 0),
                     "metricsAfter": counters.copy(), "metricsDelta": counters.copy()})
    return {"schema": 1, "arm": "candidate" if active else "baseline", "url": "http://localhost:50000",
            "createdUtc": "2026-09-09T00:00:00+00:00", "completed": True, "rows": rows}


class QualificationTests(unittest.TestCase):
    def compare(self, base, candidate):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "a.json", Path(tmp) / "b.json"
            a.write_text(json.dumps(base)); b.write_text(json.dumps(candidate))
            with contextlib.redirect_stdout(io.StringIO()):
                return q.compare(types.SimpleNamespace(baseline=a, candidate=b))

    def test_exercised_exact_speculation_passes(self):
        self.assertEqual(self.compare(artifact(False), artifact(True)), 0)

    def test_output_parity_cannot_be_waived(self):
        for field, value in (("tokens", [1, 8, 3]), ("content", "different")):
            candidate = artifact(True)
            candidate["rows"][0]["response"][field] = value
            candidate["rows"][0]["responseSha256"] = q.digest(candidate["rows"][0]["response"])
            self.assertEqual(self.compare(artifact(False), candidate), 1)

    def test_no_activity_or_no_rejections_fails(self):
        self.assertEqual(self.compare(artifact(False), artifact(False)), 1)
        candidate = artifact(True)
        for row in candidate["rows"]:
            row["metricsAfter"][q.METRICS[1]] = row["metricsDelta"][q.METRICS[1]] = 4
        self.assertEqual(self.compare(artifact(False), candidate), 1)

    def test_mutation_and_provenance_rejected(self):
        mutations = [
            lambda a: a.pop("schema"),
            lambda a: a["rows"][0]["request"].update(seed=1),
            lambda a: a["rows"][0].update(promptSha256="wrong"),
            lambda a: a["rows"][0]["response"].update(content="tampered"),
            lambda a: a["rows"].pop(),
        ]
        for mutate in mutations:
            candidate = artifact(True); mutate(candidate)
            with self.assertRaises(RuntimeError):
                self.compare(artifact(False), candidate)
        candidate = artifact(True)
        for row in candidate["rows"]:
            row["response"]["model"] = "other-model"
            row["responseSha256"] = q.digest(row["response"])
        with self.assertRaisesRegex(RuntimeError, "model identities"):
            self.compare(artifact(False), candidate)

    def test_invalid_counters_rejected(self):
        for value in (-1, float("nan"), float("inf"), 0.5, True):
            candidate = artifact(True)
            candidate["rows"][0]["metricsAfter"][q.METRICS[0]] = value
            with self.assertRaisesRegex(RuntimeError, "invalid speculative counters"):
                self.compare(artifact(False), candidate)
        candidate = artifact(True)
        candidate["rows"][0]["metricsDelta"][q.METRICS[0]] = 99
        with self.assertRaisesRegex(RuntimeError, "delta mismatch"):
            self.compare(artifact(False), candidate)

    def test_missing_native_counters_fail_closed(self):
        with patch.object(q, "request", return_value="llamacpp:tokens_predicted_total 2\n"):
            with self.assertRaisesRegex(RuntimeError, "all valid speculative counters"):
                q.metrics("http://localhost")
        with patch.object(q, "request", return_value="\n".join("llamacpp:" + key + " 0" for key in q.METRICS)):
            self.assertEqual(q.metrics("http://localhost"), dict.fromkeys(q.METRICS, 0))

    def test_collect_requires_guard_before_io(self):
        with patch.dict(q.os.environ, {}, clear=True), patch.object(q, "request") as request:
            with self.assertRaisesRegex(RuntimeError, "SWARMLET_IDLE_WINDOW=1"):
                q.collect(types.SimpleNamespace())
            request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
