#!/usr/bin/env python3
"""Strict matched A/B/A concurrency benchmark for llama.cpp-style completion APIs.

The corpus and request bodies do not depend on concurrency.  Concurrency only
changes how the fixed corpus is partitioned into barrier-released batches.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import dataclasses
import datetime
import hashlib
import json
import math
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Sequence

DEFAULT_CORPUS = [
    "Solve: 17*23. Explain briefly.",
    "Write a Python binary search function and one test.",
    "Return minified JSON: country of Zagreb and confidence.",
    "Explain speculative decoding in Croatian in four sentences.",
    "Give three causes of cache thrashing in MoE inference.",
    "Prove the sum of the first n odd integers equals n squared.",
    "Write SQL selecting the latest order per customer.",
    "Explain why European WAN latency hurts serial transformer layers.",
]


def canonical_json(value: Any) -> bytes:
    """Return the UTF-8 canonical JSON representation used by all JSON hashes."""
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _reject_non_finite_json(constant: str) -> None:
    raise ValueError(f"non-finite JSON constant is not permitted: {constant}")


def _parse_response_json(value: bytes) -> Any:
    return json.loads(value, parse_constant=_reject_non_finite_json)


def percentile(values: Sequence[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("cannot calculate a percentile of no values")
    index = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return ordered[index]


@dataclasses.dataclass(frozen=True)
class HarnessConfig:
    a_url: str
    b_url: str
    out: Path
    corpus: tuple[str, ...] = tuple(DEFAULT_CORPUS)
    concurrency: int = 8
    tokens: int = 128
    warmup_waves: int = 1
    measured_waves: int = 3
    timeout_seconds: float = 1800.0
    min_b_ratio: float = 1.0
    max_a_drift_pct: float = 5.0
    screen_label: str = "short-screen"

    def validate(self) -> None:
        if not self.corpus or any(not isinstance(prompt, str) or not prompt for prompt in self.corpus):
            raise ValueError("corpus must contain at least one non-empty string")
        if self.concurrency < 1:
            raise ValueError("concurrency must be at least 1")
        if self.tokens < 1:
            raise ValueError("tokens must be at least 1")
        if self.warmup_waves < 0 or self.measured_waves < 1:
            raise ValueError("warmup waves must be >= 0 and measured waves must be >= 1")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout must be positive")
        if self.min_b_ratio <= 0 or self.max_a_drift_pct < 0:
            raise ValueError("minimum B ratio must be positive and maximum A drift must be non-negative")
        if self.screen_label not in ("short-screen", "final"):
            raise ValueError("screen label must be 'short-screen' or 'final'")


def completion_url(base_url: str) -> str:
    return base_url.rstrip("/") + "/completion"


def request_body(prompt: str, corpus_index: int, tokens: int) -> dict[str, Any]:
    return {
        "cache_prompt": False,
        "ignore_eos": True,
        "n_predict": tokens,
        "n_probs": 1,
        "prompt": prompt,
        "seed": 42 + corpus_index,
        "temperature": 0,
        "top_k": 1,
        "top_p": 1.0,
    }


def captured_ids(response: Any) -> list[int]:
    if not isinstance(response, dict):
        raise ValueError("response is not a JSON object")
    probabilities = response.get("completion_probabilities")
    if not isinstance(probabilities, list):
        raise ValueError("completion_probabilities is not a list")
    ids: list[int] = []
    for index, item in enumerate(probabilities):
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("id"), int)
            or isinstance(item.get("id"), bool)
        ):
            raise ValueError(f"completion_probabilities[{index}].id is not an integer")
        ids.append(item["id"])
    return ids


def validate_response(response: Any, expected_tokens: int) -> tuple[list[int], str, list[str]]:
    errors: list[str] = []
    ids: list[int] = []
    content = ""
    if not isinstance(response, dict):
        return ids, content, ["response is not a JSON object"]
    timings = response.get("timings")
    predicted_n = timings.get("predicted_n") if isinstance(timings, dict) else None
    if not isinstance(predicted_n, int) or isinstance(predicted_n, bool):
        errors.append("timings.predicted_n is not an integer")
    elif predicted_n != expected_tokens:
        errors.append(f"timings.predicted_n expected {expected_tokens}, got {predicted_n}")
    try:
        ids = captured_ids(response)
    except ValueError as exc:
        errors.append(str(exc))
    if len(ids) != expected_tokens:
        errors.append(f"captured token ID count expected {expected_tokens}, got {len(ids)}")
    value = response.get("content")
    if not isinstance(value, str):
        errors.append("content is not a string")
    else:
        content = value
    return ids, content, errors


def _single_request(
    *,
    arm: str,
    url: str,
    prompt: str,
    corpus_index: int,
    phase: str,
    wave: int,
    batch: int,
    tokens: int,
    timeout_seconds: float,
    barrier: threading.Barrier,
    release_time: dict[str, float],
) -> dict[str, Any]:
    body = request_body(prompt, corpus_index, tokens)
    raw_request = canonical_json(body)
    barrier_wait_start = time.perf_counter()
    barrier.wait()
    request_start = time.perf_counter()
    row: dict[str, Any] = {
        "arm": arm,
        "phase": phase,
        "wave": wave,
        "batch": batch,
        "corpusIndex": corpus_index,
        "prompt": prompt,
        "request": body,
        "hashes": {
            "requestSha256": sha256_bytes(raw_request),
            "promptSha256": sha256_bytes(prompt.encode("utf-8")),
        },
        "barrierWaitSeconds": request_start - barrier_wait_start,
        "barrierReleaseSkewSeconds": request_start - release_time["value"],
    }
    response: Any = None
    response_raw: bytes | None = None
    transport_error: str | None = None
    response_parse_error: str | None = None
    try:
        request = urllib.request.Request(
            completion_url(url),
            data=raw_request,
            headers={"content-type": "application/json"},
            method="POST",
        )
        # Deliberately one attempt: this harness never retries benchmark traffic.
        with urllib.request.urlopen(request, timeout=timeout_seconds) as handle:
            response_raw = handle.read()
    except urllib.error.HTTPError as exc:
        response_raw = exc.read()
        exc.close()
        transport_error = f"HTTP {exc.code}: {exc.reason}"
    except Exception as exc:  # Preserve the failed attempt as data; do not retry.
        transport_error = f"{type(exc).__name__}: {exc}"
    if response_raw is not None:
        try:
            response = _parse_response_json(response_raw)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            response_parse_error = f"invalid response JSON: {exc}"
    request_end = time.perf_counter()
    ids, content, validation_errors = validate_response(response, tokens)
    if response_parse_error:
        validation_errors.insert(0, response_parse_error)
    if transport_error:
        validation_errors.insert(0, transport_error)
    timings = response.get("timings") if isinstance(response, dict) else None
    predicted_n = timings.get("predicted_n") if isinstance(timings, dict) else None
    row.update(
        {
            "wallSeconds": request_end - request_start,
            "clientWallTokensPerSecond": len(ids) / (request_end - request_start),
            "predictedN": predicted_n,
            "capturedTokenIdCount": len(ids),
            "capturedTokenIds": ids,
            "content": content,
            "response": response,
            # Keep the exact bytes even when JSON parsing or HTTP status validation fails.
            "responseBodyBase64": (
                base64.b64encode(response_raw).decode("ascii")
                if response_raw is not None
                else None
            ),
            "responseBodySha256": sha256_bytes(response_raw) if response_raw is not None else None,
            "validationErrors": validation_errors,
        }
    )
    row["hashes"].update(
        {
            "tokenIdsSha256": sha256_bytes(canonical_json(ids)),
            "contentSha256": sha256_bytes(content.encode("utf-8")),
        }
    )
    return row


def _run_batch(
    *,
    arm: str,
    url: str,
    prompts: Sequence[tuple[int, str]],
    phase: str,
    wave: int,
    batch: int,
    config: HarnessConfig,
) -> tuple[list[dict[str, Any]], float]:
    release_time: dict[str, float] = {}
    barrier = threading.Barrier(
        len(prompts), action=lambda: release_time.__setitem__("value", time.perf_counter())
    )
    batch_start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(prompts)) as executor:
        futures = [
            executor.submit(
                _single_request,
                arm=arm,
                url=url,
                prompt=prompt,
                corpus_index=index,
                phase=phase,
                wave=wave,
                batch=batch,
                tokens=config.tokens,
                timeout_seconds=config.timeout_seconds,
                barrier=barrier,
                release_time=release_time,
            )
            for index, prompt in prompts
        ]
        rows = [future.result() for future in futures]
    return rows, time.perf_counter() - batch_start


def _write_response(out: Path, row: dict[str, Any]) -> None:
    name = (
        f"{row['arm']}-{row['phase']}-w{row['wave']:03d}-"
        f"p{row['corpusIndex']:03d}.json"
    )
    (out / "responses" / name).write_text(
        json.dumps(row, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _run_arm(arm: str, url: str, config: HarnessConfig) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    wave_metrics: list[dict[str, Any]] = []
    corpus = list(enumerate(config.corpus))
    measured_start: float | None = None
    measured_end: float | None = None
    for phase, wave_count in (("warmup", config.warmup_waves), ("measured", config.measured_waves)):
        if phase == "measured":
            measured_start = time.perf_counter()
        for wave in range(wave_count):
            wave_start = time.perf_counter()
            wave_rows: list[dict[str, Any]] = []
            batch_walls: list[float] = []
            for batch, offset in enumerate(range(0, len(corpus), config.concurrency)):
                batch_rows, batch_wall = _run_batch(
                    arm=arm,
                    url=url,
                    prompts=corpus[offset : offset + config.concurrency],
                    phase=phase,
                    wave=wave,
                    batch=batch,
                    config=config,
                )
                wave_rows.extend(batch_rows)
                batch_walls.append(batch_wall)
            wave_wall = time.perf_counter() - wave_start
            rows.extend(wave_rows)
            wave_metrics.append(
                {
                    "phase": phase,
                    "wave": wave,
                    "wallSeconds": wave_wall,
                    "batchWallSeconds": batch_walls,
                    "capturedTokens": sum(
                        row["capturedTokenIdCount"] for row in wave_rows
                    ),
                    "maxBarrierReleaseSkewSeconds": max(
                        row["barrierReleaseSkewSeconds"] for row in wave_rows
                    ),
                }
            )
        if phase == "measured":
            measured_end = time.perf_counter()
    # Keep response serialization outside the measured client-wall interval.
    for row in rows:
        _write_response(config.out, row)
    measured_rows = [row for row in rows if row["phase"] == "measured"]
    valid_measured_rows = [row for row in measured_rows if not row["validationErrors"]]
    measured_wall = (measured_end - measured_start) if measured_start is not None and measured_end is not None else 0.0
    expected_requests = len(config.corpus) * config.measured_waves
    exact_good_tokens = sum(config.tokens for _ in valid_measured_rows)
    per_stream_walls = [row["wallSeconds"] for row in measured_rows]
    per_stream_goodput = [
        (config.tokens / row["wallSeconds"]) if not row["validationErrors"] else 0.0
        for row in measured_rows
    ]
    return {
        "name": arm,
        "url": url,
        "requestCount": len(rows),
        "measuredRequestCount": len(measured_rows),
        "expectedMeasuredRequestCount": expected_requests,
        "measuredClientWallSeconds": measured_wall,
        "measuredGoodTokens": exact_good_tokens,
        "aggregateGoodputTokensPerSecond": exact_good_tokens / measured_wall if measured_wall else 0.0,
        "perStreamClientWall": {
            "medianSeconds": statistics.median(per_stream_walls),
            "p95Seconds": percentile(per_stream_walls, 0.95),
            "maxSeconds": max(per_stream_walls),
            "medianGoodputTokensPerSecond": statistics.median(per_stream_goodput),
            "p05GoodputTokensPerSecond": percentile(per_stream_goodput, 0.05),
            "minGoodputTokensPerSecond": min(per_stream_goodput),
        },
        "waveMetrics": wave_metrics,
        "rows": rows,
    }


def _parity(arms: dict[str, dict[str, Any]]) -> dict[str, Any]:
    indexed: dict[str, dict[tuple[str, int, int], dict[str, Any]]] = {}
    for arm, result in arms.items():
        indexed[arm] = {
            (row["phase"], row["wave"], row["corpusIndex"]): row for row in result["rows"]
        }
    keys = sorted(set().union(*(set(rows) for rows in indexed.values())))
    mismatches: list[dict[str, Any]] = []
    for key in keys:
        arm_rows = [indexed[name].get(key) for name in ("A1", "B", "A2")]
        ids_hashes = [row["hashes"]["tokenIdsSha256"] if row else None for row in arm_rows]
        content_hashes = [row["hashes"]["contentSha256"] if row else None for row in arm_rows]
        request_hashes = [row["hashes"]["requestSha256"] if row else None for row in arm_rows]
        valid = all(row is not None and not row["validationErrors"] for row in arm_rows)
        exact_ids = [row["capturedTokenIds"] if row else None for row in arm_rows]
        exact_content = [row["content"] if row else None for row in arm_rows]
        exact_requests = [row["request"] if row else None for row in arm_rows]
        exact_match = exact_ids[0] == exact_ids[1] == exact_ids[2] and exact_content[0] == exact_content[1] == exact_content[2]
        matched_requests = exact_requests[0] == exact_requests[1] == exact_requests[2]
        if not valid or not exact_match or not matched_requests:
            mismatches.append(
                {
                    "phase": key[0],
                    "wave": key[1],
                    "corpusIndex": key[2],
                    "validResponses": valid,
                    "sameRequest": matched_requests,
                    "sameTokenIds": exact_ids[0] == exact_ids[1] == exact_ids[2],
                    "sameContent": exact_content[0] == exact_content[1] == exact_content[2],
                    "requestSha256": dict(zip(("A1", "B", "A2"), request_hashes)),
                    "tokenIdsSha256": dict(zip(("A1", "B", "A2"), ids_hashes)),
                    "contentSha256": dict(zip(("A1", "B", "A2"), content_hashes)),
                }
            )
    return {
        "passed": not mismatches,
        "compared": len(keys),
        "mismatchCount": len(mismatches),
        "mismatches": mismatches,
    }


def _benchmark_configuration(config: HarnessConfig) -> dict[str, Any]:
    """Configuration that must be identical across separately acquired arms."""
    return {
        "completionPath": "/completion",
        "concurrency": config.concurrency,
        "tokens": config.tokens,
        "warmupWaves": config.warmup_waves,
        "measuredWaves": config.measured_waves,
        "timeoutSeconds": config.timeout_seconds,
        "noRetries": True,
        "corpus": list(config.corpus),
        "corpusSize": len(config.corpus),
        "corpusSha256": sha256_bytes(canonical_json(list(config.corpus))),
    }


def _configuration_fingerprint(configuration: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json(configuration))


def _prepare_output(out: Path) -> None:
    if out.exists():
        if not out.is_dir():
            raise ValueError(f"output path is not a directory: {out}")
        if any(out.iterdir()):
            raise ValueError(f"output directory is not empty: {out}")
    else:
        out.mkdir(parents=True)


def _build_summary(
    *,
    arms: dict[str, dict[str, Any]],
    benchmark_configuration: dict[str, Any],
    min_b_ratio: float,
    max_a_drift_pct: float,
    screen_label: str,
    configuration_fingerprint: str,
) -> dict[str, Any]:
    parity = _parity(arms)
    a1 = arms["A1"]["aggregateGoodputTokensPerSecond"]
    b = arms["B"]["aggregateGoodputTokensPerSecond"]
    a2 = arms["A2"]["aggregateGoodputTokensPerSecond"]
    a_mean = (a1 + a2) / 2
    a_drift_pct = ((a2 / a1) - 1) * 100 if a1 else None
    b_ratio = b / a_mean if a_mean else None
    response_errors = [
        {
            "arm": arm,
            "phase": row["phase"],
            "wave": row["wave"],
            "corpusIndex": row["corpusIndex"],
            "errors": row["validationErrors"],
        }
        for arm, result in arms.items()
        for row in result["rows"]
        if row["validationErrors"]
    ]
    checks = {
        "allResponsesExact": not response_errors,
        "parity": parity["passed"],
        "bRatio": b_ratio is not None and b_ratio >= min_b_ratio,
        "aDrift": a_drift_pct is not None and abs(a_drift_pct) <= max_a_drift_pct,
        "configurationFingerprint": True,
    }
    configuration = dict(benchmark_configuration)
    configuration.update(
        {
            "minBRatio": min_b_ratio,
            "maxADriftPct": max_a_drift_pct,
            "configurationFingerprintSha256": configuration_fingerprint,
        }
    )
    return {
        "schemaVersion": 2,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "screenLabel": screen_label,
        "status": "pass" if all(checks.values()) else "fail",
        "configuration": configuration,
        "hashCanonicalization": {
            "request": "SHA-256 of UTF-8 RFC-8259-compatible JSON with sorted keys and compact separators",
            "prompt": "SHA-256 of exact UTF-8 prompt bytes",
            "tokenIds": "SHA-256 of canonical JSON integer array",
            "content": "SHA-256 of exact UTF-8 content bytes",
        },
        "checks": checks,
        "responseErrors": response_errors,
        "parity": parity,
        "comparisons": {
            "aDriftPct": a_drift_pct,
            "a2OverA1Ratio": a2 / a1 if a1 else None,
            "bRatioAgainstArithmeticMeanA": b_ratio,
            "bOverA1Ratio": b / a1 if a1 else None,
            "bOverA2Ratio": b / a2 if a2 else None,
            "arithmeticMeanAGoodputTokensPerSecond": a_mean,
        },
        "arms": arms,
    }


def acquire_arm(arm: str, url: str, config: HarnessConfig) -> dict[str, Any]:
    """Acquire exactly one arm and seal it into a self-contained JSON artifact."""
    config.validate()
    if arm not in ("A1", "B", "A2"):
        raise ValueError("arm must be A1, B, or A2")
    _prepare_output(config.out)
    (config.out / "responses").mkdir()
    benchmark_configuration = _benchmark_configuration(config)
    result = _run_arm(arm, url, config)
    payload = {
        "arm": arm,
        "configuration": benchmark_configuration,
        "result": result,
    }
    artifact = {
        "schemaVersion": 1,
        "artifactType": "strict-ab-arm",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "configurationFingerprintSha256": _configuration_fingerprint(benchmark_configuration),
        "artifactPayloadSha256": sha256_bytes(canonical_json(payload)),
        **payload,
    }
    (config.out / "arm.json").write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return artifact


def _load_arm_artifact(path: Path, expected_arm: str) -> dict[str, Any]:
    artifact_path = path / "arm.json" if path.is_dir() else path
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    if not isinstance(artifact, dict) or artifact.get("artifactType") != "strict-ab-arm":
        raise ValueError(f"not a strict A/B arm artifact: {artifact_path}")
    if artifact.get("arm") != expected_arm:
        raise ValueError(
            f"expected {expected_arm} artifact, got {artifact.get('arm')!r}: {artifact_path}"
        )
    configuration = artifact.get("configuration")
    result = artifact.get("result")
    if not isinstance(configuration, dict) or not isinstance(result, dict):
        raise ValueError(f"malformed arm artifact: {artifact_path}")
    fingerprint = _configuration_fingerprint(configuration)
    if artifact.get("configurationFingerprintSha256") != fingerprint:
        raise ValueError(f"configuration fingerprint verification failed: {artifact_path}")
    payload = {"arm": expected_arm, "configuration": configuration, "result": result}
    if artifact.get("artifactPayloadSha256") != sha256_bytes(canonical_json(payload)):
        raise ValueError(f"artifact payload verification failed: {artifact_path}")
    return artifact


def compare_arm_artifacts(
    *,
    a1_artifact: Path,
    b_artifact: Path,
    a2_artifact: Path,
    out: Path,
    min_b_ratio: float,
    max_a_drift_pct: float,
    screen_label: str,
) -> dict[str, Any]:
    """Offline comparison: this function performs no HTTP requests."""
    if min_b_ratio <= 0 or max_a_drift_pct < 0:
        raise ValueError("minimum B ratio must be positive and maximum A drift must be non-negative")
    if screen_label not in ("short-screen", "final"):
        raise ValueError("screen label must be 'short-screen' or 'final'")
    artifacts = {
        "A1": _load_arm_artifact(a1_artifact, "A1"),
        "B": _load_arm_artifact(b_artifact, "B"),
        "A2": _load_arm_artifact(a2_artifact, "A2"),
    }
    fingerprints = {
        name: artifact["configurationFingerprintSha256"]
        for name, artifact in artifacts.items()
    }
    if len(set(fingerprints.values())) != 1:
        raise ValueError(f"arm configuration fingerprints differ: {fingerprints}")
    _prepare_output(out)
    fingerprint = fingerprints["A1"]
    summary = _build_summary(
        arms={name: artifact["result"] for name, artifact in artifacts.items()},
        benchmark_configuration=artifacts["A1"]["configuration"],
        min_b_ratio=min_b_ratio,
        max_a_drift_pct=max_a_drift_pct,
        screen_label=screen_label,
        configuration_fingerprint=fingerprint,
    )
    summary["armArtifacts"] = {
        name: {
            "path": str(path),
            "artifactPayloadSha256": artifacts[name]["artifactPayloadSha256"],
        }
        for name, path in (("A1", a1_artifact), ("B", b_artifact), ("A2", a2_artifact))
    }
    (out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return summary


def run_benchmark(config: HarnessConfig) -> dict[str, Any]:
    """Backward-compatible in-process A/B/A mode intended for local tests only."""
    config.validate()
    _prepare_output(config.out)
    (config.out / "responses").mkdir()
    arms = {
        "A1": _run_arm("A1", config.a_url, config),
        "B": _run_arm("B", config.b_url, config),
        "A2": _run_arm("A2", config.a_url, config),
    }
    benchmark_configuration = _benchmark_configuration(config)
    summary = _build_summary(
        arms=arms,
        benchmark_configuration=benchmark_configuration,
        min_b_ratio=config.min_b_ratio,
        max_a_drift_pct=config.max_a_drift_pct,
        screen_label=config.screen_label,
        configuration_fingerprint=_configuration_fingerprint(benchmark_configuration),
    )
    (config.out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return summary


def load_corpus(path: Path | None) -> tuple[str, ...]:
    if path is None:
        return tuple(DEFAULT_CORPUS)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError("corpus JSON must be an array of prompt strings")
    return tuple(value)


def _add_acquisition_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, help="JSON array of prompt strings; defaults to the fixed built-in corpus")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--tokens", type=int, default=128)
    parser.add_argument("--warmup-waves", type=int, default=1)
    parser.add_argument("--measured-waves", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=float, default=1800.0)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse the legacy all-in-one CLI (retained for test compatibility)."""
    parser = argparse.ArgumentParser(
        description=(__doc__ or "") + " Legacy all-in-one mode is for local tests only."
    )
    parser.add_argument("--a-url", required=True, help="target-only server base URL (used for A1 and A2)")
    parser.add_argument("--b-url", required=True, help="draft-enabled server base URL")
    _add_acquisition_options(parser)
    parser.add_argument("--min-b-ratio", type=float, default=1.0)
    parser.add_argument("--max-a-drift-pct", type=float, default=5.0)
    parser.add_argument("--screen-label", choices=("short-screen", "final"), default="short-screen")
    return parser.parse_args(argv)


