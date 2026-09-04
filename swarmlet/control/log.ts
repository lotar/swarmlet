// Tiny leveled logger shared by control and agent code (stderr, one line per event, no secrets).

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function makeLogger(scope: string, level: Level = "info") {
  const min = ORDER[level];
  const emit = (lvl: Level, msg: string, extra?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const ts = new Date().toISOString().slice(11, 23);
    const tail = extra ? " " + JSON.stringify(extra) : "";
    console.error(`${ts} ${lvl.padEnd(5)} [${scope}] ${msg}${tail}`);
  };
  return {
    debug: (m: string, e?: Record<string, unknown>) => emit("debug", m, e),
    info: (m: string, e?: Record<string, unknown>) => emit("info", m, e),
    warn: (m: string, e?: Record<string, unknown>) => emit("warn", m, e),
    error: (m: string, e?: Record<string, unknown>) => emit("error", m, e),
  };
}
export type Logger = ReturnType<typeof makeLogger>;
