/** A fixed-command helper owns cooling only while this process keeps its pipe alive. */
export async function startFanLease(command: string[], readyTimeoutMs = 5000) {
  const child = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const errors = new Response(child.stderr).text().catch(() => '');
  let stopping = false;
  const ping = () => {
    if (stopping || child.exitCode !== null) return;
    try { child.stdin.write('ping\n'); void Promise.resolve(child.stdin.flush()).catch(() => undefined); } catch { /* exited helper is reported below */ }
  };
  const heartbeat = setInterval(ping, 2000);
  void child.exited.then(() => clearInterval(heartbeat));
  ping();

  async function stop() {
    stopping = true;
    clearInterval(heartbeat);
    try { child.stdin.end(); } catch { /* already closed */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {}
          reject(new Error('Fan helper did not acknowledge automatic restoration'));
        }, 12_000); }),
      ]);
      if (code !== 0) throw new Error('Fan helper exited '+code+': '+(await errors).trim().slice(0,300));
    } finally { if (timer) clearTimeout(timer); }
  }

  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Fan helper startup timed out')), readyTimeoutMs); }),
    ]);
    const text = new TextDecoder().decode(first.value).trim();
    if (first.done || text !== 'ready') throw new Error(text.slice(0,300) || (await errors).trim().slice(0,300) || 'Fan helper did not become ready');
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
  // Consume the final diagnostic, if any, without blocking normal operation.
  void (async () => {
    const drain = child.stdout.getReader();
    try { while (!(await drain.read()).done) {} }
    finally { drain.releaseLock(); }
  })().catch(() => undefined);
  return { get exitCode() { return child.exitCode; }, stop };
}
