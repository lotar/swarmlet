/* One response meter for both node and control chat. No credentials or HTML from telemetry. */
(function (global) {
  'use strict';
  var finite = function (n) { return typeof n === 'number' && isFinite(n) && n >= 0; };
  function stats(s, now) {
    var timing = s.timings || {}, usage = s.usage || {};
    var tokens = finite(timing.predicted_n) ? timing.predicted_n : finite(usage.completion_tokens) ? usage.completion_tokens : s.chunks;
    var exactTokens = finite(timing.predicted_n) || finite(usage.completion_tokens);
    var elapsed = s.first == null ? 0 : ((s.state === 'generating' ? now : s.last) - s.first) / 1000;
    var measured = s.state === 'complete' && finite(timing.predicted_per_second);
    var rate = measured ? timing.predicted_per_second : elapsed > 0.2 && s.chunks > 1 ? (s.chunks - 1) / elapsed : null;
    return { tokens: tokens, exactTokens: exactTokens, tps: rate, estimated: !measured };
  }
  function create(root) {
    var D = root.ownerDocument, snapshot = null, model = '', pinned = '', confirmed = false;
    var epoch = 0, request = null, problem = '', selectionKey = '', selectedDep = '', lastPaint = 0, s;
    function fresh() { return { state: 'preview', chunks: 0, first: null, last: null, timings: null, usage: null }; }
    s = fresh();
    function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function visible() { var tab = root.closest('[data-tab]'); return !D.hidden && (!tab || !tab.hidden); }
    function render() {
      var met = stats(s, performance.now()), current = s.state === 'generating';
      var title = current ? (confirmed ? 'Processing your reply' : 'Waiting for the model') : s.state === 'complete' ? 'Response complete' : s.state === 'stopped' ? 'Response stopped' : s.state === 'error' ? 'Response interrupted' : 'Your processing mesh';
      var head = el('div', 'processing-heading'); head.append(el('span', 'eyebrow', 'Response activity'), el('h2', '', title));
      var status = el('p', 'hint', snapshot ? snapshot.deployment.name + (confirmed ? ' · served this reply' : ' · selected deployment') : model ? 'Connecting to mesh telemetry…' : 'Choose a model to see its nodes.'); head.append(status);
      var meter = el('div', 'response-meter');
      var rate = el('div', 'response-rate'); rate.append(el('strong', '', met.tps == null ? '—' : (met.estimated ? '≈ ' : '') + met.tps.toFixed(1)), el('span', '', 'tok/s'));
      var detail = el('div', 'response-count'); detail.append(el('strong', '', s.state === 'preview' ? '—' : (met.exactTokens ? '' : '≈ ') + met.tokens), el('span', '', 'output tokens'));
      meter.append(rate, detail);
      var source = el('p', 'processing-source', s.state === 'preview' ? 'Throughput appears when you send a message.' : met.estimated ? 'Stream estimate · includes thinking tokens' : 'Measured by the model server');
      var children = [head, meter, source];
      if (problem) { var warning = el('p', 'processing-warning', problem); warning.setAttribute('role', 'status'); children.push(warning); }
      if (snapshot && snapshot.nodes.length) {
        var staleSnapshot = Date.now() - Date.parse(snapshot.sampledAt) > 10000;
        var frozen = ['complete', 'stopped', 'error'].indexOf(s.state) >= 0;
        var share = el('div', 'processing-share'); share.setAttribute('aria-hidden', 'true');
        snapshot.nodes.forEach(function (n) { if (finite(n.sharePct)) { var part = el('span', 'share-segment'); part.style.flexGrow = String(n.sharePct); part.title = n.name + ': ' + n.sharePct + '%'; share.append(part); } });
        children.push(el('h3', 'processing-section', 'Processing share'), share);
        var list = el('div', 'processing-nodes');
        snapshot.nodes.forEach(function (n) {
          var row = el('article', 'processing-node');
          var live = !problem && (!staleSnapshot || frozen) && n.metricsState === 'live';
          var participating = confirmed && current && live && snapshot.deployment.state === 'ready';
          row.dataset.state = participating ? 'active' : !n.online ? 'offline' : 'ready';
          var top = el('div', 'processing-node-head'), identity = el('div');
          identity.append(el('h3', '', n.name), el('span', 'hint', n.role + (n.device ? ' · ' + n.device : '')));
          top.append(identity, el('strong', 'processing-percent', finite(n.sharePct) ? Number(n.sharePct.toFixed(1)) + '%' : '—'));
          var label = el('p', 'processing-state', !n.online ? 'Offline' : !live ? 'Telemetry unavailable' : participating ? 'Participating in this reply' : frozen ? 'At reply end' : 'Ready');
          var data = el('dl', 'processing-facts');
          var values = [
            ['Assigned work', n.layers == null ? 'Whole model' : n.layers + ' / ' + snapshot.totalLayers + ' layers'],
            ['Pipeline TPS', confirmed && met.tps != null ? (met.estimated ? '≈ ' : '') + met.tps.toFixed(1) : '—'],
            ['Host CPU', live && finite(n.cpuPct) ? n.cpuPct.toFixed(0) + '%' : '—'],
            ['GPU memory used', live && finite(n.gpuUsedMiB) ? (n.gpuUsedMiB / 1024).toFixed(1) + ' GiB' : '—'],
          ];
          values.forEach(function (pair) { data.append(el('dt', '', pair[0]), el('dd', '', pair[1])); });
          row.append(top, label, data); list.append(row);
        });
        children.push(list, el('p', 'processing-footnote', 'Share is assigned model layers, not a fraction of answer text or measured compute time. These nodes work together on every token; pipeline TPS is shared.'));
      }
      root.replaceChildren.apply(root, children);
    }
    function invalidate() { epoch++; if (request) request.abort(); request = null; }
    async function refresh() {
      render();
      if (!visible() || !model || request || ['complete', 'stopped', 'error'].indexOf(s.state) >= 0) return;
      var mine = epoch, abort = new AbortController(); request = abort;
      var query = new URLSearchParams({ model: model }); if (pinned) query.set('deployment', pinned);
      try {
        var res = await fetch('/v1/mesh?' + query, { credentials: 'same-origin', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
        if (!res.ok) throw new Error('Telemetry unavailable · inference can still continue.');
        var data = await res.json();
        if (!data.deployment || !Array.isArray(data.nodes)) throw new Error('Telemetry unavailable');
        if (mine !== epoch) return;
        snapshot = data; problem = '';
      } catch (e) { if (mine === epoch && !abort.signal.aborted) problem = 'Telemetry unavailable · inference can still continue.'; }
      finally { if (mine === epoch) { request = null; render(); } }
    }
    function select(next, dep) {
      if (s.state === 'generating') return;
      var key = (next || '') + '\n' + (dep || '');
      if (selectionKey === key) return;
      selectionKey = key; selectedDep = dep || '';
      invalidate(); model = next || ''; pinned = dep || ''; confirmed = false; snapshot = null; problem = ''; s = fresh(); refresh();
    }
    function begin(next, dep) {
      selectionKey = next + '\n' + (dep || ''); selectedDep = dep || '';
      invalidate(); snapshot = null; problem = ''; model = next; pinned = dep || ''; confirmed = false; s = fresh(); s.state = 'generating'; refresh();
    }
    function served(headers) {
      var dep = headers.get('x-swarmlet-deployment');
      invalidate(); snapshot = null; pinned = dep || ''; confirmed = !!dep;
      if (!dep) { problem = 'Serving deployment was not reported.'; render(); return; }
      refresh();
    }
    function feed(payload) {
      if (s.state !== 'generating') return;
      if (payload.timings) s.timings = payload.timings;
      if (payload.usage) s.usage = payload.usage;
      var c = payload.choices && payload.choices[0], delta = c && c.delta;
      if (delta && (delta.content || delta.reasoning_content)) { var now = performance.now(); if (s.first == null) s.first = now; s.last = now; s.chunks++; }
      if (performance.now() - lastPaint >= 200) { lastPaint = performance.now(); render(); }
    }
    function finish(state) { s.state = state; render(); return stats(s, performance.now()); }
    var timer = setInterval(function () { if (visible()) refresh(); }, 2000);
    D.addEventListener('visibilitychange', function () { if (visible()) refresh(); });
    global.addEventListener('pagehide', function () { invalidate(); });
    render();
    return { select: select, begin: begin, served: served, feed: feed, finish: finish, refresh: refresh,
      reset: function () { invalidate(); s = fresh(); confirmed = false; snapshot = null; pinned = selectedDep; refresh(); },
      destroy: function () { invalidate(); clearInterval(timer); } };
  }
  global.SwarmletProcessing = { create: create, stats: stats };
}(typeof window !== 'undefined' ? window : globalThis));
