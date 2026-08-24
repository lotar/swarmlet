// evals/templates.ts — task template registry (L2 core).
// A template is FROZEN design; instances are regenerated forever via
// makeInstance(seed). Ground truth is known at construction time because the
// synthetic input is derived from the same seed — that is what makes
// metamorphic evaluation possible without hand-labeled data.
//
// All agency-relevant templates use a uniform machine-checkable envelope:
// the model must respond with ONLY minified JSON (fields vary per template).

import { fnv1a, mulberry32 } from "../core/mock.ts";
import { canonicalize } from "../core/sign.ts";
import type { EvalInstance } from "../core/types.ts";

export interface CheckOutcome {
  passed: boolean;
  /** Partial credit in [0,1]. */
  score: number;
}

export interface TemplateDef {
  readonly id: string;
  readonly description: string;
  makeInstance(seed: number): EvalInstance;
  /** Deterministic checker: pure function of (output, instance). */
  check(output: string, inst: EvalInstance): CheckOutcome;
  /**
   * Canonical correct response for an instance — used by tests, distillation
   * pipelines, and property checks. Pure function of the instance.
   */
  renderAnswer(inst: EvalInstance): string;
}

const REGISTRY = new Map<string, TemplateDef>();

/** Register a template definition. Throws on duplicate ids. */
export function makeTemplate(
  id: string,
  def: Omit<TemplateDef, "id">,
): void {
  if (REGISTRY.has(id)) throw new Error(`template already registered: ${id}`);
  REGISTRY.set(id, { ...def, id });
}

export function getTemplate(id: string): TemplateDef {
  const t = REGISTRY.get(id);
  if (!t) throw new Error(`unknown template: ${id}`);
  return t;
}

