// Control UI: Chat tab. Picks the model from ?model= (default qwen3.8-flash-next), sends one message,
// waits for the streamed reply to finish, reads the stats tiles, then reads the Nodes tab tok/s cells.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const q = new URL(location.href).searchParams;
  const model = q.get("model") || "qwen3.8-flash-next";
  const prompt = q.get("prompt") || "In three short sentences, explain what a mesh of consumer machines can do for AI inference.";
  const out = { model };
  await sleep(1200);
  document.querySelector('[role=tab][data-tab="chat"]').click();
  for (let i = 0; i < 40 && ![...$("chat-model").options].some((o) => o.value === model); i++) await sleep(250);
  out.models = [...$("chat-model").options].map((o) => o.value);
  $("chat-model").value = model; $("chat-model").dispatchEvent(new Event("change"));
  await sleep(800);
  out.depOptions = [...$("chat-dep").options].map((o) => (o.selected ? "*" : "") + o.textContent);
  $("chat-max").value = String(Number(q.get("max") || 160));
  $("chat-think").checked = q.get("think") === "1";
  $("chat-input").value = prompt;
  $("chat-form").dispatchEvent(new Event("submit", { cancelable: true }));
  const t0 = performance.now();
  for (let i = 0; i < 480 && $("chat-send").disabled; i++) await sleep(250); // up to 2 min
  out.waitedMs = Math.round(performance.now() - t0);
  out.sendEnabledAgain = !$("chat-send").disabled;
  const msgs = [...document.querySelectorAll("#chat-log .msg")];
  out.messages = msgs.length;
  out.reply = (msgs[msgs.length - 1]?.querySelector(".msg-text")?.textContent || "").slice(0, 400);
  out.replyMeta = msgs[msgs.length - 1]?.querySelector(".msg-meta")?.textContent;
  out.tiles = { tps: $("chat-tps").textContent, tpsSub: $("chat-tps-sub").textContent, tokens: $("chat-tokens").textContent, tokensSub: $("chat-tokens-sub").textContent, ttft: $("chat-ttft").textContent, node: $("chat-node").textContent, dep: $("chat-dep").textContent, session: $("chat-session").textContent };
  out.status = $("chat-status").textContent;
  out.topoTitle = $("chat-topo-title").textContent;
  out.topoNodes = [...document.querySelectorAll("#chat-topo-body .topo-node")].map((n) => (n.classList.contains("topo-node--served") ? "*" : "") + n.innerText.replace(/\s+/g, " ").trim());
  out.topoEdges = [...document.querySelectorAll("#chat-topo-body .topo-cap")].map((n) => n.textContent.trim());
  out.topoNotes = ($("chat-topo-body").querySelector(".topo-notes")?.innerText || "").replace(/\s+/g, " ").slice(0, 500);
  document.querySelector('[role=tab][data-tab="nodes"]').click(); await sleep(1500);
  out.nodesTps = [...$("nodes-table").querySelectorAll("tbody tr")].map((tr) => { const tds = tr.querySelectorAll("td"); return `${tds[0]?.innerText.split("\n")[0]}: ${tds[6]?.innerText.replace(/\s+/g, " ")}`; });
  document.querySelector('[role=tab][data-tab="chat"]').click(); await sleep(600);
  return JSON.stringify(out);
})()
