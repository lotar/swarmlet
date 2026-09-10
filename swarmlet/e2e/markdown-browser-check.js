/* Run with `browse eval swarmlet/e2e/markdown-browser-check.js` after the fixture reply. */
return (async function () {
  function assert(value, message) { if (!value) throw Error(message); }
  var body = document.querySelector('.chat-message--assistant .markdown-body') || document.querySelector('.msg--assistant > .markdown-body');
  assert(body, 'assistant Markdown body');
  assert(body.querySelector('h2').textContent === 'Markdown check', 'heading');
  assert(body.querySelector('strong').textContent === 'Bold' && body.querySelector('em').textContent === 'italic', 'emphasis');
  assert(body.querySelector('ul ul li').textContent === 'Child', 'nested list');
  assert(body.querySelectorAll('ol li').length === 2, 'ordered list');
  assert(body.querySelectorAll('table th').length === 2 && body.querySelector('tbody td').textContent === 'Flash', 'GFM table');
  assert(body.querySelector('pre code').textContent.includes('<script>literal</script>'), 'literal code');
  assert(body.querySelector('blockquote'), 'quote');
  assert(!body.querySelector('script,img,iframe,svg,math,style'), 'no active raw markup');
  assert(!window.markdownExecuted, 'no script execution');
  assert([...body.querySelectorAll('a')].find(a => a.textContent === 'unsafe').getAttribute('href') === null, 'unsafe URL removed');
  assert(body.querySelector('a[href="https://example.com/docs"]').rel === 'noopener noreferrer', 'safe external link');
  assert([...body.querySelectorAll('input')].every(i => i.disabled && i.type === 'checkbox'), 'read-only task list');
  assert(getComputedStyle(body).whiteSpace === 'normal' && getComputedStyle(body.querySelector('pre')).whiteSpace === 'pre', 'paragraph and code whitespace');
  if (document.querySelector('.msg-reasoning')) assert(document.querySelector('.msg-reasoning strong').textContent === 'Reasoning check', 'reasoning Markdown');
  var state = await (await fetch('/fixture-state')).json();
  assert(state.tracking === 0, 'no automatic image requests');
  var saved = JSON.parse(localStorage.getItem('swarmlet.node.chat.v1') || 'null');
  if (document.querySelector('#chat-transcript')) assert(saved.messages.at(-1).content === state.markdown, 'history preserves original Markdown');
  var probe = document.createElement('div');
  window.SwarmletMarkdown.render(probe, '```js\nconst x = "<b>";');
  assert(probe.querySelector('pre code').textContent.includes('<b>'), 'open streaming code fence');
  window.SwarmletMarkdown.render(probe, '```js\nconst x = "<b>";\n```\n\n**Finished**');
  assert(probe.querySelector('strong').textContent === 'Finished', 'closed streaming fence');
  return { pass: true, surface: document.querySelector('#chat-transcript') ? 'node' : 'hosted', headings: true, lists: true, tables: true, code: true, streamingFences: true, sanitized: true, imageRequests: state.tracking };
})();
