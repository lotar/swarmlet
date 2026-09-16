// Evidence integrity for the published benchmark reports.
//
// Two defects found on 2026-09-16 motivate this, both in the reports a reader is meant to trust:
//   - CTX_SWEEP_MAC2MAC_20260913.md sent the reader to `/tmp/ctxsweep.jsonl` and `/tmp/ctxsweep.py` for its
//     raw rows - files that do not survive a reboot, next to in-repo copies that do;
//   - the same report's headline said "5.3-6.3 tok/s" while the chart built from the same rows says 5.4-6.3
//     (the plotted minimum is 5.35).
// Neither is fatal, and neither would ever be noticed without reading the numbers next to the data. The
// checks below are the cheap half of that reading: citations must resolve inside the repository, and a
// chart's stated range must be the range of the series it plots.
//
// Scope: docs/reports/*.md and docs/reports/*.html (the published evidence), NOT the audit subdirectory,
// whose reports legitimately quote /tmp scratch paths from the session that produced them.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const REPORTS = join(ROOT, "docs", "reports");

const reportFiles = readdirSync(REPORTS).filter((f) => f.endsWith(".md"));
const chartFiles = readdirSync(REPORTS).filter((f) => /^ctx-charts.*\.html$/.test(f));

/** Scratch paths a report points at. The defect this catches is narrow and real: a report sends the reader
 *  to /tmp for rows that are committed next to it (CTX_SWEEP did exactly that, for ctxsweep.jsonl and
 *  ctxsweep.py). Paths with no in-repo copy are reported as a note instead - a scratch script that produced
 *  published numbers and never made it into the repository is a judgement call for the owner, not a failure
 *  of this reader. */
function scratchCitations(text: string): string[] {
  return [...text.matchAll(/\/(?:tmp|Users)\/[^\s`),;"]+/g)].map((m) => m[0]);
}

/** The name a report and the repository should agree on: extension off, and the timestamp a raw file
 *  carries (`-raw-20260913`) is not part of the identity. That is what makes `ctxsweep.jsonl` in /tmp and
 *  the committed `ctxsweep-raw-20260913.jsonl` the same file to this check. */
function stem(name: string): string {
  return name.replace(/\.(jsonl|json|py|sh|html)$/, "").replace(/-raw-\d{8}$/, "").replace(/-\d{8}$/, "");
}

test("no report sends the reader to scratch for a file the repository already holds", () => {
  const committed = readdirSync(REPORTS);
  const problems: string[] = [];
  const stranded: string[] = [];
  for (const file of reportFiles) {
    const text = readFileSync(join(REPORTS, file), "utf8");
    for (const cite of scratchCitations(text)) {
      if (cite.endsWith("/")) continue;                 // a scratch directory, not a file the repo could hold
      const base = cite.split("/").pop()!;
      if (!base) continue;
      const held = committed.some((name) => stem(name) === stem(base));
      if (held) problems.push(`${file}: cites ${cite}, but docs/reports/ already holds ${committed.filter((n) => stem(n) === stem(base)).join(", ")}`);
      else if (/\.(py|jsonl|json|sh)$/.test(base)) stranded.push(`${file}: ${cite}`);
    }
  }
  if (stranded.length) console.log(`  note: reports citing scratch files with no in-repo copy:\n    ${stranded.join("\n    ")}`);
  expect(problems, `citations the repository could answer itself:\n  ${problems.join("\n  ")}`).toEqual([]);
});

test("every chart's stated range is the range of the series it plots", () => {
  expect(chartFiles.length).toBeGreaterThan(0);
  let checked = 0;
  const problems: string[] = [];
  for (const file of chartFiles) {
    const html = readFileSync(join(REPORTS, file), "utf8");
    const data = /const DATA = (\{[\s\S]*?\});/.exec(html);
    if (!data) { console.log(`  note: ${file} embeds no series (nothing to cross-check)`); continue; }
    const parsed = JSON.parse(data[1]!) as { ctx?: Array<Record<string, number>>; conc?: Array<Record<string, number>> };
    checked += 1;
    const rows = parsed.ctx ?? [];
    expect(rows.length, `${file}: the ctx series is empty`).toBeGreaterThan(0);

    const decode = rows.map((r) => r.decode).filter((v): v is number => typeof v === "number");
    const note = /\((\d+(?:\.\d+)?)[–-](\d+(?:\.\d+)?) tok\/s/.exec(html);
    if (!note) continue;                       // a chart that states no range has nothing to contradict
    const [lo, hi] = [Number(note[1]), Number(note[2])];
    const [dataLo, dataHi] = [Math.min(...decode), Math.max(...decode)];
    // The note rounds to one decimal, so allow exactly that: a tenth either way, no more.
    if (Math.abs(lo - dataLo) > 0.1 || Math.abs(hi - dataHi) > 0.1) {
      problems.push(`${file}: note says ${lo}-${hi} but the plotted decode series is ${dataLo.toFixed(2)}-${dataHi.toFixed(2)}`);
    }
    // The concurrency series is what the second half of each chart is for; an empty one means a broken embed.
    expect((parsed.conc ?? []).length, `${file}: the conc series is empty`).toBeGreaterThan(0);
  }
  expect(checked, "at least one chart embeds a series to check").toBeGreaterThan(0);
  expect(problems, `stated ranges that do not match the data:\n  ${problems.join("\n  ")}`).toEqual([]);
});

test("the reports that carry raw rows keep those rows in the repository", () => {
  // A .jsonl next to a report is evidence; the report that summarises a series should be able to point at it.
  const raws = readdirSync(REPORTS).filter((f) => f.endsWith(".jsonl"));
  expect(raws.length, "expected the mac2mac raw rows to be committed").toBeGreaterThan(0);
  const orphaned = raws.filter((raw) => {
    const stem = raw.replace(/-raw.*$/, "").replace(/\.jsonl$/, "");
    const text = reportFiles.map((f) => readFileSync(join(REPORTS, f), "utf8")).join("\n");
    return !text.includes(raw) && !text.includes(stem);
  });
  // Not an assertion: orphaned raw data is a judgement call for the owner (see L9). It is reported so the
  // choice is visible rather than accidental.
  if (orphaned.length) console.log(`  note: raw rows not named by any report: ${orphaned.join(", ")}`);
});

test("the citation rule has teeth: it flags the defect it was written for", () => {
  const committed = readdirSync(REPORTS);
  // The exact sentence CTX_SWEEP carried before this test existed: /tmp/ctxsweep.jsonl, while the
  // repository holds ctxsweep-raw-20260913.jsonl. Same file, different name - which is why the rule
  // compares stems and not names.
  const before = "Produced by `ctxsweep.py` (raw rows: `/tmp/ctxsweep.jsonl`).";
  const flagged = scratchCitations(before)
    .filter((c) => !c.endsWith("/") && Boolean(c.split("/").pop()))
    .filter((c) => committed.some((name) => stem(name) === stem(c.split("/").pop()!)));
  expect(flagged).toEqual(["/tmp/ctxsweep.jsonl"]);
  // A scratch file the repository does not hold is a note, not a failure.
  const scratchOnly = scratchCitations("see /tmp/swarmlet-markdown-fleet-audit.py");
  expect(scratchOnly.filter((c) => committed.some((name) => stem(name) === stem(c.split("/").pop()!)))).toEqual([]);
});
