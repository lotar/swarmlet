import { describe, expect, test } from "bun:test";
import { coordinatorArgv, replicaArgv, workerArgv } from "../roles/recipes.ts";
import { enforce } from "../enforce/index.ts";
import { makeLogger } from "../../control/log.ts";
import type { CoordinatorAssignment, WorkerAssignment } from "../../protocol/types.ts";

const fp = "b".repeat(64);
const ep = (nodeId: string, port: number) => ({ nodeId, certFp: fp, port, direct: [{ host: "192.168.1.220", port: 47801 }], relay: true });

describe("recipes", () => {
  test("worker argv matches the measured ring recipe", () => {
    const a: WorkerAssignment = { kind: "worker", id: "w", deploymentId: "d", port: 50200, device: "CUDA0", threads: 10, memCapMiB: 3700, peerPort: 50201, peers: [{ index: 1, endpoint: ep("n2", 50201) }], allow: [fp] };
    const r = workerArgv("/eng", a, [52302]);
    expect(r.argv).toEqual(["/eng/ggml-rpc-server", "-H", "127.0.0.1", "-p", "50200", "-d", "CUDA0", "-t", "10", "--mem-cap-mib", "3700", "--peer-port", "50201", "--peer", "1=127.0.0.1:52302", "-c"]);
    expect(workerArgv("/eng", { ...a, cache: false, peers: undefined, peerPort: undefined }, []).argv).not.toContain("-c");
  });

  test("coordinator argv + env reproduce the chain-4 batched-GET exact configuration", () => {
    const a: CoordinatorAssignment = {
      kind: "coordinator", id: "c", deploymentId: "d", model: { path: "/m/flash.gguf" }, rpc: [ep("n1", 50200), ep("n2", 50200)],
      devices: ["RPC0", "RPC1", "MTL0"], tensorSplit: [1, 1, 46], ctx: 1536, parallel: 3, mtp: { path: "/m/mtp.gguf", chain: 4 },
      env: { GGML_RPC_FORWARD: "1", GGML_RPC_PIPELINE: "1", GGML_SCHED_PIPELINED_COPY: "1", GGML_RPC_GET_PIPELINE: "1", GGML_RPC_WIRE: "off" },
      extraArgs: ["-ot", "ple_ngram_embd=CPU", "-fa", "on", "--cache-ram", "0", "--ctx-checkpoints", "0"], port: 8096, modelName: "qwen3.8-flash-next", allow: [],
    };
    const r = coordinatorArgv("/eng", a, [52201, 52202]);
    const s = r.argv.join(" ");
    expect(s).toContain("--rpc 127.0.0.1:52201,127.0.0.1:52202 --device RPC0,RPC1,MTL0 --tensor-split 1,1,46 -ngl 999 -c 1536 --parallel 3");
    expect(s).toContain("--spec-type draft-mtp -md /m/mtp.gguf --spec-draft-n-max 4 -ngld 999");
    expect(s).toContain("--alias qwen3.8-flash-next");
    expect(s).toContain("-ot ple_ngram_embd=CPU -fa on --cache-ram 0 --ctx-checkpoints 0");
    expect(r.env.GGML_RPC_GET_PIPELINE).toBe("1");
    expect(r.env.GGML_RPC_WIRE).toBe("off");
    expect(coordinatorArgv("/eng", { ...a, env: { GGML_RPC_WIRE: "q8" } }, [1, 2]).env.GGML_RPC_WIRE).toBe("q8");
  });

  test("replica argv", () => {
    const r = replicaArgv("/eng", { kind: "replica", id: "r", deploymentId: "d", port: 8100, model: { path: "/m/x.gguf" }, modelName: "x", ctx: 4096, parallel: 4, extraArgs: ["-fa", "on"], allow: [] });
    expect(r.argv).toEqual(["/eng/llama-server", "-m", "/m/x.gguf", "--host", "127.0.0.1", "--port", "8100", "-ngl", "999", "--metrics", "-c", "4096", "--parallel", "4", "--alias", "x", "-fa", "on"]);
  });
});

describe("enforcement", () => {
  const log = makeLogger("t", "error");
  test("linux wraps in a systemd-run scope with MemoryMax/CPUQuota; darwin returns a watchdog", async () => {
    const e = await enforce("swarmlet-test", ["/eng/x", "-p", "1"], { ramMiB: 8192, cpuCores: 6 }, log);
    if (process.platform === "linux") {
      expect(e.argv.slice(0, 2)).toEqual(["systemd-run", "--user"]);
      expect(e.argv).toContain("MemoryMax=8192M");
      expect(e.argv).toContain("CPUQuota=600%");
      expect(e.argv.slice(-3)).toEqual(["/eng/x", "-p", "1"]);
    } else {
      expect(e.argv).toEqual(["/eng/x", "-p", "1"]);
      expect(e.summary).toContain("soft rss cap 8.0 GiB");
      expect(typeof e.watch).toBe("function");
    }
  });
});
