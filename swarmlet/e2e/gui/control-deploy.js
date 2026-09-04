// Control UI: Deployments tab -> New -> fill the split form -> Preview plan -> Create (starts) ->
// wait for ready -> details drawer. Picks the coordinator/worker options by hostname substring.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const q = new URL(location.href).searchParams;
  const name = q.get("name") || "gui-2b";
  const out = { name };
  await sleep(1200);
  document.querySelector('[role=tab][data-tab="deployments"]').click(); await sleep(1000);
  $("dep-toggle").click(); await sleep(1500);
  const setSel = (id, pred) => { const s = $(id); const o = [...s.options].find(pred); if (!o) return null; s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return o.textContent.trim(); };
  out.kind = setSel("dep-kind", (o) => o.value === "split");
  await sleep(300);
  out.profile = setSel("dep-profile", (o) => /qwen35-2b|Qwen3\.5-2B/i.test(o.value + " " + o.textContent));
  out.coordinator = setSel("dep-node", (o) => /Lotars|MBP|m5/i.test(o.textContent));
  const w = $("dep-workers"); let picked = [];
  for (const o of w.options) { o.selected = /legion/i.test(o.textContent); if (o.selected) picked.push(o.textContent.trim()); }
  w.dispatchEvent(new Event("change", { bubbles: true }));
  out.workers = picked;
  $("dep-name").value = name; $("dep-ctx").value = "2048"; $("dep-parallel").value = "1"; $("dep-chain").value = "0";
  for (const id of ["dep-name", "dep-ctx", "dep-parallel", "dep-chain"]) $(id).dispatchEvent(new Event("input", { bubbles: true }));
  $("dep-preview").click();
  for (let i = 0; i < 40 && !/Plan preview|No plan|Check the form/.test($("dep-preview-out").innerText); i++) await sleep(250);
  out.preview = $("dep-preview-out").innerText.replace(/\s+/g, " ").slice(0, 700);
  $("dep-create").click();
  for (let i = 0; i < 40 && !/Started|Not created|Created but/.test($("dep-form-status").textContent); i++) await sleep(250);
  out.formStatus = $("dep-form-status").textContent.trim();
  let row = null;
  for (let i = 0; i < 160; i++) {
    row = [...$("dep-table").querySelectorAll("tbody tr")].find((tr) => tr.innerText.includes(name));
    const t = row ? row.innerText : "";
    if (/\bready\b|\bfailed\b/.test(t)) break;
    await sleep(250);
  }
  out.row = row ? row.innerText.replace(/\s+/g, " ").slice(0, 300) : "row not found";
  await sleep(500);
  out.drawerTitle = $("drawer-title")?.textContent.trim();
  out.drawer = ($("drawer-body")?.innerText || "").replace(/\s+/g, " ").slice(0, 900);
  return JSON.stringify(out);
})()
