// Control UI: Nodes tab (registry table) and a new join code. Requires loopback admin trust or a cookie.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const out = {};
  await sleep(1500);
  out.loginVisible = !$("login")?.hidden;
  out.header = $("head-text")?.textContent.trim();
  out.nodesCount = $("nodes-count")?.textContent.trim();
  out.nodeRows = [...$("nodes-table").querySelectorAll("tbody tr")].map((tr) => tr.innerText.replace(/\s+/g, " ").slice(0, 160));
  $("join-new")?.click();
  for (let i = 0; i < 20 && !($("join-code")?.textContent || "").trim(); i++) await sleep(250);
  out.joinCode = ($("join-code")?.textContent || "").trim();
  out.joinExpiry = $("join-expiry")?.textContent.trim();
  return JSON.stringify(out);
})()
