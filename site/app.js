/* Swarmlet site: dependency-free interaction and three routing diagrams. */
(function () {
  'use strict';

  var D = document;
  var W = window;
  var REDUCED = !!(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* GA4 stays completely unloaded until the visitor opts in. */
  var analyticsMeta = D.querySelector('meta[name="swarmlet-analytics-id"]');
  var analyticsId = analyticsMeta ? analyticsMeta.content.trim() : '';
  var analyticsBanner = D.getElementById('analytics-consent');
  var analyticsAllow = D.getElementById('analytics-allow');
  var analyticsDeny = D.getElementById('analytics-deny');
  var analyticsSettings = D.getElementById('analytics-settings');
  var analyticsStorageKey = 'swarmlet.analytics-consent.v1';
  var analyticsLoaded = false;

  function analyticsChoice() {
    try { return W.localStorage.getItem(analyticsStorageKey); } catch (_) { return null; }
  }

  function saveAnalyticsChoice(value) {
    try { W.localStorage.setItem(analyticsStorageKey, value); } catch (_) { /* Keep the in-page choice only. */ }
  }

  function gtag() {
    W.dataLayer = W.dataLayer || [];
    W.dataLayer.push(arguments);
  }

  function updateAnalyticsConsent(value) {
    gtag('consent', 'update', {
      analytics_storage: value,
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });
  }

  function analyticsReferrer() {
    if (!D.referrer) return '';
    try { return new URL(D.referrer).origin; } catch (_) { return ''; }
  }

  function loadAnalytics() {
    if (analyticsLoaded || !/^G-[A-Z0-9]+$/i.test(analyticsId)) return;
    analyticsLoaded = true;
    updateAnalyticsConsent('granted');
    gtag('js', new Date());
    gtag('config', analyticsId, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      anonymize_ip: true,
      cookie_flags: 'SameSite=Lax;Secure',
      page_location: W.location.origin + W.location.pathname,
      page_referrer: analyticsReferrer()
    });
    var script = D.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(analyticsId);
    D.head.appendChild(script);
  }

  function clearAnalyticsCookies() {
    D.cookie.split(';').forEach(function (item) {
      var name = item.split('=')[0].trim();
      if (name !== '_ga' && name.indexOf('_ga_') !== 0) return;
      D.cookie = name + '=; Max-Age=0; Path=/; SameSite=Lax; Secure';
      D.cookie = name + '=; Max-Age=0; Path=/; Domain=.' + W.location.hostname + '; SameSite=Lax; Secure';
    });
  }

  function chooseAnalytics(value) {
    saveAnalyticsChoice(value);
    if (analyticsBanner) analyticsBanner.hidden = true;
    if (value === 'granted') loadAnalytics();
    else {
      updateAnalyticsConsent('denied');
      clearAnalyticsCookies();
    }
  }

  gtag('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    wait_for_update: 500
  });

  if (analyticsBanner && analyticsAllow && analyticsDeny) {
    analyticsAllow.addEventListener('click', function () { chooseAnalytics('granted'); });
    analyticsDeny.addEventListener('click', function () { chooseAnalytics('denied'); });
    if (analyticsSettings) analyticsSettings.addEventListener('click', function () {
      analyticsBanner.hidden = false;
      analyticsAllow.focus();
    });
    if (analyticsChoice() === 'granted') loadAnalytics();
    else if (analyticsChoice() !== 'denied') analyticsBanner.hidden = false;
  }

  W.swarmletAnalytics = {
    track: function (name, parameters) {
      if (analyticsChoice() !== 'granted' || !analyticsLoaded) return;
      gtag('event', name, parameters || {});
    }
  };

  /* Reveal content only as progressive enhancement. */
  var reveal = [].slice.call(D.querySelectorAll('.reveal'));
  if (REDUCED || !('IntersectionObserver' in W)) {
    reveal.forEach(function (el) { el.classList.add('in'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries, observer) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveal.forEach(function (el) { revealObserver.observe(el); });
  }

  /* One-field wishlist. The API stores only the normalized email and consent metadata. */
  var form = D.getElementById('wishlist-form');
  if (form && W.fetch) {
    var email = D.getElementById('wishlist-email');
    var error = D.getElementById('wishlist-error');
    var status = D.getElementById('wishlist-status');
    var submit = form.querySelector('button[type="submit"]');
    var submitLabel = submit.textContent;
    var validEmail = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

    function validate() {
      var value = email.value.trim();
      var valid = validEmail.test(value);
      email.setAttribute('aria-invalid', valid ? 'false' : 'true');
      error.textContent = valid ? '' : 'Enter a complete email address.';
      return valid;
    }

    email.addEventListener('blur', validate);
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!validate()) { email.focus(); return; }

      submit.disabled = true;
      submit.textContent = 'Saving…';
      form.setAttribute('aria-busy', 'true');
      error.textContent = '';

      try {
        var response = await W.fetch('/api/wishlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.value.trim() }),
        });
        if (!response.ok) throw new Error('wishlist request failed');
        W.swarmletAnalytics.track('wishlist_signup', { form_location: 'homepage' });
        form.classList.add('is-ready');
        email.value = '';
        status.focus();
      } catch (_) {
        error.textContent = 'Could not save right now. Try again.';
        email.focus();
      } finally {
        submit.disabled = false;
        submit.textContent = submitLabel;
        form.removeAttribute('aria-busy');
      }
    });
  }

  /* WebGL graph engine. Packets move only along the paths described by the HTML labels. */
  var GL_OFF = /[?&]gl=off/.test(W.location.search);
  var GL_FORCE = /[?&]gl=force/.test(W.location.search);
  var errors = [];
  var graphs = [];
  var graphByCanvas = new WeakMap();
  var raf = 0;

  var SCENES = {
    adaptive: {
      nodes: [[-.72, .64], [-.72, .14], [-.72, -.36], [-.72, -.80], [.04, -.06], [.68, -.06]],
      edges: [[0, 4], [1, 4], [2, 4], [3, 4], [4, 5]],
      routes: [[0, 4, 5], [1, 4, 5], [2, 4, 5], [3, 4, 5]],
      accent: [4, 5]
    },
    split: {
      nodes: [[-.76, 0], [-.04, .70], [-.04, .24], [-.04, -.24], [-.04, -.70], [.72, 0]],
      edges: [[0, 1], [0, 2], [0, 3], [0, 4], [1, 5], [2, 5], [3, 5], [4, 5]],
      routes: [[0, 1, 5], [0, 2, 5], [0, 3, 5], [0, 4, 5]],
      accent: [5]
    },
    federation: {
      nodes: [[-.68, .40], [-.68, -.40], [-.10, 0], [.36, 0], [.76, .40], [.76, -.40]],
      edges: [[0, 2], [1, 2], [2, 3], [3, 4], [3, 5]],
      routes: [[0, 2, 1], [1, 2, 3, 4], [5, 3, 4]],
      accent: [2, 3]
    }
  };

  function color(name) {
    var raw = W.getComputedStyle(D.documentElement).getPropertyValue(name).trim();
    var match = raw.match(/^#([0-9a-f]{6})$/i);
    if (!match) return [1, 1, 1];
    var hex = match[1];
    return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
  }

  function shader(gl, type, source) {
    var item = gl.createShader(type);
    gl.shaderSource(item, source);
    gl.compileShader(item);
    if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) {
      errors.push(gl.getShaderInfoLog(item) || 'shader compile failed');
      gl.deleteShader(item);
      return null;
    }
    return item;
  }

  function program(gl) {
    var vertex = shader(gl, gl.VERTEX_SHADER, [
      'attribute vec2 a_pos;',
      'attribute vec3 a_color;',
      'attribute float a_size;',
      'uniform float u_dpr;',
      'varying vec3 v_color;',
      'void main(){',
      '  gl_Position=vec4(a_pos,0.0,1.0);',
      '  gl_PointSize=max(1.0,a_size*u_dpr);',
      '  v_color=a_color;',
      '}'
    ].join('\n'));
    var fragment = shader(gl, gl.FRAGMENT_SHADER, [
      'precision mediump float;',
      'uniform float u_points;',
      'uniform float u_alpha;',
      'varying vec3 v_color;',
      'void main(){',
      '  float alpha=u_alpha;',
      '  if(u_points>0.5){',
      '    vec2 p=gl_PointCoord*2.0-1.0;',
      '    float d=dot(p,p);',
      '    if(d>1.0) discard;',
      '    alpha*=1.0-smoothstep(0.64,1.0,d);',
      '  }',
      '  gl_FragColor=vec4(v_color,alpha);',
      '}'
    ].join('\n'));
    if (!vertex || !fragment) return null;
    var item = gl.createProgram();
    gl.attachShader(item, vertex);
    gl.attachShader(item, fragment);
    gl.linkProgram(item);
    if (!gl.getProgramParameter(item, gl.LINK_STATUS)) {
      errors.push(gl.getProgramInfoLog(item) || 'program link failed');
      return null;
    }
    return item;
  }

  function verticesForEdges(scene, lineColor) {
    var data = [];
    scene.edges.forEach(function (edge) {
      edge.forEach(function (index) {
        var point = scene.nodes[index];
        data.push(point[0], point[1], lineColor[0], lineColor[1], lineColor[2], 1);
      });
    });
    return new Float32Array(data);
  }

  function verticesForNodes(scene, privateColor, accentColor) {
    var data = [];
    scene.nodes.forEach(function (point, index) {
      var c = scene.accent.indexOf(index) >= 0 ? accentColor : privateColor;
      data.push(point[0], point[1], c[0], c[1], c[2], scene.accent.indexOf(index) >= 0 ? 10 : 7);
    });
    return new Float32Array(data);
  }

  function packetVertices(scene, time, accentColor) {
    var data = [];
    scene.routes.forEach(function (route, routeIndex) {
      var segments = route.length - 1;
      var progress = ((time / 1800) + routeIndex * .47) % segments;
      var segment = Math.floor(progress);
      var local = progress - segment;
      local = local * local * (3 - 2 * local);
      var a = scene.nodes[route[segment]];
      var b = scene.nodes[route[segment + 1]];
      data.push(a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local,
        accentColor[0], accentColor[1], accentColor[2], 8);
    });
    return new Float32Array(data);
  }

  function createGraph(canvas) {
    var scene = SCENES[canvas.getAttribute('data-scene')];
    if (!scene) return null;
    var attributes = { alpha: true, antialias: true, depth: false, stencil: false, powerPreference: 'low-power' };
    var gl;
    try {
      gl = canvas.getContext('webgl', GL_FORCE ? attributes : Object.assign({ failIfMajorPerformanceCaveat: true }, attributes)) || canvas.getContext('experimental-webgl', attributes);
    } catch (contextError) { errors.push('context: ' + contextError.message); }
    if (!gl) { errors.push('no context: ' + canvas.getAttribute('data-scene')); return null; }

    var p = program(gl);
    if (!p) return null;
    var privateColor = color('--ink');
    var accentColor = color('--signal');
    var lineColor = color('--line');
    var edgeData = verticesForEdges(scene, lineColor);
    var nodeData = verticesForNodes(scene, privateColor, accentColor);
    var edgeBuffer = gl.createBuffer();
    var nodeBuffer = gl.createBuffer();
    var packetBuffer = gl.createBuffer();
    var aPos = gl.getAttribLocation(p, 'a_pos');
    var aColor = gl.getAttribLocation(p, 'a_color');
    var aSize = gl.getAttribLocation(p, 'a_size');
    var uDpr = gl.getUniformLocation(p, 'u_dpr');
    var uPoints = gl.getUniformLocation(p, 'u_points');
    var uAlpha = gl.getUniformLocation(p, 'u_alpha');

    gl.useProgram(p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    canvas.classList.add('gl-ready');

    function bind(buffer, data, usage) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 24, 8);
      gl.enableVertexAttribArray(aSize);
      gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, 24, 20);
    }

    function size() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(W.devicePixelRatio || 1, W.innerWidth < 640 ? 1.5 : 2);
      var width = Math.max(1, Math.round(rect.width * dpr));
      var height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      return dpr;
    }

    var graph = {
      canvas: canvas,
      visible: true,
      render: function (time) {
        var dpr = size();
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(p);
        gl.uniform1f(uDpr, dpr);

        bind(edgeBuffer, edgeData, gl.STATIC_DRAW);
        gl.uniform1f(uPoints, 0);
        gl.uniform1f(uAlpha, .42);
        gl.drawArrays(gl.LINES, 0, edgeData.length / 6);

        bind(nodeBuffer, nodeData, gl.STATIC_DRAW);
        gl.uniform1f(uPoints, 1);
        gl.uniform1f(uAlpha, .9);
        gl.drawArrays(gl.POINTS, 0, nodeData.length / 6);

        var packetData = packetVertices(scene, time, accentColor);
        bind(packetBuffer, packetData, gl.DYNAMIC_DRAW);
        gl.uniform1f(uAlpha, 1);
        gl.drawArrays(gl.POINTS, 0, packetData.length / 6);
      }
    };

    canvas.addEventListener('webglcontextlost', function (event) {
      event.preventDefault();
      graph.visible = false;
      errors.push('context lost: ' + canvas.getAttribute('data-scene'));
    });
    if ('ResizeObserver' in W) new ResizeObserver(function () { graph.render(REDUCED ? 720 : performance.now()); }).observe(canvas);
    return graph;
  }

  function frame(time) {
    raf = 0;
    var anyVisible = false;
    graphs.forEach(function (graph) {
      if (!graph.visible) return;
      anyVisible = true;
      graph.render(time);
    });
    if (anyVisible && !REDUCED) raf = W.requestAnimationFrame(frame);
  }

  function start() {
    if (!raf && !REDUCED) raf = W.requestAnimationFrame(frame);
  }

  function initCanvas(canvas) {
    if (graphByCanvas.has(canvas)) return graphByCanvas.get(canvas);
    var graph = createGraph(canvas);
    graphByCanvas.set(canvas, graph || false);
    if (!graph) return null;
    graphs.push(graph);
    graph.render(REDUCED ? 720 : performance.now());
    start();
    return graph;
  }

  function initGraphs() {
    if (GL_OFF || !W.WebGLRenderingContext) return;
    var canvases = [].slice.call(D.querySelectorAll('canvas[data-scene]'));
    if (!('IntersectionObserver' in W)) {
      canvases.forEach(initCanvas);
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var graph = graphByCanvas.get(entry.target);
        if (entry.isIntersecting && !graph) graph = initCanvas(entry.target);
        if (graph) graph.visible = entry.isIntersecting;
      });
      start();
    }, { rootMargin: '220px 0px' });
    canvases.forEach(function (canvas) { observer.observe(canvas); });
  }

  function boot() {
    var idle = W.requestIdleCallback || function (callback) { W.setTimeout(callback, 1); };
    idle(initGraphs, { timeout: 500 });
  }

  W.__sw = { views: graphs, err: errors };
  if (D.readyState === 'complete') boot(); else W.addEventListener('load', boot, { once: true });
}());
