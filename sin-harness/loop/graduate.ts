// loop/graduate.ts — saturation detector (PRD L3 gate).
//
// Weight training is NEVER scheduled; it is earned. A pattern graduates to an
// adapter recipe only when ALL of the following hold (PRD: "appears 20+ times
// over weeks and text-level skills demonstrably don't fix it"):
//   1. count >= minOccurrences        (default 20)
//   2. spread >= minSpanDays          (default 7  — recurring across weeks,
//                                      not a single-session burst)
//   3. textSkillTried === true        (an L1 skill whose provenance commit
//                                      references this pattern's events
//                                      already exists, and the pattern STILL
//                                      recurs — the text path is exhausted)
//
// Deterministic: same event store + same knowledge repo ⇒ same verdicts.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventKind, EventRecord, SaturationVerdict } from "../core/types.ts";
import { redactPii } from "./events.ts";

/** Kinds that carry failure/correction signal for graduation purposes. */
const SIGNAL_KINDS: ReadonlySet<EventKind> = new Set([
  "correction",
  "retry",
  "tool_failure",
]);

/**
 * Normalize a payload into a stable pattern signature: redact PII, lowercase,
 * strip numbers/uuids/hex tokens and punctuation, collapse whitespace.
 * "Timeout after 3000ms waiting for abc-123" ≡ "timeout after ...ms waiting".
 */
export function patternKeyOf(payload: string): string {
  const redacted = redactPii(payload).toLowerCase();
  return redacted
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, " ")
    .replace(/\b[0-9a-f]{16,}\b/g, " ")
    .replace(/\d+(\.\d+)?/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function daysBetween(isoA: string, isoB: string): number {
  return Math.abs(
    (Date.parse(isoB) - Date.parse(isoA)) / (24 * 60 * 60 * 1000),
  );
}

/** Event ids referenced by `trigger:` lines anywhere in the knowledge repo's
 * git history — i.e., events a text skill was already written to fix. */
export function provenanceTriggeredEventIds(knowledgeRoot: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(join(knowledgeRoot, ".git"))) return ids;
  const res = spawnSync("git", ["-C", knowledgeRoot, "log", "--format=%B"], {
    encoding: "utf8",
  });
  if (res.status !== 0 || !res.stdout) return ids;
  for (const m of res.stdout.matchAll(/^trigger:\s*(.+)$/gm)) {
    for (const tok of m[1]!.split(/[\s,]+/)) {
      if (tok) ids.add(tok);
    }
  }
  return ids;
}

export interface GraduateOptions {
  minOccurrences?: number; // PRD default: 20+
  minSpanDays?: number; // default 7 ("over weeks")
  knowledgeRoot?: string; // L1 repo to scan for exhausted text fixes
}

/**
 * Group signal events by normalized pattern signature and emit saturation
 * verdicts, most frequent first. Pure function of (store, knowledgeRepo).
 */
export function detectSaturatedPatterns(
  events: readonly EventRecord[],
  opts: GraduateOptions = {},
): SaturationVerdict[] {
  const minOccurrences = opts.minOccurrences ?? 20;
  const minSpanDays = opts.minSpanDays ?? 7;

  const groups = new Map<
    string,
    { events: EventRecord[]; triggeredIds: Set<string> | null }
  >();
  const triggered =
    opts.knowledgeRoot !== undefined
      ? provenanceTriggeredEventIds(opts.knowledgeRoot)
      : null;

  for (const ev of events) {
    if (!SIGNAL_KINDS.has(ev.kind)) continue;
    const key = patternKeyOf(ev.payload);
    if (!key) continue; // un-normalizable noise never graduates anything
    let g = groups.get(key);
    if (!g) {
      g = { events: [], triggeredIds: null };
      groups.set(key, g);
    }
    g.events.push(ev);
  }

  const verdicts: SaturationVerdict[] = [];
  for (const [patternKey, g] of groups) {
    const sorted = [...g.events].sort((a, b) => a.ts.localeCompare(b.ts));
    const firstSeen = sorted[0]!.ts;
    const lastSeen = sorted[sorted.length - 1]!.ts;
    const occurrences = sorted.length;
    const spanDays = daysBetween(firstSeen, lastSeen);

    let textSkillTried = false;
    if (triggered !== null) {
      textSkillTried = sorted.some((ev) => triggered.has(ev.id));
    }

    let saturated = true;
    let reason: SaturationVerdict["reason"];
    if (occurrences < minOccurrences) {
      saturated = false;
      reason = "below-threshold";
    } else if (spanDays < minSpanDays) {
      saturated = false;
      reason = "burst-not-recurring";
    } else if (!textSkillTried) {
      saturated = false;
      reason = "text-path-not-exhausted";
    }

    verdicts.push({
      patternKey,
      occurrences,
      firstSeen,
      lastSeen,
      spanDays,
      textSkillTried,
      saturated,
      ...(saturated ? {} : { reason }),
    });
  }
  verdicts.sort((a, b) => b.occurrences - a.occurrences);
  return verdicts;
}
