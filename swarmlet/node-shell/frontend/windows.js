(function () {
  'use strict';
  // Exact loopback origin or the bundled splash (http://tauri.localhost on Windows). Never style a navigated external website.
  var local = location.origin === 'http://127.0.0.1:47800';
  var bundled = location.hostname === 'tauri.localhost' || (location.protocol === 'tauri:' && location.hostname === 'localhost');
  if (!local && !bundled) return;
  var css = __SWARMLET_NATIVE_CSS__;
  var backdrop = __SWARMLET_NATIVE_BACKDROP__;
  function invoke(cmd) {
    var t = window.__TAURI_INTERNALS__;
    if (t && typeof t.invoke === 'function') { try { var p = t.invoke('plugin:window|' + cmd); if (p && p.catch) p.catch(function () {}); } catch (e) { /* not permitted */ } }
  }
  function button(cls, glyph, label, cmd) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'native-caption-button ' + cls; b.textContent = glyph;
    b.setAttribute('aria-label', label); b.title = label; b.tabIndex = -1;
    b.addEventListener('click', function () { invoke(cmd); });
    return b;
  }
  function apply() {
    if (document.getElementById('swarmlet-native-style')) return;
    document.documentElement.dataset.nativeShell = 'windows';
    document.documentElement.dataset.nativeBackdrop = backdrop;
    var style = document.createElement('style'); style.id = 'swarmlet-native-style'; style.textContent = css; document.head.appendChild(style);
    // Frameless window: this strip moves it and double-click toggles maximize (Windows convention).
    var drag = document.createElement('div'); drag.className = 'native-drag-surface'; drag.setAttribute('data-tauri-drag-region', 'true'); drag.setAttribute('aria-hidden', 'true'); drag.title = 'Drag to move window'; document.body.appendChild(drag);
    // Caption controls in the Windows 11 order and size (46 x 32, Segoe Fluent Icons glyphs). Close hides to the tray.
    var caption = document.createElement('div'); caption.className = 'native-caption'; caption.setAttribute('role', 'group'); caption.setAttribute('aria-label', 'Window controls');
    var max = button('native-maximize', '\uE922', 'Maximize', 'internal_toggle_maximize');
    caption.appendChild(button('native-minimize', '\uE921', 'Minimize', 'minimize'));
    caption.appendChild(max);
    caption.appendChild(button('native-close', '\uE8BB', 'Close', 'close'));
    document.body.appendChild(caption);
    function sync() {
      var maximized = window.outerWidth >= screen.availWidth && window.outerHeight >= screen.availHeight;
      max.textContent = maximized ? '\uE923' : '\uE922';
      max.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize'); max.title = max.getAttribute('aria-label');
    }
    window.addEventListener('resize', sync); sync();
    var status = document.querySelector('.head-status'), foot = document.querySelector('.sidebar-foot');
    if (status && foot) foot.appendChild(status);
    var brand = document.querySelector('.brand-sub'); if (brand) brand.textContent = 'On this PC';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
}());
