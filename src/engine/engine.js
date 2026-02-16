export const Engine = (() => {
  const E = {};
  let canvas, ctx;
  let dpr = 1;

  let running = true;
  let speed = 1;

  let lastT = 0;
  let acc = 0;
  const fixedDt = 1 / 60;
  const maxSteps = 6;

  const mouse = { x: 0, y: 0, px: 0, py: 0, dx: 0, dy: 0, down: false, button: 0 };
  const keys = new Set();

  const hooks = {
    update: null,
    render: null,
    onResize: null,
    onClick: null,
    onMouseDown: null,
    onMouseUp: null,
    onMouseMove: null,
    onKeyDown: null,
    onKeyUp: null,
  };

  E.$ = (sel) => document.querySelector(sel);

  E.on = (name, fn) => { hooks[name] = fn; };

  E.init = ({ canvasId = "c" } = {}) => {
    canvas = document.getElementById(canvasId);
    ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

    const resize = () => {
      dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
      const w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      hooks.onResize?.(w, h, dpr);
    };

    const pos = (ev) => {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };

    window.addEventListener("resize", resize);

    window.addEventListener("keydown", (e) => { keys.add(e.key); hooks.onKeyDown?.(e); });
    window.addEventListener("keyup", (e) => { keys.delete(e.key); hooks.onKeyUp?.(e); });

    canvas.addEventListener("mousedown", (e) => {
      const p = pos(e);
      mouse.down = true; mouse.button = e.button;
      mouse.px = mouse.x = p.x; mouse.py = mouse.y = p.y;
      hooks.onMouseDown?.(e, p);
    });

    window.addEventListener("mouseup", (e) => {
      const p = pos(e);
      mouse.down = false;
      hooks.onMouseUp?.(e, p);
    });

    canvas.addEventListener("mousemove", (e) => {
      const p = pos(e);
      mouse.dx = p.x - mouse.x; mouse.dy = p.y - mouse.y;
      mouse.px = mouse.x; mouse.py = mouse.y;
      mouse.x = p.x; mouse.y = p.y;
      hooks.onMouseMove?.(e, p);
    });

    canvas.addEventListener("click", (e) => hooks.onClick?.(e, pos(e)));

    resize();
    requestAnimationFrame(loop);
  };

  function loop(t) {
    requestAnimationFrame(loop);
    if (!lastT) lastT = t;
    const realDt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;

    if (!running) { hooks.render?.(0, 0); return; }

    acc += realDt * speed;

    let steps = 0;
    while (acc >= fixedDt && steps < maxSteps) {
      hooks.update?.(fixedDt);
      acc -= fixedDt;
      steps++;
    }

    hooks.render?.(realDt, acc / fixedDt);
  }

  E.getCtx = () => ctx;
  E.getSize = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });
  E.mouse = () => ({ ...mouse });
  E.keyDown = (k) => keys.has(k);

  E.setSpeed = (v) => { speed = Math.max(0, Number(v) || 1); };

  // Set status text in #status element if present
  E.setStatus = (text) => {
    const el = document.getElementById("status");
    if (el) el.textContent = text;
  };
  E.isPaused = () => !running;
  E.togglePause = () => { running = !running; };

  E.save = (key, value) => {
    localStorage.setItem(key, JSON.stringify(value));
    localStorage.setItem(key + "_ts", Date.now().toString());
  };

  E.load = (key, defaultValue) => {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  };

  E.loadTimestamp = (key) => {
    const ts = localStorage.getItem(key + "_ts");
    return ts ? parseInt(ts, 10) : 0;
  };

  E.gfx = {
    clearBlack() {
      ctx.fillStyle = "#000";
      const { w, h } = E.getSize();
      ctx.fillRect(0, 0, w, h);
    },
    glowCircle(x, y, r, col) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, r + 10, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    },
    line(x1, y1, x2, y2, col, width = 1, alpha = 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    }
  };

  return E;
})();
