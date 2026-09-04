// Probe module: pure parsers against realistic tool output, listModels on a temp dir, measureNet
// against an in-process control stand-in, exec semantics, and a never-throws smoke run of the
// real probes on this machine.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLogger } from "../../../control/log.ts";
import {
  CODE_NOT_FOUND, CODE_SPAWN_FAILED, CODE_TIMEOUT, cpuPctBetween, exec, listModels, measureNet, median,
  modelKind, nvidiaInventory, nvidiaUsed, NVIDIA_INVENTORY_FIELDS, NVIDIA_USED_FIELDS, parseCgroupControllers, parseDfK,
  parseDisplays, parseListDevices, parseMeminfo, parseNvidiaSmi, parseProcStat, parsePsCpu, parsePsRss, parseShaManifest,
  parseVmStat, privateIps, probeCapabilities, probeMetrics, publicIp, reclaimableMiB,
} from "../index.ts";

const log = makeLogger("probe-test", "error");

describe("darwin parsers", () => {
  const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              123456.
Pages active:                            472726.
Pages inactive:                          456507.
Pages speculative:                        15400.
Pages throttled:                              0.
Pages wired down:                       6195160.
Pages purgeable:                            221.
"Translation faults":               24192193983.
Pages copy-on-write:                 1293691109.
File-backed pages:                       339742.
Anonymous pages:                         604891.
Pages stored in compressor:             3416160.
Pages occupied by compressor:           1152972.
`;
  test("vm_stat pages and the free+reclaimable gate", () => {
    const v = parseVmStat(VM_STAT);
    expect(v).toEqual({ pageSize: 16384, free: 123456, inactive: 456507, speculative: 15400, purgeable: 221, active: 472726, wired: 6195160 });
    // (123456 + 456507 + 15400 + 221) pages * 16 KiB = 9306 MiB
    expect(reclaimableMiB(v!)).toBe(9306);
  });
  test("vm_stat rejects output without the page-size header or a gated counter", () => {
    expect(parseVmStat("Pages free: 1.\n")).toBeNull();
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\n")).toBeNull();
  });
  test("system_profiler GPU entries", () => {
    const json = JSON.stringify({
      SPDisplaysDataType: [
        { _name: "Apple M5 Max", spdisplays_ndrvs: [{ _name: "Color LCD" }], spdisplays_vendor: "sppci_vendor_Apple", sppci_cores: "40", sppci_device_type: "spdisplays_gpu", sppci_model: "Apple M5 Max" },
      ],
    });
    expect(parseDisplays(json)).toEqual([{ name: "Apple M5 Max", cores: 40, vendor: "sppci_vendor_Apple" }]);
    expect(parseDisplays("not json")).toEqual([]);
    expect(parseDisplays("{}")).toEqual([]);
  });
});

describe("linux parsers", () => {
  const MEMINFO = `MemTotal:       16273424 kB
MemFree:         1073544 kB
MemAvailable:    9884036 kB
Buffers:          412000 kB
Cached:          8500000 kB
SwapCached:            0 kB
Active:          5000000 kB
Inactive:        7000000 kB
Active(anon):    3000000 kB
SwapTotal:       4194300 kB
SwapFree:        4194300 kB
SReclaimable:     600000 kB
HugePages_Total:       0
`;
  test("/proc/meminfo with MemAvailable", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ memTotalKiB: 16273424, memFreeKiB: 1073544, memAvailableKiB: 9884036, swapTotalKiB: 4194300, swapFreeKiB: 4194300 });
  });
  test("/proc/meminfo approximates MemAvailable on old kernels", () => {
    const old = MEMINFO.split("\n").filter((l) => !l.startsWith("MemAvailable")).join("\n");
    expect(parseMeminfo(old)?.memAvailableKiB).toBe(1073544 + 412000 + 8500000 + 600000);
    expect(parseMeminfo("garbage")).toBeNull();
  });
  test("nvidia-smi csv rows, inventory and usage", () => {
    const inv = parseNvidiaSmi("0, NVIDIA GeForce GTX 1650 Ti, 3906, 3796\n1, NVIDIA RTX A6000, 49140, 48000\n\n", NVIDIA_INVENTORY_FIELDS);
    expect(inv).toHaveLength(2);
    expect(inv[0]).toEqual({ index: "0", name: "NVIDIA GeForce GTX 1650 Ti", "memory.total": "3906", "memory.free": "3796" });
    expect(nvidiaInventory(inv)).toEqual([
      { id: "cuda:0", name: "NVIDIA GeForce GTX 1650 Ti", backend: "cuda", engineName: "CUDA0", totalMiB: 3906, freeMiB: 3796 },
      { id: "cuda:1", name: "NVIDIA RTX A6000", backend: "cuda", engineName: "CUDA1", totalMiB: 49140, freeMiB: 48000 },
    ]);
    // a comma inside the name is re-joined; [N/A] memory drops the device
    const odd = parseNvidiaSmi("0, Weird, Name GPU, 1024, 1000\n1, Tesla, [N/A], [N/A]\n", NVIDIA_INVENTORY_FIELDS);
    expect(odd[0]?.name).toBe("Weird, Name GPU");
    expect(nvidiaInventory(odd).map((g) => g.id)).toEqual(["cuda:0"]);
    expect(nvidiaUsed(parseNvidiaSmi("0, 110\n1, 1024\n", NVIDIA_USED_FIELDS))).toEqual([{ id: "cuda:0", usedMiB: 110 }, { id: "cuda:1", usedMiB: 1024 }]);
  });
  test("/proc/stat cpu percent between two samples", () => {
    const a = parseProcStat("cpu  100 0 50 800 20 5 5 0 0 0\ncpu0 50 0 25 400 10 2 2 0 0 0\n");
    const b = parseProcStat("cpu  200 0 100 900 20 10 10 0 0 0\ncpu0 100 0 50 450 10 5 5 0 0 0\n");
    expect(a).toEqual({ idle: 820, total: 980 });
    expect(b).toEqual({ idle: 920, total: 1240 });
    expect(cpuPctBetween(a!, b!)).toBe(61.5);
    expect(cpuPctBetween(b!, a!)).toBeUndefined();
    expect(parseProcStat("intr 1 2 3")).toBeNull();
  });
  test("cgroup.controllers of the user slice", () => {
    expect(parseCgroupControllers("cpu memory pids\n")).toEqual({ memory: true, cpu: true });
    expect(parseCgroupControllers("pids\n")).toEqual({ memory: false, cpu: false });
    expect(parseCgroupControllers("")).toEqual({ memory: false, cpu: false });
  });
});

describe("engine parsers", () => {
  test("--list-devices on darwin: Metal kept, BLAS skipped", () => {
    const out = "Available devices:\n  MTL0: Apple M5 Max (98304 MiB, 98304 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n";
    expect(parseListDevices(out)).toEqual([{ id: "metal:0", name: "Apple M5 Max", backend: "metal", engineName: "MTL0", totalMiB: 98304, freeMiB: 98304 }]);
  });
  test("--list-devices on linux: CUDA kept, CPU/RPC/noise skipped, other backends tagged", () => {
    const out = `ggml_cuda_init: GGML_CUDA_FORCE_MMQ:    no
ggml_cuda_init: found 1 CUDA devices:
  Device 0: NVIDIA GeForce GTX 1650 Ti, compute capability 7.5, VMM: yes
Available devices:
  CUDA0: NVIDIA GeForce GTX 1650 Ti (3706 MiB, 3596 MiB free)
  Vulkan0: Intel(R) Arc(TM) A770 Graphics (16225 MiB, 15000 MiB free)
  CPU: AMD Ryzen 5 4600H with Radeon Graphics (0 MiB, 0 MiB free)
  RPC0[192.168.1.243:50052]: RPC[192.168.1.243:50052] (3706 MiB, 3596 MiB free)
`;
    expect(parseListDevices(out)).toEqual([
      { id: "cuda:0", name: "NVIDIA GeForce GTX 1650 Ti", backend: "cuda", engineName: "CUDA0", totalMiB: 3706, freeMiB: 3596 },
      { id: "vulkan:0", name: "Intel(R) Arc(TM) A770 Graphics", backend: "other", engineName: "Vulkan0", totalMiB: 16225, freeMiB: 15000 },
    ]);
    expect(parseListDevices("")).toEqual([]);
  });
  test("sha256 manifest", () => {
    const text = "45314237c2c5c3ec5ae5203ab7dc404c33baaaa1484006ebd17fc0bab7ba42fe  ggml-rpc-server\n5F5CFC8B10BA9AE6A662CDB91FA16F85EBE792600DD5934A7AB F061FD7DAC28E  bad\n60cd1f7ff9b951dad9b4a15310d2479ff4ec86a96a10568645375277fb8f08db *llama-ring-bench\n";
    expect(parseShaManifest(text)).toEqual({
      "ggml-rpc-server": "45314237c2c5c3ec5ae5203ab7dc404c33baaaa1484006ebd17fc0bab7ba42fe",
      "llama-ring-bench": "60cd1f7ff9b951dad9b4a15310d2479ff4ec86a96a10568645375277fb8f08db",
    });
  });
});

describe("host parsers", () => {
  test("df -k (macOS, inode columns) and df -kP (linux)", () => {
    const mac = `Filesystem   1024-blocks       Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s5  1948404040 1700063708 196066552    90% 4730054 1960665520    0%   /System/Volumes/Data
`;
    expect(parseDfK(mac)).toEqual({ filesystem: "/dev/disk3s5", totalMiB: 1902738, usedMiB: 1660218, availableMiB: 191471, mount: "/System/Volumes/Data" });
    const linux = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/nvme0n1p2   490691512 174049476 291640500      38% /
`;
    expect(parseDfK(linux)?.availableMiB).toBe(284805);
    expect(parseDfK(linux)?.mount).toBe("/");
    const spaced = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk4s1 1000000 500000 500000 50% /Volumes/My Disk\n";
    expect(parseDfK(spaced)).toEqual({ filesystem: "/dev/disk4s1", totalMiB: 976, usedMiB: 488, availableMiB: 488, mount: "/Volumes/My Disk" });
    expect(parseDfK("Filesystem 1024-blocks Used Available Capacity Mounted on\n")).toBeNull();
  });
  test("ps columns", () => {
    expect(parsePsCpu("  0.6\n  0.7\n  0.0\n 12.5\n")).toBeCloseTo(13.8);
    expect(parsePsRss(" 12256\n  3184\n")).toBe(15440);
    expect(parsePsRss("")).toBe(0);
  });
  test("private IPv4s: LAN first, loopback and link-local dropped, deduped", () => {
    const ifaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }, { address: "::1", family: "IPv6", internal: true }],
      utun3: [{ address: "100.64.0.5", family: "IPv4", internal: false }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
      en0: [{ address: "192.168.1.53", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
      en1: [{ address: "192.168.1.53", family: "IPv4", internal: false }],
      awdl0: [{ address: "169.254.10.1", family: "IPv4", internal: false }],
      empty: undefined,
    };
    expect(privateIps(ifaces)).toEqual(["172.17.0.1", "192.168.1.53", "100.64.0.5"]);
  });
  test("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe("exec", () => {
  test("missing executable is 127, a directory is 126, exit codes and output pass through", async () => {
    expect((await exec(["/nonexistent/bin/llama-server", "--list-devices"])).code).toBe(CODE_NOT_FOUND);
    expect((await exec(["not-a-command-swarmlet-xyz"])).code).toBe(CODE_NOT_FOUND);
    expect((await exec([tmpdir()])).code).toBe(CODE_SPAWN_FAILED);
    const r = await exec(["sh", "-c", "echo out; echo err 1>&2; exit 3"]);
    expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });
  test("timeout kills the child and reports 124", async () => {
    const t0 = performance.now();
    const r = await exec(["sleep", "10"], { timeoutMs: 150 });
    expect(r.code).toBe(CODE_TIMEOUT);
    expect(r.timedOut).toBe(true);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe("listModels", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarmlet-models-"));
  beforeAll(() => {
    writeFileSync(join(dir, "Qwen3.6-35B-Q4_K_M.gguf"), "hello");
    writeFileSync(join(dir, "Qwen3.6-35B-MTP-Q8_0.gguf"), Buffer.alloc(3000, 1));
    writeFileSync(join(dir, "mmproj-Qwen3.6.GGUF"), "x");
    writeFileSync(join(dir, "README.md"), "not a model");
    mkdirSync(join(dir, "folder.gguf"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("kinds", () => {
    expect(modelKind("Qwen3.6-35B-A3B-Q4_K_M.gguf")).toBe("gguf");
    expect(modelKind("Qwen3.6-35B-A3B-mtp-Q8_0.gguf")).toBe("mtp");
    expect(modelKind("mmproj-model-f16.gguf")).toBe("mmproj");
  });
  test("non-recursive *.gguf scan sorted by name, sizes, no hash by default", async () => {
    const models = await listModels(dir);
    expect(models.map((m) => [m.name, m.kind, m.sizeBytes, m.sha256])).toEqual([
      ["Qwen3.6-35B-MTP-Q8_0.gguf", "mtp", 3000, undefined],
      ["Qwen3.6-35B-Q4_K_M.gguf", "gguf", 5, undefined],
      ["mmproj-Qwen3.6.GGUF", "mmproj", 1, undefined],
    ]);
    expect(models[0]?.path).toBe(join(dir, "Qwen3.6-35B-MTP-Q8_0.gguf"));
  });
  test("hash option streams sha256", async () => {
    const models = await listModels(dir, { hash: true });
    expect(models.find((m) => m.sizeBytes === 5)?.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(models.every((m) => /^[0-9a-f]{64}$/.test(m.sha256 ?? ""))).toBe(true);
  });
  test("missing dir or a plain file is empty", async () => {
    expect(await listModels(join(dir, "nope"))).toEqual([]);
    expect(await listModels(join(dir, "README.md"))).toEqual([]);
  });
});

describe("measureNet", () => {
  const seen = { down: 0, up: 0, health: 0 };
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") { seen.health++; return Response.json({ status: "ok", nodes: 0 }); }
        if (url.pathname === "/probe/down") {
          const n = Number(url.searchParams.get("bytes") ?? "0");
          seen.down = n;
          return new Response(new Uint8Array(n), { headers: { "content-type": "application/octet-stream" } });
        }
        if (url.pathname === "/probe/up" && req.method === "POST") {
          seen.up = (await req.arrayBuffer()).byteLength;
          return Response.json({ bytes: seen.up });
        }
        if (url.pathname === "/probe/ip") return Response.json({ ip: "203.0.113.7" });
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}/`;
  });
  afterAll(() => server.stop(true));

  test("rtt median, down/up throughput and public ip against control", async () => {
    const n = await measureNet(base, { bytes: 1_000_000 });
    expect(n.rttMs).toBeGreaterThanOrEqual(0);
    expect(n.rttMs).toBeLessThan(1000);
    expect(n.downMbit).toBeGreaterThan(0);
    expect(n.upMbit).toBeGreaterThan(0);
    expect(Date.parse(n.measuredAt)).toBeGreaterThan(0);
    expect(seen).toEqual({ health: 5, down: 1_000_000, up: 1_000_000 });
    expect(await publicIp(base)).toBe("203.0.113.7");
  });
  test("unreachable control: measureNet rejects, publicIp is undefined", async () => {
    await expect(measureNet("http://127.0.0.1:1", { bytes: 10 })).rejects.toThrow(/unreachable/);
    expect(await publicIp("http://127.0.0.1:1")).toBeUndefined();
  });
  test("a control without /probe endpoints still yields rtt; the throughput legs are left out", async () => {
    const healthOnly = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/health" ? Response.json({ status: "ok" }) : new Response("no", { status: 404 })) });
    try {
      const n = await measureNet(`http://127.0.0.1:${healthOnly.port}`, { bytes: 10, samples: 3 });
      expect(n.rttMs).toBeGreaterThanOrEqual(0);
      expect(n.downMbit).toBeUndefined();
      expect(n.upMbit).toBeUndefined();
      expect(await publicIp(`http://127.0.0.1:${healthOnly.port}`)).toBeUndefined();
    } finally { healthOnly.stop(true); }
  });
});

describe("live probes on this machine", () => {
  test("probeCapabilities never throws without an engine and reports the OS basics", async () => {
    const caps = await probeCapabilities({ enginePath: join(tmpdir(), "swarmlet-no-engine-here"), log });
    expect(["darwin", "linux"]).toContain(caps.os);
    expect(["arm64", "x64"]).toContain(caps.arch);
    expect(caps.hostname.length).toBeGreaterThan(0);
    expect(caps.ramMiB).toBeGreaterThan(1024);
    expect(caps.ramReserveMiB).toBe(caps.os === "darwin" ? 12288 : 4096);
    expect(caps.cpuCores).toBeGreaterThan(0);
    expect(Array.isArray(caps.gpus)).toBe(true);
    for (const g of caps.gpus) expect(g.totalMiB).toBeGreaterThan(0);
    expect(caps.diskFreeMiB).toBeGreaterThan(0);
    expect(caps.privateIps.every((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))).toBe(true);
    expect(caps.engine).toBeUndefined();
    expect(caps.net).toBeUndefined();
    expect(caps.cgroup !== undefined).toBe(caps.os === "linux");
    expect(Date.parse(caps.measuredAt)).toBeGreaterThan(0);
  }, 30_000);

  test("probeCapabilities with an unreachable control omits net and publicIp", async () => {
    const caps = await probeCapabilities({ enginePath: join(tmpdir(), "swarmlet-no-engine-here"), controlUrl: "http://127.0.0.1:1", log });
    expect(caps.net).toBeUndefined();
    expect(caps.publicIp).toBeUndefined();
    expect(caps.ramMiB).toBeGreaterThan(1024);
  }, 30_000);

  const enginePath = join(import.meta.dir, "../../../engine/dist", process.platform);
  test.if(existsSync(join(enginePath, "llama-server")))("probeCapabilities with the shipped engine lists its devices and hashes", async () => {
    const caps = await probeCapabilities({ enginePath, log });
    expect(caps.gpus.length).toBeGreaterThan(0);
    expect(caps.gpus[0]?.engineName).toMatch(/^(MTL|CUDA)\d+$/);
    expect(caps.engine?.proto).toBe("8.1");
    expect(caps.engine?.sha256["llama-server"]).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  test("probeMetrics reports rss of this process, free RAM and cpu", async () => {
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    // a pid that already exited and one that cannot exist must not poison the ps batch
    const m = await probeMetrics({ pids: [process.pid, gone.pid, 999_999_999], gpus: [], sampleMs: 200, log });
    expect(Date.parse(m.ts)).toBeGreaterThan(0);
    expect(m.rssMiB).toBeGreaterThan(0);
    expect(m.freeRamMiB).toBeGreaterThan(0);
    expect(m.cpuPct).toBeGreaterThanOrEqual(0);
    expect(m.cpuPct).toBeLessThanOrEqual(100);
    expect(m.gpu).toBeUndefined();
    expect((await probeMetrics({ gpus: [], sampleMs: 50, log })).rssMiB).toBeUndefined();
  }, 15_000);
});
