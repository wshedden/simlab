import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab.openrouterNeonProbe.v1";

  const uiRoot =
    ctx && ctx.uiRoot && typeof ctx.uiRoot === "object" && ctx.uiRoot.appendChild
      ? ctx.uiRoot
      : null;

  const OR_KEY =
    (typeof import.meta !== "undefined" &&
      import.meta.env &&
      (import.meta.env.VITE_OPENROUTER_API_KEY || import.meta.env.OPENROUTER_API_KEY)) ||
    "";

  const OR_BASE = "https://openrouter.ai/api/v1/chat/completions";

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;

  function nowSec() {
    return performance.now() * 0.001;
  }

  function safeJsonParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function fmtTime(t) {
    if (!isFinite(t)) return "0s";
    if (t < 60) return `${t.toFixed(1)}s`;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}m ${s.toFixed(0)}s`;
  }

  function engineSave(obj) {
    try {
      Engine.save(SAVE_KEY, obj);
    } catch {}
  }

  function engineLoad(def) {
    try {
      return Engine.load(SAVE_KEY, def);
    } catch {
      return def;
    }
  }

  // ---------------- visual state ----------------
  const pulses = [];
  const MAX_PULSES = 260;

  const state = {
    paused: false,
    t: 0,
    status: "",
    statusUntil: 0,

    // “token energy” to drive visuals
    tokenEnergy: 0,
    tokenEnergyEMA: 0,
    tokensSeen: 0,

    // request state
    busy: false,
    abort: null,
    startedAt: 0,

    // displayed response
    responseText: "",
    lastError: "",

    // settings
    model: "openai/gpt-4o-mini",
    system: "You are a concise assistant. Reply in British English.",
    prompt: "Say a one-paragraph explanation of what OpenRouter is, then give 3 bullet points for how to call it from fetch().",
    temperature: 0.7,
    maxTokens: 500,
    stream: true,

    // UI toggles
    showCanvasHelp: true,
    mute: true, // placeholder if you later add audio
  };

  // load saved UI state
  const saved = engineLoad(null);
  if (saved && typeof saved === "object") {
    if (typeof saved.model === "string") state.model = saved.model;
    if (typeof saved.system === "string") state.system = saved.system;
    if (typeof saved.prompt === "string") state.prompt = saved.prompt;
    if (typeof saved.temperature === "number") state.temperature = clamp(saved.temperature, 0, 2);
    if (typeof saved.maxTokens === "number") state.maxTokens = clamp(saved.maxTokens | 0, 16, 4000);
    if (typeof saved.stream === "boolean") state.stream = saved.stream;
  }

  function flash(msg, seconds = 1.2) {
    state.status = msg || "";
    state.statusUntil = nowSec() + seconds;
  }

  function addPulse(x, y, strength, hueKind) {
    // hueKind: 0 cyan, 1 blue, 2 purple, 3 magenta
    const h = hueKind | 0;
    const p = {
      x,
      y,
      vx: (Math.random() * 2 - 1) * 40,
      vy: (Math.random() * 2 - 1) * 40,
      r: 2 + Math.random() * 2,
      life: 0.8 + Math.random() * 0.4,
      t: 0,
      s: clamp(strength, 0.2, 3.0),
      h,
    };
    if (pulses.length >= MAX_PULSES) pulses.shift();
    pulses.push(p);
  }

  function burstAt(x, y, n, strength) {
    for (let i = 0; i < n; i++) addPulse(x, y, strength, i & 3);
  }

  function spawnSpiralPulse(strength) {
    const { w, h } = Engine.getSize();
    const cx = w * 0.5;
    const cy = h * 0.5;
    const a = state.t * 2.2 + Math.random() * 0.4;
    const r = (Math.min(w, h) * 0.07) * (0.5 + 0.5 * Math.random()) + (state.tokenEnergyEMA * 0.8);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    addPulse(x, y, strength, (Math.random() * 4) | 0);
  }

  // ---------------- UI ----------------
  let ui = null;

  function makeEl(tag, styleObj) {
    const el = document.createElement(tag);
    if (styleObj) Object.assign(el.style, styleObj);
    return el;
  }

  function makeBtn(label) {
    const b = makeEl("button", {
      display: "inline-block",
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(8,12,18,0.85)",
      color: "#dff6ff",
      cursor: "pointer",
      font: "700 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    });
    b.textContent = label;
    b.onmouseenter = () => (b.style.borderColor = "rgba(255,75,216,0.45)");
    b.onmouseleave = () => (b.style.borderColor = "rgba(120,180,255,0.25)");
    return b;
  }

  function makeLabel(text) {
    const d = makeEl("div", {
      font: "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      opacity: "0.9",
      marginTop: "8px",
      marginBottom: "4px",
    });
    d.textContent = text;
    return d;
  }

  function buildUI() {
    if (!uiRoot) return null;
    uiRoot.innerHTML = "";

    const panel = makeEl("div", {
      position: "absolute",
      left: "12px",
      top: "12px",
      width: "360px",
      padding: "12px",
      borderRadius: "14px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(0,0,0,0.65)",
      backdropFilter: "blur(6px)",
      boxShadow: "0 0 24px rgba(40,120,255,0.10)",
      color: "#dff6ff",
      font: "14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      userSelect: "none",
    });

    const title = makeEl("div", { fontWeight: "900", fontSize: "16px", marginBottom: "6px" });
    title.textContent = "OpenRouter Neon Probe";
    panel.appendChild(title);

    const hint = makeEl("div", { fontSize: "12px", opacity: "0.9", lineHeight: "1.35" });
    hint.innerHTML =
      `Key source: <b>${OR_KEY ? "VITE_OPENROUTER_API_KEY" : "missing"}</b><br>` +
      `Click canvas = burst • Space pause • R reset • Esc cancel request`;
    panel.appendChild(hint);

    const rowTop = makeEl("div", { display: "flex", gap: "8px", marginTop: "10px" });
    const btnSend = makeBtn("Send (Stream)");
    const btnStop = makeBtn("Stop");
    const btnClear = makeBtn("Clear");
    btnStop.style.opacity = "0.8";
    btnStop.disabled = true;

    rowTop.appendChild(btnSend);
    rowTop.appendChild(btnStop);
    rowTop.appendChild(btnClear);
    panel.appendChild(rowTop);

    const stats = makeEl("div", {
      marginTop: "10px",
      fontSize: "12px",
      opacity: "0.95",
      whiteSpace: "pre-wrap",
    });
    panel.appendChild(stats);

    panel.appendChild(makeLabel("Model (OpenRouter model id)"));
    const modelIn = makeEl("input", {
      width: "100%",
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(8,12,18,0.85)",
      color: "#dff6ff",
      outline: "none",
      font: "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    });
    modelIn.value = state.model;
    panel.appendChild(modelIn);

    const grid2 = makeEl("div", { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "10px" });

    const tempWrap = makeEl("div");
    tempWrap.appendChild(makeLabel("Temperature"));
    const tempIn = makeEl("input", { width: "100%" });
    tempIn.type = "range";
    tempIn.min = "0";
    tempIn.max = "2";
    tempIn.step = "0.05";
    tempIn.value = String(state.temperature);
    tempWrap.appendChild(tempIn);

    const tokWrap = makeEl("div");
    tokWrap.appendChild(makeLabel("Max tokens"));
    const tokIn = makeEl("input", {
      width: "100%",
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(8,12,18,0.85)",
      color: "#dff6ff",
      outline: "none",
      font: "700 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    });
    tokIn.type = "number";
    tokIn.min = "16";
    tokIn.max = "4000";
    tokIn.step = "1";
    tokIn.value = String(state.maxTokens);

    tokWrap.appendChild(tokIn);

    grid2.appendChild(tempWrap);
    grid2.appendChild(tokWrap);
    panel.appendChild(grid2);

    panel.appendChild(makeLabel("System"));
    const sysTa = makeEl("textarea", {
      width: "100%",
      height: "52px",
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(8,12,18,0.85)",
      color: "#dff6ff",
      outline: "none",
      resize: "vertical",
      font: "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    });
    sysTa.value = state.system;
    panel.appendChild(sysTa);

    panel.appendChild(makeLabel("Prompt"));
    const promptTa = makeEl("textarea", {
      width: "100%",
      height: "74px",
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(8,12,18,0.85)",
      color: "#dff6ff",
      outline: "none",
      resize: "vertical",
      font: "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    });
    promptTa.value = state.prompt;
    panel.appendChild(promptTa);

    panel.appendChild(makeLabel("Response"));
    const outTa = makeEl("textarea", {
      width: "100%",
      height: "140px",
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(0,0,0,0.55)",
      color: "#dff6ff",
      outline: "none",
      resize: "vertical",
      font: "600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
    });
    outTa.value = state.responseText;
    panel.appendChild(outTa);

    const rowBot = makeEl("div", { display: "flex", gap: "8px", marginTop: "10px", alignItems: "center" });

    const chkStream = makeEl("label", {
      display: "flex",
      gap: "8px",
      alignItems: "center",
      fontSize: "12px",
      opacity: "0.9",
      cursor: "pointer",
    });
    const streamBox = document.createElement("input");
    streamBox.type = "checkbox";
    streamBox.checked = state.stream;
    chkStream.appendChild(streamBox);
    chkStream.appendChild(document.createTextNode("Stream"));
    rowBot.appendChild(chkStream);

    const back = makeEl("a", {
      marginLeft: "auto",
      fontSize: "12px",
      color: "#2aa2ff",
      textDecoration: "none",
      border: "1px solid rgba(42,162,255,0.25)",
      padding: "6px 10px",
      borderRadius: "10px",
    });
    back.href = "/";
    back.textContent = "Back";
    back.onmouseenter = () => (back.style.borderColor = "rgba(255,75,216,0.45)");
    back.onmouseleave = () => (back.style.borderColor = "rgba(42,162,255,0.25)");
    rowBot.appendChild(back);

    panel.appendChild(rowBot);

    uiRoot.appendChild(panel);

    // wiring
    function syncToState() {
      state.model = (modelIn.value || "").trim() || state.model;
      state.temperature = clamp(parseFloat(tempIn.value), 0, 2);
      state.maxTokens = clamp(parseInt(tokIn.value || "500", 10) | 0, 16, 4000);
      state.system = sysTa.value || "";
      state.prompt = promptTa.value || "";
      state.stream = !!streamBox.checked;

      engineSave({
        model: state.model,
        temperature: state.temperature,
        maxTokens: state.maxTokens,
        system: state.system,
        prompt: state.prompt,
        stream: state.stream,
      });
    }

    modelIn.onchange = syncToState;
    tempIn.oninput = () => {
      syncToState();
      flash(`Temperature: ${state.temperature.toFixed(2)}`, 0.6);
    };
    tokIn.onchange = syncToState;
    sysTa.onchange = syncToState;
    promptTa.onchange = syncToState;
    streamBox.onchange = () => {
      syncToState();
      flash(state.stream ? "Streaming on." : "Streaming off.", 0.8);
    };

    btnSend.onclick = async () => {
      syncToState();
      if (!OR_KEY) {
        flash("Missing API key (VITE_OPENROUTER_API_KEY).", 2.0);
        return;
      }
      if (state.busy) return;
      state.responseText = "";
      outTa.value = "";
      state.tokensSeen = 0;
      state.tokenEnergy = 0;
      state.lastError = "";
      await sendOpenRouter(outTa, btnSend, btnStop, stats);
    };

    btnStop.onclick = () => {
      cancelRequest();
      flash("Stopped.", 1.0);
    };

    btnClear.onclick = () => {
      state.responseText = "";
      outTa.value = "";
      state.lastError = "";
      flash("Cleared.", 0.6);
    };

    return { outTa, stats, btnSend, btnStop };
  }

  function updateUIStatus() {
    if (!ui) return;
    const tNow = nowSec();
    if (tNow < state.statusUntil && state.status) {
      // show status as first line in stats
    }
    const busy = state.busy;
    ui.btnStop.disabled = !busy;
    ui.btnStop.style.opacity = busy ? "1" : "0.55";
    ui.btnSend.disabled = busy;
    ui.btnSend.style.opacity = busy ? "0.55" : "1";
  }

  ui = buildUI();

  // ---------------- OpenRouter call (streaming) ----------------
  function cancelRequest() {
    if (state.abort) {
      try {
        state.abort.abort();
      } catch {}
    }
    state.abort = null;
    state.busy = false;
    state.startedAt = 0;
    updateUIStatus();
  }

  function buildHeaders() {
    const headers = {
      Authorization: `Bearer ${OR_KEY}`,
      "Content-Type": "application/json",
      // optional attribution headers supported by OpenRouter
      "HTTP-Referer": (typeof window !== "undefined" && window.location && window.location.origin) ? window.location.origin : "http://localhost",
      "X-Title": "SimLab",
    };
    return headers;
  }

  async function sendOpenRouter(outTa, btnSend, btnStop, statsEl) {
    state.busy = true;
    state.startedAt = nowSec();
    updateUIStatus();

    const controller = new AbortController();
    state.abort = controller;

    const body = {
      model: state.model,
      messages: [
        ...(state.system ? [{ role: "system", content: state.system }] : []),
        { role: "user", content: state.prompt || "Hello!" },
      ],
      temperature: state.temperature,
      max_tokens: state.maxTokens,
      stream: !!state.stream,
    };

    const headers = buildHeaders();

    const setStats = (extra) => {
      const dt = state.startedAt ? nowSec() - state.startedAt : 0;
      const base =
        `Busy: ${state.busy ? "yes" : "no"}\n` +
        `Model: ${state.model}\n` +
        `Stream: ${state.stream ? "yes" : "no"}\n` +
        `Tokens-ish: ${state.tokensSeen}\n` +
        `Elapsed: ${fmtTime(dt)}\n` +
        (state.lastError ? `Error: ${state.lastError}\n` : "");
      statsEl.textContent = base + (extra ? `\n${extra}` : "");
    };

    setStats("");

    try {
      const res = await fetch(OR_BASE, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        state.lastError = `HTTP ${res.status}`;
        flash(`Request failed: ${state.lastError}`, 2.0);
        setStats(txt ? txt.slice(0, 600) : "");
        state.busy = false;
        state.abort = null;
        updateUIStatus();
        return;
      }

      if (!state.stream) {
        const json = await res.json().catch(() => null);
        if (!json) throw new Error("Bad JSON response.");
        const content = (((json.choices || [])[0] || {}).message || {}).content || "";
        state.responseText = String(content);
        outTa.value = state.responseText;
        burstAt(Engine.getSize().w * 0.5, Engine.getSize().h * 0.5, 36, 1.6);
        flash("Done.", 0.9);
        setStats(json.usage ? `Usage: ${JSON.stringify(json.usage)}` : "");
        state.busy = false;
        state.abort = null;
        updateUIStatus();
        return;
      }

      // STREAMING: SSE "data: {json}\n\n" and "data: [DONE]"
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) throw new Error("Streaming not supported by this browser.");

      const decoder = new TextDecoder("utf-8");
      let buf = "";
      let done = false;

      while (!done) {
        const { value, done: drDone } = await reader.read();
        if (drDone) break;
        buf += decoder.decode(value, { stream: true });

        // parse SSE blocks
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          // Each block may contain multiple lines; we care about lines starting with "data:"
          const lines = block.split("\n");
          for (let li = 0; li < lines.length; li++) {
            const line = lines[li].trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") {
              done = true;
              break;
            }
            const obj = safeJsonParse(payload);
            if (!obj) continue;

            const delta = (((obj.choices || [])[0] || {}).delta || {});
            const chunk = delta.content || "";
            if (chunk) {
              state.responseText += chunk;
              outTa.value = state.responseText;
              state.tokensSeen += 1;
              // drive visuals: token energy spikes
              state.tokenEnergy = clamp(state.tokenEnergy + 0.35 + Math.min(1.8, chunk.length * 0.06), 0, 30);
              spawnSpiralPulse(0.9 + Math.min(2.2, chunk.length * 0.08));
            }

            // occasionally show usage if present in stream chunks (varies by provider)
            if (obj.usage && typeof obj.usage === "object" && (state.tokensSeen % 24 === 0)) {
              setStats(`Usage: ${JSON.stringify(obj.usage)}`);
            } else if (state.tokensSeen % 30 === 0) {
              setStats("");
            }
          }
        }

        if (controller.signal.aborted) break;
      }

      burstAt(Engine.getSize().w * 0.5, Engine.getSize().h * 0.5, 52, 2.0);
      flash("Done.", 0.9);
      setStats("");
    } catch (e) {
      const msg = (e && e.name === "AbortError") ? "Aborted" : (e && e.message ? e.message : "Request error");
      state.lastError = msg;
      flash(`Error: ${msg}`, 2.0);
    } finally {
      state.busy = false;
      state.abort = null;
      updateUIStatus();
    }
  }

  // ---------------- hooks ----------------
  function onClick(ev, pos) {
    if (!pos) return;
    burstAt(pos.x, pos.y, 28, 1.2);
    flash("Burst.", 0.5);
  }

  function onKeyDown(ev) {
    const k = ev && ev.key ? ev.key : "";
    if (k === " " || k === "Spacebar") {
      Engine.togglePause();
      state.paused = Engine.isPaused();
      flash(state.paused ? "Paused." : "Running.", 0.8);
      return;
    }
    if (k === "r" || k === "R") {
      const ok = confirm("Reset visuals + clear output?");
      if (!ok) return;
      pulses.length = 0;
      state.responseText = "";
      state.tokensSeen = 0;
      state.tokenEnergy = 0;
      state.tokenEnergyEMA = 0;
      if (ui && ui.outTa) ui.outTa.value = "";
      flash("Reset.", 0.8);
      return;
    }
    if (k === "Escape") {
      if (state.busy) {
        cancelRequest();
        flash("Cancelled.", 0.9);
      }
      return;
    }
  }

  function update(dt) {
    state.paused = Engine.isPaused();
    if (state.paused) return;

    state.t += dt;

    // token energy decay + EMA
    state.tokenEnergy = Math.max(0, state.tokenEnergy - dt * 9.0);
    state.tokenEnergyEMA = lerp(state.tokenEnergyEMA, state.tokenEnergy, 0.08);

    // move pulses
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.t += dt;
      if (p.t >= p.life) {
        pulses.splice(i, 1);
        continue;
      }
      // gentle spiral drift around centre
      const { w, h } = Engine.getSize();
      const cx = w * 0.5;
      const cy = h * 0.5;
      const dx = p.x - cx;
      const dy = p.y - cy;
      const rot = 0.22 * dt * (0.8 + 0.25 * state.tokenEnergyEMA);
      const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
      const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
      const tx = cx + rx;
      const ty = cy + ry;

      // inertia + mild pull
      p.vx += (tx - p.x) * (0.7 * dt);
      p.vy += (ty - p.y) * (0.7 * dt);

      // damping
      p.vx *= 0.92;
      p.vy *= 0.92;

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // bounds soft wrap
      const pad = 12;
      if (p.x < -pad) p.x = w + pad;
      else if (p.x > w + pad) p.x = -pad;
      if (p.y < -pad) p.y = h + pad;
      else if (p.y > h + pad) p.y = -pad;
    }

    // autosave UI snapshot every ~8s
    // (engineSave already called on input changes; this is just belt & braces)
    // no timestamp needed.
  }

  function render() {
    const g = Engine.gfx;
    const ctx2d = Engine.getCtx();
    const { w, h } = Engine.getSize();

    g.clearBlack();

    // subtle star speckle (cheap, deterministic)
    ctx2d.save();
    ctx2d.globalAlpha = 0.35;
    ctx2d.fillStyle = "rgba(223,246,255,0.16)";
    const s = 130;
    // pseudo-random but stable by using floor coords
    for (let i = 0; i < s; i++) {
      const x = (Math.sin(i * 999.17 + 1.23) * 0.5 + 0.5) * w;
      const y = (Math.sin(i * 1337.41 + 4.56) * 0.5 + 0.5) * h;
      const r = 0.6 + (i % 3) * 0.25;
      ctx2d.fillRect(x | 0, y | 0, r, r);
    }
    ctx2d.restore();

    const cx = w * 0.5;
    const cy = h * 0.5;
    const baseR = Math.min(w, h) * 0.18;

    // hub rings
    const energy = state.tokenEnergyEMA;
    const ringCount = 5;
    for (let i = 0; i < ringCount; i++) {
      const t = i / (ringCount - 1);
      const rr = baseR * (0.55 + 0.65 * t) + energy * (1.5 + i * 0.6);
      const a = 0.06 + 0.07 * t;
      const col =
        i % 2 === 0
          ? "rgba(61,252,255,1)"
          : "rgba(255,75,216,1)";
      g.glowCircle(cx, cy, rr, col, 2, a, 10 + i * 3);
    }

    // pulses
    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i];
      const u = p.t / p.life;
      const fade = 1 - u;
      const rr = p.r + (1 - fade) * 3.5 * p.s;

      let col = "rgba(61,252,255,1)";
      if (p.h === 1) col = "rgba(42,162,255,1)";
      else if (p.h === 2) col = "rgba(176,75,255,1)";
      else if (p.h === 3) col = "rgba(255,75,216,1)";

      g.glowCircle(p.x, p.y, rr, col, 2, 0.08 + 0.22 * fade, 12);
    }

    // neon “response shimmer” line
    if (state.responseText) {
      const len = state.responseText.length;
      const wave = 0.5 + 0.5 * Math.sin(state.t * 2.2);
      const y = h * 0.82 + Math.sin(state.t * 1.7) * 8;
      const x0 = w * 0.12;
      const x1 = w * (0.12 + 0.76 * clamp(len / 800, 0, 1));
      g.line(x0, y, x1, y, "rgba(61,252,255,1)", 3, 0.12 + 0.10 * wave);
      g.line(x0, y + 6, x1 * (0.98 + 0.02 * wave), y + 6, "rgba(255,75,216,1)", 2, 0.07);
    }

    // canvas HUD if no UI
    if (!uiRoot) {
      ctx2d.save();
      ctx2d.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx2d.fillStyle = "rgba(223,246,255,0.88)";
      ctx2d.fillText("OpenRouter Neon Probe", 12, 18);

      ctx2d.font = "600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
      ctx2d.fillStyle = "rgba(223,246,255,0.72)";
      ctx2d.fillText(`Key: ${OR_KEY ? "present" : "missing"}  Model: ${state.model}`, 12, 36);
      ctx2d.fillText(`Tokens-ish: ${state.tokensSeen}  Busy: ${state.busy ? "yes" : "no"}`, 12, 52);
      ctx2d.fillText("Space pause • R reset • Esc cancel • Click = burst", 12, h - 14);

      if (nowSec() < state.statusUntil && state.status) {
        ctx2d.fillStyle = "rgba(255,75,216,0.88)";
        ctx2d.fillText(state.status, 12, 70);
      }
      ctx2d.restore();
    } else {
      if (nowSec() < state.statusUntil && state.status) {
        ctx2d.save();
        ctx2d.fillStyle = "rgba(255,75,216,0.85)";
        ctx2d.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx2d.fillText(state.status, 12, 22);
        ctx2d.restore();
      }
      // update stats text periodically
      if (ui && ui.stats) {
        const dt = state.startedAt ? nowSec() - state.startedAt : 0;
        const extra = state.lastError ? `Error: ${state.lastError}` : "";
        ui.stats.textContent =
          `Busy: ${state.busy ? "yes" : "no"}\n` +
          `Key: ${OR_KEY ? "present" : "missing"}\n` +
          `Model: ${state.model}\n` +
          `Tokens-ish: ${state.tokensSeen}\n` +
          `Energy: ${state.tokenEnergyEMA.toFixed(1)}\n` +
          `Elapsed: ${fmtTime(dt)}\n` +
          (extra ? `${extra}\n` : "");
      }
      updateUIStatus();
    }
  }

  Engine.on("update", update);
  Engine.on("render", render);
  Engine.on("onClick", onClick);
  Engine.on("onKeyDown", onKeyDown);
}
