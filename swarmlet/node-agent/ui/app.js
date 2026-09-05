/* Swarmlet node agent UI. Five tabs over the agent's local JSON API; no build step, no dependencies. */
(function () {
  'use strict';

  var D = document;
  var POLL_MS = 3000;
  var GIB = 1024;          /* MiB per GiB: the API speaks MiB, the owner reads GiB */
  var NA = '—';

  /* ---------- DOM helpers ---------- */
  function $(id) { return D.getElementById(id); }

  function el(tag, attrs, children) {
    var node = D.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    });
    return append(node, children);
  }

  function append(node, children) {
    if (children == null) return node;
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' ? D.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function replace(node, children) { return append(clear(node), children); }

  function kv(pairs) {
    var out = [];
    pairs.forEach(function (p) {
      if (!p) return;
      out.push(el('dt', { text: p[0] }));
      out.push(el('dd', null, p[1] == null || p[1] === '' ? NA : p[1]));
    });
    return out;
  }

  function tile(label, value, unit, sub) {
    return el('div', { class: 'tile' }, [
      el('span', { class: 'label', text: label }),
      el('div', { class: 'value' }, [String(value), unit ? el('small', { text: unit }) : null]),
      sub ? el('div', { class: 'sub', text: sub }) : null,
    ]);
  }

  function badge(state) {
    state = String(state || 'unknown');
    return el('span', { class: 'badge', 'data-state': state.replace(/\s+/g, '-'), text: state });
  }

  /* Cell content sits in one wrapper so the card layout on small screens has exactly label + value. */
  function td(content, cls, title) { return el('td', { class: cls, title: title }, el('div', { class: 'cell' }, content)); }

  /* Fill a table body; each cell gets its column header as data-th for the card layout on small screens. */
  function setRows(table, rows, emptyText) {
    var heads = [].map.call(table.tHead.rows[0].cells, function (th) { return th.textContent; });
    if (!rows.length) rows = [el('tr', { class: 'empty' }, el('td', { colspan: String(heads.length), text: emptyText }))];
    else rows.forEach(function (tr) { [].forEach.call(tr.cells, function (cell, i) { cell.setAttribute('data-th', heads[i] || ''); }); });
    replace(table.tBodies[0], rows);
  }

  function note(id, text, kind) {
    var n = $(id);
    n.textContent = text || '';
    n.className = 'form-status' + (kind ? ' is-' + kind : '');
  }

  function listMsgs(id, items) {
    var n = $(id);
    items = items || [];
    replace(n, items.map(function (m) { return el('li', { text: String(m) }); }));
    n.hidden = !items.length;
  }

  /* ---------- formatting ---------- */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, digits) { return isNum(v) ? v.toFixed(digits) : NA; }
  function trim(v) { return String(Math.round(v * 100) / 100); }
  function fmtGiB(mib, digits) { return isNum(mib) ? (mib / GIB).toFixed(digits == null ? 1 : digits) : NA; }
  function bytesGiB(bytes) { return isNum(bytes) ? (bytes / (GIB * GIB * GIB)).toFixed(2) : NA; }
  function shortId(id) { return id ? String(id).slice(0, 8) : NA; }
  function shortFp(fp) { return fp ? String(fp).slice(0, 16) + '…' : NA; }
  function hostOf(url) { try { return new URL(url).host; } catch (_) { return url || ''; } }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function ago(iso) {
    if (!iso) return NA;
    var s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return NA;
    if (s < 0) s = 0;
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  function clock(date) {
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return two(date.getHours()) + ':' + two(date.getMinutes()) + ':' + two(date.getSeconds());
  }

  /* ---------- API ---------- */
  function api(method, path, body) {
    var init = { method: method, headers: {} };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        if (text) { try { data = JSON.parse(text); } catch (_) { data = { error: text.slice(0, 200) }; } }
        if (!res.ok) {
          var err = new Error(data.error || (data.errors && data.errors.join('; ')) || ('HTTP ' + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------- tabs ---------- */
  var TABS = ['status', 'resources', 'models', 'connection', 'logs'];
  var active = 'status';

  function showTab(name) {
    if (TABS.indexOf(name) < 0) name = 'status';
    active = name;
    TABS.forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    [].forEach.call(D.querySelectorAll('.tabs [role="tab"]'), function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === name ? 'true' : 'false');
    });
    if (history.replaceState) history.replaceState(null, '', '#' + name);
    if (name === 'resources' && !offer.loaded) loadOffer();
    if (name === 'models' && !models.loaded) loadModels();
    if (name === 'logs') loadLogs();
  }

  [].forEach.call(D.querySelectorAll('.tabs [role="tab"]'), function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });

  /* ---------- header ---------- */
  function renderHead(s) {
    var dot = $('head-dot'), txt = $('head-conn');
    if (s.connected) { dot.setAttribute('data-state', 'on'); txt.textContent = 'connected to ' + hostOf(s.controlUrl); }
    else if (s.controlUrl) { dot.setAttribute('data-state', 'warn'); txt.textContent = 'not connected to ' + hostOf(s.controlUrl); }
    else { dot.setAttribute('data-state', 'off'); txt.textContent = 'not joined to a control plane'; }
  }

  /* ---------- status tab ---------- */
  function roleList(o) {
    if (!o || !o.roles) return [];
    return ['worker', 'coordinator', 'replica'].filter(function (r) { return o.roles[r]; });
  }

  function gpuUsed(metrics, id) {
    var hit = metrics && metrics.gpu ? metrics.gpu.filter(function (g) { return g.id === id; })[0] : null;
    return hit ? hit.usedMiB : null;
  }

  function renderStatus(s) {
    var caps = s.caps || {};
    var m = s.metrics;
    var roles = roleList(s.offer);
    replace($('status-kv'), kv([
      ['Connection', badge(s.connected ? 'connected' : (s.controlUrl ? 'disconnected' : 'not joined'))],
      ['Control', s.controlUrl],
      ['Node id', s.nodeId],
      ['Certificate', el('span', { title: s.certFp || '', text: shortFp(s.certFp) })],
      ['Agent', (s.agentVersion || NA) + ' on ' + (s.hostname || caps.hostname || NA) + (caps.os ? ' (' + caps.os + ' ' + caps.arch + ')' : '')],
      ['Offer', s.enabled ? (roles.length ? 'enabled: ' + roles.join(', ') : 'enabled, no roles') : 'disabled'],
    ]));

    var tiles = [
      tile('Free RAM', fmtGiB(m && m.freeRamMiB), 'GiB', 'of ' + fmtGiB(caps.ramMiB) + ' GiB total'),
      tile('CPU', num(m && m.cpuPct, 0), '%', caps.cpuCores ? caps.cpuCores + ' cores' : ''),
    ];
    (caps.gpus || []).forEach(function (g) {
      tiles.push(tile(g.name || g.id, fmtGiB(gpuUsed(m, g.id)), 'GiB used', 'of ' + fmtGiB(g.totalMiB) + ' GiB on ' + g.id));
    });
    if (m && (m.serving || m.serverMetricsState)) {
      var sampleAt = Date.parse(m.serverMetricsTs || m.ts);
      var fresh = sampleAt && Date.now() - sampleAt <= 10000;
      var available = fresh && (!m.serverMetricsState || m.serverMetricsState === 'ok');
      var busy = available && isNum(m.inflight) && m.inflight > 0;
      var measured = available && isNum(m.tokPerSec) && m.tokPerSec > 0;
      var hint = !fresh ? 'stale engine sample' : !available ? m.serverMetricsState + ' engine metrics' : measured ? 'completed-token interval' : busy ? 'active · decode rate unavailable' : m.inflight === 0 ? 'idle at engine sample' : 'activity unknown';
      tiles.push(tile('Throughput', measured ? num(m.tokPerSec, 1) : available && m.inflight === 0 ? '0.0' : NA, 'tok/s', hint));
      tiles.push(tile('In flight', available && isNum(m.inflight) ? m.inflight : NA, 'requests', available ? 'engine sample' : hint));
    }
    tiles.push(tile('Agent RSS', fmtGiB(m && m.rssMiB, 2), 'GiB', m ? 'sampled ' + ago(m.ts) : 'no sample yet'));
    replace($('status-metrics'), tiles);

    var errs = s.offerErrors || [];
    replace($('status-offer-errors'), [el('strong', { text: 'The offer needs attention' }), el('ul', null, errs.map(function (e) { return el('li', { text: e }); }))]);
    $('status-offer-errors').hidden = !errs.length;

    setRows($('status-assignments'), (s.assignments || []).map(function (a) {
      var ports = a.ports ? Object.keys(a.ports).map(function (k) { return k + ':' + a.ports[k]; }).join(' ') : '';
      return el('tr', null, [
        td(shortId(a.id), 'mono', a.id),
        td(a.kind),
        td(shortId(a.deploymentId), 'mono', a.deploymentId),
        td(badge(a.state)),
        td(a.detail || '', 'small'),
        td(ports, 'mono small'),
      ]);
    }), 'No assignments. This node is idle.');
  }

  /* ---------- resources tab ---------- */
  var offer = { loaded: false, limits: null, gpuRows: [], ram: null, cpu: null };

  function rangeRow(opt) {
    var slider = el('input', { type: 'range', min: '0', max: String(opt.max), step: String(opt.step), 'aria-label': opt.label });
    var number = el('input', { type: 'number', min: '0', max: String(opt.max), step: String(opt.step), inputmode: 'decimal', 'aria-label': opt.label + ' value' });
    var measured = el('span', { class: 'measured' });
    slider.value = number.value = trim(clamp(opt.value || 0, 0, opt.max));
    slider.addEventListener('input', function () { number.value = slider.value; });
    number.addEventListener('input', function () { var v = parseFloat(number.value); if (isFinite(v)) slider.value = String(clamp(v, 0, opt.max)); });
    number.addEventListener('change', function () { var v = clamp(parseFloat(number.value) || 0, 0, opt.max); number.value = trim(v); slider.value = String(v); });
    var node = el('div', { class: 'range-row' }, [
      el('div', { class: 'range-head' }, [
        el('span', { class: 'range-label' }, [opt.label, opt.sub ? el('small', { text: opt.sub }) : null]),
        measured,
      ]),
      slider,
      el('div', { class: 'num-wrap' }, [number, el('span', { class: 'unit', text: opt.unit + ' of ' + trim(opt.max) })]),
    ]);
    return { node: node, measured: measured, value: function () { return clamp(parseFloat(number.value) || 0, 0, opt.max); } };
  }

  function loadOffer() {
    note('offer-status', 'Loading…');
    return api('GET', '/api/offer').then(renderResources).catch(function (e) { note('offer-status', e.message, 'error'); });
  }

  function renderResources(data) {
    var o = data.offer || {};
    var limits = data.limits || { ramMaxMiB: 0, cpuMax: 0, gpus: [] };
    offer.loaded = true;
    offer.limits = limits;
    $('offer-enabled').checked = !!o.enabled;
    ['worker', 'coordinator', 'replica'].forEach(function (r) { $('role-' + r).checked = !!(o.roles && o.roles[r]); });

    var gpuBox = clear($('offer-gpus'));
    offer.gpuRows = (limits.gpus || []).map(function (g) {
      var cur = (o.gpu || []).filter(function (x) { return x.id === g.id; })[0];
      var row = rangeRow({ label: g.name || g.id, sub: g.id, max: g.totalMiB / GIB, step: 0.25, unit: 'GiB', value: (cur ? cur.memMiB : 0) / GIB });
      gpuBox.appendChild(row.node);
      return { id: g.id, row: row };
    });
    if (!offer.gpuRows.length) gpuBox.appendChild(el('p', { class: 'hint', text: 'No GPU detected. A worker on this node would use RAM only.' }));

    offer.ram = rangeRow({ label: 'RAM', sub: 'excluding the OS reserve', max: limits.ramMaxMiB / GIB, step: 0.25, unit: 'GiB', value: (o.ramMiB || 0) / GIB });
    replace($('offer-ram'), offer.ram.node);
    offer.cpu = rangeRow({ label: 'CPU cores', max: limits.cpuMax, step: 1, unit: 'cores', value: o.cpuCores || 0 });
    replace($('offer-cpu'), offer.cpu.node);
    $('offer-disk').value = trim((o.diskMiB || 0) / GIB);
    $('offer-models-dir').value = o.modelsDir || '';

    updateMeasured(data.caps);
    listMsgs('offer-errors', []);
    listMsgs('offer-warnings', []);
    note('offer-status', '');
  }

  /* Measured totals next to each control; refreshed from every status poll without touching the inputs. */
  function updateMeasured(capsIn) {
    if (!offer.loaded) return;
    var s = state.status || {};
    var caps = capsIn || s.caps || {};
    var m = s.metrics;
    offer.gpuRows.forEach(function (g) {
      var dev = (caps.gpus || []).filter(function (d) { return d.id === g.id; })[0];
      g.row.measured.textContent = 'measured ' + fmtGiB(dev && dev.totalMiB) + ' GiB total, ' + fmtGiB(gpuUsed(m, g.id)) + ' GiB in use now';
    });
    offer.ram.measured.textContent = 'measured ' + fmtGiB(caps.ramMiB) + ' GiB total, OS reserve ' + fmtGiB(caps.ramReserveMiB) + ' GiB, ' + fmtGiB(m && m.freeRamMiB) + ' GiB free now';
    offer.cpu.measured.textContent = 'measured ' + (caps.cpuCores || NA) + ' cores, ' + num(m && m.cpuPct, 0) + ' % busy now';
    $('offer-disk-measured').textContent = fmtGiB(caps.diskFreeMiB) + ' GiB free';
  }

  function toMiB(gib) { return Math.round(gib * GIB); }

  function readOffer() {
    return {
      enabled: $('offer-enabled').checked,
      roles: { worker: $('role-worker').checked, coordinator: $('role-coordinator').checked, replica: $('role-replica').checked },
      gpu: offer.gpuRows.map(function (g) { return { id: g.id, memMiB: toMiB(g.row.value()) }; }),
      ramMiB: toMiB(offer.ram.value()),
      cpuCores: Math.round(offer.cpu.value()),
      diskMiB: toMiB(Math.max(0, parseFloat($('offer-disk').value) || 0)),
      modelsDir: $('offer-models-dir').value.trim(),
    };
  }

  function saveOffer(ev) {
    ev.preventDefault();
    if (!offer.loaded) return;
    var btn = $('offer-save');
    btn.disabled = true;
    note('offer-status', 'Saving…');
    api('PUT', '/api/offer', readOffer()).then(function (r) {
      listMsgs('offer-errors', []);
      listMsgs('offer-warnings', r.warnings);
      note('offer-status', 'Saved' + (r.warnings && r.warnings.length ? ' with warnings' : ''), 'ok');
      tick();
    }).catch(function (e) {
      listMsgs('offer-errors', (e.data && e.data.errors) || [e.message]);
      listMsgs('offer-warnings', []);
      note('offer-status', 'Not saved', 'error');
    }).then(function () { btn.disabled = false; });
  }

  function setEnabled() {
    var on = $('offer-enabled').checked;
    note('enabled-status', on ? 'Enabling…' : 'Disabling…');
    api('POST', '/api/enabled', { enabled: on }).then(function () {
      note('enabled-status', on ? 'Enabled: the node accepts assignments.' : 'Disabled: the node only reports.', 'ok');
      tick();
    }).catch(function (e) {
      $('offer-enabled').checked = !on;
      note('enabled-status', e.message, 'error');
    });
  }

  $('offer-form').addEventListener('submit', saveOffer);
  $('offer-reload').addEventListener('click', function () { loadOffer(); });
  $('offer-enabled').addEventListener('change', setEnabled);

  /* ---------- models tab ---------- */
  var models = { loaded: false };

  function renderModels(data) {
    models.loaded = true;
    if (data.modelsDir) $('models-dir').textContent = data.modelsDir;
    var list = data.models || [];
    setRows($('models-table'), list.map(function (f) {
      return el('tr', null, [
        td(f.name, 'mono', f.path),
        td(badge(f.kind)),
        td(bytesGiB(f.sizeBytes), 'num'),
        td(f.sha256 ? f.sha256.slice(0, 12) + '…' : 'not hashed', 'mono dim', f.sha256 || ''),
      ]);
    }), 'No model files in the models directory.');
    note('models-status', list.length + (list.length === 1 ? ' file' : ' files'));
  }

  function loadModels() {
    note('models-status', 'Loading…');
    return api('GET', '/api/models').then(renderModels).catch(function (e) { note('models-status', e.message, 'error'); });
  }

  $('models-rescan').addEventListener('click', function () {
    var btn = $('models-rescan');
    btn.disabled = true;
    note('models-status', 'Scanning…');
    api('POST', '/api/models/rescan').then(renderModels).catch(function (e) { note('models-status', e.message, 'error'); }).then(function () { btn.disabled = false; });
  });

  /* ---------- connection tab ---------- */
  function renderConnection(s) {
    replace($('conn-kv'), kv([
      ['State', badge(s.connected ? 'connected' : (s.controlUrl ? 'disconnected' : 'not joined'))],
      ['Control URL', s.controlUrl],
      ['Node id', s.nodeId],
      ['Certificate', s.certFp],
    ]));
    var url = $('join-url');
    if (!url.value && s.controlUrl && D.activeElement !== url) url.value = s.controlUrl;
    renderNet(newerNet(s.net, state.lastNet));
  }

  /* The status poll carries the agent's last measurement; a fresh one from the button wins until it is older. */
  function newerNet(a, b) {
    if (!a) return b;
    if (!b) return a;
    return Date.parse(b.measuredAt || 0) > Date.parse(a.measuredAt || 0) ? b : a;
  }

  function renderNet(net) {
    if (!net) { replace($('net-tiles'), el('div', { class: 'tile' }, [el('span', { class: 'label', text: 'Network' }), el('div', { class: 'sub', text: 'Not measured yet.' })])); return; }
    var when = net.measuredAt ? 'measured ' + ago(net.measuredAt) : 'measured';
    replace($('net-tiles'), [
      tile('Round trip', num(net.rttMs, 0), 'ms', when),
      tile('Upload', num(net.upMbit, 0), 'Mbit/s', when),
      tile('Download', num(net.downMbit, 0), 'Mbit/s', when),
    ]);
  }

  $('join-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var controlUrl = $('join-url').value.trim();
    var code = $('join-code').value.trim().toUpperCase();
    if (!controlUrl || !code) { listMsgs('join-errors', ['Control URL and join code are both required.']); return; }
    var btn = $('join-submit');
    btn.disabled = true;
    listMsgs('join-errors', []);
    note('join-status', 'Joining…');
    api('POST', '/api/join', { controlUrl: controlUrl, code: code }).then(function (r) {
      note('join-status', 'Joined as ' + (r.nodeId || 'this node') + '. Connecting…', 'ok');
      $('join-code').value = '';
      tick();
    }).catch(function (e) {
      listMsgs('join-errors', [e.message]);
      note('join-status', 'Join failed', 'error');
    }).then(function () { btn.disabled = false; });
  });

  $('net-measure').addEventListener('click', function () {
    var btn = $('net-measure');
    btn.disabled = true;
    note('net-status', 'Measuring… this takes a few seconds');
    api('POST', '/api/net/measure').then(function (net) {
      state.lastNet = net;
      renderNet(net);
      note('net-status', 'Measured at ' + clock(new Date()), 'ok');
    }).catch(function (e) { note('net-status', e.message, 'error'); }).then(function () { btn.disabled = false; });
  });

  /* ---------- logs tab ---------- */
  function updateLogSources(s) {
    var sel = $('logs-source');
    var cur = sel.value;
    var list = s.assignments || [];
    var wanted = [''].concat(list.map(function (a) { return a.id; }));
    var have = [].map.call(sel.options, function (o) { return o.value; });
    if (wanted.join('\n') === have.join('\n')) return;
    replace(sel, [el('option', { value: '', text: 'Agent log' })].concat(list.map(function (a) {
      return el('option', { value: a.id, text: a.kind + ' ' + shortId(a.id) + ' (' + a.state + ')' });
    })));
    sel.value = wanted.indexOf(cur) >= 0 ? cur : '';
  }

  function loadLogs() {
    var id = $('logs-source').value;
    var out = $('logs-out');
    api('GET', '/api/logs?lines=200' + (id ? '&assignment=' + encodeURIComponent(id) : '')).then(function (r) {
      var lines = r.lines || [];
      out.textContent = lines.length ? lines.join('\n') : '(no output yet)';
      if ($('logs-follow').checked) out.scrollTop = out.scrollHeight;
      note('logs-status', lines.length + ' lines, updated ' + clock(new Date()));
    }).catch(function (e) { note('logs-status', e.message, 'error'); });
  }

  $('logs-source').addEventListener('change', loadLogs);

  /* ---------- polling ---------- */
  var state = { status: null, lastNet: null };

  function tick() {
    return api('GET', '/api/status').then(function (s) {
      state.status = s;
      $('agent-error').hidden = true;
      renderHead(s);
      renderStatus(s);
      renderConnection(s);
      updateLogSources(s);
      updateMeasured();
      if (active === 'logs') loadLogs();
    }).catch(function (e) {
      $('agent-error').textContent = 'Cannot reach the agent: ' + e.message;
      $('agent-error').hidden = false;
      $('head-dot').setAttribute('data-state', 'err');
      $('head-conn').textContent = 'agent unreachable';
    });
  }

  showTab((location.hash || '#status').slice(1));
  tick();
  setInterval(tick, POLL_MS);
}());
