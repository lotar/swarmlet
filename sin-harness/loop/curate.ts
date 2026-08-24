// loop/curate.ts — every-3h judge pass over unprocessed events.
//
// Division of authority (PRD §2 L2 reasoning): the local-model JUDGE only
// narrows and annotates; DETERMINISTIC rules decide. If the judge's output
// is unparseable or schema-invalid (as with the mock endpoint), the
// deterministic fallback fully owns classification — curation never blocks
// on model quality, and the mock-server path is meaningful in tests.
//
// PII rule: events flagged at capture NEVER contribute verbatim text to
// candidate summaries; their payloads pass through redactPii() first.

import { fnv1a } from "../core/mock.ts";
import type { ChatMsg, EventRecord, L0Client, SkillCandidate } from "../core/types.ts";
import { extractJson } from "../evals/templates.ts";
import { EventStore, detectPii, redactPii } from "./events.ts";

export interface JudgeVerdict {
  signal: boolean;
  skillCandidate: boolean;
  reason: string;
  /** true when the verdict came from the model rather than the fallback */
  judged: boolean;
}

const JUDGE_SYSTEM =
  "You are a strict data curator for an AI agent's event log. Classify each " +
  "event. Respond with ONLY minified JSON: " +
  '{"signal": <boolean>, "skill_candidate": <boolean>, "reason": "<short reason>"} ' +
  '"signal"=true means the event carries reusable operational lesson, not chatter.';

/** Deterministic classification used when the judge is unavailable/unparseable. */
export function fallbackVerdict(ev: EventRecord): JudgeVerdict {
  const p = ev.payload.toLowerCase();
  const failureShaped =
    /error|fail|wrong|incorrect|broken|crash|timeout|fix|should have/.test(p);
  const signalByKind = ev.kind === "correction" || ev.kind === "retry" || ev.kind === "tool_failure";
  const signal = signalByKind || (ev.kind === "observation" && failureShaped);
  return {
    signal,
    skillCandidate: signal && ev.kind !== "observation",
    reason: `fallback(${ev.kind}${failureShaped ? "+failure-shaped" : ""})`,
    judged: false,
  };
}

/** Ask the L0 judge; fall back to deterministic rules on any parse problem. */
export async function judgeEvent(client: L0Client, ev: EventRecord): Promise<JudgeVerdict> {
  const msgs: ChatMsg[] = [
    { role: "system", content: JUDGE_SYSTEM },
    {
      role: "user",
      content: JSON.stringify({
        kind: ev.kind,
        session: ev.session,
        // judge sees PII-redacted content only — nothing verbatim leaks upstream
        payload: redactPii(ev.payload).slice(0, 600),
      }),
    },
  ];
  try {
    const raw = await client.chat(msgs, { seed: 7 });
    const parsed = extractJson(raw);
    if (
      parsed &&
      typeof parsed.signal === "boolean" &&
      typeof parsed.skill_candidate === "boolean"
    ) {
      return {
        signal: parsed.signal,
        skillCandidate: parsed.skill_candidate,
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "judged",
        judged: true,
      };
    }
  } catch {
    // endpoint hiccup → fallback keeps the loop running (crash-only rule)
  }
  return fallbackVerdict(ev);
}

function excerpt(s: string, max = 140): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Curate all unprocessed events into SkillCandidates.
 * - signal events grouped per session; ≥2 signals in a session ⇒ a "skill"
 *   candidate (recurring pattern), a lone signal ⇒ a "memory" candidate.
 * - PII-flagged events contribute ONLY redacted prose.
 * - every event in the processed batch is marked processed afterwards, so a
 *   crash between classify and mark simply re-runs idempotently next cycle.
 */
export async function curateUnprocessed(opts: {
  client: L0Client;
  store: EventStore;
  batchSize?: number;
}): Promise<SkillCandidate[]> {
  const batch = opts.store.unprocessed(opts.batchSize ?? 500);
  if (batch.length === 0) return [];

  const candidates: SkillCandidate[] = [];
  const bySession = new Map<string, EventRecord[]>();
  for (const ev of batch) {
    const v = await judgeEvent(opts.client, ev);
    if (!v.signal) continue;
    const list = bySession.get(ev.session) ?? [];
    list.push(ev);
    bySession.set(ev.session, list);
  }

  const summarize = (events: EventRecord[]): string => {
    const kinds = [...new Set(events.map((e) => e.kind))].join("+");
    const lines = events.slice(0, 5).map((e) => {
      const src = e.piiFlagged || detectPii(e.payload) ? redactPii(e.payload) : e.payload;
      return `- [${e.kind}] ${excerpt(src)}`;
    });
    return `Recurring ${kinds} pattern in session(s); lessons:\n${lines.join("\n")}`;
  };

  for (const [session, events] of [...bySession.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const eventIds = events.map((e) => e.id);
    const kind = events.length >= 2 ? "skill" : "memory";
    candidates.push({
      id: `cand-${fnv1a(`${session}|${eventIds.join(",")}`).toString(36)}`,
      eventIds,
      summary: `[session:${session}] ${summarize(events)}`,
      kind,
    });
  }

  opts.store.markProcessed(batch.map((e) => e.id));
  return candidates;
}
