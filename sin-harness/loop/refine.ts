// loop/refine.ts — L1 knowledge-layer writes.
// Every refinement is the SMALLEST possible CRUD edit to one markdown
// artifact, committed to the knowledge git repo with a provenance message:
//
//   refine(<type>): <one-liner>
//
//   trigger: <event-id>[,<event-id>...]
//   evidence: <outcome signal>
//
// Provenance is therefore greppable in `git log` forever, revert is
// revert-by-SHA, and no custom history infrastructure exists (PRD §2 L1).

export type RefineType = "skill" | "memory";
export type RefineAction = "create" | "update" | "delete";

export interface RefinementInput {
  type: RefineType;
  action: RefineAction;
  /** Path relative to the knowledge repo root, e.g. "skills/invoice-format.md". */
  path: string;
  /** New content; required for create/update, ignored for delete. */
  content?: string;
  oneLiner: string;
  /** Event ids that motivated this edit (provenance). */
  triggers: readonly string[];
  /** Outcome signal that justifies keeping it (provenance). */
  evidence: string;
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "sin-loop",
  GIT_AUTHOR_EMAIL: "loop@sin.local",
  GIT_COMMITTER_NAME: "sin-loop",
  GIT_COMMITTER_EMAIL: "loop@sin.local",
} as const;

/** Run a git command inside the repo; throws with stderr on failure. */
export async function git(root: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_IDENTITY },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`);
  }
  return out.trim();
}

/**
 * Idempotently create the knowledge repo: git init, immutable system.md,
 * skills/ + memory/ skeletons, initial commit if the repo has no HEAD.
 * system.md is IMMUTABLE after creation — gate treats any working-tree diff
 * to it as a hard failure (see loop/gate.ts).
 */
export async function ensureKnowledgeRepo(root: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(`${root}/skills`, { recursive: true });
  await fs.mkdir(`${root}/memory`, { recursive: true });
  const sysPath = `${root}/system.md`;
  try {
    await fs.access(sysPath);
  } catch {
    await fs.writeFile(
      sysPath,
      [
        "<!-- IMMUTABLE-CORE: do not edit outside scripts/init.ts; gate rejects any diff -->",
        "# System Core",
        "",
        "Answer ONLY with minified JSON when the task specifies an envelope.",
        "Be deterministic and literal; prefer verbatim data from context.",
        "",
      ].join("\n"),
    );
  }
  await git(root, "init", "-q").catch(() => {
    /* already a repo */
  });
  const head = await git(root, "rev-parse", "--verify", "HEAD").catch(() => "");
  if (!head) {
    await git(root, "add", "-A");
    await git(
      root,
      "commit",
      "-q",
      "-m",
      "init: immutable core + empty skills/memory",
    );
  }
}

/** Exact provenance commit message (format is part of the contract). */
export function provenanceMessage(input: RefinementInput): string {
  return [
    `refine(${input.type}): ${input.oneLiner}`,
    "",
    `trigger: ${input.triggers.join(",") || "none"}`,
    `evidence: ${input.evidence}`,
  ].join("\n");
}

async function currentHead(root: string): Promise<string> {
  return git(root, "rev-parse", "HEAD");
}

/**
 * Apply one refinement as the smallest CRUD edit + one provenance commit.
 * Returns the commit SHA. If the edit produces NO diff (idempotent replay),
 * returns the existing HEAD without creating an empty commit — cron jobs can
 * be killed and retried freely (crash-only rule).
 */
export async function applyRefinement(
  root: string,
  input: RefinementInput,
): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = `${root}/${input.path}`;
  switch (input.action) {
    case "create":
    case "update": {
      if (!input.content) throw new Error(`content required for ${input.action}`);
      await fs.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
      await fs.writeFile(path, input.content);
      break;
    }
    case "delete": {
      // delete of a missing file is already satisfied — idempotent
      try {
        await fs.unlink(path);
      } catch {
        return currentHead(root);
      }
      break;
    }
  }
  await git(root, "add", "-A");
  const stagedFiles = await git(root, "diff", "--cached", "--name-only");
  if (stagedFiles === "") {
    // nothing actually changed (e.g. identical content) — no empty commit
    return currentHead(root);
  }
  await git(root, "commit", "-q", "-m", provenanceMessage(input));
  return currentHead(root);
}

/**
 * Revert-by-SHA: inverse-commits `sha` with a gate/revert provenance message.
 * Used by gate auto-revert and by humans (`git revert` stays compatible).
 */
export async function revertCommit(
  root: string,
  sha: string,
  reason: string,
): Promise<string> {
  await git(root, "revert", "--no-commit", sha);
  await git(root, "commit", "-q", "-m", `gate(revert): auto-revert ${sha} (${reason})`);
  return currentHead(root);
}

/**
 * Concatenated knowledge state AT A GIVEN COMMIT as a single system prompt:
# system.md first, then every skills/*.md and memory/*.md in stable path
 * order. Deterministic — identical shas yield byte-identical prompts, which
 * head-to-head gating depends on.
 */
export async function knowledgePromptAt(root: string, sha: string): Promise<string> {
  const listing = await git(root, "ls-tree", "-r", "--name-only", sha);
  const paths = listing
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p === "system.md" || p.startsWith("skills/") || p.startsWith("memory/"))
    .sort();
  const parts: string[] = [];
  for (const p of paths) {
    const blob = await git(root, "show", `${sha}:${p}`);
    parts.push(`<<<FILE: ${p}>>>\n${blob}\n<<<END>>>`);
  }
  return parts.join("\n");
}
