/* Keep an open desktop/web window in step with the signed agent serving its UI. */
(function () {
  'use strict';
  var D = document, marker = D.querySelector('meta[name="swarmlet-ui-version"]');
  if (!marker) return;
  var loaded = marker.content, checking = false, reloading = false, holds = 0;
  var dirtyFields = new Map(), generation = 0;
  function dirty(ev) {
    var form = ev.target.form;
    if (form && form.id !== 'chat-form') dirtyFields.set(ev.target, ++generation);
  }
  function clean(element, through) {
    dirtyFields.forEach(function (changed, field) {
      if ((field === element || field.form === element) && changed <= through) dirtyFields.delete(field);
    });
  }
  D.addEventListener('input', dirty, true);
  D.addEventListener('change', dirty, true);
  async function check() {
    if (checking || reloading) return;
    checking = true;
    try {
      var res = await fetch('/ui-version.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      var next = (await res.json()).version;
      if (typeof next !== 'string' || !/^[a-f0-9]{64}$/.test(next) || next === loaded) return;
      var note = D.getElementById('ui-update-note');
      if (note) note.hidden = false;
      if (holds || dirtyFields.size) return;
      // Chat saves its draft/history here, or cancels while a reply is in flight.
      if (!D.dispatchEvent(new Event('swarmlet:before-ui-update', { cancelable: true }))) return;
      reloading = true;
      window.location.reload();
    } catch (_) { /* The agent may be switching releases. Retry after it returns. */ }
    finally { checking = false; }
  }
  window.SwarmletUiUpdate = {
    check: check,
    clean: function (element) { clean(element, Infinity); },
    checkpoint: function (element) {
      var through = generation;
      return function () { clean(element, through); };
    },
    hold: function () {
      holds++;
      var released = false;
      return function () { if (!released) { released = true; holds--; } };
    }
  };
  D.addEventListener('DOMContentLoaded', check, { once: true });
  D.addEventListener('visibilitychange', function () { if (!D.hidden) check(); });
  window.addEventListener('focus', check);
  setInterval(check, 10000);
})();
