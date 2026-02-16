import { Engine } from "../engine/engine.js";

export function startGame(ctx = {}) {
  Engine.init({ canvasId: ctx.canvasId || "c" });

  const dots = [];
  let paused = false;

  function spawn(x, y, n = 10) {
    const { w, h } = Engine.getSize();
    for (let i = 0; i < n; i++) {
      dots.push({
        x: x ?? w * 0.5,
        y: y ?? h * 0.5,
        vx: (Math.random() - 0.5) * 260,
        vy: (Math.random() - 0.5) * 260,
        r: 3 + Math.random() * 3,
        hue: 200 + Math.random() * 90
      });
    }
    if (dots.length > 1200) dots.splice(0, dots.length - 1200);
  }

  // Minimal optional per-game UI (remove if you want zero UI)
  if (ctx.uiRoot) {
    ctx.uiRoot.innerHTML = `
      <div style="display:inline-flex; gap:10px; padding:10px 12px; border-radius:12px;
                  border:1px solid rgba(120,160,255,0.25); background:rgba(10,12,20,0.75);">
        <button id="p" style="cursor:pointer;">Pause</button>
        <button id="r" style="cursor:pointer;">Reset</button>
        <button id="s" style="cursor:pointer;">Spawn</button>
        <a href="/" style="align-self:center;">Back</a>
      </div>
    `;
    const p = ctx.uiRoot.querySelector("#p");
    const r = ctx.uiRoot.querySelector("#r");
    const s = ctx.uiRoot.querySelector("#s");

    p.onclick = () => { paused = !paused; p.textContent = paused ? "Play" : "Pause"; };
    r.onclick = () => { dots.length = 0; };
    s.onclick = () => spawn(null, null, 50);
  }

  Engine.on("onClick", (_e, p) => spawn(p.x, p.y, 10));

  Engine.on("onKeyDown", (e) => {
    if (e.key === " ") { e.preventDefault(); paused = !paused; }
  });

  Engine.on("update", (dt) => {
    if (paused) return;

    const m = Engine.mouse();
    const { w, h } = Engine.getSize();
    const attract = m.down ? 700 : 0;

    for (const d of dots) {
      if (attract) {
        const dx = m.x - d.x, dy = m.y - d.y;
        const r2 = dx*dx + dy*dy + 120;
        const inv = 1 / Math.sqrt(r2);
        d.vx += dx * inv * attract * dt;
        d.vy += dy * inv * attract * dt;
      }

      d.vy += 30 * dt;
      d.vx *= 0.985; d.vy *= 0.985;

      d.x += d.vx * dt;
      d.y += d.vy * dt;

      if (d.x < d.r) { d.x = d.r; d.vx *= -0.85; }
      if (d.x > w - d.r) { d.x = w - d.r; d.vx *= -0.85; }
      if (d.y < d.r) { d.y = d.r; d.vy *= -0.85; }
      if (d.y > h - d.r) { d.y = h - d.r; d.vy *= -0.85; }
    }
  });

  Engine.on("render", () => {
    const ctx2 = Engine.getCtx();
    const { w, h } = Engine.getSize();

    Engine.gfx.clearBlack();

    // stars
    ctx2.save();
    ctx2.globalAlpha = 0.12;
    ctx2.fillStyle = "#8fb0ff";
    for (let i = 0; i < 120; i++) ctx2.fillRect((i * 7919) % w, (i * 104729) % h, 1, 1);
    ctx2.restore();

    for (const d of dots) {
      Engine.gfx.glowCircle(d.x, d.y, d.r, `hsl(${d.hue} 90% 65%)`);
    }

    // minimal in-canvas text (no UI required)
    ctx2.save();
    ctx2.fillStyle = "rgba(233,236,255,0.65)";
    ctx2.font = "12px system-ui";
    ctx2.fillText(`Dots: ${dots.length} | Click: spawn | Drag: attract | Space: pause`, 12, h - 14);
    ctx2.restore();
  });

  spawn(null, null, 200);
}
