// Control UI: realtime check. Starts a chat pinned to the deployment named in ?dep= (default
// mesh-2b-internet), samples the topology panel while the reply is still streaming, then switches to
// the Nodes tab mid-stream and returns its rows (tok/s and relay rates arrive over /api/stream), so a
// SHOT taken right after this expression shows the live Nodes tab.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const q = new URL(location.href).searchParams;
  const model = q.get("model") || "qwen3.5-2b";
  const dep = q.get("dep") || "mesh-2b-internet";
  const out = { model, dep };
  await sleep(1200);
  document.querySelector('[role=tab][data-tab="chat"]').click();
  for (let i = 0; i < 40 && ![...$("chat-model").options].some((o) => o.value === model); i++) await sleep(250);
  $("chat-model").value = model; $("chat-model").dispatchEvent(new Event("change"));
  await sleep(800);
  const opt = [...$("chat-dep").options].find((o) => o.textContent.includes(dep));
  if (opt) { $("chat-dep").value = opt.value; $("chat-dep").dispatchEvent(new Event("change")); await sleep(300); }
  out.depSelected = $("chat-dep").selectedOptions[0]?.textContent;
  $("chat-max").value = String(Number(q.get("max") || 200));
  $("chat-think").checked = false;
  $("chat-input").value = q.get("prompt") || "Write about 150 words on why routing model layers across the internet costs latency per token.";
  $("chat-form").dispatchEvent(new Event("submit", { cancelable: true }));
  const t0 = performance.now();
  const streamed = () => (document.querySelector("#chat-log .msg:last-child .msg-text")?.textContent || "").trim().length;
  for (let i = 0; i < 240 && !(streamed() > 0 && $("chat-send").disabled); i++) await sleep(250); // first streamed text
  out.firstTokenAfterMs = Math.round(performance.now() - t0);
  await sleep(Number(q.get("settle") || 6000));
  out.streaming = $("chat-send").disabled; out.charsSoFar = streamed();
  out.tilesMid = { tps: $("chat-tps").textContent, tpsSub: $("chat-tps-sub").textContent, tokens: $("chat-tokens").textContent, node: $("chat-node").textContent };
  out.topoTitle = $("chat-topo-title").textContent;
  out.topoNodesMid = [...document.querySelectorAll("#chat-topo-body .topo-node")].map((n) => (n.classList.contains("topo-node--served") ? "*" : "") + n.innerText.replace(/\s+/g, " ").trim());
  out.topoEdges = [...document.querySelectorAll("#chat-topo-body .topo-cap")].map((n) => n.textContent.trim());
  document.querySelector('[role=tab][data-tab="nodes"]').click(); await sleep(2500);
  out.header = (document.querySelector("header")?.innerText || "").replace(/\s+/g, " ").slice(0, 160);
  out.nodesRowsMid = [...$("nodes-table").querySelectorAll("tbody tr")].map((tr) => tr.innerText.replace(/\s+/g, " ").trim().slice(0, 260));
  out.stillStreaming = $("chat-send").disabled;
  return JSON.stringify(out);
})()
