// Where the agent keeps its state. SWARMLET_HOME overrides (tests use a temp dir).

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentPaths {
  home: string;
  configFile: string;
  keysDir: string;
  tlsDir: string;
  stateDir: string;
  logsDir: string;
  runDir: string;
}

export function agentPaths(home = process.env.SWARMLET_HOME ?? join(homedir(), ".swarmlet")): AgentPaths {
  const p: AgentPaths = {
    home,
    configFile: join(home, "node.json"),
    keysDir: join(home, "keys"),
    tlsDir: join(home, "tls"),
    stateDir: join(home, "state"),
    logsDir: join(home, "logs"),
    runDir: join(home, "run"),
  };
  for (const d of [p.home, p.keysDir, p.tlsDir, p.stateDir, p.logsDir, p.runDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return p;
}
