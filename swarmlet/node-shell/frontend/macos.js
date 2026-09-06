(function () {
  'use strict';
  // Exact loopback origin or the bundled splash. Never style a navigated external website.
  var local = location.origin === 'http://127.0.0.1:47800';
  var bundled = location.protocol === 'tauri:' && location.hostname === 'localhost';
  if (!local && !bundled) return;
  var css = __SWARMLET_NATIVE_CSS__;
  function apply() {
    if (document.getElementById('swarmlet-native-style')) return;
    document.documentElement.dataset.nativeShell = 'macos';
    var style = document.createElement('style'); style.id = 'swarmlet-native-style'; style.textContent = css; document.head.appendChild(style);
    var drag = document.createElement('div'); drag.className = 'native-drag-surface'; drag.setAttribute('data-tauri-drag-region', 'true'); drag.setAttribute('aria-hidden', 'true'); drag.title = 'Drag to move window'; document.body.appendChild(drag);
    // The chrome-free drag strip has no double-click maximize action.
    ['mousedown', 'mouseup'].forEach(function (type) { drag.addEventListener(type, function (event) { if (event.detail > 1) event.stopPropagation(); }); });
    var status = document.querySelector('.head-status'), foot = document.querySelector('.sidebar-foot');
    if (status && foot) foot.appendChild(status);
    var brand = document.querySelector('.brand-sub'); if (brand) brand.textContent = 'On your Mac';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
}());
