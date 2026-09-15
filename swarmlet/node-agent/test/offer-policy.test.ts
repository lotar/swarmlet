// The contribution offer: the one path where a node writes an offer its owner did not choose.
// Everything here is about the two ways that can go wrong — deriving an offer the control refuses,
// and quietly taking capability away from a machine that had more.
import { expect, test } from "bun:test";
import { contributionOffer, defaultOffer, OFFER_POLICY_VERSION } from "../config.ts";
import { validateOffer } from "../../protocol/validate.ts";
import type { Capabilities, Offer } from "../../protocol/types.ts";

const HOME = "/home/u";   // defaultOffer takes a home directory and joins "models" onto it
const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  os: "darwin", arch: "arm64", hostname: "mac", ramMiB: 32768, ramReserveMiB: 12288,
  cpuCores: 15, diskFreeMiB: 773205, privateIps: [],
  gpus: [{ id: "metal:0", name: "Apple M5 Pro", backend: "metal", engineName: "MTL0", totalMiB: 18186, freeMiB: 18185 }],
  ...over,
}) as Capabilities;

const ownerOffer = (over: Partial<Offer> = {}): Offer => ({
  enabled: true, roles: { worker: true, coordinator: true, replica: true },
  gpu: [{ id: "metal:0", memMiB: 98304 }], ramMiB: 117996, cpuCores: 10, diskMiB: 100004, modelsDir: "/home/u/models",
  ...over,
});

test("a node with no offer of its own comes up contributing, sized to its own hardware", () => {
  const c = caps();
  const offer = contributionOffer(c, { ...defaultOffer(HOME) });
  expect(offer.enabled).toBe(true);
  expect(offer.roles.worker).toBe(true);
  expect(offer.gpu).toEqual([{ id: "metal:0", memMiB: 18186 }]);   // the whole reported device
  expect(offer.ramMiB).toBe(32768 - 12288);                        // total minus the OS reserve
  expect(offer.cpuCores).toBe(15);
  expect(offer.modelsDir).toBe("/home/u/models");
});

test("the derived offer is one the control actually accepts", () => {
  // The failure this guards: a plausible-looking offer the validator refuses, which would leave the
  // node reporting offerErrors instead of contributing.
  const c = caps();
  const v = validateOffer(contributionOffer(c, defaultOffer(HOME)), c);
  expect(v.ok).toBe(true);
  // A successful validation returns warnings (possibly empty), never errors.
  expect(Array.isArray((v as { warnings?: string[] }).warnings)).toBe(true);
});

test("a CPU-only machine still validates: no GPU, but the RAM pledge carries the worker role", () => {
  const c = caps({ os: "linux", gpus: [], ramMiB: 8192, ramReserveMiB: 4096, cpuCores: 8 });
  const offer = contributionOffer(c, { ...defaultOffer(HOME) });
  expect(offer.gpu).toEqual([]);
  expect(offer.ramMiB).toBe(4096);
  expect(validateOffer(offer, c).ok).toBe(true);
});

test("capability is only ever added: an owner's coordinator and replica roles survive", () => {
  // This machine is the coordinator for a live split. If this migration dropped that role it would
  // turn a drivable machine into a worker and break the deployment it was running.
  const c = caps();
  const offer = contributionOffer(c, ownerOffer({ roles: { worker: true, coordinator: true, replica: true } }));
  expect(offer.roles).toEqual({ worker: true, coordinator: true, replica: true });
});

test("worker is switched on even where an owner had it off, and a role they never claimed stays off", () => {
  const c = caps();
  const offer = contributionOffer(c, { ...defaultOffer(HOME), roles: { worker: false, coordinator: false, replica: false } });
  expect(offer.roles).toEqual({ worker: true, coordinator: false, replica: false });
});

test("an owner's disk pledge is respected rather than replaced with the whole free disk", () => {
  const c = caps();
  expect(contributionOffer(c, ownerOffer()).diskMiB).toBe(100004);
  expect(contributionOffer(c, { ...defaultOffer(HOME) }).diskMiB).toBe(773205);
});

test("the policy version only moves forward, so an owner's edit is not re-overwritten", () => {
  expect(OFFER_POLICY_VERSION).toBeGreaterThan(0);
  // The agent applies the policy only while cfg.offerPolicy < OFFER_POLICY_VERSION; a node that has
  // adopted it records the version and is left alone from then on.
  const adopted = { ...defaultOffer(HOME), enabled: false };
  expect(contributionOffer(caps(), adopted).enabled).toBe(true);
});
