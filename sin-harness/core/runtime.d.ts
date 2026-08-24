// Minimal ambient declarations for runtime built-ins used under the
// zero-dependency policy (no @types/bun, no @types/node installed).
// Only surfaces actually used by sin-harness are declared here.

declare namespace Bun {
  interface Server {
    readonly port: number;
    stop(closeActiveConnections?: boolean): void;
  }
  function serve(options: {
    port?: number | undefined;
    hostname?: string;
    idleTimeout?: number;
    fetch(req: Request): Response | Promise<Response>;
  }): Server;

  interface BunFile {
    text(): Promise<string>;
    json(): Promise<unknown>;
    exists(): Promise<boolean>;
  }
  function file(path: string | URL): BunFile;

  function sha256(data: string | Uint8Array): Promise<string>; // available if needed

  function write(path: string, data: string | Uint8Array): Promise<number>;
}

// Ambient stub for bun:test — the real matcher API is large; tests only use
// the registration functions and expect() (justified `any` per spec rule 5).
declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
  export function beforeAll(fn: () => unknown | Promise<unknown>): void;
  export function afterAll(fn: () => unknown | Promise<unknown>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matcher surface intentionally stubbed
  export function expect(actual: unknown): any;
}

declare var process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  argv: string[];
  pid: number;
  exit(code?: number): never;
};

declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<string | undefined>;
  export function writeFile(
    path: string,
    data: string | Uint8Array,
  ): Promise<void>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
}
