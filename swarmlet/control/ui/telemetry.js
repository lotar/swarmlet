/* Read-only history over the existing authenticated admin API. */
(function () {
  'use strict';
  var D = document, $ = function (id) { return D.getElementById(id); }, current = null, pending = null, last = 0, generation = 0;
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function number(value, digits) { return typeof value === 'number' && isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits == null ? 1 : digits }) : '—'; }
  function bytes(value) { return value >= 1000000000 ? number(value / 1000000000, 2) + ' GB' : number(value / 1000000, 1) + ' MB'; }
  function date(value) { return value == null ? 'No data yet' : new Date(value).toLocaleString(); }
  function tile(label, value, detail) { var box = el('article', 'telemetry-tile'); box.append(el('p', 'eyebrow', label), el('strong', '', value), el('p', 'hint', detail)); return box; }
  function row(label, value) { var pair = el('div', 'telemetry-fact'); pair.append(el('dt', '', label), el('dd', '', value)); return pair; }
  function details(title, data) { var box = el('details', 'telemetry-details'); box.append(el('summary', '', title), el('pre', '', JSON.stringify(data, null, 2))); return box; }
  function draw() {
    var root = $('telemetry-chart'); root.replaceChildren();
    if (!current) return;
    var metric = $('telemetry-metric').value, series = current.series, available = series.filter(function (r) { return typeof r[metric] === 'number'; });
    var hint = $('telemetry-chart-hint');
    hint.textContent = 'Average per ' + number(current.bucketMs / 1000, 0) + '-second bucket. Missing measurements stay unknown. Hover a point for its time and value.';
    if (!available.length) { root.append(el('p', 'telemetry-empty', 'No measurements for this metric and time range yet.')); return; }
    var ns = 'http://www.w3.org/2000/svg', svg = D.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 1000 250'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', $('telemetry-metric').selectedOptions[0].textContent + ', ' + available.length + ' measured time buckets');
    var peak = Math.max.apply(null, available.map(function (p) { return p[metric]; })), ceiling = Math.max(1, peak * 1.1), start = current.from, duration = Math.max(1, current.to - start);
    function point(p) { return [65 + (p.at - start) / duration * 910, 210 - p[metric] / ceiling * 180]; }
    for (var i = 0; i <= 3; i++) {
      var y = 210 - i * 60, grid = D.createElementNS(ns, 'line'); grid.setAttribute('x1', '65'); grid.setAttribute('x2', '975'); grid.setAttribute('y1', y); grid.setAttribute('y2', y); grid.setAttribute('class', 'telemetry-gridline'); svg.append(grid);
      var label = D.createElementNS(ns, 'text'); label.setAttribute('x', '55'); label.setAttribute('y', y + 4); label.setAttribute('text-anchor', 'end'); label.textContent = number(ceiling * i / 3); svg.append(label);
    }
    var path = '', previous = null;
    series.forEach(function (p) { if (typeof p[metric] !== 'number') { previous = null; return; } var xy = point(p); path += (!previous || p.at - previous.at > current.bucketMs * 1.5 ? 'M' : 'L') + xy[0] + ',' + xy[1]; previous = p; });
    var line = D.createElementNS(ns, 'path'); line.setAttribute('d', path); line.setAttribute('class', 'telemetry-line'); svg.append(line);
    available.forEach(function (p) { var xy = point(p), dot = D.createElementNS(ns, 'circle'); dot.setAttribute('cx', xy[0]); dot.setAttribute('cy', xy[1]); dot.setAttribute('r', available.length > 100 ? '1.5' : '3'); dot.setAttribute('class', 'telemetry-dot'); var title = D.createElementNS(ns, 'title'); title.textContent = date(p.at) + ' · ' + number(p[metric]); dot.append(title); svg.append(dot); });
    [current.from, current.to].forEach(function (at, index) { var t = D.createElementNS(ns, 'text'); t.setAttribute('x', index ? '975' : '65'); t.setAttribute('y', '240'); t.setAttribute('text-anchor', index ? 'end' : 'start'); t.textContent = new Date(at).toLocaleString([], Object.assign({ hour: '2-digit', minute: '2-digit' }, duration >= 86400000 ? { month: 'short', day: 'numeric' } : {})); svg.append(t); });
    root.append(svg);
  }
  function render(data) {
    current = data;
    var old = $('telemetry-node').value, select = $('telemetry-node');
    // Keep the complete selector while viewing one node, so a refresh does not erase alternatives.
    if (!old) {
      select.replaceChildren(); var all = el('option', '', 'All nodes'); all.value = ''; select.append(all);
      data.sources.forEach(function (s) { var option = el('option', '', s.source + ' · ' + s.latest.os); option.value = s.source; select.append(option); });
    }
    var count = data.sources.reduce(function (n, s) { return n + s.samples; }, 0), r = data.requests;
    $('telemetry-summary').replaceChildren(tile('Samples', number(count, 0), number(data.sources.length, 0) + ' nodes in this range'), tile('Responses', number(r.count, 0), number(r.errors, 0) + ' errors · ' + number(r.cancelled, 0) + ' cancelled'), tile('Response duration', number(r.averageDurationMs) + ' ms', 'Mean · max ' + number(r.maxDurationMs) + ' ms'), tile('First response byte', number(r.averageFirstByteMs) + ' ms', 'Mean · includes headers-to-body wait; not first-token latency'));
    var nodes = $('telemetry-sources'); nodes.replaceChildren();
    if (!data.sources.length) nodes.append(el('p', 'telemetry-empty', 'No node samples in this range. Connected nodes send metrics every two seconds.'));
    data.sources.forEach(function (s) {
      var sample = s.latest, v = sample.values, fresh = data.to - s.at < 15000 && typeof v.sampleAgeMs === 'number' && v.sampleAgeMs < 15000;
      var card = el('article', 'telemetry-node'), head = el('div', 'telemetry-node-heading');
      head.append(el('h3', '', s.source), el('span', 'telemetry-badge' + (fresh ? ' is-live' : ''), fresh ? 'Recent sample' : 'Historical'));
      var facts = el('dl', 'telemetry-facts');
      facts.append(row('Host CPU', number(v.cpuPct) + ' %'), row('Agent + engines RAM', number(v.rssMiB) + ' MiB'), row('GPU memory used', number(v.gpuUsedMiB) + ' MiB'), row('Free host RAM', number(v.freeRamMiB) + ' MiB'), row('Controller RTT', number(v.rttMs) + ' ms'), row('Completed-token rate', number(v.tokPerSec) + ' tok/s'), row('Maximum temperature', number(v.temperatureC) + ' °C'), row('Maximum fan speed', number(v.fanRpm, 0) + ' RPM'));
      card.append(head, el('p', 'hint', sample.os + ' / ' + sample.arch + ' · ' + date(s.at) + ' · ' + number(s.samples, 0) + ' samples'), facts,
        details('All sensors, capacity and runtime', sample)); nodes.append(card);
    });
    var records = $('telemetry-records'); records.replaceChildren();
    data.recent.forEach(function (r) { records.append(details(date(r.at) + ' · ' + r.kind + ' · ' + r.source, r.data)); });
    if (!data.recent.length) records.append(el('p', 'telemetry-empty', 'No matching records yet.'));
    var retention = data.retention, storage = $('telemetry-storage'); storage.replaceChildren();
    var meter = el('progress'); meter.max = retention.maxBytes; meter.value = retention.bytes; meter.setAttribute('aria-label', 'Telemetry storage used');
    storage.append(el('h2', '', 'Retention'), el('p', '', bytes(retention.bytes) + ' of ' + bytes(retention.maxBytes) + ' · ' + number(retention.records, 0) + ' retained records'), meter,
      el('p', 'hint', 'Oldest first: up to 72 hours or 2 GB, whichever limit is reached first. Disk usage includes SQLite files, indexes and the anonymous-ID key; journal space is reserved.'),
      el('p', 'hint', 'Oldest record: ' + date(retention.oldestAt) + ' · ' + number(retention.dropped, 0) + ' dropped since this controller started.'));
    $('telemetry-error').hidden = !retention.error; $('telemetry-error').textContent = retention.error || '';
    draw();
  }
  function refresh(force) {
    if (D.hidden || $('tab-telemetry').hidden) return Promise.resolve();
    if (pending) return pending;
    if (!force && Date.now() - last < 10000) return Promise.resolve();
    var mine = generation, url = '/api/telemetry?range=' + encodeURIComponent($('telemetry-range').value);
    if ($('telemetry-node').value) url += '&node=' + encodeURIComponent($('telemetry-node').value);
    $('telemetry-refresh').disabled = true;
    pending = window.SwarmletAdmin.api('GET', url).then(function (data) { if (mine === generation) { render(data); last = Date.now(); } })
      .catch(function (error) { if (mine === generation) { $('telemetry-error').textContent = error.message; $('telemetry-error').hidden = false; } })
      .finally(function () { pending = null; $('telemetry-refresh').disabled = false; if (mine !== generation) refresh(true); });
    return pending;
  }
  ['telemetry-range', 'telemetry-node'].forEach(function (id) { $(id).addEventListener('change', function () { generation++; last = 0; refresh(true); }); });
  $('telemetry-metric').addEventListener('change', draw);
  $('telemetry-refresh').addEventListener('click', function () { last = 0; refresh(true); });
  window.SwarmletTelemetry = { refresh: refresh };
}());