def _parse_split_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    acquire = subparsers.add_parser("acquire", help="acquire exactly one immutable arm artifact")
    acquire.add_argument("--arm", choices=("A1", "B", "A2"), required=True)
    acquire.add_argument("--url", required=True, help="the single server URL for this arm")
    _add_acquisition_options(acquire)
    compare = subparsers.add_parser("compare", help="offline comparison of three arm artifacts")
    compare.add_argument("--a1-artifact", type=Path, required=True)
    compare.add_argument("--b-artifact", type=Path, required=True)
    compare.add_argument("--a2-artifact", type=Path, required=True)
    compare.add_argument("--out", type=Path, required=True)
    compare.add_argument("--min-b-ratio", type=float, default=1.0)
    compare.add_argument("--max-a-drift-pct", type=float, default=5.0)
    compare.add_argument("--screen-label", choices=("short-screen", "final"), default="short-screen")
    return parser.parse_args(argv)


def _config_from_args(args: argparse.Namespace, *, a_url: str, b_url: str) -> HarnessConfig:
    return HarnessConfig(
        a_url=a_url,
        b_url=b_url,
        out=args.out,
        corpus=load_corpus(args.corpus),
        concurrency=args.concurrency,
        tokens=args.tokens,
        warmup_waves=args.warmup_waves,
        measured_waves=args.measured_waves,
        timeout_seconds=args.timeout_seconds,
        min_b_ratio=getattr(args, "min_b_ratio", 1.0),
        max_a_drift_pct=getattr(args, "max_a_drift_pct", 5.0),
        screen_label=getattr(args, "screen_label", "short-screen"),
    )


