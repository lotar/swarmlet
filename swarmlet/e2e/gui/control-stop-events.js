// Control UI: stop a deployment by name from the table (confirm() auto-accepted), wait for stopped,
// then read the Events tab.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const name = new URL(location.href).searchParams.get("name") || "gui-2b";
  const out = { name };
  window.confirm = () => true;
  await sleep(1200);
  document.querySelector('[role=tab][data-tab="deployments"]').click(); await sleep(1200);
  const findRow = () => [...$("dep-table").querySelectorAll("tbody tr")].find((tr) => tr.innerText.includes(name));
  let row = findRow();
  out.before = row ? row.innerText.replace(/\s+/g, " ").slice(0, 200) : "row not found";
  const stop = row && [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Stop");
  out.stopEnabled = !!stop && !stop.disabled;
  if (stop && !stop.disabled) stop.click();
  for (let i = 0; i < 160; i++) { row = findRow(); if (row && /\bstopped\b/.test(row.innerText)) break; await sleep(250); }
  out.after = row ? row.innerText.replace(/\s+/g, " ").slice(0, 200) : "row not found";
  out.depStatus = $("dep-status")?.textContent.trim();
  document.querySelector('[role=tab][data-tab="events"]').click(); await sleep(1500);
  out.events = [...$("events-table").querySelectorAll("tbody tr")].slice(0, 8).map((tr) => tr.innerText.replace(/\s+/g, " ").slice(0, 160));
  return JSON.stringify(out);
})()
