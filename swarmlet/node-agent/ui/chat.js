/* Participant chat uses the same local /v1 endpoint as SDK clients. No mesh credentials in the UI. */
(function () {
  'use strict';
  var D = document, $ = function (id) { return D.getElementById(id); };
  var processing = window.SwarmletProcessing.create($('chat-processing'));
  var messages = [], busy = false, loading = false, controller = null, catalog = [], saved = {};
  var savedKey = 'swarmlet.node.chat.v1';
  try {
    saved = JSON.parse(localStorage.getItem(savedKey) || '{}') || {};
    if (Array.isArray(saved.messages)) messages = saved.messages.filter(function (m) { return m && ['user', 'assistant'].indexOf(m.role) >= 0 && typeof m.content === 'string'; }).slice(-80);
  } catch (_) {}
  function save() { try { localStorage.setItem(savedKey, JSON.stringify({ model: $('chat-model').value, messages: messages })); } catch (_) {} }
  function error(text) { $('chat-error').textContent = text || ''; $('chat-error').hidden = !text; }
  function messageNode(message) {
    var row = D.createElement('article'); row.className = 'chat-message chat-message--' + message.role;
    var name = D.createElement('h3'); name.textContent = message.role === 'user' ? 'You' : 'Mesh'; row.appendChild(name);
    var text = D.createElement('div'); text.className = 'chat-message-text'; text.textContent = message.content; row.appendChild(text);
    $('chat-transcript').appendChild(row); return text;
  }
  function render() {
    $('chat-transcript').querySelectorAll('.chat-message').forEach(function (node) { node.remove(); });
    $('chat-empty').hidden = !!messages.length;
    messages.forEach(messageNode);
  }
  function setBusy(value) {
    busy = value; $('chat-send').disabled = busy || !$('chat-model').value; $('chat-model').disabled = busy;
    $('chat-new').disabled = busy; $('chat-refresh').disabled = busy; $('chat-stop').hidden = !busy;
    $('chat-input').disabled = busy; $('chat-transcript').setAttribute('aria-busy', String(busy));
  }
  function example() {
    var model = $('chat-model').value || 'MODEL_NAME';
    $('chat-api-url').textContent = location.origin + '/v1';
    $('chat-api-example').textContent = 'from openai import OpenAI\n\nclient = OpenAI(base_url="' + location.origin + '/v1", api_key="local")\nreply = client.chat.completions.create(\n    model=' + JSON.stringify(model) + ',\n    messages=[{"role": "user", "content": "Hello"}]\n)\nprint(reply.choices[0].message.content)';
    processing.select($('chat-model').value);
    var chosen = catalog.find(function (m) { return m.id === model; });
    $('chat-route').textContent = chosen ? (chosen.route === 'local' ? 'Local model server · shortest route' : 'Internet mesh · shared model') : 'No model available';
  }
  async function loadModels() {
    if (loading || busy || D.hidden || $('tab-chat').hidden) return;
    loading = true;
    try {
      var res = await fetch('/v1/models', { signal: AbortSignal.timeout(10000) });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error && body.error.message || 'Models unavailable');
      var previous = $('chat-model').value || saved.model;
      catalog = body.data || [];
      $('chat-model').replaceChildren();
      if (!catalog.length) { var empty = D.createElement('option'); empty.value = ''; empty.textContent = 'No ready models'; $('chat-model').appendChild(empty); }
      catalog.forEach(function (model) { var option = D.createElement('option'); option.value = model.id; option.textContent = model.id + (model.route === 'local' ? ' · local' : ' · mesh'); $('chat-model').appendChild(option); });
      if (catalog.some(function (m) { return m.id === previous; })) $('chat-model').value = previous;
      error(''); example(); setBusy(false);
    } catch (e) { error(e.message); $('chat-route').textContent = 'Mesh unavailable · retry with Refresh'; }
    finally { loading = false; }
  }
  async function send(ev) {
    ev.preventDefault();
    var prompt = $('chat-input').value.trim();
    if (busy || !prompt || !$('chat-model').value) return;
    error(''); messages.push({ role: 'user', content: prompt });
    var history = messages.map(function (m) { return { role: m.role, content: m.content }; });
    var answer = { role: 'assistant', content: '' }; messages.push(answer); render();
    var output = $('chat-transcript').lastElementChild.querySelector('.chat-message-text');
    $('chat-input').value = ''; setBusy(true); save();
    processing.begin($('chat-model').value);
    controller = new AbortController(); var start = performance.now(), route = '', done = false;
    $('chat-status').textContent = 'Waiting for the model…';
    var reader;
    try {
      var response = await fetch('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: $('chat-model').value, messages: history, stream: true, stream_options: { include_usage: true }, max_tokens: 1024, chat_template_kwargs: { enable_thinking: false } }), signal: controller.signal });
      if (!response.ok) { var failure = await response.json(); throw new Error(failure.error && failure.error.message || 'Request failed (HTTP ' + response.status + ')'); }
      if (!response.body) throw new Error('The model returned no stream');
      processing.served(response.headers);
      route = response.headers.get('x-swarmlet-route') === 'local' ? 'Local server' : 'Internet mesh';
      $('chat-status').textContent = route + ' · generating…';
      reader = response.body.getReader(); var decoder = new TextDecoder(), buffer = '';
      function consume(frame) {
        var data = frame.split(/\r?\n/).filter(function (line) { return line.indexOf('data:') === 0; }).map(function (line) { return line.slice(5).trimStart(); }).join('\n');
        if (!data) return;
        if (data === '[DONE]') { done = true; return; }
        var payload = JSON.parse(data);
        processing.feed(payload);
        if (payload.error) throw new Error(payload.error.message || 'Generation failed');
        var delta = payload.choices && payload.choices[0] && payload.choices[0].delta;
        if (delta && typeof delta.content === 'string') {
          var nearBottom = $('chat-transcript').scrollHeight - $('chat-transcript').scrollTop - $('chat-transcript').clientHeight < 100;
          answer.content += delta.content; output.textContent = answer.content;
          if (nearBottom) $('chat-transcript').scrollTop = $('chat-transcript').scrollHeight;
        }
      }
      while (!done) {
        var chunk = await reader.read();
        if (chunk.done) { buffer += decoder.decode(); if (buffer.trim()) consume(buffer); break; }
        buffer += decoder.decode(chunk.value, { stream: true });
        var match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) { consume(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); }
      }
      if (!done) throw new Error('Connection ended before the reply completed. You can retry.');
      processing.finish('complete');
      $('chat-status').textContent = route + ' · ' + ((performance.now() - start) / 1000).toFixed(1) + ' s';
    } catch (e) {
      processing.finish(e.name === 'AbortError' ? 'stopped' : 'error');
      if (e.name === 'AbortError') $('chat-status').textContent = 'Stopped';
      else { error(e.message); $('chat-status').textContent = 'Reply interrupted'; }
    } finally {
      if (reader) await reader.cancel().catch(function () {});
      if (!answer.content) messages.pop();
      save(); setBusy(false); controller = null; $('chat-input').focus();
    }
  }
  $('chat-form').addEventListener('submit', send);
  $('chat-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('chat-form').requestSubmit(); } });
  $('chat-stop').addEventListener('click', function () { if (controller) controller.abort(); });
  $('chat-new').addEventListener('click', function () { processing.reset(); messages = []; render(); save(); error(''); $('chat-input').focus(); });
  $('chat-refresh').addEventListener('click', loadModels);
  $('chat-model').addEventListener('change', function () { example(); save(); });
  $('chat-copy').addEventListener('click', async function () { try { await navigator.clipboard.writeText($('chat-api-example').textContent); $('chat-copy').textContent = 'Copied'; } catch (_) { $('chat-copy').textContent = 'Select the example to copy'; } });
  D.querySelector('[data-tab="chat"][role="tab"]').addEventListener('click', loadModels);
  D.addEventListener('visibilitychange', loadModels);
  render(); example(); loadModels(); setInterval(loadModels, 15000);
}());
