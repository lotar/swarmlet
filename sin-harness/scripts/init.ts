// scripts/init.ts — one-box node bootstrap (idempotent).
// Creates: knowledge/ git repo (immutable system.md), data/keys ed25519
// keypair, data/events.sqlite event store. Safe to run repeatedly.

import { loadConfig, resolveFromRoot } from "../core/config.ts";
import { ensureKeys } from "../core/sign.ts";
import { EventStore } from "../loop/events.ts";
import { ensureKnowledgeRepo } from "../loop/refine.ts";

async function main(): Promise<void> {
  const cfg = await loadConfig(resolveFromRoot("config.json"));

  const knowledgeRoot = resolveFromRoot(cfg.paths.knowledge);
  await ensureKnowledgeRepo(knowledgeRoot);

  const keysDir = resolveFromRoot(`${cfg.paths.data}/keys`);
  await ensureKeys(keysDir);

  const dbPath = resolveFromRoot(`${cfg.paths.data}/events.sqlite`);
  const store = new EventStore(dbPath);
  store.close();

  console.log(
    JSON.stringify(
      {
        initialized: true,
        knowledgeRepo: knowledgeRoot,
        keysDir,
        eventStore: dbPath,
        baseModel: cfg.baseModel.name,
      },
      null,
      2,
    ),
  );
}

await main();
