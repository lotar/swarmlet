/* Shared by the embedded node UI and hosted workspace. Message storage stays Markdown text. */
(function () {
  'use strict';
  function escape(text) {
    return String(text).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  var parser = new window.marked.Marked({
    gfm: true,
    renderer: {
      html: function (token) { return escape(token.text); },
      // Model-generated images must not fetch third-party URLs merely by rendering a reply.
      image: function (token) { return '<a href="' + escape(token.href) + '">' + escape(token.text || 'Image') + '</a>'; }
    }
  });
  function render(target, text) {
    target.classList.add('markdown-body');
    var fragment = window.DOMPurify.sanitize(parser.parse(String(text || '')), {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
      ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align', 'type', 'checked', 'disabled'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false
    });
    fragment.querySelectorAll('a').forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href) return;
      try {
        var url = new URL(href, window.location.href);
        if (['https:', 'http:', 'mailto:'].indexOf(url.protocol) < 0) { link.removeAttribute('href'); return; }
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      } catch (_) { link.removeAttribute('href'); }
    });
    fragment.querySelectorAll('input').forEach(function (input) { input.type = 'checkbox'; input.disabled = true; });
    target.replaceChildren(fragment);
  }
  window.SwarmletMarkdown = { render: render };
})();
