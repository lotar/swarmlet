/* Swarmlet control UI. Five tabs over the admin JSON API; the admin cookie comes from POST /login.
   No build step, no dependencies. */
(function () {
  'use strict';

  var D = document;
  var POLL_MS = 3000;
  var GIB = 1024;          /* MiB per GiB: the API speaks MiB, people read GiB */
  var NA = '—';
  var TABS = ['nodes', 'chat', 'deployments', 'routing', 'events', 'keys'];
  var STARTABLE = ['planned', 'stopped', 'failed'];
  var STOPPABLE = ['placing', 'loading', 'ready'];

  var state = {
    authed: false, active: 'nodes', whoami: null,
    nodes: [], deployments: [], events: [],
    profiles: null, profilesFailed: false,
    joinCode: null, drawer: { id: null, logsId: null },
  };

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

  function badge(s) {
    s = String(s || 'unknown');
    return el('span', { class: 'badge', 'data-state': s.replace(/\s+/g, '-'), text: s });
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

  function buildTable(heads, rows, emptyText) {
    var table = el('table', { class: 'data' }, [
      el('thead', null, el('tr', null, heads.map(function (h) { return el('th', { text: h }); }))),
      el('tbody'),
    ]);
    setRows(table, rows, emptyText);
    return el('div', { class: 'table-wrap' }, table);
  }

  function note(id, text, kind) {
    var n = $(id);
    n.textContent = text || '';
    n.className = 'form-status' + (kind ? ' is-' + kind : '');
  }

  function showError(e) {
    var box = $('app-error');
    box.textContent = e && e.message ? e.message : String(e);
    box.hidden = false;
  }

  function copyText(text, btn) {
    function done(ok) {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () { btn.textContent = old; }, 1500);
    }
    function fallback() {
      var ta = el('textarea', { readonly: true, 'aria-hidden': 'true' });
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      D.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = D.execCommand('copy'); } catch (_) { ok = false; }
      D.body.removeChild(ta);
      return ok;
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback()); });
    } else done(fallback());
  }

  /* ---------- formatting ---------- */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, digits) { return isNum(v) ? v.toFixed(digits) : NA; }
  function fmtGiB(mib, digits) { return isNum(mib) ? (mib / GIB).toFixed(digits == null ? 1 : digits) : NA; }
  function shortId(id) { return id ? String(id).slice(0, 8) : NA; }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function clock(d) { return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); }

  function when(iso) {
    if (!iso) return NA;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var sameDay = d.toDateString() === new Date().toDateString();
    return (sameDay ? '' : two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ') + clock(d);
  }

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

  function nodeById(id) { return state.nodes.filter(function (n) { return n.id === id; })[0] || null; }
  function nodeName(id) { var n = nodeById(id); return n ? n.hostname : shortId(id); }
  function depById(id) { return state.deployments.filter(function (d) { return d.id === id; })[0] || null; }
  function depName(id) { var d = depById(id); return d && d.spec && d.spec.name ? d.spec.name : shortId(id); }
  function roleList(o) { return o && o.roles ? ['worker', 'coordinator', 'replica'].filter(function (r) { return o.roles[r]; }) : []; }

  /* ---------- API + login ---------- */
  function api(method, path, body) {
    var init = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        if (text) { try { data = JSON.parse(text); } catch (_) { data = { error: text.slice(0, 200) }; } }
        if (res.status === 401) showLogin();
        if (!res.ok) {
          var msg = data.error && data.error.message ? data.error.message : data.error;
          var err = new Error(msg || (data.errors && data.errors.join('; ')) || ('HTTP ' + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function showLogin() {
    if (!state.authed && !$('login').hidden) return;
    state.authed = false;
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-token').focus();
  }

  function hideLogin() {
    state.authed = true;
    $('login').hidden = true;
    $('app').hidden = false;
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var form = ev.target;
    note('login-status', 'Signing in…');
    fetch('/login', { method: 'POST', body: new FormData(form), credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) { note('login-status', res.status === 401 ? 'Wrong token' : 'HTTP ' + res.status, 'error'); return; }
      form.reset();
      note('login-status', '');
      boot();
    }).catch(function (e) { note('login-status', e.message, 'error'); });
  });

  /* ---------- tabs ---------- */
  function showTab(name) {
    if (TABS.indexOf(name) < 0) name = 'nodes';
    state.active = name;
    TABS.forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    [].forEach.call(D.querySelectorAll('.tabs [role="tab"]'), function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === name ? 'true' : 'false');
    });
    if (history.replaceState) history.replaceState(null, '', '#' + name);
    if (name === 'deployments') ensureProfiles();
    if (name === 'keys') loadKeys().catch(showError);
    if (name === 'chat') loadChatModels().catch(showError);
    tick();
  }

  [].forEach.call(D.querySelectorAll('.tabs [role="tab"]'), function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });

  /* ---------- nodes ---------- */
  function loadNodes() {
    return api('GET', '/api/nodes').then(function (r) { state.nodes = r.nodes || []; renderNodes(); });
  }

  function offerSummary(o) {
    if (!o) return el('span', { class: 'dim', text: 'no offer yet' });
    var gpuMiB = (o.gpu || []).reduce(function (s, g) { return s + (g.memMiB || 0); }, 0);
    var roles = roleList(o);
    return [
      el('div', { class: 'mono', text: 'GPU ' + fmtGiB(gpuMiB) + ' GiB, RAM ' + fmtGiB(o.ramMiB) + ' GiB, ' + (o.cpuCores || 0) + ' cores' }),
      el('div', { class: o.enabled ? '' : 'dim', text: o.enabled ? (roles.length ? roles.join(', ') : 'enabled, no roles') : 'disabled by the owner' }),
    ];
  }

  function netSummary(net) {
    if (!net) return el('span', { class: 'dim', text: 'not measured' });
    return ['rtt ' + num(net.rttMs, 0) + ' ms', el('br'), 'up ' + num(net.upMbit, 0) + ' / down ' + num(net.downMbit, 0) + ' Mbit'];
  }

  function servedModels(nodeId) {
    var names = {};
    (state.deployments || []).forEach(function (d) { if (d.state === 'ready' && d.endpoint && d.endpoint.nodeId === nodeId) names[d.endpoint.modelName] = 1; });
    return Object.keys(names);
  }

  function tpsCell(m, routed, models) {
    var serving = (models && models.length) ? models.join(', ') : (m && m.serving);
    if (!serving && !(isNum(routed) && routed > 0)) return el('span', { class: 'dim', text: NA });
    var live = isNum(routed) && routed > 0 ? routed : (m && isNum(m.tokPerSec) ? m.tokPerSec : 0);
    var sub = live > 0 ? (isNum(routed) && routed > 0 ? 'streaming now' : 'last interval') : 'idle';
    if (serving) sub += ' \u00b7 ' + serving;
    if (m && isNum(m.tokPerSecAvg) && m.tokPerSecAvg > 0) sub += ' \u00b7 avg ' + m.tokPerSecAvg.toFixed(1);
    return [el('span', { class: live > 0 ? 'strong tps-live' : 'dim', text: live.toFixed(1) }), el('br'), el('span', { class: 'dim small', text: sub })];
  }

  function metricsSummary(m) {
    if (!m) return el('span', { class: 'dim', text: 'no metrics yet' });
    var gpuUsed = (m.gpu || []).reduce(function (s, g) { return s + (g.usedMiB || 0); }, 0);
    return [
      'free RAM ' + fmtGiB(m.freeRamMiB) + ' GiB', el('br'),
      'GPU used ' + (m.gpu && m.gpu.length ? fmtGiB(gpuUsed) + ' GiB' : NA) + ', CPU ' + num(m.cpuPct, 0) + ' %', el('br'),
      el('span', { class: 'dim', text: ago(m.ts) }),
    ];
  }

  function renderNodes() {
    var online = state.nodes.filter(function (n) { return n.online; }).length;
    $('nodes-count').textContent = state.nodes.length + (state.nodes.length === 1 ? ' node, ' : ' nodes, ') + online + ' online';
    $('head-text').textContent = online + ' of ' + state.nodes.length + ' nodes online';
    $('head-dot').setAttribute('data-state', online ? 'on' : 'off');
    setRows($('nodes-table'), state.nodes.map(function (n) {
      var caps = n.caps || {};
      return el('tr', null, [
        td([el('div', { class: 'strong', text: n.hostname }), el('div', { class: 'dim small mono', text: (n.os || NA) + ' ' + (n.arch || '') + (n.agentVersion ? ', agent ' + n.agentVersion : '') })]),
        td(shortId(n.id), 'mono', n.id),
        td([badge(n.online ? 'online' : 'offline'), n.online ? null : el('div', { class: 'dim small', text: n.lastSeen ? 'seen ' + ago(n.lastSeen) : 'never seen' })]),
        td(offerSummary(n.offer), 'small'),
        td(netSummary(caps.net), 'mono small'),
        td(metricsSummary(n.metrics), 'mono small'),
        td(tpsCell(n.metrics, n.routedTokPerSec, servedModels(n.id)), 'num mono'),
        td(String((n.models || []).length), 'num'),
      ]);
    }), 'No nodes yet. Create a join code and enter it in a node agent.');
    fillNodeSelects();
  }

  function renderJoinCode() {
    var jc = state.joinCode;
    $('join-box').hidden = !jc;
    if (!jc) return;
    $('join-code').textContent = jc.code;
    var left = Math.round((Date.parse(jc.expiresAt) - Date.now()) / 1000);
    if (left > 0) note('join-expiry', 'Expires in ' + Math.floor(left / 60) + ':' + two(left % 60) + ', single use');
    else note('join-expiry', 'Expired. Create a new one.', 'error');
    var url = state.whoami && state.whoami.publicUrl ? state.whoami.publicUrl : location.origin;
    $('join-hint').textContent = 'On the node: open its agent UI at http://127.0.0.1:47800, Connection tab, control URL ' + url + ', then this code.';
  }

  $('join-new').addEventListener('click', function () {
    var btn = $('join-new');
    btn.disabled = true;
    note('join-status', 'Creating…');
    api('POST', '/api/join-codes').then(function (r) {
      state.joinCode = r;
      note('join-status', '');
      renderJoinCode();
    }).catch(function (e) { note('join-status', e.message, 'error'); }).then(function () { btn.disabled = false; });
  });
  $('join-copy').addEventListener('click', function () { if (state.joinCode) copyText(state.joinCode.code, $('join-copy')); });

  /* ---------- deployments: list + actions ---------- */
  function loadDeployments() {
    return api('GET', '/api/deployments').then(function (r) { state.deployments = r.deployments || []; renderDeployments(); });
  }

  function renderDeployments() {
    var list = state.deployments;
    var ready = list.filter(function (d) { return d.state === 'ready'; }).length;
    $('dep-count').textContent = list.length + (list.length === 1 ? ' deployment, ' : ' deployments, ') + ready + ' ready';
    setRows($('dep-table'), list.map(function (d) {
      var s = d.spec || {};
      var what = s.kind === 'external' ? (s.external && s.external.modelName) : s.profile;
      return el('tr', null, [
        td([el('div', { class: 'strong', text: s.name || d.id }), el('div', { class: 'dim small mono', text: shortId(d.id) + ', ' + (s.kind || NA) + ', ' + (what || NA) })]),
        td(badge(d.state)),
        td(d.endpoint ? [d.endpoint.modelName, el('br'), nodeName(d.endpoint.nodeId) + ':' + d.endpoint.port] : el('span', { class: 'dim', text: NA }), 'mono small'),
        td(d.error ? el('span', { class: 'err', title: d.error, text: d.error.length > 90 ? d.error.slice(0, 90) + '…' : d.error }) : '', 'small'),
        td(ago(d.updatedAt), 'dim small', d.updatedAt),
        td(el('div', { class: 'actions' }, [
          el('button', { class: 'button button--small', type: 'button', text: 'Details', onclick: function () { openDrawer(d.id); } }),
          el('button', { class: 'button button--small', type: 'button', text: 'Start', disabled: STARTABLE.indexOf(d.state) < 0, onclick: function () { act(d, 'start'); } }),
          el('button', { class: 'button button--small', type: 'button', text: 'Stop', disabled: STOPPABLE.indexOf(d.state) < 0, onclick: function () { act(d, 'stop'); } }),
          el('button', { class: 'button button--small button--danger', type: 'button', text: 'Delete', onclick: function () { act(d, 'delete'); } }),
        ])),
      ]);
    }), 'No deployments yet.');
  }

  function act(d, what) {
    var name = (d.spec && d.spec.name) || shortId(d.id);
    if (what !== 'start' && !window.confirm((what === 'delete' ? 'Delete' : 'Stop') + ' deployment "' + name + '"?')) return;
    note('dep-status', what + 'ing ' + name + '…');
    var p = what === 'delete' ? api('DELETE', '/api/deployments/' + encodeURIComponent(d.id)) : api('POST', '/api/deployments/' + encodeURIComponent(d.id) + '/' + what);
    p.then(function () {
      note('dep-status', name + ': ' + what + ' accepted', 'ok');
      if (what === 'delete' && state.drawer.id === d.id) closeDrawer();
      return loadDeployments();
    }).catch(function (e) { note('dep-status', name + ': ' + e.message, 'error'); });
  }

  /* ---------- deployments: details drawer ---------- */
  function openDrawer(id) {
    state.drawer.id = id;
    state.drawer.logsId = null;
    $('drawer-logs').hidden = true;
    $('drawer-logs-title').hidden = true;
    $('drawer').hidden = false;
    $('drawer-backdrop').hidden = false;
    $('drawer-title').textContent = depName(id);
    replace($('drawer-body'), el('p', { class: 'hint', text: 'Loading…' }));
    loadDrawer().catch(function (e) { note('drawer-status', e.message, 'error'); });
  }

  function closeDrawer() {
    state.drawer.id = null;
    state.drawer.logsId = null;
    $('drawer').hidden = true;
    $('drawer-backdrop').hidden = true;
  }

  function loadDrawer() {
    var id = state.drawer.id;
    if (!id) return Promise.resolve();
    return api('GET', '/api/deployments/' + encodeURIComponent(id)).then(function (d) {
      if (state.drawer.id !== id) return;
      renderDrawer(d);
      note('drawer-status', 'updated ' + clock(new Date()));
      if (state.drawer.logsId) return loadDrawerLogs();
    });
  }

  function renderDrawer(d) {
    var spec = d.spec || {};
    $('drawer-title').textContent = spec.name || d.id;
    var pairs = [
      ['State', badge(d.state)],
      ['Id', d.id],
      ['Kind', spec.kind],
      spec.kind !== 'external' ? ['Profile', spec.profile] : null,
      spec.kind === 'split' ? ['Coordinator', nodeName(spec.coordinatorNodeId)] : null,
      spec.kind === 'split' ? ['Workers', (spec.workerNodeIds || []).map(nodeName).join(', ')] : null,
      spec.kind === 'replica' ? ['Replica node', nodeName(spec.replicaNodeId)] : null,
      spec.kind !== 'external' ? ['Context', 'ctx ' + (spec.ctx || 'default') + ', parallel ' + (spec.parallel || 'default') + ', chain ' + (spec.chain == null ? 'default' : spec.chain)] : null,
      spec.kind === 'split' ? ['Boundaries', 'wire ' + (spec.wire || 'off') + (spec.batchedGets === false ? ', unbatched GETs' : ', batched GETs') + (spec.forwarding === false ? ', no forwarding' : ', forwarding')] : null,
      spec.stopExternal ? ['External server', el('span', { class: 'err', text: 'stopped for the run, restarted after' })] : null,
      spec.external ? ['External', spec.external.url + ' (' + spec.external.healthPath + ') on ' + nodeName(spec.external.nodeId) + ' as ' + spec.external.modelName] : null,
      ['Endpoint', d.endpoint ? d.endpoint.modelName + ' at ' + nodeName(d.endpoint.nodeId) + ':' + d.endpoint.port : null],
      ['Error', d.error ? el('span', { class: 'err', text: d.error }) : null],
      ['Created', when(d.createdAt)],
      ['Updated', when(d.updatedAt)],
    ];
    var body = [el('dl', { class: 'kv' }, kv(pairs))];
    if (d.plan) body = body.concat([el('h2', { class: 'label', text: 'Plan' })], renderPlan(d.plan));
    body.push(el('h2', { class: 'label', text: 'Assignments' }));
    body.push(buildTable(['Assignment', 'Kind', 'Node', 'State', 'Detail', 'Logs'], (d.assignments || []).map(function (a) {
      return el('tr', null, [
        td(shortId(a.id), 'mono', a.id),
        td(a.body && a.body.kind ? a.body.kind : NA),
        td(nodeName(a.nodeId), null, a.nodeId),
        td([badge(a.state), el('div', { class: 'dim small', text: ago(a.updatedAt) })]),
        td(a.detail || '', 'small'),
        td(el('button', { class: 'button button--small', type: 'button', text: state.drawer.logsId === a.id ? 'Showing' : 'Logs', onclick: function () { state.drawer.logsId = a.id; loadDrawerLogs().catch(function (e) { note('drawer-status', e.message, 'error'); }); renderDrawer(d); } })),
      ]);
    }), 'No assignments yet. Start the deployment to place it.'));
    replace($('drawer-body'), body);
  }

  function loadDrawerLogs() {
    var id = state.drawer.logsId;
    if (!id) return Promise.resolve();
    return api('GET', '/api/assignments/' + encodeURIComponent(id) + '/logs').then(function (r) {
      if (state.drawer.logsId !== id) return;
      var out = $('drawer-logs');
      var lines = r.lines || [];
      $('drawer-logs-title').textContent = 'Logs of ' + shortId(id) + ' (' + lines.length + ' lines)';
      $('drawer-logs-title').hidden = false;
      out.textContent = lines.length ? lines.join('\n') : '(no output yet)';
      out.hidden = false;
      out.scrollTop = out.scrollHeight;
    });
  }

  function renderPlan(p) {
    var out = [el('dl', { class: 'kv' }, kv([
      ['Coordinator', nodeName(p.coordinatorNodeId) + ' on ' + p.coordinatorDevice],
      ['Tensor split', (p.tensorSplit || []).join(' / ')],
      ['Context', p.ctx + ' tokens, ' + p.parallel + ' parallel, chain ' + (p.chain ? p.chain : 'off')],
      ['Model', p.modelPath],
      p.mtpPath ? ['MTP head', p.mtpPath] : null,
    ]))];
    out.push(buildTable(['Worker', 'Device', 'Layers', 'Port', 'Peer port', 'Threads', 'Mem cap'], (p.workers || []).map(function (w) {
      return el('tr', null, [
        td(nodeName(w.nodeId), 'strong', w.nodeId),
        td(w.device, 'mono'),
        td(String(w.layers), 'num'),
        td(String(w.port), 'num'),
        td(w.peerPort ? String(w.peerPort) : NA, 'num'),
        td(String(w.threads), 'num'),
        td(fmtGiB(w.memCapMiB) + ' GiB', 'num'),
      ]);
    }), 'No workers: the coordinator holds every layer.'));
    var env = p.env || {};
    var keys = Object.keys(env);
    if (keys.length) out.push(el('pre', { class: 'code', text: keys.map(function (k) { return k + '=' + env[k]; }).join('\n') }));
    if (p.reasons && p.reasons.length) out.push(el('ol', { class: 'reasons' }, p.reasons.map(function (r) { return el('li', { text: r }); })));
    return out;
  }

  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  $('drawer-refresh').addEventListener('click', function () { loadDrawer().catch(function (e) { note('drawer-status', e.message, 'error'); }); });
  D.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && state.drawer.id) closeDrawer(); });

  /* ---------- deployments: create form ---------- */
  function ensureProfiles() {
    if (state.profiles || state.profilesFailed) return;
    api('GET', '/api/profiles').then(function (r) {
      state.profiles = r.profiles || [];
      replace($('dep-profile'), state.profiles.map(function (p) { return el('option', { value: p.id, text: p.name + ' (' + p.modelName + ')' }); }));
      if (!state.profiles.length) replace($('dep-profile'), el('option', { value: '', text: 'no profiles on this control plane' }));
    }).catch(function (e) {
      if (e.status === 401) return;
      state.profilesFailed = true;
      $('dep-profile').hidden = true;
      $('dep-profile-text').hidden = false;
    });
  }

  function fillSelect(sel, items) {
    var have = [].map.call(sel.options, function (o) { return o.value + '=' + o.textContent; }).join('\n');
    var want = items.map(function (i) { return i.value + '=' + i.text; }).join('\n');
    if (have === want) return;
    var selected = [].filter.call(sel.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
    replace(sel, items.map(function (i) { return el('option', { value: i.value, text: i.text }); }));
    [].forEach.call(sel.options, function (o) { o.selected = selected.indexOf(o.value) >= 0; });
    if (!sel.multiple && !selected.length && sel.options.length) sel.selectedIndex = 0;
  }

  function fillNodeSelects() {
    var items = state.nodes.filter(function (n) { return n.online; }).map(function (n) {
      var roles = roleList(n.offer);
      return { value: n.id, text: n.hostname + ' (' + shortId(n.id) + ')' + (roles.length ? ', ' + roles.join(', ') : ', no roles') };
    });
    if (!items.length) items = [{ value: '', text: 'no node is online' }];
    fillSelect($('dep-node'), items);
    fillSelect($('dep-workers'), items.filter(function (i) { return i.value; }));
  }

  function applyKind() {
    var kind = $('dep-kind').value;
    [].forEach.call($('dep-form').querySelectorAll('[data-kinds]'), function (n) {
      n.hidden = n.getAttribute('data-kinds').split(' ').indexOf(kind) < 0;
    });
    $('dep-node-label').textContent = kind === 'split' ? 'Coordinator node' : (kind === 'replica' ? 'Replica node' : 'Node running the server');
  }

  function optNum(spec, key, id) {
    var v = $(id).value.trim();
    if (v === '') return;
    var n = Number(v);
    if (isFinite(n)) spec[key] = n;
  }

  function selectedValues(sel) { return [].filter.call(sel.options, function (o) { return o.selected && o.value; }).map(function (o) { return o.value; }); }

  function readSpec() {
    var kind = $('dep-kind').value;
    var spec = { name: $('dep-name').value.trim(), kind: kind };
    if (kind === 'external') {
      spec.profile = 'external';
      spec.external = {
        nodeId: $('dep-node').value,
        url: $('dep-ext-url').value.trim(),
        healthPath: $('dep-ext-health').value.trim() || '/health',
        modelName: $('dep-ext-model').value.trim(),
      };
      return spec;
    }
    spec.profile = state.profilesFailed ? $('dep-profile-text').value.trim() : $('dep-profile').value;
    if (kind === 'split') {
      spec.coordinatorNodeId = $('dep-node').value;
      spec.workerNodeIds = selectedValues($('dep-workers'));
      spec.wire = $('dep-wire').value;
      spec.batchedGets = $('dep-batched').checked;
      spec.forwarding = $('dep-forwarding').checked;
    } else {
      spec.replicaNodeId = $('dep-node').value;
    }
    optNum(spec, 'ctx', 'dep-ctx');
    optNum(spec, 'parallel', 'dep-parallel');
    optNum(spec, 'chain', 'dep-chain');
    spec.stopExternal = $('dep-stop-external').checked;
    return spec;
  }

  function checkSpec(spec) {
    var problems = [];
    if (!spec.name) problems.push('A name is required.');
    if (spec.kind === 'external') {
      if (!spec.external.nodeId) problems.push('Pick the node that runs the server.');
      if (!spec.external.url) problems.push('The server URL is required.');
      if (!spec.external.modelName) problems.push('The model name is required.');
    } else {
      if (!spec.profile) problems.push('Pick a profile.');
      if (spec.kind === 'split' && !spec.coordinatorNodeId) problems.push('Pick a coordinator node.');
      if (spec.kind === 'replica' && !spec.replicaNodeId) problems.push('Pick a replica node.');
    }
    return problems;
  }

  function renderPreview(r) {
    var box = $('dep-preview-out');
    var plan = r && r.plan ? r.plan : (r && r.tensorSplit ? r : null);
    if (plan) {
      replace(box, [el('h2', { class: 'label', text: 'Plan preview' })].concat(renderPlan(plan)));
      return;
    }
    var reasons = (r && (r.reasons || r.errors)) || [];
    replace(box, el('div', { class: 'banner banner--error' }, [
      el('strong', { text: 'No plan' }),
      el('ul', null, (reasons.length ? reasons : [(r && r.error) || 'The planner returned nothing usable.']).map(function (x) { return el('li', { text: String(x) }); })),
    ]));
  }

  function previewProblems(problems) {
    replace($('dep-preview-out'), el('div', { class: 'banner banner--error' }, [
      el('strong', { text: 'Check the form' }),
      el('ul', null, problems.map(function (x) { return el('li', { text: x }); })),
    ]));
  }

  $('dep-toggle').addEventListener('click', function () {
    var form = $('dep-form');
    form.hidden = !form.hidden;
    if (!form.hidden) { ensureProfiles(); fillNodeSelects(); applyKind(); $('dep-name').focus(); }
  });
  $('dep-kind').addEventListener('change', applyKind);

  $('dep-preview').addEventListener('click', function () {
    var spec = readSpec();
    var problems = checkSpec(spec);
    if (problems.length) { previewProblems(problems); return; }
    var btn = $('dep-preview');
    btn.disabled = true;
    note('dep-form-status', 'Planning…');
    api('POST', '/api/deployments/plan-preview', spec).then(function (r) {
      renderPreview(r);
      note('dep-form-status', '');
    }).catch(function (e) {
      renderPreview(e.data && (e.data.reasons || e.data.errors) ? e.data : { error: e.message });
      note('dep-form-status', 'No plan', 'error');
    }).then(function () { btn.disabled = false; });
  });

  $('dep-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var spec = readSpec();
    var problems = checkSpec(spec);
    if (problems.length) { previewProblems(problems); return; }
    var btn = $('dep-create');
    btn.disabled = true;
    note('dep-form-status', 'Creating…');
    var created = null;
    api('POST', '/api/deployments', spec).then(function (r) {
      created = r.id;
      note('dep-form-status', 'Created ' + shortId(created) + ', starting…');
      return api('POST', '/api/deployments/' + encodeURIComponent(created) + '/start');
    }).then(function () {
      note('dep-form-status', 'Started ' + spec.name, 'ok');
      $('dep-form').hidden = true;
      clear($('dep-preview-out'));
      return loadDeployments().then(function () { openDrawer(created); });
    }).catch(function (e) {
      note('dep-form-status', (created ? 'Created but not started: ' : 'Not created: ') + e.message, 'error');
      if (created) loadDeployments().catch(showError);
    }).then(function () { btn.disabled = false; });
  });

  /* ---------- routing ---------- */
  function loadRouting() {
    return api('GET', '/api/routing').then(function (r) {
      $('routing-note').hidden = true;
      renderRouting(r);
    }).catch(function (e) {
      if (e.status === 401) throw e;
      $('routing-note').textContent = 'Live routing data is unavailable: ' + e.message;
      $('routing-note').hidden = false;
      renderRouting({ models: [], totals: {} });
    });
  }

  function renderRouting(r) {
    var base = location.origin + '/v1';
    var models = r.models || [];
    var model = models[0] ? models[0].modelName : 'MODEL_NAME';
    $('routing-base').textContent = base;
    $('routing-curl').textContent = 'curl ' + base + '/chat/completions \\\n' +
      '  -H "Authorization: Bearer sw-YOUR-API-KEY" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -d \'{"model":"' + model + '","messages":[{"role":"user","content":"Hello"}]}\'';
    var rows = [];
    models.forEach(function (mo) {
      var deps = mo.deployments || [];
      if (!deps.length) rows.push(el('tr', null, [td(mo.modelName, 'strong mono'), td('no ready deployment', 'dim'), td(NA), td(NA), td(NA, 'num'), td(NA, 'num')]));
      deps.forEach(function (d, i) {
        rows.push(el('tr', null, [
          td(i === 0 ? mo.modelName : '', 'strong mono'),
          td(d.name || NA),
          td(shortId(d.id), 'mono', d.id),
          td(nodeName(d.nodeId), null, d.nodeId),
          td(isNum(d.inflight) ? String(d.inflight) : NA, 'num'),
          td(num(d.tokPerSec, 1), 'num'),
        ]));
      });
    });
    setRows($('routing-table'), rows, 'No model is served yet. Start a deployment.');
    $('routing-totals').textContent = 'In flight now: ' + (r.totals && isNum(r.totals.inflight) ? r.totals.inflight : 0);
  }

  /* ---------- events ---------- */
  function loadEvents() {
    return api('GET', '/api/events?limit=200').then(function (r) { state.events = r.events || []; renderEvents(); });
  }

  function renderEvents() {
    var q = $('events-filter').value.trim().toLowerCase();
    var list = state.events.filter(function (e) {
      return !q || [e.kind, e.nodeId, nodeName(e.nodeId), e.deploymentId, depName(e.deploymentId), e.message].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    setRows($('events-table'), list.map(function (e) {
      return el('tr', null, [
        td(when(e.ts), 'mono small', e.ts),
        td(e.kind, 'mono small'),
        td(e.nodeId ? nodeName(e.nodeId) : '', 'small', e.nodeId || ''),
        td(e.deploymentId ? depName(e.deploymentId) : '', 'small', e.deploymentId || ''),
        td(e.message, 'small'),
      ]);
    }), q ? 'No events match the filter.' : 'No events yet.');
    note('events-status', list.length + ' of ' + state.events.length + ' events, updated ' + clock(new Date()));
  }

  $('events-filter').addEventListener('input', renderEvents);

  /* ---------- keys ---------- */
  function loadKeys() {
    return api('GET', '/api/api-keys').then(function (r) {
      setRows($('keys-table'), (r.keys || []).map(function (k) {
        return el('tr', null, [td(k.name, 'strong'), td((k.keyPrefix || '') + '…', 'mono'), td(when(k.createdAt), 'mono small', k.createdAt)]);
      }), 'No API keys yet. Clients need one for /v1.');
    });
  }

  $('key-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = $('key-name').value.trim() || 'default';
    var btn = $('key-create');
    btn.disabled = true;
    note('key-status', 'Creating…');
    api('POST', '/api/api-keys', { name: name }).then(function (r) {
      $('key-value').textContent = r.key;
      $('key-box').hidden = false;
      $('key-name').value = '';
      note('key-status', 'Created "' + name + '"', 'ok');
      return loadKeys();
    }).catch(function (e) { note('key-status', e.message, 'error'); }).then(function () { btn.disabled = false; });
  });
  $('key-copy').addEventListener('click', function () { copyText($('key-value').textContent, $('key-copy')); });

  /* ---------- chat: talks to the router, measures the reply ---------- */
  var chat = { messages: [], busy: false, abort: null, models: [], stats: { tokens: 0, seconds: 0, replies: 0 } };

  function depLabel(c) {
    var n = (c.nodes || [c.nodeId]).map(nodeName);
    return c.name + ' \u00b7 ' + (c.kind || '?') + ' \u00b7 ' + n.length + (n.length === 1 ? ' node: ' : ' nodes: ') + n.join(' \u2192 ');
  }

  /** Models and their ready deployments; the deployment list defaults to the one spanning the most nodes. */
  function loadChatModels() {
    return api('GET', '/api/routing').then(function (r) {
      chat.routing = r.models || [];
      var list = chat.routing.map(function (m) { return m.modelName; });
      var sel = $('chat-model');
      var cur = sel.value;
      if (list.join('|') !== chat.models.join('|')) {
        clear(sel);
        list.forEach(function (id) { sel.appendChild(el('option', { value: id, text: id })); });
        if (list.indexOf(cur) >= 0) sel.value = cur;
        chat.models = list;
      }
      fillChatDeployments();
      if (!list.length) note('chat-status', 'No ready deployment serves a model yet (Deployments tab).', 'error');
      else if (/No ready deployment/.test($('chat-status').textContent)) note('chat-status', '');
      if (list.length && !topo.lastDep && !chat.busy) return loadTopologyForModel();
    });
  }

  function chatCandidates() {
    var entry = (chat.routing || []).filter(function (m) { return m.modelName === $('chat-model').value; })[0];
    return entry ? entry.deployments.slice() : [];
  }

  function fillChatDeployments() {
    var sel = $('chat-dep');
    var cands = chatCandidates().sort(function (a, b) { return ((b.nodes || []).length - (a.nodes || []).length) || (a.inflight - b.inflight); });
    var cur = sel.value;
    var sig = cands.map(function (c) { return c.id + ':' + depLabel(c); }).join('|');
    if (sig === chat.depSig) return;
    chat.depSig = sig;
    clear(sel);
    cands.forEach(function (c) { sel.appendChild(el('option', { value: c.id, text: depLabel(c) })); });
    if (cands.some(function (c) { return c.id === cur; })) sel.value = cur; // keep the user's pick; otherwise the most nodes
    sel.disabled = cands.length < 2;
  }

  function chatBubble(role, text) {
    var node = el('div', { class: 'msg msg--' + role }, [el('div', { class: 'msg-role', text: role === 'user' ? 'you' : 'assistant' }), el('div', { class: 'msg-text', text: text })]);
    var log = $('chat-log');
    var hint = log.querySelector('.hint');
    if (hint) hint.parentNode.removeChild(hint);
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }

  function setTile(id, value, small) {
    var v = clear($(id));
    v.appendChild(D.createTextNode(value));
    if (small) v.appendChild(el('small', { text: small }));
  }

  function sendChat(text) {
    if (chat.busy) return;
    var model = $('chat-model').value;
    if (!model) { note('chat-status', 'Pick a model first.', 'error'); return; }
    chat.messages.push({ role: 'user', content: text });
    chatBubble('user', text);
    var bubble = chatBubble('assistant', '');
    var textNode = bubble.querySelector('.msg-text');
    var meta = el('div', { class: 'msg-meta dim small mono', text: 'waiting for the first token…' });
    bubble.appendChild(meta);
    var reasoningNode = null;
    chat.busy = true;
    $('chat-send').disabled = true;
    $('chat-stop').disabled = false;
    var ctrl = new AbortController();
    chat.abort = ctrl;
    var body = {
      model: model, messages: chat.messages.slice(), stream: true, stream_options: { include_usage: true },
      max_tokens: Math.max(16, Number($('chat-max').value) || 512),
      chat_template_kwargs: { enable_thinking: $('chat-think').checked },
    };
    var t0 = performance.now(), tFirst = 0, tEnd = 0, content = '', reasoning = '', chunks = 0, usage = null, timings = null, served = {};
    note('chat-status', 'Sending to ' + model + '…');

    function handle(obj) {
      if (obj.timings) timings = obj.timings;
      if (obj.usage) usage = obj.usage;
      var ch = obj.choices && obj.choices[0];
      var d = ch && ch.delta;
      if (!d) return;
      if (d.reasoning_content) {
        reasoning += d.reasoning_content;
        if (!reasoningNode) {
          reasoningNode = el('details', { class: 'msg-reasoning' }, [el('summary', { text: 'thinking' }), el('div', { class: 'msg-text dim' })]);
          bubble.insertBefore(reasoningNode, textNode);
        }
        reasoningNode.lastChild.textContent = reasoning;
        if (!tFirst) tFirst = performance.now();
      }
      if (d.content) {
        if (!tFirst) tFirst = performance.now();
        chunks++;
        content += d.content;
        textNode.textContent = content;
        tEnd = performance.now();
        if (chunks % 3 === 0) {
          var sec = (tEnd - tFirst) / 1000;
          meta.textContent = '≈ ' + (sec > 0.2 ? (chunks / sec).toFixed(1) : '…') + ' tok/s while streaming';
        }
      }
    }

    function finish(failed, why) {
      chat.busy = false;
      chat.abort = null;
      $('chat-send').disabled = false;
      $('chat-stop').disabled = true;
      if (!tEnd) tEnd = performance.now();
      var n = (timings && isNum(timings.predicted_n)) ? timings.predicted_n : (usage && isNum(usage.completion_tokens)) ? usage.completion_tokens : chunks;
      var promptN = (timings && isNum(timings.prompt_n)) ? timings.prompt_n : (usage && isNum(usage.prompt_tokens)) ? usage.prompt_tokens : null;
      var genSec = (timings && isNum(timings.predicted_ms)) ? timings.predicted_ms / 1000 : (tFirst ? (tEnd - tFirst) / 1000 : 0);
      var tps = (timings && isNum(timings.predicted_per_second)) ? timings.predicted_per_second : (genSec > 0 ? n / genSec : 0);
      var source = (timings && isNum(timings.predicted_per_second)) ? 'server timing' : 'measured in the browser';
      var ttft = tFirst ? Math.round(tFirst - t0) : null;
      if (content || reasoning) chat.messages.push({ role: 'assistant', content: content });
      else chat.messages.pop();
      if (n > 0 && genSec > 0) { chat.stats.tokens += n; chat.stats.seconds += genSec; chat.stats.replies++; }
      setTile('chat-tps', tps ? tps.toFixed(1) : NA, tps ? ' tok/s' : '');
      $('chat-tps-sub').textContent = source + (failed ? ' (' + why + ')' : '');
      setTile('chat-tokens', (promptN == null ? NA : promptN) + ' / ' + n);
      $('chat-tokens-sub').textContent = 'prompt / completion' + (genSec ? ', ' + genSec.toFixed(1) + ' s generating' : '');
      setTile('chat-ttft', ttft == null ? NA : String(ttft), ttft == null ? '' : ' ms');
      setTile('chat-node', served.node ? nodeName(served.node) : NA);
      if (served.dep) { $('chat-topo-title').textContent = 'Topology · served this reply'; loadTopology(served.dep, { servedNodeId: served.node, note: 'This reply was served by ' + (served.node ? nodeName(served.node) : 'the node below') + ' through deployment ' + shortId(served.dep) + '.' }).catch(showError); }
      $('chat-dep').textContent = served.dep ? 'deployment ' + shortId(served.dep) + ' · ' + model : 'deployment';
      var sess = chat.stats.seconds > 0 ? chat.stats.tokens / chat.stats.seconds : 0;
      setTile('chat-session', sess ? sess.toFixed(1) : NA, sess ? ' tok/s' : '');
      $('chat-session-sub').textContent = chat.stats.replies + (chat.stats.replies === 1 ? ' reply, ' : ' replies, ') + chat.stats.tokens + ' tokens';
      meta.textContent = failed ? (why || 'failed') : (tps ? tps.toFixed(1) + ' tok/s' : '') + (n ? ' · ' + n + ' tokens' : '') + (ttft != null ? ' · first token ' + ttft + ' ms' : '') + (served.node ? ' · ' + nodeName(served.node) : '');
      if (failed) meta.className = 'msg-meta err small mono';
      note('chat-status', failed ? (why || 'failed') : '', failed ? 'error' : undefined);
      $('chat-log').scrollTop = $('chat-log').scrollHeight;
      $('chat-input').focus();
    }

    var headers = { 'content-type': 'application/json' };
    if ($('chat-dep').value) headers['x-swarmlet-deployment'] = $('chat-dep').value;
    fetch('/v1/chat/completions', { method: 'POST', headers: headers, credentials: 'same-origin', body: JSON.stringify(body), signal: ctrl.signal }).then(function (res) {
      served = { node: res.headers.get('x-swarmlet-node'), dep: res.headers.get('x-swarmlet-deployment') };
      if (res.status === 401) { showLogin(); throw new Error('not logged in'); }
      if (!res.ok) return res.text().then(function (t) { throw new Error('HTTP ' + res.status + ': ' + t.slice(0, 200)); });
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var parts = buf.split('\n\n');
          buf = parts.pop();
          parts.forEach(function (p) {
            p.split('\n').forEach(function (line) {
              if (line.indexOf('data:') !== 0) return;
              var data = line.slice(5).trim();
              if (!data || data === '[DONE]') return;
              try { handle(JSON.parse(data)); } catch (_) { /* partial frame */ }
            });
          });
          $('chat-log').scrollTop = $('chat-log').scrollHeight;
          return pump();
        });
      }
      return pump();
    }).then(function () { finish(false); }).catch(function (e) { finish(true, e.name === 'AbortError' ? 'stopped' : e.message); });
  }

  $('chat-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = $('chat-input').value.trim();
    if (!text) return;
    $('chat-input').value = '';
    sendChat(text);
  });
  $('chat-input').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('chat-form').dispatchEvent(new Event('submit', { cancelable: true })); }
  });
  $('chat-stop').addEventListener('click', function () { if (chat.abort) chat.abort.abort(); });
  $('chat-clear').addEventListener('click', function () {
    if (chat.abort) chat.abort.abort();
    chat.messages = [];
    chat.stats = { tokens: 0, seconds: 0, replies: 0 };
    replace($('chat-log'), el('p', { class: 'hint', text: 'New conversation. The model keeps no memory of the previous one.' }));
    ['chat-tps', 'chat-tokens', 'chat-ttft', 'chat-node', 'chat-session'].forEach(function (id) { setTile(id, NA); });
    note('chat-status', '');
  });

  /* ---------- chat topology: what serves the selected model / the last reply ---------- */
  var topo = { profiles: null, lastDep: null };

  function ensureTopoProfiles() {
    if (topo.profiles) return Promise.resolve(topo.profiles);
    return api('GET', '/api/profiles').then(function (r) {
      topo.profiles = {};
      (r.profiles || []).forEach(function (p) { topo.profiles[p.id] = p; });
      return topo.profiles;
    });
  }

  function fmtBytes(n) { return isNum(n) ? (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KiB' : n + ' B') : NA; }

  function topoNode(cls, lines) {
    return el('div', { class: 'topo-node ' + cls }, lines.filter(function (l) { return l != null && l !== ''; }).map(function (l, i) {
      return el('div', { class: i === 0 ? 'topo-title' : 'topo-line', text: l });
    }));
  }
  function topoEdge(caption) {
    return el('div', { class: 'topo-edge' }, [el('div', { class: 'topo-arrow', text: '→' }), el('div', { class: 'topo-cap', text: caption })]);
  }
  function nodeLive(id) {
    var n = nodeById(id);
    if (!n) return '';
    var parts = [];
    var rtt = n.caps && n.caps.net && isNum(n.caps.net.rttMs) ? n.caps.net.rttMs : null;
    if (rtt != null) parts.push('rtt ' + num(rtt, 0) + ' ms');
    var live = isNum(n.routedTokPerSec) && n.routedTokPerSec > 0 ? n.routedTokPerSec : (n.metrics && isNum(n.metrics.tokPerSec) ? n.metrics.tokPerSec : null);
    if (live != null) parts.push(num(live, 1) + ' tok/s');
    return parts.join(' · ');
  }

  function renderTopology(dep, profiles, opts) {
    opts = opts || {};
    var body = clear($('chat-topo-body'));
    var spec = dep.spec || {};
    var plan = dep.plan;
    var prof = profiles[spec.profile] || null;
    var asg = dep.assignments || [];
    var coordA = asg.filter(function (a) { return a.body && a.body.kind === 'coordinator' && a.state !== 'stopped'; })[0];
    var paths = {};
    if (coordA && coordA.detail) {
      (coordA.detail.match(/rpc\d+=(direct|relay)/g) || []).forEach(function (m) { var kv = m.split('='); paths[kv[0]] = kv[1]; });
    }
    var served = opts.servedNodeId || null;
    var row = el('div', { class: 'topo' });
    row.appendChild(topoNode('topo-client', ['browser', 'this page', 'SSE stream back']));
    row.appendChild(topoEdge('HTTP · /v1/chat/completions'));
    row.appendChild(topoNode('topo-router', ['control router', location.host, spec.name + ' (' + shortId(dep.id) + ')', 'least in-flight, then lowest rtt']));
    if (spec.kind === 'external' && spec.external) {
      var extId = spec.external.nodeId;
      row.appendChild(topoEdge('agent channel · tunnel to ' + (dep.endpoint ? ':' + dep.endpoint.port : 'server')));
      row.appendChild(topoNode('topo-coord' + (served === extId ? ' topo-node--served' : ''), [nodeName(extId), 'external server · whole model', spec.external.url, spec.external.modelName, nodeLive(extId)]));
    } else if (plan) {
      var total = prof ? prof.layers : plan.tensorSplit.reduce(function (a, b) { return a + b; }, 0);
      var coordLayers = plan.tensorSplit.length ? plan.tensorSplit[plan.tensorSplit.length - 1] : total;
      row.appendChild(topoEdge('agent channel · tunnel to :' + (dep.endpoint ? dep.endpoint.port : '?')));
      row.appendChild(topoNode('topo-coord' + (served === plan.coordinatorNodeId ? ' topo-node--served' : ''), [
        nodeName(plan.coordinatorNodeId),
        (spec.kind === 'replica' ? 'whole model' : 'coordinator') + ' · ' + plan.coordinatorDevice,
        (spec.kind === 'replica' ? total + ' layers' : coordLayers + ' of ' + total + ' layers') + (prof ? ' · ' + fmtGiB(coordLayers * prof.layerMiB) + ' GiB' : ''),
        'ctx ' + plan.ctx + ', parallel ' + plan.parallel + (plan.chain ? ', MTP chain ' + plan.chain : ''),
        nodeLive(plan.coordinatorNodeId),
      ]));
      (plan.workers || []).forEach(function (w, i) {
        var path = paths['rpc' + i] || (coordA ? 'path pending' : 'not started');
        var bytes = prof && isNum(prof.boundaryBytes) ? ' · ' + fmtBytes(prof.boundaryBytes) + '/token' : '';
        row.appendChild(topoEdge('RPC' + i + ' · ' + path + bytes));
        row.appendChild(topoNode('topo-worker' + (served === w.nodeId ? ' topo-node--served' : ''), [
          nodeName(w.nodeId),
          'worker · ' + w.device,
          w.layers + (w.layers === 1 ? ' layer' : ' layers') + (prof ? ' · ' + fmtGiB(w.layers * prof.layerMiB) + ' GiB' : '') + ' · cap ' + fmtGiB(w.memCapMiB) + ' GiB',
          'rpc :' + w.port + (w.peerPort ? ' · peer :' + w.peerPort : '') + ' · ' + w.threads + ' threads',
          nodeLive(w.nodeId),
        ]));
      });
    } else {
      row.appendChild(topoEdge('not planned yet'));
    }
    body.appendChild(row);
    var notes = [];
    notes.push('state ' + dep.state + (dep.endpoint ? ', endpoint ' + nodeName(dep.endpoint.nodeId) + ':' + dep.endpoint.port : ''));
    if (plan && plan.workers && plan.workers.length) {
      var env = plan.env || {};
      notes.push('ring: the coordinator sends the boundary activations to RPC0' + (plan.workers.length > 1 ? (env.GGML_RPC_FORWARD === '1' ? ', each worker pushes them on to the next (peer port)' : ', the coordinator relays between workers') : '') + ', the last worker answers the coordinator’s GET; the coordinator finishes the layers and samples');
      notes.push('boundary GETs ' + (env.GGML_RPC_GET_PIPELINE === '1' ? 'batched' : 'serial') + ' · wire ' + (env.GGML_RPC_WIRE || 'off') + ' · pipelined dispatcher ' + (env.GGML_RPC_PIPELINE === '1' ? 'on' : 'off'));
      notes.push('direct = TLS to the worker’s data listener with its certificate pinned; relay = through the control channel');
    }
    if (opts.note) notes.unshift(opts.note);
    body.appendChild(el('div', { class: 'topo-notes dim small' }, notes.map(function (t) { return el('div', { text: t }); })));
  }

  function loadTopology(depId, opts) {
    return Promise.all([ensureTopoProfiles(), api('GET', '/api/deployments/' + encodeURIComponent(depId))]).then(function (r) {
      topo.lastDep = depId;
      topo.lastOpts = opts;
      renderTopology(r[1], r[0], opts);
    });
  }

  /** Topology of what can serve the selected model (before any reply). */
  function loadTopologyForModel() {
    var model = $('chat-model').value;
    if (!model) { replace($('chat-topo-body'), el('p', { class: 'hint', text: 'No model selected.' })); return Promise.resolve(); }
    var cands = chatCandidates();
    if (!cands.length) { replace($('chat-topo-body'), el('p', { class: 'hint', text: 'No ready deployment serves ' + model + ' right now.' })); return Promise.resolve(); }
    var pickId = $('chat-dep').value || cands[0].id;
    var pick = cands.filter(function (c) { return c.id === pickId; })[0] || cands[0];
    $('chat-topo-title').textContent = 'Topology · ' + model + ' · ' + pick.name + (cands.length > 1 ? ' (' + cands.length + ' deployments serve this model)' : '');
    return loadTopology(pick.id, { note: cands.length > 1 ? 'Replies go to the selected deployment; the router only chooses on its own when none is selected.' : null });
  }

  $('chat-model').addEventListener('change', function () { fillChatDeployments(); loadTopologyForModel().catch(showError); });
  $('chat-dep').addEventListener('change', function () { loadTopologyForModel().catch(showError); });

  /* ---------- polling ---------- */
  function tick() {
    if (!state.authed) return;
    var extra = Promise.resolve();
    if (state.active === 'routing') extra = loadRouting();
    else if (state.active === 'events') extra = loadEvents();
    else if (state.active === 'chat') extra = chat.busy ? (topo.lastDep ? loadTopology(topo.lastDep, topo.lastOpts || {}) : Promise.resolve()) : loadChatModels();
    Promise.all([loadNodes(), loadDeployments(), extra]).then(function () {
      $('app-error').hidden = true;
      renderJoinCode();
      if (state.drawer.id) return loadDrawer();
    }).catch(function (e) { if (e.status !== 401) showError(e); });
  }

  function boot() {
    api('GET', '/api/whoami').then(function (w) {
      state.whoami = w;
      hideLogin();
      showTab((location.hash || '#nodes').slice(1));
    }).catch(function (e) { if (e.status !== 401) showError(e); });
  }

  boot();
  setInterval(tick, POLL_MS);
}());