def main(argv: Sequence[str] | None = None) -> int:
    raw_argv = list(argv) if argv is not None else sys.argv[1:]
    split_mode = bool(raw_argv and raw_argv[0] in ("acquire", "compare"))
    args = _parse_split_args(raw_argv) if split_mode else parse_args(raw_argv)
    try:
        if split_mode and args.command == "acquire":
            config = _config_from_args(args, a_url=args.url, b_url=args.url)
            artifact = acquire_arm(args.arm, args.url, config)
            result = {
                "status": "acquired",
                "arm": args.arm,
                "artifact": str(config.out / "arm.json"),
                "configurationFingerprintSha256": artifact["configurationFingerprintSha256"],
                "artifactPayloadSha256": artifact["artifactPayloadSha256"],
            }
            print("RESULT_JSON=" + json.dumps(result, separators=(",", ":"), sort_keys=True))
            return 0
        if split_mode:
            summary = compare_arm_artifacts(
                a1_artifact=args.a1_artifact,
                b_artifact=args.b_artifact,
                a2_artifact=args.a2_artifact,
                out=args.out,
                min_b_ratio=args.min_b_ratio,
                max_a_drift_pct=args.max_a_drift_pct,
                screen_label=args.screen_label,
            )
            output = args.out
        else:
            config = _config_from_args(args, a_url=args.a_url, b_url=args.b_url)
            summary = run_benchmark(config)
            output = config.out
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, separators=(",", ":")), file=sys.stderr)
        return 2
    result = {
        "status": summary["status"],
        "screenLabel": summary["screenLabel"],
        "summary": str(output / "summary.json"),
        "checks": summary["checks"],
        "comparisons": summary["comparisons"],
    }
    print("RESULT_JSON=" + json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0 if summary["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
