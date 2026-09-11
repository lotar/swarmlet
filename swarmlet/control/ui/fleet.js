/* Fleet planning UI. The server owns placement, admission and durable apply state. */
(function () {
  'use strict';
  var D = document, $ = function (id) { return D.getElementById(id); };
  var api = function (method, path, value) { return window.SwarmletAdmin.api(method, path, value); };
  var snapshot = null, profiles = [], selected = new Map(), pool = new Set(), initialized = false;
  var draftVersion = 0;
  var preview = null, dirty = false, working = false, loading = null, manual = null;
  var pages = { node: 0, dep: 0, result: 0, worker: 0 }, sizes = { node: 25, dep: 15, result: 10, worker: 20 };
  var STORAGE = 'swarmlet:fleet-draft:v1';
  function el(tag, attrs, children) {
    var node = D.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'class') node.className = value;
      else if (key === 'value') node.value = value;
      else if (key === 'checked' || key === 'disabled') node[key] = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(function (child) {
      if (child !== null && child !== undefined) node.appendChild(child && child.nodeType ? child : D.createTextNode(String(child)));
    });
    return node;
  }
  function put(id, children) { $(id).replaceChildren.apply($(id), Array.isArray(children) ? children : [children]); }
  function gib(value) { return ((value || 0) / 1024).toFixed(1) + ' GiB'; }
  function notice(message, error) { $('fleet-notice').hidden = !message; $('fleet-notice').textContent = message || ''; $('fleet-notice').classList.toggle('fleet-notice--error', !!error); }
  function eligible(n) { return n.online && n.supported && n.offer && n.offer.enabled && n.offer.ramMiB > 0 && n.offer.cpuCores >= 1; }
  function managed(d) { return d.spec.kind === 'split' || d.spec.kind === 'replica'; }
  function busy() { return working || !!(snapshot && snapshot.busy); }
  function nodeName(id) { var n = snapshot && snapshot.nodes.find(function (n) { return n.id === id; }); return n ? n.hostname : id || 'Automatic'; }
  function itemFor(d) { return selected.get(d.id) || { deploymentId: d.id, mode: 'balanced' }; }
  function persist() { try { localStorage.setItem(STORAGE, JSON.stringify({ items: Array.from(selected.values()), poolNodeIds: Array.from(pool) })); } catch (_) {} }
  function changed() {
    draftVersion++; dirty = true; persist(); renderReview(); renderPool(); updateButtons();
    if (preview) notice('Selections changed. Recommend again to review the new allocation.');
  }
  function paginate(list, key) {
    pages[key] = Math.max(0, Math.min(pages[key], Math.max(0, Math.ceil(list.length / sizes[key]) - 1)));
    var start = pages[key] * sizes[key];
    $('fleet-' + key + '-prev').disabled = !pages[key];
    $('fleet-' + key + '-next').disabled = start + sizes[key] >= list.length;
    $('fleet-' + key + '-page').textContent = list.length ? (start + 1) + '–' + Math.min(start + sizes[key], list.length) + ' of ' + list.length : 'No matches';
    return list.slice(start, start + sizes[key]);
  }
  function bar(used, total, unit) {
    var percentage = total ? Math.min(100, used / total * 100) : 0;
    return el('div', { class: 'fleet-meter' + (used > total ? ' fleet-meter--over' : '') }, [
      el('span', { class: 'mono', text: unit === 'ram' ? gib(used) + ' / ' + gib(total) : used + ' / ' + total + ' cores' }),
      el('div', { class: 'fleet-meter-track', role: 'meter', 'aria-label': 'Reserved capacity', 'aria-valuemin': 0, 'aria-valuemax': total || 1, 'aria-valuenow': Math.min(used, total || 1) }, el('span', { style: 'width:' + percentage + '%' }))
    ]);
  }
  function renderSummary() {
    if (!snapshot) return;
    var nodes = snapshot.nodes, ready = nodes.filter(eligible), reserved = nodes.filter(function (n) { return n.reserved && n.reserved.cpuCores; }).length;
    put('fleet-summary', [
      el('div', {}, [el('strong', { text: ready.length }), el('span', { text: 'eligible nodes' })]),
      el('div', {}, [el('strong', { text: reserved }), el('span', { text: 'currently allocated' })]),
      el('div', {}, [el('strong', { text: gib(ready.reduce(function (sum, n) { return sum + (n.available ? n.available.ramMiB : 0); }, 0)) }), el('span', { text: 'unreserved RAM' })]),
      el('p', { class: 'hint', text: 'Nodes retain the resource limits set by their owners. Select existing deployments together to redistribute their budgets.' })
    ]);
    $('fleet-pool-count').textContent = pool.size + ' selected · ' + ready.length + ' eligible of ' + nodes.length + ' enrolled';
    $('fleet-deployment-count').textContent = selected.size + ' selected · allocations are planned together';
  }
  function renderPool() {
    if (!snapshot || $('fleet-nodes').contains(D.activeElement)) return;
    var query = $('fleet-node-search').value.toLowerCase(), filter = $('fleet-node-filter').value;
    var nodes = snapshot.nodes.filter(function (n) {
      var text = [n.hostname, n.id].concat(n.gpus.map(function (g) { return g.name; }), n.deployments.map(function (d) { return d.name; })).join(' ').toLowerCase();
      return text.indexOf(query) >= 0 && (filter === 'all' || filter === 'eligible' && eligible(n) || filter === 'allocated' && n.deployments.length || filter === 'selected' && pool.has(n.id));
    }).sort(function (a, b) { return Number(eligible(b)) - Number(eligible(a)) || a.hostname.localeCompare(b.hostname); });
    var proposed = preview && preview.status === 'preview' && !dirty && snapshot.revision === preview.revision;
    D.querySelector('.fleet-node-table thead th:nth-child(3)').textContent = proposed ? 'RAM after plan' : 'RAM reserved';
    D.querySelector('.fleet-node-table thead th:nth-child(4)').textContent = proposed ? 'CPU after plan' : 'CPU reserved';
    put('fleet-nodes', paginate(nodes, 'node').map(function (n) {
      var allocation = proposed ? preview.allocations.find(function (a) { return a.nodeId === n.id; }) : n.reserved;
      allocation = allocation || { ramMiB: 0, cpuCores: 0, gpu: [] };
      var offer = n.offer || { ramMiB: 0, cpuCores: 0, gpu: [] };
      var label = !n.online ? 'Offline' : !n.supported ? 'Agent update required' : !eligible(n) ? 'Not offering resources' : 'Online';
      var checkbox = el('input', { type: 'checkbox', checked: pool.has(n.id), disabled: busy() || !eligible(n), 'aria-label': 'Include ' + n.hostname, 'data-fleet-node': n.id, onchange: function () { if (checkbox.checked) pool.add(n.id); else pool.delete(n.id); changed(); renderSummary(); } });
      var gpuLines = n.gpus.map(function (g) {
        var offered = offer.gpu.find(function (x) { return x.id === g.id; }), used = allocation.gpu.find(function (x) { return x.id === g.id; });
        return el('span', { class: 'fleet-hardware-detail', text: g.name + ' · ' + gib(used ? used.memMiB : 0) + ' / ' + gib(offered ? offered.memMiB : 0) + ' GPU reserved' });
      });
      var names = n.deployments.map(function (d) { return d.name; });
      if (proposed) names = n.deployments.filter(function (d) { return !preview.entries.some(function (e) { return e.deploymentId === d.id; }); }).map(function (d) { return d.name; }).concat(preview.entries.filter(function (e) { return e.plan && e.plan.allocations.some(function (a) { return a.nodeId === n.id; }); }).map(function (e) { return e.name; }));
      return el('tr', {}, [el('td', {}, checkbox), el('td', {}, [el('strong', { text: n.hostname }), el('span', { class: 'fleet-hardware-detail' + (!eligible(n) ? ' err' : ''), text: label + ' · ' + n.os })].concat(gpuLines)),
        el('td', {}, bar(allocation.ramMiB, offer.ramMiB, 'ram')), el('td', {}, bar(allocation.cpuCores, offer.cpuCores, 'cpu')), el('td', { class: 'fleet-assignment-names', text: names.join(', ') || 'Unassigned' })]);
    }));
  }
  function renderDeployments() {
    if (!snapshot || $('fleet-deployments').contains(D.activeElement)) return;
    var query = $('fleet-deployment-search').value.toLowerCase();
    var list = snapshot.deployments.filter(function (d) { return (d.spec.name + ' ' + d.spec.profile).toLowerCase().indexOf(query) >= 0; });
    put('fleet-deployments', paginate(list, 'dep').map(function (d) {
      var item = itemFor(d), checked = selected.has(d.id), supported = managed(d);
      var check = el('input', { type: 'checkbox', checked: checked, disabled: busy() || !supported, 'aria-label': 'Allocate ' + d.spec.name, 'data-fleet-deployment': d.id, onchange: function () {
        if (check.checked) selected.set(d.id, item); else selected.delete(d.id); changed(); renderSummary();
        mode.disabled = busy() || !check.checked; cpu.disabled = busy() || !check.checked; edit.disabled = busy() || !check.checked;
      } });
      var mode = el('select', { disabled: busy() || !checked, 'aria-label': d.spec.name + ' placement mode', onchange: function () {
        if (mode.value === 'manual') { openManual(d); mode.value = item.mode; return; }
        item.mode = mode.value; delete item.placement; selected.set(d.id, item); changed();
      } }, [el('option', { value: 'balanced', text: 'Balanced recommendation' }), el('option', { value: 'keep', text: 'Keep current nodes' }), el('option', { value: 'manual', text: 'Manual assignments' })]); mode.value = item.mode;
      var cpu = el('input', { type: 'number', min: 1, max: 65536, value: item.cpuCores || '', placeholder: 'Auto', disabled: busy() || !checked, 'aria-label': d.spec.name + ' CPU cores per node', oninput: function () {
        if (!cpu.value) delete item.cpuCores; else item.cpuCores = Number(cpu.value);
        selected.set(d.id, item); changed();
      } });
      var edit = el('button', { type: 'button', class: 'button button--small', text: 'Assign nodes', disabled: busy() || !checked, onclick: function () { openManual(d); } });
      return el('div', { class: 'fleet-deployment-row' + (checked ? ' is-selected' : '') }, [el('div', { class: 'fleet-deployment-name' }, [check, el('div', {}, [el('strong', { text: d.spec.name }), el('span', { class: 'hint', text: d.spec.profile + ' · ' + d.state + (d.inflight ? ' · ' + d.inflight + ' active requests' : '') }), !supported ? el('span', { class: 'hint', text: 'External and qualified native placements stay fixed.' }) : null])]),
        supported ? el('div', { class: 'fleet-deployment-controls' }, [el('label', {}, [el('span', { class: 'label', text: 'Placement' }), mode]), el('label', { class: 'fleet-cpu-field' }, [el('span', { class: 'label', text: 'CPU / node' }), cpu]), edit]) : null]);
    }));
  }
  function placementText(p) {
    if (!p) return 'No placement';
    if (p.kind === 'replica') return nodeName(p.replicaNodeId) + ' · whole model';
    return nodeName(p.coordinatorNodeId) + ' + ' + ((p.workerNodeIds || []).length) + ' workers';
  }
  function renderReview() {
    $('fleet-review-empty').hidden = !!preview; $('fleet-review-content').hidden = !preview;
    if (!preview) { updateButtons(); return; }
    var stale = preview.status === 'preview' && (dirty || snapshot && snapshot.revision !== preview.revision);
    var phases = preview.entries.filter(function (e) { return e.phase === 'ready'; }).length;
    var title = preview.status === 'preview' ? preview.plannedCount + ' of ' + preview.selectedCount + ' deployments fit' : preview.status === 'applying' ? 'Applying · ' + phases + ' of ' + preview.selectedCount + ' ready' : preview.status === 'succeeded' ? 'Allocation applied · ' + phases + ' deployments ready' : 'Allocation needs attention';
    put('fleet-plan-summary', [el('strong', { text: title }), el('span', { class: 'hint', text: stale ? 'Fleet or selections changed. Recommend again.' : preview.status === 'preview' ? 'Review node changes and budgets before applying.' : 'Progress is saved and survives a page reload.' })]);
    put('fleet-warnings', (preview.error ? [preview.error] : []).concat(preview.warnings || []).map(function (text, i) { return el('p', { class: i === 0 && !preview.error ? 'hint' : 'fleet-warning', text: text }); }));
    put('fleet-results', paginate(preview.entries, 'result').map(function (entry) {
      var details = [];
      if (entry.plan) {
        var rows = entry.plan.allocations.map(function (a) {
          var worker = entry.plan.workers.find(function (w) { return w.nodeId === a.nodeId; });
          var role = worker ? 'Worker · ' + worker.layers + ' layers' : entry.spec.kind === 'replica' ? 'Whole model' : 'Coordinator · ' + entry.plan.tensorSplit[entry.plan.tensorSplit.length - 1] + ' layers';
          return el('tr', {}, [el('td', { text: nodeName(a.nodeId) }), el('td', { text: role }), el('td', { text: gib(a.ramMiB) }), el('td', { text: String(a.cpuCores) }), el('td', { text: a.gpu.map(function (g) { return g.id + ': ' + gib(g.memMiB); }).join(', ') || 'CPU only' })]);
        });
        details.push(el('div', { class: 'table-wrap' }, el('table', { class: 'data fleet-budget-table' }, [el('thead', {}, el('tr', {}, ['Node', 'Role', 'RAM limit', 'CPU cores', 'GPU reservation'].map(function (text) { return el('th', { text: text }); }))), el('tbody', {}, rows)])));
        details.push(el('ul', { class: 'fleet-reasons' }, entry.reasons.map(function (text) { return el('li', { text: text }); })));
      }
      if (entry.error) details.push(el('p', { class: 'err', text: entry.error }));
      return el('article', { class: 'fleet-result' }, [el('div', { class: 'fleet-result-heading' }, [el('h3', { text: entry.name }), el('span', { class: 'fleet-phase', 'data-phase': entry.phase || (entry.error ? 'failed' : 'queued'), text: entry.phase || (entry.error ? 'Does not fit' : 'Proposed') })]),
        entry.spec ? el('div', { class: 'fleet-placement-change' }, [el('span', { text: placementText(entry.before) }), el('span', { 'aria-label': 'changes to', text: '→' }), el('strong', { text: placementText(entry.spec) })]) : null,
        el('details', { open: !!entry.error || preview.entries.length <= 3 }, [el('summary', { text: 'Node budgets and placement reasons' })].concat(details))]);
    }));
    $('fleet-apply-hint').textContent = stale ? 'This preview is out of date. Recommend again before applying.' : preview.status === 'preview' ? 'Applying reloads selected deployments and starts any that are stopped. Active requests must finish first.' : preview.status === 'succeeded' ? 'The selected workloads are running with these resource budgets.' : 'Each deployment shows its current apply result. If interrupted, review the fleet and create a new preview.';
    updateButtons();
  }
  function updateButtons() {
    $('fleet-preview').disabled = busy() || !selected.size || !pool.size || !!manual;
    $('fleet-preview').textContent = working && (!preview || preview.status !== 'applying') ? 'Planning allocation…' : 'Recommend balanced allocation';
    $('fleet-apply').disabled = busy() || !preview || !preview.canApply || preview.status !== 'preview' || dirty || !!manual || !!(snapshot && preview.revision !== snapshot.revision);
    $('fleet-apply').textContent = preview && preview.status === 'applying' ? 'Applying…' : 'Apply and run ' + (preview ? preview.selectedCount : 0) + ' deployments';
    ['fleet-select-deployments', 'fleet-clear-deployments', 'fleet-select-nodes', 'fleet-clear-nodes'].forEach(function (id) { $(id).disabled = busy(); });
  }
  function restoreDraft() {
    var draft;
    try { draft = JSON.parse(localStorage.getItem(STORAGE) || 'null'); } catch (_) {}
    if (draft && Array.isArray(draft.items) && Array.isArray(draft.poolNodeIds)) {
      draft.items.forEach(function (item) { if (item && snapshot.deployments.some(function (d) { return d.id === item.deploymentId && managed(d); })) selected.set(item.deploymentId, item); });
      draft.poolNodeIds.forEach(function (id) { if (snapshot.nodes.some(function (n) { return n.id === id; })) pool.add(id); });
    } else snapshot.nodes.filter(eligible).forEach(function (n) { pool.add(n.id); });
    initialized = true;
  }
  function refresh() {
    if (loading) return loading;
    loading = api('GET', '/api/fleet').then(function (data) {
      snapshot = data;
      if (!initialized) restoreDraft();
      if (!preview && !dirty && snapshot.runs.length) preview = snapshot.runs[0];
      if (preview && preview.status === 'applying') return api('GET', '/api/fleet/' + encodeURIComponent(preview.id)).then(function (run) { preview = run; });
    }).then(function () {
      renderSummary(); renderPool(); renderDeployments(); renderReview(); updateButtons();
    }).catch(function (error) { notice(error.message, true); }).finally(function () { loading = null; });
    return loading;
  }
  function profileFor(d) { return profiles.find(function (p) { return p.id === d.spec.profile; }); }
  function openManual(d) {
    if (busy()) return;
    var item = itemFor(d), placement = item.placement || { kind: d.spec.kind, replicaNodeId: d.plan ? d.plan.coordinatorNodeId : d.spec.replicaNodeId, coordinatorNodeId: d.plan ? d.plan.coordinatorNodeId : d.spec.coordinatorNodeId, workerNodeIds: d.plan ? d.plan.workers.map(function (w) { return w.nodeId; }) : d.spec.workerNodeIds || [], workerLayers: d.spec.workerLayers || (d.plan ? d.plan.workers.map(function (w) { return w.layers; }) : []) };
    manual = { deployment: d, counts: new Map(), order: (placement.workerNodeIds || []).slice(), mtp: (d.spec.chain || 0) > 0 };
    (placement.workerNodeIds || []).forEach(function (id, i) { manual.counts.set(id, (placement.workerLayers || [])[i] || 1); });
    $('fleet-manual-title').textContent = 'Assign nodes · ' + d.spec.name;
    $('fleet-manual-hint').textContent = 'Assignments use only nodes in your selected hardware pool.';
    $('fleet-manual-error').textContent = ''; $('fleet-worker-search').value = ''; pages.worker = 0;
    $('fleet-manual-kind').value = placement.kind === 'replica' ? 'replica' : 'split';
    put('fleet-manual-coordinator', snapshot.nodes.filter(function (n) { return pool.has(n.id); }).map(function (n) { return el('option', { value: n.id, text: n.hostname + (eligible(n) ? '' : ' (unavailable)') }); }));
    $('fleet-manual-coordinator').value = placement.kind === 'replica' ? placement.replicaNodeId || '' : placement.coordinatorNodeId || '';
    if (!$('fleet-manual-coordinator').value && $('fleet-manual-coordinator').options.length) $('fleet-manual-coordinator').selectedIndex = 0;
    renderWorkers(); $('fleet-manual-dialog').showModal(); updateButtons();
    if (!profiles.length) api('GET', '/api/profiles').then(function (data) { profiles = data.profiles; if (manual) renderWorkers(); }).catch(function (error) { $('fleet-manual-error').textContent = error.message; });
  }
  function renderWorkers() {
    if (!manual) return;
    var split = $('fleet-manual-kind').value === 'split', coord = $('fleet-manual-coordinator').value, query = $('fleet-worker-search').value.toLowerCase(), profile = profileFor(manual.deployment);
    $('fleet-manual-workers').hidden = !split; $('fleet-manual-node-label').textContent = split ? 'Coordinator' : 'Model node';
    var qualified = profile ? profile.envelope.filter(function (r) { return (manual.deployment.spec.ctx || 1536) <= r.maxCtx && (manual.deployment.spec.parallel || 1) <= r.maxParallel && (manual.deployment.spec.chain || 0) <= r.maxChain; }).map(function (r) { return r.workerLayers; }).filter(function (n) { return n > 0; }) : [];
    $('fleet-worker-rule').textContent = manual.mtp ? 'Select workers. Layer counts remain inside the qualified MTP profile.' : 'Use 0 to exclude a worker. Qualified counts for this configuration: ' + (qualified.join(', ') || 'loading profile') + '.';
    var list = snapshot.nodes.filter(function (n) { return pool.has(n.id) && n.id !== coord && (n.hostname + ' ' + n.gpus.map(function (g) { return g.name; }).join(' ')).toLowerCase().indexOf(query) >= 0; });
    put('fleet-worker-rows', paginate(list, 'worker').map(function (n) {
      var field = manual.mtp ? el('input', { type: 'checkbox', checked: manual.counts.has(n.id), 'aria-label': 'Use ' + n.hostname + ' as worker' }) : el('input', { type: 'number', min: 0, max: profile ? profile.layers - 1 : 10000, step: 1, value: manual.counts.get(n.id) || 0, 'aria-label': n.hostname + ' worker layers' });
      field.addEventListener(manual.mtp ? 'change' : 'input', function () {
        var value = manual.mtp ? (field.checked ? 1 : 0) : Number(field.value);
        if (value) { manual.counts.set(n.id, value); if (manual.order.indexOf(n.id) < 0) manual.order.push(n.id); } else manual.counts.delete(n.id);
      });
      return el('tr', {}, [el('td', { text: n.hostname }), el('td', { text: n.gpus.map(function (g) { return g.name; }).join(', ') || 'No GPU' }), el('td', {}, field)]);
    }));
  }
  $('fleet-manual-form').addEventListener('submit', function (event) {
    event.preventDefault(); if (!manual || busy()) return;
    var coord = $('fleet-manual-coordinator').value, kind = $('fleet-manual-kind').value;
    if (!coord) { $('fleet-manual-error').textContent = 'Choose a model node.'; return; }
    var placement = kind === 'replica' ? { kind: kind, replicaNodeId: coord } : { kind: kind, coordinatorNodeId: coord, workerNodeIds: manual.order.filter(function (id) { return id !== coord && manual.counts.has(id); }) };
    if (kind === 'split') {
      if (!placement.workerNodeIds.length) { $('fleet-manual-error').textContent = 'Select at least one worker.'; return; }
      if (!manual.mtp) placement.workerLayers = placement.workerNodeIds.map(function (id) { return manual.counts.get(id); });
    }
    var item = itemFor(manual.deployment); item.mode = 'manual'; item.placement = placement; selected.set(item.deploymentId, item);
    $('fleet-manual-dialog').close(); manual = null; changed(); renderDeployments(); renderSummary();
  });
  $('fleet-manual-cancel').addEventListener('click', function () { $('fleet-manual-dialog').close(); manual = null; updateButtons(); });
  $('fleet-manual-dialog').addEventListener('cancel', function () { manual = null; updateButtons(); });
  ['fleet-manual-kind', 'fleet-manual-coordinator'].forEach(function (id) { $(id).addEventListener('change', function () { pages.worker = 0; renderWorkers(); }); });
  $('fleet-worker-search').addEventListener('input', function () { pages.worker = 0; renderWorkers(); });
  $('fleet-node-search').addEventListener('input', function () { pages.node = 0; renderPool(); });
  $('fleet-node-filter').addEventListener('change', function () { pages.node = 0; renderPool(); });
  $('fleet-deployment-search').addEventListener('input', function () { pages.dep = 0; renderDeployments(); });
  ['node', 'dep', 'result', 'worker'].forEach(function (key) { ['prev', 'next'].forEach(function (direction) {
    $('fleet-' + key + '-' + direction).addEventListener('click', function () { pages[key] += direction === 'next' ? 1 : -1; ({ node: renderPool, dep: renderDeployments, result: renderReview, worker: renderWorkers })[key](); });
  }); });
  $('fleet-select-deployments').addEventListener('click', function () { snapshot.deployments.filter(managed).forEach(function (d) { selected.set(d.id, itemFor(d)); }); changed(); renderDeployments(); renderSummary(); });
  $('fleet-clear-deployments').addEventListener('click', function () { selected.clear(); changed(); renderDeployments(); renderSummary(); });
  $('fleet-select-nodes').addEventListener('click', function () { snapshot.nodes.filter(eligible).forEach(function (n) { pool.add(n.id); }); changed(); renderPool(); renderSummary(); });
  $('fleet-clear-nodes').addEventListener('click', function () { pool.clear(); changed(); renderPool(); renderSummary(); });
  $('fleet-new-deployment').addEventListener('click', function () { window.SwarmletAdmin.showTab('deployments'); if ($('dep-form').hidden) $('dep-toggle').click(); $('dep-start-immediately').checked = false; $('dep-start-immediately').dispatchEvent(new Event('change')); });
  $('fleet-preview').addEventListener('click', function () {
    if (busy() || manual) return;
    var invalid = $('fleet-deployments').querySelector('input:invalid'); if (invalid) { invalid.reportValidity(); return; }
    var ticket = draftVersion;
    working = true; notice('Checking hardware and balancing selected deployments…'); updateButtons();
    api('POST', '/api/fleet/preview', { items: Array.from(selected.values()), poolNodeIds: Array.from(pool) }).then(function (run) {
      preview = run; dirty = ticket !== draftVersion; pages.result = 0; notice(dirty ? 'Selections changed during planning. Recommend again.' : run.canApply ? 'Allocation is ready to review.' : 'Some workloads cannot fit. Review the reasons below.', !run.canApply); persist();
    }).catch(function (error) { notice(error.message, true); }).finally(function () { working = false; renderReview(); renderPool(); updateButtons(); });
  });
  $('fleet-apply').addEventListener('click', function () {
    if ($('fleet-apply').disabled) return;
    working = true; updateButtons(); notice('Applying the reviewed allocation…');
    api('POST', '/api/fleet/' + encodeURIComponent(preview.id) + '/apply', {}).then(function (run) { preview = run; notice('Allocation accepted. Progress is shown below.'); }).catch(function (error) { dirty = true; notice(error.message, true); }).finally(function () { working = false; renderReview(); refresh(); });
  });
  window.SwarmletFleet = { refresh: refresh, selectDeployment: function (id) { selected.set(id, { deploymentId: id, mode: 'balanced' }); changed(); refresh(); } };
}());
