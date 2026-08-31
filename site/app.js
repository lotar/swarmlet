/* Swarmlet teaser — no dependencies, no third-party scripts, no storage beyond the local form note.
   Progressive enhancement only: the page is complete and readable with JS disabled,
   and the WebGL mesh degrades to the CSS gradient if anything about GL fails. */
(function () {
  'use strict';
  var D = document, W = window;
  var RM = W.matchMedia ? W.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

  /* ───────────────────────── scroll progress ───────────────────────── */
  var prog = D.getElementById('prog'), pTick = false, scrollY = 0;
  function onScroll() {
    if (pTick) return; pTick = true;
    W.requestAnimationFrame(function () {
      pTick = false;
      scrollY = W.scrollY || W.pageYOffset || 0;
      if (prog) {
        var h = D.documentElement.scrollHeight - W.innerHeight;
        prog.style.transform = 'scaleX(' + (h > 0 ? Math.min(1, scrollY / h) : 0) + ')';
      }
    });
  }
  W.addEventListener('scroll', onScroll, { passive: true });

  /* ───────────────────────── scrollspy ───────────────────────── */
  var links = [].slice.call(D.querySelectorAll('.nav__links a[href^="#"]:not(.nav__cta)'));
  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  var secs = [].slice.call(D.querySelectorAll('main section[id]')).filter(function (s) { return byId[s.id]; });
  if ('IntersectionObserver' in W && secs.length) {
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (l) { l.removeAttribute('aria-current'); });
        byId[e.target.id].setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    secs.forEach(function (s) { spy.observe(s); });
  }

  /* close the mobile disclosure after a choice */
  D.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('.nav__pop a') : null;
    if (a) { var dd = D.querySelector('.nav__menu'); if (dd) dd.removeAttribute('open'); }
  });

  /* ───────────────────────── reveal, bars, loop ───────────────────────── */
  var anim = [].slice.call(D.querySelectorAll('.rv,[data-anim]'));
  if (RM || !('IntersectionObserver' in W)) anim.forEach(function (n) { n.classList.add('in'); });
  else {
    var io = new IntersectionObserver(function (es, o) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); o.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.06 });
    anim.forEach(function (n) { io.observe(n); });
  }

  /* ───────────────────────── counters ───────────────────────── */
  var nums = [].slice.call(D.querySelectorAll('[data-count]'));
  function paint(el, v) { el.textContent = v.toFixed(+(el.getAttribute('data-dec') || 0)); }
  function run(el) {
    var to = parseFloat(el.getAttribute('data-count')) || 0;
    if (RM) { paint(el, to); return; }
    var t0 = 0, dur = 620;
    (function step(t) {
      if (!t0) t0 = t;
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      paint(el, to * e);
      if (p < 1) W.requestAnimationFrame(step);
    })(0);
  }
  if (!('IntersectionObserver' in W)) nums.forEach(function (n) { paint(n, parseFloat(n.getAttribute('data-count')) || 0); });
  else {
    var io2 = new IntersectionObserver(function (es, o) {
      es.forEach(function (e) { if (e.isIntersecting) { run(e.target); o.unobserve(e.target); } });
    }, { threshold: 0.4 });
    nums.forEach(function (n) { io2.observe(n); });
  }

  /* ───────────────────────── access form ───────────────────────── */
  var f = D.getElementById('access-form');
  if (f) {
    var ok = D.getElementById('ok'), mailto = D.getElementById('ok-mail');
    /* native validation only when this script is the one handling submit */
    f.noValidate = true;
    var rules = {
      'f-name': ['name', function (v) { return v.length >= 2; }, 'Tell us who to reply to.'],
      'f-org': ['org', function (v) { return v.length >= 2; }, 'Company or agency, please.'],
      'f-email': ['email', function (v) { return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v); }, 'A work email we can answer.'],
      'f-hw': ['hardware', function (v) { return !!v; }, 'Pick the closest match.'],
      'f-work': ['workflows', function (v) { return v.length >= 4; }, 'Two or three recurring workflows.']
    };
    function val(id) {
      var el = D.getElementById(id), r = rules[id], err = D.getElementById('e-' + r[0]);
      var good = r[1](el.value.trim());
      if (err) err.textContent = good ? '' : r[2];
      el.setAttribute('aria-invalid', good ? 'false' : 'true');
      return good;
    }
    Object.keys(rules).forEach(function (id) {
      var el = D.getElementById(id);
      if (el) el.addEventListener('blur', function () { val(id); });
    });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var bad = null;
      Object.keys(rules).forEach(function (id) { if (!val(id) && !bad) bad = D.getElementById(id); });
      if (bad) { bad.focus(); return; }
      var d = {};
      new FormData(f).forEach(function (v, k) { d[k] = String(v); });
      var body = 'Name: ' + d.name + '\nOrganisation: ' + d.org + '\nEmail: ' + d.email +
        '\nHardware: ' + d.hardware + '\nRecurring workflows: ' + d.workflows + '\n';
      if (mailto) mailto.href = 'mailto:hello@swarmlet.ai?subject=' + encodeURIComponent('Deployment request — ' + d.org) + '&body=' + encodeURIComponent(body);
      try {
        var all = JSON.parse(W.localStorage.getItem('swarmlet.requests') || '[]');
        all.push({ t: Date.now(), d: d });
        W.localStorage.setItem('swarmlet.requests', JSON.stringify(all.slice(-50)));
      } catch (err) { /* storage disabled — the mail path still works */ }
      var ep = f.getAttribute('data-endpoint');
      if (ep) { try { W.fetch(ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d), keepalive: true }); } catch (err) { } }
      f.classList.add('done');
      if (ok) { ok.classList.add('show'); ok.focus(); }
    });
  }

  /* ───────────────────────── WebGL mesh ─────────────────────────
     One context per canvas (a WebGL context belongs to exactly one canvas).
     One tiny fragment program per context; a single fullscreen triangle.
     Everything is drawn as premultiplied alpha over the CSS background, so a
     dead or missing canvas simply shows the page's own gradient.            */
  function rnd(n) { var x = Math.sin(n) * 43758.5453; return x - Math.floor(x); }

  /* Node placement on a jittered lattice with holes, then wired to nearest
     neighbours with hub-style degrees plus the odd long-haul link. A full
     lattice wired 3-ways reads as a fence; dropped nodes and uneven degree
     read as a network someone actually built. */
  function graph(aspect, cfg) {
    /* pitch is measured in canvas heights; narrow canvases would otherwise get
       three columns of very long links, so hold the pitch closer to square */
    var s = cfg.spacing * Math.max(0.62, Math.min(1, aspect / 1.6));
    var ox = aspect * 0.5 + s, oy = 0.5 + s;
    var cols = Math.max(2, Math.ceil((ox * 2) / s)), rows = Math.max(2, Math.ceil((oy * 2) / s));
    var idx = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
    var pts = [], i, j, k;
    for (j = 0; j <= rows; j++) {
      for (i = 0; i <= cols; i++) {
        var n = j * (cols + 1) + i;
        var keep = rnd(i * 7.11 + j * 3.37 + cfg.seed);
        var border = (i === 0 || j === 0 || i === cols || j === rows);
        if (!border && keep > cfg.live) continue;                 /* holes in the lattice */
        var h1 = rnd(i * 12.9898 + j * 78.233 + cfg.seed);
        var h2 = rnd(i * 39.425 + j * 11.135 + cfg.seed * 1.7);
        idx[n] = pts.length;
        pts.push({
          x: -ox + (i + (h1 - 0.5) * 0.82) * s,
          y: -oy + (j + (h2 - 0.5) * 0.82) * s, gi: i, gj: j,
          ph: rnd(i * 5.11 + j * 3.77 + cfg.seed * 2.3),
          dep: 0.55 + 0.45 * rnd(i * 2.7 + j * 9.1 + cfg.seed)
        });
      }
    }
    var deg = function (i) { var r = rnd(i * 17.13 + cfg.seed * 5.3); return r > 0.88 ? 4 : r > 0.34 ? 3 : r > 0.12 ? 2 : 1; };
    var cand = [], edges = [], seen = {};
    function add(a, b, len) {
      var key = (a < b ? a : b) + '_' + (a < b ? b : a);
      if (seen[key]) return; seen[key] = 1;
      edges.push([a, b, rnd(a * 3.31 + b * 7.7 + cfg.seed), 0.5 + 0.8 * rnd(a * 8.1 + b * 1.9 + cfg.seed * 3.1), len]);
    }
    for (i = 0; i < pts.length; i++) {
      cand.length = 0;
      /* lattice coordinates are recoverable because we walk the grid in order */
      var gi = pts[i].gi, gj = pts[i].gj;
      for (var dj = -2; dj <= 2; dj++) {
        for (var di = -2; di <= 2; di++) {
          var nj = gj + dj, ni = gi + di;
          if (nj < 0 || ni < 0 || nj > rows || ni > cols) continue;
          var t = idx[nj * (cols + 1) + ni];
          if (t < 0 || t === i) continue;
          var dx = pts[i].x - pts[t].x, dy = pts[i].y - pts[t].y, dd = Math.sqrt(dx * dx + dy * dy);
          cand.push([dd, t]);
        }
      }
      cand.sort(function (a, b) { return a[0] - b[0]; });
      var near = cand.filter(function (c) { return c[0] < s * 1.55; });
      var want = deg(i);
      for (k = 0; k < Math.min(near.length, want); k++) add(i, near[k][1], near[k][0] / s);
      /* every so often, a long-haul link to a distant node */
      var far = cand.filter(function (c) { return c[0] > s * 1.9 && c[0] < s * 2.45; });
      if (far.length && rnd(i * 23.7 + cfg.seed * 7.1) > 1 - (cfg.haul === undefined ? 0.10 : cfg.haul)) add(i, far[0][1], far[0][0] / s);
      else if (!near.length && cand.length) add(i, cand[0][1], cand[0][0] / s);   /* never orphan a node */
    }

    /* ── firing schedule ───────────────────────────────────────────────────
       A pulse leaves a node, crosses one edge, and the node it lands on fires
       the instant it arrives. So traffic does not shimmer randomly: it walks
       the graph in cascades, the way a burst walks a real network. */
    var HOP = 0.13;                                  /* cycle fraction per lattice spacing */
    var adj = {};
    for (i = 0; i < edges.length; i++) {
      (adj[edges[i][0]] || (adj[edges[i][0]] = [])).push(i);
      (adj[edges[i][1]] || (adj[edges[i][1]] = [])).push(i);
    }
    var fire = new Float64Array(pts.length).fill(NaN);
    var order = pts.map(function (_, n) { return n; }).sort(function (x, y) { return rnd(x * 5.1 + cfg.seed) - rnd(y * 5.1 + cfg.seed); });
    var q = [];
    for (i = 0; i < order.length; i++) {
      var root = order[i];
      if (!isNaN(fire[root])) continue;
      fire[root] = rnd(root * 1.73 + cfg.seed * 2.3);
      q.length = 0; q.push(root);
      for (var qi = 0; qi < q.length; qi++) {
        var cur = q[qi], es = adj[cur] || [];
        for (k = 0; k < es.length; k++) {
          var ee = edges[es[k]], other = ee[0] === cur ? ee[1] : ee[0];
          if (!isNaN(fire[other])) continue;
          fire[other] = (fire[cur] + Math.max(0.05, ee[4]) * HOP) % 1;
          q.push(other);
        }
      }
    }
    /* every edge carries traffic downhill from whichever end fired first */
    for (i = 0; i < edges.length; i++) {
      var ee2 = edges[i], fa = fire[ee2[0]], fb = fire[ee2[1]];
      var fwd = (fb - fa + 1) % 1, bwd = (fa - fb + 1) % 1;
      ee2[5] = fwd <= bwd ? ee2[0] : ee2[1];
      ee2[6] = Math.min(0.5, Math.max(0.05, Math.min(fwd, bwd)));
    }

    /* interleaved per vertex: A(2) B(2) side(1) t(1) seed(1) fire(1) dur(1) dep(1) = 10 floats */
    var a = new Float32Array(edges.length * 6 * 10), o = 0;
    function vert(p, q, side, t, e) {
      a[o++] = p.x; a[o++] = p.y; a[o++] = q.x; a[o++] = q.y;
      a[o++] = side; a[o++] = t; a[o++] = e[2]; a[o++] = fire[e[5]]; a[o++] = e[6];
      a[o++] = t ? q.dep : p.dep;
    }
    var TRI = [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]];
    for (i = 0; i < edges.length; i++) {
      var e = edges[i], src = pts[e[5]], dst = pts[e[5] === e[0] ? e[1] : e[0]];
      for (k = 0; k < 6; k++) vert(src, dst, TRI[k][0], TRI[k][1], e);
    }
    /* nodes: pos(2) fire(1) depth(1) */
    var nb = new Float32Array(pts.length * 4), m = 0;
    for (i = 0; i < pts.length; i++) { nb[m++] = pts[i].x; nb[m++] = pts[i].y; nb[m++] = fire[i]; nb[m++] = pts[i].dep; }
    return { lines: a, nVerts: edges.length * 6, nodes: nb, nNodes: pts.length, edges: edges.length };
  }

  var VS_LINE = [
    'attribute vec2 aA,aB;attribute float aSide,aT,aSeed,aPhase,aDur,aDep;',
    'uniform vec2 u_ptr;uniform float u_t,u_aspect,u_w,u_par;',
    'varying float v_t,v_d,v_seed,v_phase,v_dur,v_dep;',
    'void main(){',
    /* slow drift + pointer parallax, scaled by node depth */
    ' float dep=aDep;',
    ' vec2 p=mix(aA,aB,aT)+vec2(u_t*0.0055,sin(u_t*0.037)*0.004)*dep+u_ptr*0.028*u_par*dep;',
    /* widen the segment across its own normal, in canvas-height units */
    ' vec2 d=normalize(aB-aA);',
    ' p+=vec2(-d.y,d.x)*(aSide*u_w);',
    ' v_t=aT;v_d=aSide*u_w;v_seed=aSeed;v_phase=aPhase;v_dur=aDur;v_dep=dep;',
    ' gl_Position=vec4(p.x/(u_aspect*0.5),p.y/0.5,0.0,1.0);}'
  ].join('\n');

  var VS_NODE = [
    'attribute vec2 aP;attribute float aPh,aDep;',
    'uniform vec2 u_ptr;uniform float u_t,u_aspect,u_par,u_pt;',
    'varying float v_ph,v_lit,v_dep;',
    'void main(){',
    ' vec2 p=aP+vec2(u_t*0.011,sin(u_t*0.085)*0.0045)*aDep+u_ptr*0.028*u_par*aDep;',
    /* same clock as the packets: a node flashes the instant a pulse lands on it */
    ' float ft=fract(u_t+aPh);',
    ' v_lit=exp(-ft*7.0);',
    ' v_ph=aPh;v_dep=aDep;',
    ' gl_Position=vec4(p.x/(u_aspect*0.5),p.y/0.5,0.0,1.0);',
    ' gl_PointSize=u_pt*(0.72+0.46*aDep)*(1.0+0.7*v_lit);}'
  ].join('\n');

  var FS_LINE = [
    'precision highp float;',
    'uniform vec2 u_res;uniform vec3 u_line,u_acc;uniform float u_t,u_gain,u_mask,u_vm,u_core,u_px,u_la,u_pk;',
    'varying float v_t,v_d,v_seed,v_phase,v_dur,v_dep;',
    'void main(){',
    /* hairline across the quad, ~1 device pixel, soft on the outer half-pixel */
    /* screen-space hairline: continuous at any dpr, no MSAA needed */
    ' float line=1.0-smoothstep(u_core,u_core+u_px,abs(v_d));',
    ' line*=0.86+0.14*v_dep;',
    /* ends fade into the nodes so the lattice has no hard stubs */
    ' float taper=smoothstep(0.0,0.13,v_t)*smoothstep(0.0,0.13,1.0-v_t);',
    ' line*=0.22+0.78*taper;',
    /* one pulse per active edge per cycle. it departs at fire[src] and lands at
       fire[dst], where the node lights up and sends the next pulse: a cascade. */
    ' float cyc=fract(u_t+v_phase);',
    ' float on=step(cyc,v_dur)*step(0.34,fract(v_seed*13.31));',
    ' float s=cyc/max(v_dur,0.05);',
    ' float head=exp(-pow((v_t-s)/0.018,2.0));',
    ' float tail=exp(-pow((v_t-s+0.05)/0.05,2.0))*0.38;',
    ' float pkt=(head+tail)*on*taper;',
    /* the wire itself brightens for as long as the pulse is crossing it */
    ' line*=0.86+0.14*v_dep;',
    ' float m=mix(1.0,smoothstep(-0.2,1.15,gl_FragCoord.x/u_res.x),u_mask);',
    /* narrow screens carry copy edge to edge: lift the field off the text block */
    ' m*=mix(1.0,1.0-smoothstep(0.05,0.48,gl_FragCoord.y/u_res.y),u_vm);',
    /* dissolve before the canvas edge so a section never cuts the field off */
    ' m*=smoothstep(0.0,0.09,gl_FragCoord.y/u_res.y)*smoothstep(0.0,0.09,1.0-gl_FragCoord.y/u_res.y);',
    ' float ink=line*(u_la+0.30*on)*u_gain*m;',
    ' float acc=clamp(pkt*u_pk*1.05*u_gain*m,0.0,1.0);',
    ' vec3 prem=u_acc*acc+(1.0-acc)*u_line*ink;',
    ' gl_FragColor=vec4(prem,clamp(acc+(1.0-acc)*ink,0.0,1.0));}'
  ].join('\n');

  var FS_NODE = [
    'precision highp float;',
    'uniform vec2 u_res;uniform vec3 u_line,u_acc;uniform float u_gain,u_mask,u_vm,u_t,u_pt,u_na;',
    'varying float v_ph,v_lit,v_dep;',
    'void main(){',
    /* small round node. it flashes the moment a pulse lands on it (same clock as
       the packet shader) and rings out, so firing propagates visibly node to node */
    ' vec2 q=(gl_PointCoord-0.5)*2.0;',
    ' float r=length(q);',
    ' float dotm=1.0-smoothstep(0.30,0.78,r);',
    ' float lit=v_lit;',
    ' float idle=0.40+0.16*sin(v_ph*24.0+u_t*0.8);',
    ' float rr=0.44+0.30*lit;',
    ' float ring=(1.0-smoothstep(rr,rr+0.06,r))*step(rr-0.13,r)*lit;',
    ' float m=mix(1.0,smoothstep(-0.2,1.15,gl_FragCoord.x/u_res.x),u_mask);',
    /* narrow screens carry copy edge to edge: lift the field off the text block */
    ' m*=mix(1.0,1.0-smoothstep(0.05,0.48,gl_FragCoord.y/u_res.y),u_vm);',
    /* dissolve before the canvas edge so a section never cuts the field off */
    ' m*=smoothstep(0.0,0.09,gl_FragCoord.y/u_res.y)*smoothstep(0.0,0.09,1.0-gl_FragCoord.y/u_res.y);',
    ' float aInk=dotm*idle*u_na*u_gain*m*(0.7+0.3*v_dep);',
    ' float aAcc=clamp(dotm*lit*1.15+ring*0.55,0.0,1.0)*u_gain*m;',
    ' vec3 prem=u_acc*aAcc+(1.0-aAcc)*u_line*aInk;',
    ' gl_FragColor=vec4(prem,clamp(aAcc+(1.0-aAcc)*aInk,0.0,1.0));}'
  ].join('\n');

  var INK = [0.043, 0.063, 0.09], ACC = [0.071, 0.196, 0.808];
  var VIEWS = [
    { sel: '#mesh-canvas', spacing: 0.205, live: 0.7, seed: 0.7, gain: 1, mask: 0.86, par: 1.0, w: 1.35, la: 0.36, na: 0.5, pt: 3.8, line: INK, acc: ACC, max: 2300000 },
    { sel: '[data-shader="thesis"]', spacing: 0.185, live: 0.74, seed: 4.2, gain: 1, mask: 0.45, par: 0.6, w: 1.3, la: 0.34, na: 0.44, pt: 3.6, line: INK, acc: ACC, max: 950000 },
    { sel: '[data-shader="cta"]', spacing: 0.26, live: 0.62, seed: 9.4, gain: 0.82, mask: 0.74, par: 0.8, w: 1.25, la: 0.30, na: 0.42, pt: 3.6, haul: 0.05, line: [0.827, 0.875, 0.949], acc: [0.502, 0.635, 1.0], max: 950000 }
  ];
  VIEWS.forEach(function (v) { v.vm = v.vm || 0; });
  var views = [], rafId = 0, t0 = 0, last = 0;
  var CYCLE = 1.85;  /* seconds per firing cycle: a hop crosses in ~0.25s */
  /* QA flags: ?gl=force keeps the field alive on software rasterisers (headless QA),
     ?gl=off disables it. Neither changes production behaviour. */
  var GL_FORCE = /[?&]gl=force/.test(W.location.search);
  var GL_OFF = /[?&]gl=off/.test(W.location.search);

  /* phones and coarse-pointer devices get one canvas, a lower pixel ceiling and
     30fps: the field has to cost the main thread nothing measurable. */
  var LOW = !!(W.matchMedia && W.matchMedia('(max-width: 880px), (pointer: coarse)').matches);
  /* on a phone the copy runs nearly edge to edge, so the field sits further back */
  if (LOW) VIEWS.forEach(function (v) { v.mask = Math.max(v.mask, 0.94); v.vm = 0.8; v.la *= 0.6; v.na *= 0.7; v.gain *= 0.92; });
  var GLERR = [];
  /* render dials; only reachable through ?gl=force, which QA uses for software WebGL */
  var DBG = { lines: 1, nodes: 1, pkt: 1, w: 0 };
  if (GL_FORCE) W.__dbg = DBG;
  function sh(gl, type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { GLERR.push((type === gl.VERTEX_SHADER ? 'vs' : 'fs') + ': ' + gl.getShaderInfoLog(s)); gl.deleteShader(s); return null; }
    return s;
  }
  function link(gl, vsSrc, fsSrc, names) {
    var vs = sh(gl, gl.VERTEX_SHADER, vsSrc), fs = sh(gl, gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    var p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { GLERR.push('link: ' + gl.getProgramInfoLog(p)); return null; }
    var o = { p: p, a: {}, u: {} };
    names.forEach(function (n) {
      var loc = gl.getAttribLocation(p, n); if (loc >= 0) o.a[n] = loc;
      var ul = gl.getUniformLocation(p, n); if (ul) o.u[n] = ul;
    });
    return o;
  }

  /* A view is assembled in five short stages, one per idle slice. Context creation plus the two
     shader compiles cost hundreds of milliseconds *together* on software WebGL — PageSpeed Insights
     runs Chrome without a GPU — and one long task costs more TBT than the whole animation. So no
     stage is allowed to share a task with the next. */
  function makeView(v) {
    var el = D.querySelector(v.sel); if (!el) { GLERR.push('no element ' + v.sel); return null; }
    var gl = null, P = null, N = null, lbuf = null, nbuf = null;

    var vw = {
      el: el, gl: null, cfg: v, w: 0, h: 0, aspect: 0, vis: false, live: false, dead: false, step: 0, stages: null,
      ptr: [0, 0], ptrT: [0, 0], nV: 0, nN: 0,
      build: function () {
        var g = graph(this.aspect, v);
        gl.bindBuffer(gl.ARRAY_BUFFER, lbuf); gl.bufferData(gl.ARRAY_BUFFER, g.lines, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, nbuf); gl.bufferData(gl.ARRAY_BUFFER, g.nodes, gl.STATIC_DRAW);
        this.nV = g.nVerts; this.nN = g.nNodes;
      },
      size: function () {
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        var dpr = Math.min(W.devicePixelRatio || 1, LOW ? 1.5 : 2);
        var w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
        var budget = v.max * (LOW ? 0.5 : 1);
        if (w * h > budget) { var k = Math.sqrt(budget / (w * h)); w = Math.round(w * k); h = Math.round(h * k); }
        var ar = w / h;
        if (w === this.w && h === this.h) return true;
        this.w = w; this.h = h; el.width = w; el.height = h;
        if (!this.aspect || Math.abs(ar - this.aspect) / this.aspect > 0.18) { this.aspect = ar; this.build(); }
        return true;
      },
      draw: function (t) {
        if (!this.live || !this.size() || !this.nV) return;
        this.ptr[0] += (this.ptrT[0] - this.ptr[0]) * 0.1;
        this.ptr[1] += (this.ptrT[1] - this.ptr[1]) * 0.1;
        var dpr = this.w / this.el.clientWidth || 1;
        gl.viewport(0, 0, this.w, this.h);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(P.p);
        gl.uniform2f(P.u.u_res, this.w, this.h);
        gl.uniform2f(P.u.u_ptr, this.ptr[0], this.ptr[1]);
        gl.uniform1f(P.u.u_t, t); gl.uniform1f(P.u.u_aspect, this.aspect);
        var px = dpr / this.h;                              /* one device pixel, in canvas-height units */
        var core = v.w * 0.5 * px, halfW = core + 1.4 * px;
        gl.uniform1f(P.u.u_par, v.par); gl.uniform1f(P.u.u_gain, v.gain); gl.uniform1f(P.u.u_mask, v.mask); gl.uniform1f(P.u.u_vm, v.vm);
        if (DBG.w) { core = 0.5 * DBG.w * px; halfW = core + 1.4 * px; }
        gl.uniform1f(P.u.u_w, halfW); gl.uniform1f(P.u.u_core, core); gl.uniform1f(P.u.u_px, px); gl.uniform1f(P.u.u_la, v.la * DBG.lines);
        gl.uniform1f(P.u.u_pk, DBG.pkt);
        gl.uniform3fv(P.u.u_line, v.line); gl.uniform3fv(P.u.u_acc, v.acc);
        gl.bindBuffer(gl.ARRAY_BUFFER, lbuf);
        var S = 10 * 4;   /* must match vert() above: 10 floats */
        [[P.a.aA, 2, 0], [P.a.aB, 2, 8], [P.a.aSide, 1, 16], [P.a.aT, 1, 20], [P.a.aSeed, 1, 24], [P.a.aPhase, 1, 28], [P.a.aDur, 1, 32], [P.a.aDep, 1, 36]]
          .forEach(function (a) {
            if (a[0] === undefined) return;
            gl.enableVertexAttribArray(a[0]); gl.vertexAttribPointer(a[0], a[1], gl.FLOAT, false, S, a[2]);
          });
        gl.drawArrays(gl.TRIANGLES, 0, this.nV);

        gl.useProgram(N.p);
        gl.uniform2f(N.u.u_ptr, this.ptr[0], this.ptr[1]);
        gl.uniform1f(N.u.u_t, t); gl.uniform1f(N.u.u_aspect, this.aspect); gl.uniform1f(N.u.u_par, v.par);
        gl.uniform1f(N.u.u_pt, v.pt * dpr); gl.uniform1f(N.u.u_gain, v.gain); gl.uniform1f(N.u.u_mask, v.mask); gl.uniform1f(N.u.u_vm, v.vm); gl.uniform1f(N.u.u_na, v.na * DBG.nodes);
        gl.uniform3fv(N.u.u_line, v.line); gl.uniform3fv(N.u.u_acc, v.acc);
        gl.bindBuffer(gl.ARRAY_BUFFER, nbuf);
        [[N.a.aP, 2, 0], [N.a.aPh, 1, 8], [N.a.aDep, 1, 12]].forEach(function (a) {
          if (a[0] === undefined) return;
          gl.enableVertexAttribArray(a[0]); gl.vertexAttribPointer(a[0], a[1], gl.FLOAT, false, 16, a[2]);
        });
        gl.drawArrays(gl.POINTS, 0, this.nN);
      }
    };
    el.addEventListener('webglcontextlost', function (e) { e.preventDefault(); vw.live = false; });

    vw.stages = [
      function context() {
        var at = { alpha: true, antialias: true, depth: false, stencil: false, premultipliedAlpha: true };
        try {
          gl = el.getContext('webgl', GL_FORCE ? at : Object.assign({ powerPreference: 'low-power', failIfMajorPerformanceCaveat: true }, at))
            || el.getContext('experimental-webgl', at);
        } catch (e) { GLERR.push('getContext ' + v.sel + ': ' + e); gl = null; }
        if (!gl) { GLERR.push('no context ' + v.sel); vw.dead = true; return; }
        vw.gl = gl; gl.clearColor(0, 0, 0, 0);
      },
      function lines() {   /* the expensive one on SwiftShader: kept on its own */
        P = link(gl, VS_LINE, FS_LINE, ['aA', 'aB', 'aSide', 'aT', 'aSeed', 'aPhase', 'aDur', 'aDep',
          'u_res', 'u_ptr', 'u_t', 'u_aspect', 'u_par', 'u_gain', 'u_mask', 'u_vm', 'u_w', 'u_core', 'u_px', 'u_la', 'u_pk', 'u_line', 'u_acc']);
      },
      function nodes() {
        N = link(gl, VS_NODE, FS_NODE, ['aP', 'aPh', 'aDep', 'u_ptr', 'u_t', 'u_aspect', 'u_par', 'u_pt', 'u_gain', 'u_mask', 'u_vm', 'u_line', 'u_acc']);
        if (!P || !N) { GLERR.push('shader ' + v.sel); vw.dead = true; return; }
        lbuf = gl.createBuffer(); nbuf = gl.createBuffer();
        gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      },
      function lattice() { if (!vw.size()) { GLERR.push('zero rect ' + v.sel); vw.dead = true; } },
      function live() { vw.live = true; vw.vis = true; vw.draw(RM ? 0.37 : 0); watch(vw); }
    ];
    return vw;
  }

  function loop(now) {
    rafId = W.requestAnimationFrame(loop);
    if (D.hidden) return;
    if (now - last < (LOW ? 31 : 15)) return;              /* 60fps desktop, 30fps phones; paused when hidden */
    last = now;
    if (!t0) t0 = now;
    var t = (now - t0) / 1000 / CYCLE;                 /* shader clock is in cycles */
    for (var i = 0; i < views.length; i++) if (views[i].vis) views[i].draw(t);
  }

  /* one context per canvas; each canvas starts only when it is near the viewport */
  var pumpGL = null;                     /* set by initGL: resumes a paused build when the tab returns */

  function watch(vw) {
    if (RM) return;
    if ('IntersectionObserver' in W) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { vw.vis = e.isIntersecting; if (e.isIntersecting && !rafId) rafId = W.requestAnimationFrame(loop); });
      }, { rootMargin: '180px 0px' }).observe(vw.el);
    } else vw.vis = true;
    if (!rafId) rafId = W.requestAnimationFrame(loop);
  }

  function initGL() {
    if (!W.WebGLRenderingContext || GL_OFF) return;
    var els = VIEWS.map(function (v) { return D.querySelector(v.sel); });
    /* phones get the hero only: one context, two programs, nothing else to pay for */
    var queue = [];
    (LOW ? els.slice(0, 1) : els).forEach(function (el, i) {
      var k = els.indexOf(el);
      if (el) queue.push({ el: el, cfg: VIEWS[k], vw: null, step: 0 });
    });
    var armed = false, pumpQ = 0;
    var IO = 'IntersectionObserver' in W ? new IntersectionObserver(function () { next(); }, { rootMargin: '260px 0px' }) : null;
    function near(el) { var r = el.getBoundingClientRect(); return r.bottom > -260 && r.top < W.innerHeight + 260; }
    function retire(job, why) {
      if (why) GLERR.push(why);
      if (!job.vw || !job.vw.live) { var i = views.indexOf(job.vw); if (i > -1) views.splice(i, 1); }   /* built views keep animating */
      job.el.__gl = true;
      queue.splice(queue.indexOf(job), 1);
    }
    /* One stage per slice, and never two views in the same slice. */
    function tick(deadline) {
      if (!armed || !queue.length) return;
      if (deadline && !deadline.timeRemaining() && !deadline.didTimeout) return;
      for (var k = 0; k < queue.length;) {
        var job = queue[k];
        if (!job.step && !near(job.el)) { k++; continue; } /* not started and offscreen: the observer wakes us */
        if (!job.vw) {
          try { job.vw = makeView(job.cfg); } catch (e) { retire(job, 'makeView ' + job.cfg.sel + ': ' + (e && e.message || e)); continue; }
          if (!job.vw) { retire(job); continue; }
          views.push(job.vw);
        }
        try { job.vw.stages[job.step++](); } catch (e) { retire(job, 'stage ' + job.step + ' ' + job.cfg.sel + ': ' + (e && e.message || e)); continue; }
        if (job.vw.dead) { retire(job); continue; }
        if (job.step >= job.vw.stages.length) { retire(job); break; }   /* built: stop, one view per slice */
        break;                                            /* still building this one: next slice continues */
      }
    }
    /* Scheduling. Every stage runs in an idle slice: a shader compile or a geometry upload has no
       business landing on an animation frame — that is the scroll jank the first draft of this caused.
       The timeout is what stops the render loop from starving a half-built view forever. A pass that
       advances nothing (the view scrolled out of range) stops asking for slices and waits for the
       observer instead; asking for the next slice unconditionally would spin. */
    function next() {
      if (!queue.length || pumpQ) return;
      var reach = !IO;
      /* a view that has started is always worth another slice, even if it scrolled away: leaving it
         half-built means the next scroll finds it blank. Only untouched offscreen views wait. */
      for (var i = 0; i < queue.length; i++) if (queue[i].step || near(queue[i].el)) { reach = true; break; }
      if (!reach) return;                                  /* nothing in reach: the observer wakes us */
      pumpQ = 1; W.requestIdleCallback(idle, { timeout: 500 });
    }
    function idle(dl) { pumpQ = 0; tick(dl); next(); }
    pumpGL = next;
    /* offscreen canvases wait for the scroll that brings them in */
    if (IO) { queue.forEach(function (job) { IO.observe(job.el); }); }
    armed = true;
    if (GL_FORCE) W.__swq = function () { return queue.map(function (j) { return { sel: j.cfg.sel, step: j.step, built: !!j.vw, live: !!(j.vw && j.vw.live), near: near(j.el) }; }); };
    next();

    if (!RM) {
      D.addEventListener('pointermove', function (e) {
        for (var i = 0; i < views.length; i++) {
          var v = views[i], r = v.el.getBoundingClientRect();
          if (r.bottom < -80 || r.top > W.innerHeight + 80) continue;
          v.ptrT[0] = ((e.clientX - r.left) / r.width - 0.5) * 2;
          v.ptrT[1] = -((e.clientY - r.top) / r.height - 0.5) * 2;
        }
      }, { passive: true });
    }
    var invalidate = function () { for (var i = 0; i < views.length; i++) { views[i].w = 0; views[i].aspect = 0; } };
    if (W.ResizeObserver) { var ro = new ResizeObserver(invalidate); els.forEach(function (el) { if (el) ro.observe(el); }); }
    W.addEventListener('resize', invalidate);
    onScroll();
  }

  D.addEventListener('visibilitychange', function () { if (!D.hidden) { last = 0; if (pumpGL) pumpGL(); } });

  /* start after first paint so the shader never competes with LCP */
  function boot() { try { initGL(); } catch (e) { GLERR.push('boot: ' + e); /* no GL: the CSS gradient carries the hero */ } finally { if (GL_FORCE) { W.__sw = { views: views, err: GLERR }; } } }
  /* after load, then in idle slices: first paint and LCP never wait for the field */
  if (D.readyState === 'complete') W.requestIdleCallback ? W.requestIdleCallback(boot, { timeout: 1200 }) : W.setTimeout(boot, 120);
  else W.addEventListener('load', function () { W.requestIdleCallback ? W.requestIdleCallback(boot, { timeout: 1200 }) : W.setTimeout(boot, 120); }, { once: true });
})();
