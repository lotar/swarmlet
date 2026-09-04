// Node agent UI scenario for tools/site/probe.mjs (evaluated in the page, returns a JSON summary).
// Status -> Resources (change CPU cores, save) -> Models -> Connection (measure network) -> Logs.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const tab = (name) => document.querySelector(`[role=tab][data-tab="${name}"]`).click();
  const out = { errors: [] };
  await sleep(1500);
  out.header = $("head-conn")?.textContent.trim();
  out.status = $("status-kv")?.innerText.replace(/\s+/g, " ").slice(0, 400);
  out.assignments = $("status-assignments")?.innerText.replace(/\s+/g, " ").slice(0, 200);

  tab("resources"); await sleep(1200);
  const cpuBox = $("offer-cpu");
  const inputs = cpuBox ? [...cpuBox.querySelectorAll("input")] : [];
  out.cpuInputs = inputs.map((i) => i.type);
  const want = Number(new URL(location.href).searchParams.get("cpu") || 10);
  for (const i of inputs) { i.value = String(want); i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); }
  $("offer-save")?.click();
  for (let i = 0; i < 20 && !/Saved|Not saved/.test($("offer-status")?.textContent || ""); i++) await sleep(250);
  out.saveStatus = $("offer-status")?.textContent.trim();
  out.saveErrors = $("offer-errors")?.innerText.trim();
  out.offerAfter = await (await fetch("/api/offer")).json().then((o) => ({ cpuCores: o.offer.cpuCores, ramMiB: o.offer.ramMiB, gpu: o.offer.gpu, roles: o.offer.roles, enabled: o.offer.enabled }));

  tab("models"); await sleep(1200);
  out.models = [...$("models-table").querySelectorAll("tbody tr")].length;
  out.modelsFirst = $("models-table").querySelector("tbody tr")?.innerText.replace(/\s+/g, " ").slice(0, 120);

  tab("connection"); await sleep(600);
  out.connection = $("conn-kv")?.innerText.replace(/\s+/g, " ").slice(0, 300);
  $("net-measure")?.click();
  for (let i = 0; i < 60 && !/ms|Mbit|failed|error/i.test($("net-tiles")?.innerText || ""); i++) await sleep(500);
  out.net = $("net-tiles")?.innerText.replace(/\s+/g, " ").slice(0, 200);
  out.netStatus = $("net-status")?.textContent.trim();

  tab("logs"); await sleep(1500);
  out.logLines = ($("logs-out")?.textContent || "").split("\n").filter(Boolean).length;
  tab("resources"); await sleep(500);
  return JSON.stringify(out);
})()
