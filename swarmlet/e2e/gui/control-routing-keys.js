// Control UI: Routing tab (served models, base URL, curl example) and Keys tab (create one key).
// The key value is returned so the caller can use it for a request; it is not printed by the caller.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const out = {};
  await sleep(1200);
  document.querySelector('[role=tab][data-tab="routing"]').click(); await sleep(1500);
  out.routingBase = $("routing-base")?.textContent.trim();
  out.routingTotals = $("routing-totals")?.textContent.trim();
  out.routingRows = [...$("routing-table").querySelectorAll("tbody tr")].map((tr) => tr.innerText.replace(/\s+/g, " ").slice(0, 200));
  out.curlExample = ($("routing-curl")?.textContent || "").replace(/\s+/g, " ").slice(0, 200);
  document.querySelector('[role=tab][data-tab="keys"]').click(); await sleep(1000);
  $("key-name").value = "gui-e2e"; $("key-name").dispatchEvent(new Event("input", { bubbles: true }));
  $("key-create").click();
  for (let i = 0; i < 20 && !($("key-value")?.textContent || "").trim(); i++) await sleep(250);
  out.keyValue = ($("key-value")?.textContent || "").trim();
  out.keyStatus = $("key-status")?.textContent.trim();
  out.keysRows = [...$("keys-table").querySelectorAll("tbody tr")].length;
  return JSON.stringify(out);
})()