/** All registered templates, stable order (sorted by id). */
export function listTemplates(): TemplateDef[] {
  return [...REGISTRY.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---------- shared helpers ----------

/** Extract a JSON object from model output (direct parse, then brace scan). */
export function extractJson(output: string): Record<string, unknown> | undefined {
  const tryParse = (s: string): Record<string, unknown> | undefined => {
    try {
      const v: unknown = JSON.parse(s);
      return isObj(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(output.trim());
  if (direct) return direct;
  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");
  if (first === -1 || last <= first) return undefined;
  return tryParse(output.slice(first, last + 1));
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  const i = Math.floor(rand() * arr.length);
  return arr[i] as T;
}

function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:'"()\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normSql(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function fail(score = 0): CheckOutcome {
  return { passed: false, score };
}

// ---------- 1. extract-invoice-fields ----------

interface InvoiceLine {
  desc: string;
  qty: number;
  unit: number;
  amt: number;
}

makeTemplate("extract-invoice-fields", {
  description:
    "Extract invoice_id and total from a synthetic B2B invoice (Croatian SME flavor).",
  makeInstance(seed) {
    const rand = mulberry32(fnv1a(`invoice:${seed}`));
    const vendor = pick(rand, [
      "Zagreb Tech d.o.o.",
      "Adria Logistics j.d.o.o.",
      "Kuna Software d.o.o.",
      "Sava Consulting",
    ]);
    const invoiceId = `INV-2026-${10000 + Math.floor(rand() * 89999)}`;
    const n = 1 + Math.floor(rand() * 4);
    const lines: InvoiceLine[] = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const desc = pick(rand, [
        "MCP integration sprint",
        "Retainer hours",
        "Model evaluation batch",
        "Prompt engineering",
        "Data migration",
      ]);
      const qty = 1 + Math.floor(rand() * 9);
      const unit = 50 + Math.floor(rand() * 451);
      const amt = qty * unit;
      total += amt;
      lines.push({ desc, qty, unit, amt });
    }
    return {
      id: `extract-invoice-fields-${seed}`,
      templateId: "extract-invoice-fields",
      transformId: "identity",
      seed,
      prompt: [
        "Extract the invoice fields from the text below.",
        'Respond with ONLY minified JSON: {"invoice_id": "<string>", "total": <number>}',
        "",
        "<invoice>",
        `Vendor: ${vendor}`,
        `Invoice number: ${invoiceId}`,
        "Items:",
        ...lines.map(
          (l) => `- ${l.desc}: ${l.qty} x ${l.unit} EUR = ${l.amt} EUR`,
        ),
        `Total due: ${total} EUR`,
        "Currency: EUR",
        "</invoice>",
      ].join("\n"),
      expected: { kind: "exact", value: canonicalize({ invoice_id: invoiceId, total }) },
      meta: { scaleTarget: "total" },
    };
  },
  check(output, inst) {
    if (inst.expected.kind !== "exact") return fail();
    const parsed = extractJson(output);
    if (!parsed) return fail();
    let exp: { invoice_id: string; total: number };
    try {
      const v: unknown = JSON.parse(inst.expected.value);
      if (!isObj(v) || typeof v.invoice_id !== "string" || typeof v.total !== "number") return fail();
      exp = { invoice_id: v.invoice_id, total: v.total };
    } catch {
      return fail();
    }
    const idOk =
      typeof parsed.invoice_id === "string" &&
      parsed.invoice_id.trim() === exp.invoice_id;
    const totalOk =
      typeof parsed.total === "number" &&
      Math.abs(parsed.total - exp.total) <= 0.01;
    const score = (idOk ? 0.5 : 0) + (totalOk ? 0.5 : 0);
    return { passed: score === 1, score };
  },
  renderAnswer(inst) {
    if (inst.expected.kind !== "exact") throw new Error("unexpected expected kind");
    const v: unknown = JSON.parse(inst.expected.value);
    if (!isObj(v)) throw new Error("corrupt expected");
    return canonicalize({ invoice_id: v.invoice_id, total: v.total });
  },
});

// ---------- 2. summarize-with-constraints ----------

makeTemplate("summarize-with-constraints", {
  description:
    "Summarize meeting notes under hard constraints: word cap + mandatory keywords.",
  makeInstance(seed) {
    const rand = mulberry32(fnv1a(`summary:${seed}`));
    const kw1 = pick(rand, ["migration", "onboarding", "renewal", "audit", "handover"]);
    const kw2 = pick(rand, ["compliance", "budget", "rollout", "training", "review"]);
    const client = pick(rand, ["Adria Media", "Kuna Retail", "Sava Bank", "Lika Logistics"]);
    const owner = pick(rand, ["Ana", "Ivan", "Petra", "Marko"]);
    const filler = pick(rand, ["vendor review", "security training", "backup policy drill"]);
    const quarter = 1 + Math.floor(rand() * 4);
    const budget = (2 + Math.floor(rand() * 18)) * 500;
    return {
      id: `summarize-with-constraints-${seed}`,
      templateId: "summarize-with-constraints",
      transformId: "identity",
      seed,
      prompt: [
        "Summarize the meeting notes below.",
        `Constraints: the summary must be at most 35 words and MUST mention "${kw1}" and "${kw2}".`,
        'Respond with ONLY minified JSON: {"summary": "<string>"}',
        "",
        "<notes>",
        `Meeting notes — ${client}`,
        `1. Approved the ${kw1} plan starting next month.`,
        `2. Postponed the ${filler} until Q${quarter}.`,
        `3. Budget of ${budget} EUR reserved for the ${kw2}.`,
        `Owner: ${owner}`,
        "</notes>",
      ].join("\n"),
      expected: { kind: "contains", value: kw1 },
      meta: { keywords: `${kw1},${kw2}`, maxWords: 35 },
    };
  },
  check(output, inst) {
    const parsed = extractJson(output);
    if (!parsed || typeof parsed.summary !== "string") return fail();
    const summary = parsed.summary;
    const words = summary.split(/\s+/).filter(Boolean).length;
    const maxWords =
      typeof inst.meta?.maxWords === "number" ? inst.meta.maxWords : 35;
    const wcOk = words > 0 && words <= maxWords;
    const kwsRaw =
      typeof inst.meta?.keywords === "string"
        ? inst.meta.keywords.split(",")
        : [];
    const kwLower = summary.toLowerCase();
    const kwsOk = kwsRaw.length > 0 &&
      kwsRaw.every((k) => kwLower.includes(k.toLowerCase()));
    const score = ((wcOk ? 1 : 0) + (kwsOk ? 1 : 0)) / 2;
    return { passed: wcOk && kwsOk, score };
  },
  renderAnswer(inst) {
    const kwsRaw =
      typeof inst.meta?.keywords === "string"
        ? inst.meta.keywords.split(",")
        : ["x", "y"];
    return canonicalize({
      summary: `Approved the ${kwsRaw[0]} and budgeted the ${kwsRaw[1]}.`,
    });
  },
});

// ---------- 3. hr-en-translate ----------

const PHRASEBOOK: ReadonlyArray<readonly [string, string]> = [
  ["Hvala vam na brzom odgovoru.", "Thank you for the quick reply."],
  ["Možemo li zakazati sastanak za sljedeći tjedan?", "Can we schedule a meeting for next week?"],
  ["Potvrđujem primanje fakture.", "I confirm receipt of the invoice."],
  ["Šaljemo vam revidiranu ponudu danas.", "We are sending you the revised proposal today."],
  ["Tim je završio integraciju prije roka.", "The team finished the integration ahead of the deadline."],
  ["Molimo potvrdite novi rok za isporuku.", "Please confirm the new delivery date."],
  ["Razgovarat ćemo o ugovoru nakon praznika.", "We will discuss the contract after the holiday."],
  ["Naš odjel za podršku odgovara u roku od 24 sata.", "Our support department responds within 24 hours."],
];

makeTemplate("hr-en-translate", {
  description:
    "Bidirectional HR↔EN business phrasebook translation with canonical targets.",
  makeInstance(seed) {
    const rand = mulberry32(fnv1a(`translate:${seed}`));
    const idx = Math.floor(rand() * PHRASEBOOK.length);
    const pair = PHRASEBOOK[idx] as readonly [string, string];
    const toEnglish = rand() < 0.5;
    const src = toEnglish ? pair[0] : pair[1];
    const tgt = toEnglish ? pair[1] : pair[0];
    const dir = toEnglish ? "hr->en" : "en->hr";
    return {
      id: `hr-en-translate-${seed}`,
      templateId: "hr-en-translate",
      transformId: "identity",
      seed,
      prompt: [
        `Translate the sentence to ${toEnglish ? "English" : "Croatian"}.`,
        'Respond with ONLY minified JSON: {"translation": "<string>"}',
        "",
        `Sentence: "${src}"`,
      ].join("\n"),
      expected: { kind: "exact", value: canonicalize({ translation: tgt }) },
      meta: { hrText: pair[0], enText: pair[1], direction: dir },
    };
  },
  check(output, inst) {
    if (inst.expected.kind !== "exact") return fail();
    const parsed = extractJson(output);
    if (!parsed || typeof parsed.translation !== "string") return fail();
    let exp: { translation: string };
    try {
      const v: unknown = JSON.parse(inst.expected.value);
      if (!isObj(v) || typeof v.translation !== "string") return fail();
      exp = { translation: v.translation };
    } catch {
      return fail();
    }
    const ok =
      normText(parsed.translation) === normText(exp.translation) ||
      normText(exp.translation).includes(normText(parsed.translation));
    return { passed: ok, score: ok ? 1 : 0 };
  },
  renderAnswer(inst) {
    if (inst.expected.kind !== "exact") throw new Error("unexpected expected kind");
    const v: unknown = JSON.parse(inst.expected.value);
    if (!isObj(v) || typeof v.translation !== "string") throw new Error("corrupt expected");
    return canonicalize({ translation: v.translation });
  },
});

// ---------- 4. tool-call-json-emission ----------

makeTemplate("tool-call-json-emission", {
  description:
    "Given a tool schema and a task, emit exactly the right tool-call JSON.",
  makeInstance(seed) {
    const rand = mulberry32(fnv1a(`toolcall:${seed}`));
    const tool = Math.floor(rand() * 3);
    let call: { name: string; arguments: Record<string, string | number> };
    let task: string;
    let meta: Record<string, string | number | boolean> = {};
    if (tool === 0) {
      const title = pick(rand, ["Kickoff", "Quarterly review", "Retrospective"]);
      const day = `2026-09-${10 + Math.floor(rand() * 18)}`;
      const hour = 9 + Math.floor(rand() * 9);
      call = { name: "create_calendar_event", arguments: { title, day, hour } };
      task = `Schedule a "${title}" meeting on ${day} at ${hour}:00.`;
    } else if (tool === 1) {
      const to = pick(rand, ["ana@klijent.hr", "ivan@firma.hr", "podrska@adria.hr"]);
      const subject = pick(rand, ["Proposal v2", "Invoice reminder", "Follow-up"]);
      const priority = pick(rand, ["low", "normal", "high"]);
      call = { name: "send_email", arguments: { to, subject, priority } };
      task = `Email ${to} about "${subject}" with ${priority} priority.`;
    } else {
      const client = pick(rand, ["Adria Media", "Kuna Retail"]);
      const amount = (500 + Math.floor(rand() * 451)) * 10;
      call = { name: "create_invoice", arguments: { client, amount_eur: amount } };
      task = `Create an invoice for ${client} totaling ${amount} EUR.`;
      meta = { scaleTarget: "amount_eur" };
    }
    return {
      id: `tool-call-json-emission-${seed}`,
      templateId: "tool-call-json-emission",
      transformId: "identity",
      seed,
      prompt: [
        "You may call exactly one tool.",
        "Tools:",
        "- create_calendar_event(title: string, day: string, hour: number)",
        '- send_email(to: string, subject: string, priority: "low"|"normal"|"high")',
        "- create_invoice(client: string, amount_eur: number)",
        'Emit the tool call as ONLY minified JSON: {"name": "<tool>", "arguments": {...}}',
        "",
        `Task: ${task}`,
      ].join("\n"),
      expected: { kind: "exact", value: canonicalize(call) },
      meta,
    };
  },
  check(output, inst) {
    if (inst.expected.kind !== "exact") return fail();
    const parsed = extractJson(output);
    if (!parsed) return fail();
    let exp: { name: string; arguments: Record<string, unknown> };
    try {
      const v: unknown = JSON.parse(inst.expected.value);
      if (
        !isObj(v) || typeof v.name !== "string" || !isObj(v.arguments)
      ) return fail();
      exp = { name: v.name, arguments: v.arguments };
    } catch {
      return fail();
    }
    const nameOk = parsed.name === exp.name;
    const argsOk =
      isObj(parsed.arguments) &&
      canonicalize(parsed.arguments) === canonicalize(exp.arguments);
    const score = ((nameOk ? 1 : 0) + (argsOk ? 1 : 0)) / 2;
    return { passed: score === 1, score };
  },
  renderAnswer(inst) {
    if (inst.expected.kind !== "exact") throw new Error("unexpected expected kind");
    const v: unknown = JSON.parse(inst.expected.value);
    if (!isObj(v) || typeof v.name !== "string" || !isObj(v.arguments)) {
      throw new Error("corrupt expected");
    }
    return canonicalize({ name: v.name, arguments: v.arguments });
  },
});

// ---------- 5. fix-broken-sql ----------

const SQL_VARIANTS: ReadonlyArray<{
  correct: string;
  inject: (sql: string) => string;
}> = [
  {
    correct:
      "SELECT name FROM customers WHERE country = 'HR' AND credit_limit > 5000 ORDER BY name;",
    inject: (sql) => sql.replace("credit_limit", "credit_limt"),
  },
  {
    correct: "SELECT SUM(total_eur) AS revenue FROM orders WHERE status = 'paid';",
    inject: (sql) => sql.replace("SELECT", "SELCT"),
  },
  {
    correct:
      "SELECT customers.name FROM customers JOIN orders ON orders.customer_id = customers.id WHERE orders.status = 'open';",
    inject: (sql) => sql.replace(/WHERE.*$/, ""),
  },
];

makeTemplate("fix-broken-sql", {
  description:
    "Fix a seeded SQL bug (typo'd identifier, keyword typo, or dropped WHERE).",
  makeInstance(seed) {
    const rand = mulberry32(fnv1a(`sqlfix:${seed}`));
    const idx = Math.floor(rand() * SQL_VARIANTS.length);
    const v = SQL_VARIANTS[idx] as (typeof SQL_VARIANTS)[number];
    const broken = v.inject(v.correct);
    const bugKind =
      broken.includes("SELCT") ? "keyword typo"
      : !broken.includes("WHERE") && v.correct.includes("WHERE") ? "missing WHERE clause"
      : "identifier typo";
    return {
      id: `fix-broken-sql-${seed}`,
      templateId: "fix-broken-sql",
      transformId: "identity",
      seed,
      prompt: [
        "Fix the broken SQL query against the schema below.",
        "Schema:",
        "- customers(id, name, country, credit_limit)",
        "- orders(id, customer_id, total_eur, status)",
        'Respond with ONLY minified JSON: {"sql": "<corrected query>"}',
        "",
        "<sql>",
        broken,
        "</sql>",
        `Known defect: ${bugKind}.`,
      ].join("\n"),
      expected: { kind: "exact", value: canonicalize({ sql: v.correct }) },
      meta: {},
    };
  },
  check(output, inst) {
    if (inst.expected.kind !== "exact") return fail();
    const parsed = extractJson(output);
    if (!parsed || typeof parsed.sql !== "string") return fail();
    let exp: { sql: string };
    try {
      const v: unknown = JSON.parse(inst.expected.value);
      if (!isObj(v) || typeof v.sql !== "string") return fail();
      exp = { sql: v.sql };
    } catch {
      return fail();
    }
    const ok = normSql(parsed.sql) === normSql(exp.sql);
    return { passed: ok, score: ok ? 1 : 0 };
  },
  renderAnswer(inst) {
    if (inst.expected.kind !== "exact") throw new Error("unexpected expected kind");
    const v: unknown = JSON.parse(inst.expected.value);
    if (!isObj(v) || typeof v.sql !== "string") throw new Error("corrupt expected");
    return canonicalize({ sql: v.sql });
  },
});

// ---------- 6. classify-support-ticket ----------

const TICKET_CATEGORIES = ["billing", "technical", "account", "feature_request"] as const;

const TICKET_BODIES: Record<(typeof TICKET_CATEGORIES)[number], (c: string, p: string) => string> = {
  billing: (c, p) =>
    `${c} here. I was charged twice for my ${p} subscription this month — please refund the duplicate charge and fix our billing.`,
  technical: (c, p) =>
    `${c} reporting: the ${p} dashboard returns a 500 error whenever I export the monthly report. This blocks our accounting.`,
  account: (c, p) =>
    `${c} cannot sign in to ${p}; the password-reset email never arrives. Please check whether our account is locked.`,
  feature_request: (c, p) =>
    `${c} suggestion for ${p}: please add SSO login for teams. Most of our staff cannot manage separate passwords.`,
};

makeTemplate("classify-support-ticket", {
  description: "Classify a support ticket into one of four fixed categories.",
  makeInstance(seed) {
    const rand = mulberry32(fnv1a(`ticket:${seed}`));
    const cat = pick(rand, TICKET_CATEGORIES);
    const customer = pick(rand, ["Ana Horvat", "Ivan Kovač", "Petra Novak", "Marko Babić"]);
    const product = pick(rand, ["MeshDesk", "LedgerApp", "PortalCRM"]);
    return {
      id: `classify-support-ticket-${seed}`,
      templateId: "classify-support-ticket",
      transformId: "identity",
      seed,
      prompt: [
        "Classify the support ticket into exactly one category:",
        `billing | technical | account | feature_request.`,
        'Respond with ONLY minified JSON: {"category": "<category>"}',
        "",
        "<ticket>",
        TICKET_BODIES[cat](customer, product),
        "</ticket>",
      ].join("\n"),
      expected: { kind: "exact", value: canonicalize({ category: cat }) },
      meta: {},
    };
  },
  check(output, inst) {
    if (inst.expected.kind !== "exact") return fail();
    const parsed = extractJson(output);
    if (!parsed || typeof parsed.category !== "string") return fail();
    let exp: { category: string };
    try {
      const v: unknown = JSON.parse(inst.expected.value);
      if (!isObj(v) || typeof v.category !== "string") return fail();
      exp = { category: v.category };
    } catch {
      return fail();
    }
    const ok = parsed.category.trim().toLowerCase() === exp.category.toLowerCase();
    return { passed: ok, score: ok ? 1 : 0 };
  },
  renderAnswer(inst) {
    if (inst.expected.kind !== "exact") throw new Error("unexpected expected kind");
    const v: unknown = JSON.parse(inst.expected.value);
    if (!isObj(v) || typeof v.category !== "string") throw new Error("corrupt expected");
    return canonicalize({ category: v.category });
  },
});
