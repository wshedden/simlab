import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab.alienDiplomacy.v2.clean";
  const OR_KEY =
    (typeof import.meta !== "undefined" &&
      import.meta.env &&
      (import.meta.env.VITE_OPENROUTER_API_KEY ||
        import.meta.env.OPENROUTER_API_KEY ||
        import.meta.env.VITE_OR_API_KEY)) ||
    "";

  const OR_BASE = "https://openrouter.ai/api/v1/chat/completions";

  const uiRoot =
    ctx && ctx.uiRoot && typeof ctx.uiRoot === "object" && ctx.uiRoot.appendChild
      ? ctx.uiRoot
      : null;

  // ---------------- util ----------------
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const nowSec = () => performance.now() * 0.001;

  function safeJsonParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function fmtInt(n) {
    n = Number(n);
    if (!isFinite(n)) n = 0;
    return String(Math.round(n));
  }

  function pct(n) {
    n = Number(n);
    if (!isFinite(n)) n = 0;
    return clamp(n, 0, 100);
  }

  function el(tag, styleObj) {
    const e = document.createElement(tag);
    if (styleObj) Object.assign(e.style, styleObj);
    return e;
  }

  function btn(label) {
    const b = el("button", {
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(8,12,18,0.90)",
      color: "#dff6ff",
      cursor: "pointer",
      font: "800 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      userSelect: "none",
    });
    b.textContent = label;
    b.onmouseenter = () => (b.style.borderColor = "rgba(255,75,216,0.45)");
    b.onmouseleave = () => (b.style.borderColor = "rgba(120,180,255,0.25)");
    return b;
  }

  function setDisabled(b, dis) {
    b.disabled = !!dis;
    b.style.opacity = dis ? "0.55" : "1";
    b.style.cursor = dis ? "not-allowed" : "pointer";
  }

  // ---------------- state ----------------
  const STAT_KEYS = [
    "TRUST",
    "STATUS",
    "CREDITS",
    "STABILITY",
    "TECH",
    "ECONOMY",
    "PATIENCE",
    "THREAT",
  ];

  const DEFAULT_STATS = {
    TRUST: 52,
    STATUS: 40,
    CREDITS: 25,
    STABILITY: 55,
    TECH: 35,
    ECONOMY: 45,
    PATIENCE: 60,
    THREAT: 35,
  };

  const state = {
    paused: false,
    turn: 1,

    // OpenRouter settings
    model: "openai/gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 900,
    stream: true,

    // gameplay
    stats: { ...DEFAULT_STATS },
    gameOver: false,
    gameOverReason: "",

    // convo
    transcript: [], // {role,text,ts}
    lastAlienText: "",
    lastControl: null,
    lastError: "",
    status: "",
    statusUntil: 0,

    // request lifecycle
    busy: false,
    abort: null,
    startedAt: 0,

    // UI text
    inputText:
      "We want peaceful contact. What do you need, and what can we offer that benefits both sides?",
    notesText:
      "Tip: be concrete. Propose verification, limits, exchange, mutual benefit, and face-saving language.",
    autosaveAt: 0,
  };

  function flash(msg, seconds = 1.2) {
    state.status = msg || "";
    state.statusUntil = nowSec() + seconds;
  }

  function addTranscript(role, text) {
    state.transcript.push({ role, text: String(text || ""), ts: Date.now() });
    if (state.transcript.length > 160) state.transcript.splice(0, state.transcript.length - 160);
  }

  function saveNow() {
    try {
      Engine.save(SAVE_KEY, {
        v: 2,
        model: state.model,
        temperature: state.temperature,
        maxTokens: state.maxTokens,
        stream: state.stream,
        turn: state.turn,
        stats: state.stats,
        transcript: state.transcript,
        inputText: state.inputText,
        notesText: state.notesText,
        lastAlienText: state.lastAlienText,
        gameOver: state.gameOver,
        gameOverReason: state.gameOverReason,
        savedAt: Date.now(),
      });
    } catch {}
  }

  function loadNow() {
    try {
      const s = Engine.load(SAVE_KEY, null);
      if (!s || typeof s !== "object") return false;

      if (typeof s.model === "string") state.model = s.model;
      if (typeof s.temperature === "number") state.temperature = clamp(s.temperature, 0, 2);
      if (typeof s.maxTokens === "number") state.maxTokens = clamp(s.maxTokens | 0, 64, 4000);
      if (typeof s.stream === "boolean") state.stream = s.stream;

      if (typeof s.turn === "number") state.turn = Math.max(1, s.turn | 0);
      if (s.stats && typeof s.stats === "object") {
        for (let i = 0; i < STAT_KEYS.length; i++) {
          const k = STAT_KEYS[i];
          const v = Number(s.stats[k]);
          state.stats[k] = isFinite(v) ? pct(v) : DEFAULT_STATS[k];
        }
      }
      if (Array.isArray(s.transcript)) state.transcript = s.transcript.slice(0, 160);
      if (typeof s.inputText === "string") state.inputText = s.inputText;
      if (typeof s.notesText === "string") state.notesText = s.notesText;
      if (typeof s.lastAlienText === "string") state.lastAlienText = s.lastAlienText;
      if (typeof s.gameOver === "boolean") state.gameOver = s.gameOver;
      if (typeof s.gameOverReason === "string") state.gameOverReason = s.gameOverReason;

      // Optional offline progress: just keep it sane.
      // If you want, you can extend this later (use last CPS estimate etc).
      const savedAt = Number(s.savedAt);
      if (isFinite(savedAt) && savedAt > 0) {
        const dt = clamp((Date.now() - savedAt) / 1000, 0, 4 * 3600);
        if (dt > 10 && !state.gameOver) {
          // Very conservative: a tiny stability bleed + tiny credits drip, purely to show "offline happened".
          state.stats.CREDITS = pct(state.stats.CREDITS + Math.min(12, dt / 1200));
          state.stats.PATIENCE = pct(state.stats.PATIENCE - Math.min(6, dt / 1800));
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  loadNow();

  if (!state.transcript.length) {
    addTranscript("system", "Incoming transmission: unidentified fleet at lunar distance.");
    addTranscript("system", "You are the negotiator. Keep THREAT low and PATIENCE high.");
  }

  // ---------------- control block parsing (robust, forgiving) ----------------
  // Accepts lots of key spellings: UTRUST / YOU_TRUST / TRUST / trust etc.
  const BLOCK_OPEN = "[[SIMLAB_V1]]";
  const BLOCK_CLOSE = "[[/SIMLAB_V1]]";

  function normaliseKey(k) {
    const s = String(k || "")
      .toUpperCase()
      .replace(/[^A-Z_]/g, "");
    // Strip common prefixes
    let t = s;
    t = t.replace(/^YOU_/, "");
    t = t.replace(/^WORLD_/, "");
    t = t.replace(/^ALIENS_/, "");
    t = t.replace(/^U_/, "");
    t = t.replace(/^W_/, "");
    t = t.replace(/^A_/, "");
    t = t.replace(/^U/, ""); // "UTRUST" -> "TRUST"
    t = t.replace(/^W/, ""); // "WSTABILITY" -> "STABILITY"
    t = t.replace(/^A/, ""); // "ATHREAT" -> "THREAT"
    // Canonical mappings
    if (t === "STABLE" || t === "STABILITY") return "STABILITY";
    if (t === "ECO" || t === "ECON" || t === "ECONOMY") return "ECONOMY";
    if (t === "PAT" || t === "PATIENCE") return "PATIENCE";
    if (t === "THREAT") return "THREAT";
    if (t === "TRUST") return "TRUST";
    if (t === "STATUS") return "STATUS";
    if (t === "CREDITS" || t === "MONEY" || t === "CREDIT") return "CREDITS";
    if (t === "TECH") return "TECH";
    return t;
  }

  function extractBlock(fullText) {
    const s = String(fullText || "");
    const a = s.indexOf(BLOCK_OPEN);
    const b = s.indexOf(BLOCK_CLOSE);
    if (a === -1 || b === -1 || b <= a) return null;
    const block = s.slice(a + BLOCK_OPEN.length, b).trim();
    const dialogue = (s.slice(0, a).trim() || "").trim();
    return { block, dialogue, raw: s };
  }

  function parseBlock(blockText) {
    const lines = String(blockText || "")
      .split("\n")
      .map((l) => l.replace(/\r/g, ""));

    const out = {
      speaker: "",
      tone: "",
      intent: "",
      summary: "",
      delta: {},
      eventsYou: [],
      eventsWorld: [],
      flags: [],
      suggestions: [],
    };

    // Default all deltas to 0 (NO hard failure if missing)
    for (let i = 0; i < STAT_KEYS.length; i++) out.delta[STAT_KEYS[i]] = 0;

    let section = "";
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) continue;

      if (line === "DELTA:" || line === "DELTA") { section = "DELTA"; continue; }
      if (line === "EVENTS_YOU:" || line === "EVENTS_YOU") { section = "EVENTS_YOU"; continue; }
      if (line === "EVENTS_WORLD:" || line === "EVENTS_WORLD") { section = "EVENTS_WORLD"; continue; }
      if (line === "FLAGS:" || line === "FLAGS") { section = "FLAGS"; continue; }
      if (line === "SUGGESTIONS:" || line === "SUGGESTIONS") { section = "SUGGESTIONS"; continue; }

      const mKV = line.match(/^([A-Z0-9_\- ]+)\s*:\s*(.*)$/);
      if (mKV && section !== "DELTA") {
        const key = String(mKV[1] || "").trim().toUpperCase().replace(/\s+/g, "_");
        const val = (mKV[2] || "").trim();
        if (key === "SPEAKER") out.speaker = val;
        else if (key === "TONE") out.tone = val;
        else if (key === "INTENT") out.intent = val;
        else if (key === "SUMMARY") out.summary = val;
        continue;
      }

      if (section === "DELTA") {
        const mD = line.match(/^([A-Z0-9_\- ]+)\s*:\s*([-+]?\d+)\s*$/);
        if (mD) {
          const key = normaliseKey(mD[1]);
          const v = clamp(parseInt(mD[2], 10) | 0, -25, 25);
          // Only apply to our canonical keys
          if (STAT_KEYS.indexOf(key) !== -1) out.delta[key] = v;
        }
        continue;
      }

      if (section === "EVENTS_YOU" || section === "EVENTS_WORLD" || section === "FLAGS" || section === "SUGGESTIONS") {
        const mL = line.match(/^-+\s*(.+)$/);
        if (mL) {
          const item = mL[1].trim();
          if (!item) continue;
          if (section === "EVENTS_YOU") out.eventsYou.push(item);
          else if (section === "EVENTS_WORLD") out.eventsWorld.push(item);
          else if (section === "FLAGS") out.flags.push(item);
          else out.suggestions.push(item);
        }
        continue;
      }
    }

    return out;
  }

  function applyDelta(delta) {
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const k = STAT_KEYS[i];
      const v = Number(delta[k]);
      if (!isFinite(v)) continue;
      state.stats[k] = pct(state.stats[k] + v);
    }
  }

  function checkLose() {
    const st = state.stats;
    if (st.THREAT >= 100) {
      state.gameOver = true;
      state.gameOverReason = "THREAT reached 100. Invasion begins.";
    } else if (st.STABILITY <= 0) {
      state.gameOver = true;
      state.gameOverReason = "STABILITY collapsed. Earth loses coherent control.";
    } else if (st.PATIENCE <= 0) {
      state.gameOver = true;
      state.gameOverReason = "PATIENCE hit 0. Talks end with ultimatum.";
    }
    return state.gameOver;
  }

  // ---------------- OpenRouter ----------------
  function buildHeaders() {
    return {
      Authorization: `Bearer ${OR_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer":
        typeof window !== "undefined" && window.location && window.location.origin
          ? window.location.origin
          : "http://localhost",
      "X-Title": "SimLab Alien Diplomacy Protocol",
    };
  }

  function cancelRequest() {
    if (state.abort) {
      try { state.abort.abort(); } catch {}
    }
    state.abort = null;
    state.busy = false;
    state.startedAt = 0;
  }

  function systemPrompt() {
    // Much tighter + no mandatory A/B/C
    return (
      "You are the alien envoy in a high-stakes diplomacy game.\n" +
      "You MUST respond in TWO PARTS:\n" +
      "1) Freeform alien dialogue (1–5 short paragraphs). Keep it grounded sci-fi.\n" +
      "2) EXACTLY ONE control block delimited by [[SIMLAB_V1]] and [[/SIMLAB_V1]].\n\n" +
      "CONTROL BLOCK FORMAT (ASCII only inside the block):\n" +
      "SPEAKER: <short name>\n" +
      "TONE: <one or two words>\n" +
      "INTENT: <one line>\n" +
      "SUMMARY: <one line>\n" +
      "DELTA:\n" +
      "  TRUST: <int -25..+25>\n" +
      "  STATUS: <int -25..+25>\n" +
      "  CREDITS: <int -25..+25>\n" +
      "  STABILITY: <int -25..+25>\n" +
      "  TECH: <int -25..+25>\n" +
      "  ECONOMY: <int -25..+25>\n" +
      "  PATIENCE: <int -25..+25>\n" +
      "  THREAT: <int -25..+25>\n" +
      "EVENTS_YOU:\n" +
      "- <0–3 bullet items>\n" +
      "EVENTS_WORLD:\n" +
      "- <0–3 bullet items>\n" +
      "FLAGS:\n" +
      "- <0–5 bullet items>\n" +
      "SUGGESTIONS:\n" +
      "- <0–5 bullet items: good next moves for the player>\n\n" +
      "Important:\n" +
      "- Always include the DELTA keys exactly as shown.\n" +
      "- Do NOT output JSON.\n" +
      "- Do NOT include extra blocks.\n"
    );
  }

  function buildMessages(playerText) {
    const st = state.stats;
    const compactState =
      `TURN=${state.turn}\n` +
      `TRUST=${fmtInt(st.TRUST)} STATUS=${fmtInt(st.STATUS)} CREDITS=${fmtInt(st.CREDITS)}\n` +
      `STABILITY=${fmtInt(st.STABILITY)} TECH=${fmtInt(st.TECH)} ECONOMY=${fmtInt(st.ECONOMY)}\n` +
      `PATIENCE=${fmtInt(st.PATIENCE)} THREAT=${fmtInt(st.THREAT)}\n`;

    const recent = state.transcript.slice(-12);
    let recap = "RECENT:\n";
    for (let i = 0; i < recent.length; i++) {
      const r = recent[i];
      const tag = r.role === "player" ? "PLAYER" : r.role === "alien" ? "ALIEN" : "SYS";
      const txt = (r.text || "").replace(/\s+/g, " ").trim();
      recap += `${tag}: ${txt.slice(0, 240)}\n`;
    }

    // You can extend this later for "analysis-only" calls; for now, one clean message path.
    const user =
      `PLAYER MESSAGE:\n${String(playerText || "").trim()}\n\n` +
      `STATE:\n${compactState}\n` +
      `${recap}\n` +
      `REMINDER: Freeform dialogue + one strict [[SIMLAB_V1]] block.\n`;

    return [
      { role: "system", content: systemPrompt() },
      { role: "user", content: user },
    ];
  }

  async function callOpenRouter(playerText) {
    if (!OR_KEY) return { ok: false, err: "Missing API key (VITE_OPENROUTER_API_KEY)." };
    if (state.busy) return { ok: false, err: "Busy." };
    if (state.gameOver) return { ok: false, err: "Game over." };

    state.busy = true;
    state.lastError = "";
    state.startedAt = nowSec();

    const controller = new AbortController();
    state.abort = controller;

    const body = {
      model: state.model,
      messages: buildMessages(playerText),
      temperature: state.temperature,
      max_tokens: state.maxTokens,
      stream: !!state.stream,
    };

    try {
      const res = await fetch(OR_BASE, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ok: false, err: `HTTP ${res.status}${txt ? `: ${txt.slice(0, 220)}` : ""}` };
      }

      if (!state.stream) {
        const json = await res.json().catch(() => null);
        if (!json) throw new Error("Bad JSON.");
        const content = (((json.choices || [])[0] || {}).message || {}).content || "";
        return { ok: true, text: String(content || "") };
      }

      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) throw new Error("Streaming not supported.");

      const decoder = new TextDecoder("utf-8");
      let buf = "";
      let done = false;
      let full = "";

      while (!done) {
        const { value, done: drDone } = await reader.read();
        if (drDone) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split("\n");
          for (let li = 0; li < lines.length; li++) {
            const line = lines[li].trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") { done = true; break; }
            const obj = safeJsonParse(payload);
            if (!obj) continue;
            const delta = (((obj.choices || [])[0] || {}).delta || {});
            const chunk = delta.content || "";
            if (chunk) full += chunk;
          }
        }
        if (controller.signal.aborted) break;
      }

      return { ok: true, text: full };
    } catch (e) {
      const msg = e && e.name === "AbortError" ? "Aborted" : e && e.message ? e.message : "Request error";
      return { ok: false, err: msg };
    } finally {
      state.busy = false;
      state.abort = null;
      state.startedAt = 0;
    }
  }

  async function runTurn(playerText) {
    addTranscript("player", playerText);

    const res = await callOpenRouter(playerText);
    if (!res.ok) {
      state.lastError = res.err || "Error";
      addTranscript("system", `Comms interference. (${state.lastError})`);
      // small, consistent penalty
      state.stats.PATIENCE = pct(state.stats.PATIENCE - 2);
      state.stats.THREAT = pct(state.stats.THREAT + 2);
      checkLose();
      state.turn++;
      saveNow();
      ui && ui.update();
      flash(`Comms error: ${state.lastError}`, 2.0);
      return;
    }

    const text = String(res.text || "");
    const extracted = extractBlock(text);

    if (!extracted) {
      // No block: show dialogue anyway, apply mild penalty, but DO NOT spam format errors.
      state.lastAlienText = text.trim().slice(0, 6000);
      addTranscript("alien", state.lastAlienText || "(no content)");
      addTranscript("system", "Control block missing. Applied mild penalty.");
      state.stats.PATIENCE = pct(state.stats.PATIENCE - 2);
      state.stats.THREAT = pct(state.stats.THREAT + 3);
      checkLose();
      state.turn++;
      saveNow();
      ui && ui.update();
      flash("Control block missing (mild penalty).", 1.8);
      return;
    }

    const control = parseBlock(extracted.block);

    state.lastAlienText = extracted.dialogue || "";
    state.lastControl = control;

    addTranscript("alien", state.lastAlienText || "(silent)");

    applyDelta(control.delta);

    if (control.eventsYou && control.eventsYou.length) {
      for (let i = 0; i < control.eventsYou.length && i < 3; i++) {
        addTranscript("system", `YOU: ${control.eventsYou[i]}`);
      }
    }
    if (control.eventsWorld && control.eventsWorld.length) {
      for (let i = 0; i < control.eventsWorld.length && i < 3; i++) {
        addTranscript("system", `WORLD: ${control.eventsWorld[i]}`);
      }
    }
    if (control.flags && control.flags.length) {
      addTranscript("system", `FLAGS: ${control.flags.slice(0, 5).join(", ")}`);
    }

    checkLose();
    state.turn++;
    saveNow();
    ui && ui.update();
  }

  // ---------------- UI ----------------
  let ui = null;

  function buildUI() {
    if (!uiRoot) return null;

    uiRoot.innerHTML = "";

    const panel = el("div", {
      position: "fixed",
      left: "12px",
      top: "12px",
      width: "540px",
      maxWidth: "calc(100vw - 24px)",
      maxHeight: "calc(100vh - 24px)",
      overflow: "auto",
      padding: "12px",
      borderRadius: "14px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(0,0,0,0.82)",
      backdropFilter: "blur(6px)",
      boxShadow: "0 0 24px rgba(40,120,255,0.10)",
      color: "#dff6ff",
      font: "14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      zIndex: "9999",
    });

    // Header
    const header = el("div", { display: "flex", alignItems: "baseline", gap: "10px" });
    const title = el("div", { fontWeight: "950", fontSize: "16px" });
    title.textContent = "Alien Diplomacy Protocol";
    const sub = el("div", { fontSize: "12px", opacity: "0.85" });
    sub.textContent = `Turn ${state.turn} • Key: ${OR_KEY ? "present" : "MISSING"}`;
    header.appendChild(title);
    header.appendChild(sub);
    panel.appendChild(header);

    const divider = () =>
      panel.appendChild(el("div", { height: "1px", background: "rgba(120,180,255,0.12)", margin: "10px 0" }));

    divider();

    // Stats grid (labels + bars)
    const statsWrap = el("div", {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "10px 12px",
      alignItems: "center",
    });

    const statRows = {};
    function makeStat(name, hint) {
      const row = el("div", { display: "grid", gridTemplateColumns: "110px 1fr 36px", gap: "8px", alignItems: "center" });
      const lab = el("div", { fontSize: "12px", opacity: "0.92", fontWeight: "800" });
      lab.textContent = name;
      if (hint) lab.title = hint;

      const barOuter = el("div", {
        height: "10px",
        borderRadius: "999px",
        background: "rgba(223,246,255,0.10)",
        border: "1px solid rgba(120,180,255,0.18)",
        overflow: "hidden",
      });

      const barInner = el("div", {
        height: "100%",
        width: "50%",
        background: "rgba(61,252,255,0.55)",
      });

      barOuter.appendChild(barInner);

      const num = el("div", { fontSize: "12px", opacity: "0.90", textAlign: "right", fontWeight: "800" });
      num.textContent = "0";

      row.appendChild(lab);
      row.appendChild(barOuter);
      row.appendChild(num);

      return { row, barInner, num, lab };
    }

    // A slightly opinionated ordering
    const s1 = makeStat("TRUST", "How much the aliens believe you're acting in good faith.");
    const s2 = makeStat("THREAT", "How close this is to violence. Keep low.");
    const s3 = makeStat("PATIENCE", "How long they’ll tolerate delays or evasiveness.");
    const s4 = makeStat("STABILITY", "Earth-side political stability and control.");
    const s5 = makeStat("STATUS", "Your personal standing / authority to negotiate.");
    const s6 = makeStat("CREDITS", "Your personal leverage/resources (abstract).");
    const s7 = makeStat("TECH", "Earth’s technical capability / understanding.");
    const s8 = makeStat("ECONOMY", "Earth’s economic outlook.");

    // Colour tweaks
    s1.barInner.style.background = "rgba(61,252,255,0.55)";
    s2.barInner.style.background = "rgba(255,75,216,0.55)";
    s3.barInner.style.background = "rgba(176,75,255,0.55)";
    s4.barInner.style.background = "rgba(42,162,255,0.55)";
    s5.barInner.style.background = "rgba(61,252,255,0.40)";
    s6.barInner.style.background = "rgba(176,75,255,0.40)";
    s7.barInner.style.background = "rgba(42,162,255,0.40)";
    s8.barInner.style.background = "rgba(255,75,216,0.35)";

    statsWrap.appendChild(s1.row);
    statsWrap.appendChild(s2.row);
    statsWrap.appendChild(s3.row);
    statsWrap.appendChild(s4.row);
    statsWrap.appendChild(s5.row);
    statsWrap.appendChild(s6.row);
    statsWrap.appendChild(s7.row);
    statsWrap.appendChild(s8.row);

    statRows.TRUST = s1;
    statRows.THREAT = s2;
    statRows.PATIENCE = s3;
    statRows.STABILITY = s4;
    statRows.STATUS = s5;
    statRows.CREDITS = s6;
    statRows.TECH = s7;
    statRows.ECONOMY = s8;

    panel.appendChild(statsWrap);

    divider();

    // Settings row
    const settings = el("div", {
      display: "grid",
      gridTemplateColumns: "1fr 120px 120px",
      gap: "8px",
      alignItems: "center",
    });

    const modelIn = el("input", {
      width: "100%",
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(8,12,18,0.90)",
      color: "#dff6ff",
      outline: "none",
      font: "700 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    });
    modelIn.value = state.model;

    const tempIn = el("input", { width: "100%" });
    tempIn.type = "range";
    tempIn.min = "0";
    tempIn.max = "2";
    tempIn.step = "0.05";
    tempIn.value = String(state.temperature);

    const streamWrap = el("label", {
      display: "flex",
      gap: "8px",
      alignItems: "center",
      justifyContent: "flex-start",
      fontSize: "12px",
      opacity: "0.9",
      cursor: "pointer",
      userSelect: "none",
      paddingLeft: "6px",
    });
    const streamBox = document.createElement("input");
    streamBox.type = "checkbox";
    streamBox.checked = state.stream;
    const streamText = document.createTextNode("Stream");
    streamWrap.appendChild(streamBox);
    streamWrap.appendChild(streamText);

    settings.appendChild(modelIn);
    settings.appendChild(tempIn);
    settings.appendChild(streamWrap);

    panel.appendChild(settings);

    const settingsHint = el("div", { fontSize: "11px", opacity: "0.70", marginTop: "6px" });
    settingsHint.textContent = "Model + temperature affect style/creativity. Streaming shows the reply as it arrives.";
    panel.appendChild(settingsHint);

    divider();

    // Input area (clearly input)
    const inLabel = el("div", { fontSize: "12px", fontWeight: "900", opacity: "0.90" });
    inLabel.textContent = "Your message (input)";
    panel.appendChild(inLabel);

    const input = el("textarea", {
      width: "100%",
      height: "120px",
      marginTop: "6px",
      padding: "10px 10px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.25)",
      background: "rgba(8,12,18,0.92)",
      color: "#dff6ff",
      outline: "none",
      resize: "vertical",
      font: "650 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      lineHeight: "1.35",
    });
    input.value = state.inputText;
    panel.appendChild(input);

    // Buttons row
    const row = el("div", { display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" });
    const send = btn("Send");
    const stop = btn("Stop");
    const reset = btn("Reset");
    const back = el("a", {
      display: "inline-flex",
      alignItems: "center",
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(42,162,255,0.25)",
      color: "#2aa2ff",
      textDecoration: "none",
      font: "800 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      background: "rgba(0,0,0,0.25)",
    });
    back.href = "/";
    back.textContent = "Back";

    row.appendChild(send);
    row.appendChild(stop);
    row.appendChild(reset);
    row.appendChild(back);
    panel.appendChild(row);

    // Status line
    const status = el("div", {
      marginTop: "8px",
      fontSize: "12px",
      minHeight: "18px",
      color: "#ff4bd8",
      whiteSpace: "pre-wrap",
    });
    panel.appendChild(status);

    divider();

    // Output area (clearly output + readonly)
    const outLabel = el("div", { fontSize: "12px", fontWeight: "900", opacity: "0.90" });
    outLabel.textContent = "Alien reply (output)";
    panel.appendChild(outLabel);

    const output = el("textarea", {
      width: "100%",
      height: "240px",
      marginTop: "6px",
      padding: "10px 10px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.18)",
      background: "rgba(0,0,0,0.55)",
      color: "#dff6ff",
      outline: "none",
      resize: "vertical",
      font: "650 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      lineHeight: "1.35",
    });
    output.readOnly = true;
    output.value = state.lastAlienText || "";
    panel.appendChild(output);

    // Suggestions/notes (optional, editable)
    divider();

    const notesLabel = el("div", { fontSize: "12px", fontWeight: "900", opacity: "0.90" });
    notesLabel.textContent = "Notes (local, optional)";
    panel.appendChild(notesLabel);

    const notes = el("textarea", {
      width: "100%",
      height: "64px",
      marginTop: "6px",
      padding: "10px 10px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.14)",
      background: "rgba(0,0,0,0.35)",
      color: "rgba(223,246,255,0.82)",
      outline: "none",
      resize: "vertical",
      font: "650 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      lineHeight: "1.35",
    });
    notes.value = state.notesText || "";
    panel.appendChild(notes);

    uiRoot.appendChild(panel);

    // ---- wiring ----
    function syncSettings() {
      state.model = (modelIn.value || "").trim() || state.model;
      state.temperature = clamp(parseFloat(tempIn.value), 0, 2);
      state.stream = !!streamBox.checked;
      saveNow();
      update();
    }

    modelIn.onchange = syncSettings;
    tempIn.oninput = () => {
      syncSettings();
      flash(`Temperature: ${state.temperature.toFixed(2)}`, 0.6);
    };
    streamBox.onchange = syncSettings;

    input.oninput = () => {
      state.inputText = input.value || "";
    };
    notes.oninput = () => {
      state.notesText = notes.value || "";
    };

    async function doSend() {
      if (state.busy) return;
      if (state.gameOver) {
        flash("Game over. Reset to play again.", 1.5);
        update();
        return;
      }
      const text = (input.value || "").trim();
      if (!text) {
        flash("Type a message first.", 0.9);
        update();
        return;
      }
      if (!OR_KEY) {
        flash("Missing API key. Set VITE_OPENROUTER_API_KEY in .env and restart Vite.", 2.4);
        update();
        return;
      }
      state.lastError = "";
      status.textContent = "";
      output.value = "";
      update();
      await runTurn(text);
      output.value = state.lastAlienText || "";
      update();
    }

    send.onclick = doSend;

    stop.onclick = () => {
      if (!state.busy) return;
      cancelRequest();
      flash("Cancelled.", 0.9);
      update();
    };

    reset.onclick = () => {
      const ok = confirm("Reset run? This wipes current progress.");
      if (!ok) return;
      cancelRequest();
      state.turn = 1;
      state.stats = { ...DEFAULT_STATS };
      state.transcript = [];
      state.lastAlienText = "";
      state.lastControl = null;
      state.lastError = "";
      state.gameOver = false;
      state.gameOverReason = "";
      state.inputText =
        "We want peaceful contact. What do you need, and what can we offer that benefits both sides?";
      addTranscript("system", "Incoming transmission: unidentified fleet at lunar distance.");
      addTranscript("system", "You are the negotiator. Keep THREAT low and PATIENCE high.");
      input.value = state.inputText;
      output.value = "";
      saveNow();
      flash("Reset.", 0.8);
      update();
    };

    function update() {
      // Top header line
      sub.textContent = `Turn ${state.turn} • Key: ${OR_KEY ? "present" : "MISSING"}${state.gameOver ? " • GAME OVER" : ""}`;

      // Stats
      for (let i = 0; i < STAT_KEYS.length; i++) {
        const k = STAT_KEYS[i];
        const row = statRows[k];
        if (!row) continue;
        const v = pct(state.stats[k]);
        row.barInner.style.width = `${v}%`;
        row.num.textContent = fmtInt(v);
      }

      // Busy controls
      setDisabled(send, state.busy || state.gameOver);
      setDisabled(stop, !state.busy);
      setDisabled(reset, state.busy);

      // Status
      if (state.gameOver) status.textContent = state.gameOverReason || "Game over.";
      else if (state.lastError) status.textContent = `Error: ${state.lastError}`;
      else if (nowSec() < state.statusUntil && state.status) status.textContent = state.status;
      else if (state.lastControl && state.lastControl.summary) status.textContent = state.lastControl.summary;
      else status.textContent = "";

      // Keep output aligned with latest
      // (Don’t constantly overwrite while user scrolls; only set on updates that matter)
    }

    return { update, input, output, status };
  }

  ui = buildUI();
  if (ui) ui.update();

  // ---------------- keyboard ----------------
  async function sendFromUI() {
    if (!ui) return;
    // mimic clicking send
    const text = (ui.input.value || "").trim();
    if (!text) {
      flash("Type a message first.", 0.9);
      ui.update();
      return;
    }
    if (state.busy) return;
    if (state.gameOver) {
      flash("Game over. Reset to play again.", 1.5);
      ui.update();
      return;
    }
    if (!OR_KEY) {
      flash("Missing API key. Set VITE_OPENROUTER_API_KEY in .env and restart Vite.", 2.4);
      ui.update();
      return;
    }

    state.lastError = "";
    ui.status.textContent = "";
    ui.output.value = "";
    ui.update();

    await runTurn(text);

    ui.output.value = state.lastAlienText || "";
    ui.update();
  }

  function onKeyDown(ev) {
    const k = ev && ev.key ? ev.key : "";
    if (k === " " || k === "Spacebar") {
      Engine.togglePause();
      state.paused = Engine.isPaused();
      flash(state.paused ? "Paused." : "Running.", 0.8);
      ui && ui.update();
      return;
    }
    if (k === "Escape") {
      if (state.busy) {
        cancelRequest();
        flash("Cancelled.", 0.9);
        ui && ui.update();
      }
      return;
    }
    if (k === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      // Ctrl+Enter sends
      sendFromUI();
      return;
    }
    if (k === "r" || k === "R") {
      const ok = confirm("Reset run? This wipes current progress.");
      if (!ok) return;
      cancelRequest();
      state.turn = 1;
      state.stats = { ...DEFAULT_STATS };
      state.transcript = [];
      state.lastAlienText = "";
      state.lastControl = null;
      state.lastError = "";
      state.gameOver = false;
      state.gameOverReason = "";
      state.inputText =
        "We want peaceful contact. What do you need, and what can we offer that benefits both sides?";
      addTranscript("system", "Incoming transmission: unidentified fleet at lunar distance.");
      addTranscript("system", "You are the negotiator. Keep THREAT low and PATIENCE high.");
      if (ui) {
        ui.input.value = state.inputText;
        ui.output.value = "";
        ui.update();
      }
      saveNow();
      flash("Reset.", 0.8);
      return;
    }
  }

  // ---------------- render/update (clean + minimal) ----------------
  function update(dt) {
    state.paused = Engine.isPaused();
    if (state.paused) return;

    const tNow = nowSec();
    if (tNow >= state.autosaveAt) {
      saveNow();
      state.autosaveAt = tNow + 8.0;
    }
  }

  function render() {
    // No pointless visuals: just a clean black canvas.
    Engine.gfx.clearBlack();
  }

  // ---------------- boot ----------------
  state.autosaveAt = nowSec() + 8.0;
  window.addEventListener("beforeunload", () => {
    try {
      saveNow();
    } catch {}
  });

  Engine.on("update", update);
  Engine.on("render", render);
  Engine.on("onKeyDown", onKeyDown);

  // Small UX: if uiRoot missing, at least make it obvious.
  if (!uiRoot) {
    // Minimal on-canvas hint would require drawing text; you explicitly said the overlap is bad,
    // so instead we use a single console error.
    console.warn("[SimLab] Alien Diplomacy Protocol: ctx.uiRoot is missing; UI panel cannot be created.");
  }

  // If key missing, prompt once via status (visible in UI).
  if (ui && !OR_KEY) {
    flash("Missing API key. Set VITE_OPENROUTER_API_KEY in .env then restart Vite.", 6.0);
    ui.update();
  }
}
