// Run an external tool with a timeout and captured output. Never throws: a missing executable is
// code 127, a timeout is code 124 (the child is SIGKILLed), any other spawn failure is code 126.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  /** Wall-clock budget; the child is killed when it runs out. Default 15 s. */
  timeoutMs?: number;
  cwd?: string;
  /** Extra environment on top of process.env. */
  env?: Record<string, string>;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const CODE_NOT_FOUND = 127;
export const CODE_SPAWN_FAILED = 126;
export const CODE_TIMEOUT = 124;

function spawnPiped(cmd: string[], opts: ExecOptions) {
  return Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
}

export async function exec(cmd: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped([...cmd], opts);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const code = err.code === "ENOENT" ? CODE_NOT_FOUND : CODE_SPAWN_FAILED;
    return { code, stdout: "", stderr: err.message, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: timedOut ? CODE_TIMEOUT : exit, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
