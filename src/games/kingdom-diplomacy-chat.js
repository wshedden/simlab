import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab.kingdomDiplomacyChat.v1";
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

  // ---------------- utilities ----------------
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const nowSec = () => performance.now() * 0.001;
  const TAU = Math.PI * 2;

  function safeJsonParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function fmtGold(n) {
    n = Number(n);
    if (!isFinite(n)) n = 0;
    const r = Math.round(n);
    return `${r}g`;
  }

  function fmtRel(n) {
    n = Math.round(Number(n) || 0);
    if (n > 0) return `+${n}`;
    return `${n}`;
  }

  function monthName(m) {
    const a = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return a[((m % 12) + 12) % 12];
  }

  function el(tag, styleObj) {
    const e = document.createElement(tag);
    if (styleObj) Object.assign(e.style, styleObj);
    return e;
  }

  function btn(label) {
    const b = el("button", {
      padding: "9px 12px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.22)",
      background: "rgba(8,12,18,0.92)",
      color: "#dff6ff",
      cursor: "pointer",
      font: "800 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      userSelect: "none",
      whiteSpace: "nowrap",
    });
    b.textContent = label;
    b.onmouseenter = () => (b.style.borderColor = "rgba(255,75,216,0.40)");
    b.onmouseleave = () => (b.style.borderColor = "rgba(120,180,255,0.22)");
    return b;
  }

  function setDisabled(b, dis) {
    b.disabled = !!dis;
    b.style.opacity = dis ? "0.55" : "1";
    b.style.cursor = dis ? "not-allowed" : "pointer";
  }

  function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ---------------- world model ----------------
  // Player is England (simple diplomacy sandbox, one action per month)
  const REALMS = [
    {
      id: "ENG",
      name: "England",
      colour: "#2aa2ff",
      capital: "London",
      provinces: ["London", "Kent", "Wessex", "Mercia", "York"],
      artifacts: ["Wool Contracts", "Royal Charter Seal"],
      gold: 220,
      aiStyle: "direct, pragmatic, modern",
    },
    {
      id: "SCO",
      name: "Scotland",
      colour: "#b54bff",
      capital: "Edinburgh",
      provinces: ["Lothian", "Fife", "Highlands", "Aberdeenshire"],
      artifacts: ["Highland Timber Rights"],
      gold: 140,
      aiStyle: "blunt, guarded, modern",
    },
    {
      id: "IRE",
      name: "Ireland",
      colour: "#3dfcff",
      capital: "Dublin",
      provinces: ["Leinster", "Munster", "Connacht", "Ulster"],
      artifacts: ["Harbour Access Pact"],
      gold: 120,
      aiStyle: "wry, transactional, modern",
    },
    {
      id: "FRA",
      name: "France",
      colour: "#ff4bd8",
      capital: "Paris",
      provinces: ["Île-de-France", "Normandy", "Brittany", "Aquitaine", "Burgundy Fringe"],
      artifacts: ["Wine Monopoly Writ", "Court Favour Token"],
      gold: 280,
      aiStyle: "confident, strategic, modern",
    },
    {
      id: "CAS",
      name: "Castile",
      colour: "#2aa2ff",
      capital: "Toledo",
      provinces: ["Castilla", "Galicia", "Andalucía (North)"],
      artifacts: ["Silver Assay Mark"],
      gold: 240,
      aiStyle: "formal but plain, modern",
    },
    {
      id: "POR",
      name: "Portugal",
      colour: "#b54bff",
      capital: "Lisbon",
      provinces: ["Lisboa", "Porto", "Algarve"],
      artifacts: ["Atlantic Charts (Draft)"],
      gold: 180,
      aiStyle: "practical, friendly, modern",
    },
  ];

  const REALM_BY_ID = {};
  for (let i = 0; i < REALMS.length; i++) REALM_BY_ID[REALMS[i].id] = REALMS[i];

  function defaultRelations() {
    // -100..+100
    return {
      SCO: -10,
      IRE: +5,
      FRA: -15,
      CAS: +8,
      POR: +18,
    };
  }

  const state = {
    paused: false,

    // time
    year: 1444,
    month: 10, // Nov (0-based)
    actionAvailable: true,

    // settings
    model: "openai/gpt-4o-mini",
    temperature: 0.45,
    maxTokens: 700,
    stream: true,

    // player
    playerId: "ENG",
    playerGold: REALM_BY_ID.ENG.gold,
    relations: defaultRelations(),

    // inventories
    invPlayer: REALM_BY_ID.ENG.artifacts.slice(),
    invOther: {
      SCO: REALM_BY_ID.SCO.artifacts.slice(),
      IRE: REALM_BY_ID.IRE.artifacts.slice(),
      FRA: REALM_BY_ID.FRA.artifacts.slice(),
      CAS: REALM_BY_ID.CAS.artifacts.slice(),
      POR: REALM_BY_ID.POR.artifacts.slice(),
    },
    goldOther: {
      SCO: REALM_BY_ID.SCO.gold,
      IRE: REALM_BY_ID.IRE.gold,
      FRA: REALM_BY_ID.FRA.gold,
      CAS: REALM_BY_ID.CAS.gold,
      POR: REALM_BY_ID.POR.gold,
    },

    // UI selection
    selectedRealm: "SCO",

    // chat logs per realm
    chats: {
      SCO: [],
      IRE: [],
      FRA: [],
      CAS: [],
      POR: [],
    },

    // monthly log
    worldEvents: [], // {t, text}
    status: "",
    statusUntil: 0,

    // request lifecycle
    busy: false,
    abort: null,
    lastError: "",
    autosaveAt: 0,

    // offer builder
    offer: {
      giveGold: 0,
      takeGold: 0,
      giveItems: {}, // item -> true
      takeItems: {}, // item -> true
    },
  };

  function flash(msg, seconds = 1.2) {
    state.status = String(msg || "");
    state.statusUntil = nowSec() + seconds;
  }

  function chatAdd(realmId, who, text) {
    const arr = state.chats[realmId];
    if (!arr) return;
    arr.push({
      id: uid(),
      who,
      text: String(text || ""),
      ts: Date.now(),
      month: state.month,
      year: state.year,
    });
    if (arr.length > 200) arr.splice(0, arr.length - 200);
  }

  function worldAdd(text) {
    state.worldEvents.push({ t: Date.now(), text: String(text || "") });
    if (state.worldEvents.length > 80) state.worldEvents.splice(0, state.worldEvents.length - 80);
  }

  function advanceMonth() {
    state.month++;
    if (state.month >= 12) {
      state.month = 0;
      state.year++;
    }
    state.actionAvailable = true;

    // small drift: if you keep being hostile, relations worsen; if friendly, slight stabilisation
    const keys = Object.keys(state.relations);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      let r = state.relations[k] || 0;
      // Gentle mean reversion to 0
      r += (0 - r) * 0.02;
      state.relations[k] = clamp(Math.round(r), -100, 100);
    }
  }

  // ---------------- persistence ----------------
  function saveNow() {
    try {
      Engine.save(SAVE_KEY, {
        v: 1,
        year: state.year,
        month: state.month,
        actionAvailable: state.actionAvailable,
        model: state.model,
        temperature: state.temperature,
        maxTokens: state.maxTokens,
        stream: state.stream,
        playerGold: state.playerGold,
        relations: state.relations,
        invPlayer: state.invPlayer,
        invOther: state.invOther,
        goldOther: state.goldOther,
        chats: state.chats,
        worldEvents: state.worldEvents,
        selectedRealm: state.selectedRealm,
        savedAt: Date.now(),
      });
    } catch {}
  }

  function loadNow() {
    try {
      const s = Engine.load(SAVE_KEY, null);
      if (!s || typeof s !== "object") return false;

      if (typeof s.year === "number") state.year = Math.max(1000, s.year | 0);
      if (typeof s.month === "number") state.month = clamp(s.month | 0, 0, 11);
      if (typeof s.actionAvailable === "boolean") state.actionAvailable = s.actionAvailable;

      if (typeof s.model === "string") state.model = s.model;
      if (typeof s.temperature === "number") state.temperature = clamp(s.temperature, 0, 2);
      if (typeof s.maxTokens === "number") state.maxTokens = clamp(s.maxTokens | 0, 64, 4000);
      if (typeof s.stream === "boolean") state.stream = s.stream;

      if (typeof s.playerGold === "number") state.playerGold = Math.max(0, s.playerGold);
      if (s.relations && typeof s.relations === "object") {
        const keys = Object.keys(defaultRelations());
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          state.relations[k] = clamp((Number(s.relations[k]) || 0) | 0, -100, 100);
        }
      }
      if (Array.isArray(s.invPlayer)) state.invPlayer = s.invPlayer.slice(0, 64).map(String);
      if (s.invOther && typeof s.invOther === "object") {
        const ids = ["SCO", "IRE", "FRA", "CAS", "POR"];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const arr = s.invOther[id];
          if (Array.isArray(arr)) state.invOther[id] = arr.slice(0, 64).map(String);
        }
      }
      if (s.goldOther && typeof s.goldOther === "object") {
        const ids = ["SCO", "IRE", "FRA", "CAS", "POR"];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const g = Number(s.goldOther[id]);
          if (isFinite(g)) state.goldOther[id] = Math.max(0, g);
        }
      }
      if (s.chats && typeof s.chats === "object") {
        const ids = ["SCO", "IRE", "FRA", "CAS", "POR"];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const arr = s.chats[id];
          if (Array.isArray(arr)) state.chats[id] = arr.slice(0, 200);
        }
      }
      if (Array.isArray(s.worldEvents)) state.worldEvents = s.worldEvents.slice(0, 80);
      if (typeof s.selectedRealm === "string" && state.chats[s.selectedRealm]) {
        state.selectedRealm = s.selectedRealm;
      }

      // tiny offline: if you end a month without acting, no free income; just keep it safe.
      return true;
    } catch {
      return false;
    }
  }

  loadNow();

  // seed initial chat if empty
  function ensureIntro(realmId) {
    const arr = state.chats[realmId];
    if (arr && arr.length) return;

    const r = REALM_BY_ID[realmId];
    chatAdd(realmId, "system", `${monthName(state.month)} ${state.year}. You open a channel to ${r.name}. One action per month.`);
    chatAdd(
      realmId,
      "system",
      `Keep it modern and blunt. Offer deals, threats, concessions. Everything you write can change relations, gold, and artifacts.`
    );
  }

  const otherIds = ["SCO", "IRE", "FRA", "CAS", "POR"];
  for (let i = 0; i < otherIds.length; i++) ensureIntro(otherIds[i]);

  // ---------------- strict control block parsing ----------------
  const BLOCK_OPEN = "[[DIPLOMACY_V1]]";
  const BLOCK_CLOSE = "[[/DIPLOMACY_V1]]";

  function extractBlock(fullText) {
    const s = String(fullText || "");
    const a = s.indexOf(BLOCK_OPEN);
    const b = s.indexOf(BLOCK_CLOSE);
    if (a === -1 || b === -1 || b <= a) return null;
    const block = s.slice(a + BLOCK_OPEN.length, b).trim();
    const dialogue = (s.slice(0, a).trim() || "").trim();
    return { block, dialogue };
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
      toRealm: state.selectedRealm,
      deltaRelations: {}, // realmId -> int
      deltaGoldPlayer: 0,
      deltaGoldOther: 0,
      transferGiveItems: [],
      transferTakeItems: [],
      worldEvents: [],
      suggestions: [],
      flags: [],
    };

    // defaults
    for (let i = 0; i < otherIds.length; i++) out.deltaRelations[otherIds[i]] = 0;

    let section = "";
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) continue;

      if (line === "DELTA_RELATIONS:" || line === "DELTA_RELATIONS") { section = "DELTA_REL"; continue; }
      if (line === "TRANSFER_ITEMS:" || line === "TRANSFER_ITEMS") { section = "XFER"; continue; }
      if (line === "WORLD_EVENTS:" || line === "WORLD_EVENTS") { section = "WORLD"; continue; }
      if (line === "SUGGESTIONS:" || line === "SUGGESTIONS") { section = "SUGG"; continue; }
      if (line === "FLAGS:" || line === "FLAGS") { section = "FLAGS"; continue; }

      const kv = line.match(/^([A-Z0-9_\- ]+)\s*:\s*(.*)$/);
      if (kv && section !== "DELTA_REL" && section !== "XFER") {
        const key = String(kv[1] || "").trim().toUpperCase().replace(/\s+/g, "_");
        const val = String(kv[2] || "").trim();
        if (key === "SPEAKER") out.speaker = val;
        else if (key === "TONE") out.tone = val;
        else if (key === "INTENT") out.intent = val;
        else if (key === "SUMMARY") out.summary = val;
        else if (key === "TO_REALM") {
          const t = val.toUpperCase();
          if (REALM_BY_ID[t] && t !== "ENG") out.toRealm = t;
        } else if (key === "DELTA_GOLD_PLAYER") out.deltaGoldPlayer = clamp((parseInt(val, 10) || 0) | 0, -500, 500);
        else if (key === "DELTA_GOLD_OTHER") out.deltaGoldOther = clamp((parseInt(val, 10) || 0) | 0, -500, 500);
        continue;
      }

      if (section === "DELTA_REL") {
        const m = line.match(/^([A-Z]{3})\s*:\s*([-+]?\d+)\s*$/);
        if (m) {
          const id = m[1].toUpperCase();
          const v = clamp((parseInt(m[2], 10) || 0) | 0, -25, 25);
          if (id !== "ENG" && state.relations[id] !== undefined) out.deltaRelations[id] = v;
        }
        continue;
      }

      if (section === "XFER") {
        // Give: item; item  OR  Take: item; item
        const mG = line.match(/^GIVE\s*:\s*(.*)$/i);
        const mT = line.match(/^TAKE\s*:\s*(.*)$/i);
        if (mG) {
          const parts = mG[1].split(";").map((p) => p.trim()).filter(Boolean);
          for (let j = 0; j < parts.length && out.transferGiveItems.length < 8; j++) out.transferGiveItems.push(parts[j]);
        } else if (mT) {
          const parts = mT[1].split(";").map((p) => p.trim()).filter(Boolean);
          for (let j = 0; j < parts.length && out.transferTakeItems.length < 8; j++) out.transferTakeItems.push(parts[j]);
        }
        continue;
      }

      if (section === "WORLD" || section === "SUGG" || section === "FLAGS") {
        const mL = line.match(/^-+\s*(.+)$/);
        if (mL) {
          const item = mL[1].trim();
          if (!item) continue;
          if (section === "WORLD") out.worldEvents.push(item);
          else if (section === "SUGG") out.suggestions.push(item);
          else out.flags.push(item);
        }
        continue;
      }
    }

    return out;
  }

  function applyControl(ctrl) {
    // gold deltas
    state.playerGold = Math.max(0, state.playerGold + (ctrl.deltaGoldPlayer | 0));
    const rid = ctrl.toRealm;
    state.goldOther[rid] = Math.max(0, (state.goldOther[rid] || 0) + (ctrl.deltaGoldOther | 0));

    // relations deltas
    const keys = Object.keys(ctrl.deltaRelations || {});
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (state.relations[k] === undefined) continue;
      state.relations[k] = clamp((state.relations[k] || 0) + (ctrl.deltaRelations[k] | 0), -100, 100);
    }

    // item transfers (best-effort; only if items exist)
    // GIVE: player -> other
    for (let i = 0; i < ctrl.transferGiveItems.length; i++) {
      const item = ctrl.transferGiveItems[i];
      const idx = state.invPlayer.indexOf(item);
      if (idx !== -1) {
        state.invPlayer.splice(idx, 1);
        state.invOther[rid].push(item);
      }
    }
    // TAKE: other -> player
    for (let i = 0; i < ctrl.transferTakeItems.length; i++) {
      const item = ctrl.transferTakeItems[i];
      const arr = state.invOther[rid];
      const idx = arr.indexOf(item);
      if (idx !== -1) {
        arr.splice(idx, 1);
        state.invPlayer.push(item);
      }
    }

    // world events
    for (let i = 0; i < ctrl.worldEvents.length && i < 4; i++) worldAdd(ctrl.worldEvents[i]);

    // store summary as a small system note in chat
    if (ctrl.summary) chatAdd(rid, "system", `Outcome: ${ctrl.summary}`);
  }

  // ---------------- LLM prompt + OpenRouter ----------------
  function buildHeaders() {
    return {
      Authorization: `Bearer ${OR_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer":
        typeof window !== "undefined" && window.location && window.location.origin
          ? window.location.origin
          : "http://localhost",
      "X-Title": "SimLab Kingdom Diplomacy Chat",
    };
  }

  function systemPromptFor(realmId) {
    const r = REALM_BY_ID[realmId];
    return (
      "You are simulating diplomacy messages in a lightweight strategy sandbox.\n" +
      "Setting: year 1444, but everyone speaks in plain modern-day English.\n" +
      "Player is England. You are the ruler/minister of the target realm.\n\n" +
      "Style rules:\n" +
      "- Keep replies SHORT: 3–10 sentences total.\n" +
      "- No flowery 'esteemed envoy' stuff. Be blunt, concrete, and transactional.\n" +
      "- Make it feel like two leaders negotiating over money, favours, artifacts, and territory pressure.\n\n" +
      "You MUST output TWO parts:\n" +
      "1) The freeform message text.\n" +
      "2) Exactly one control block delimited by [[DIPLOMACY_V1]] and [[/DIPLOMACY_V1]].\n\n" +
      "Control block format (ASCII only inside the block):\n" +
      "SPEAKER: <short name>\n" +
      "TONE: <e.g. calm / annoyed / upbeat / threatening>\n" +
      "INTENT: <one line>\n" +
      "SUMMARY: <one line: what just happened>\n" +
      `TO_REALM: ${realmId}\n` +
      "DELTA_GOLD_PLAYER: <int -500..+500>\n" +
      "DELTA_GOLD_OTHER: <int -500..+500>\n" +
      "DELTA_RELATIONS:\n" +
      "  SCO: <int -25..+25>\n" +
      "  IRE: <int -25..+25>\n" +
      "  FRA: <int -25..+25>\n" +
      "  CAS: <int -25..+25>\n" +
      "  POR: <int -25..+25>\n" +
      "TRANSFER_ITEMS:\n" +
      "  GIVE: <semicolon-separated item names that the PLAYER gives>\n" +
      "  TAKE: <semicolon-separated item names that the PLAYER receives>\n" +
      "WORLD_EVENTS:\n" +
      "- <0–4 bullet items>\n" +
      "FLAGS:\n" +
      "- <0–5 bullet items>\n" +
      "SUGGESTIONS:\n" +
      "- <0–5 bullet items: good next moves for the player>\n\n" +
      "Important:\n" +
      "- Always include all five DELTA_RELATIONS lines.\n" +
      "- Keep deltas small most of the time.\n" +
      "- Don't invent items; only trade items that exist in inventories.\n" +
      "- Don't write JSON.\n" +
      `Persona for ${r.name}: ${r.aiStyle}.\n`
    );
  }

  function buildContextFor(realmId, playerText, offerText) {
    const r = REALM_BY_ID[realmId];
    const rel = state.relations[realmId] || 0;

    const invPlayer = state.invPlayer.slice(0, 12).join("; ") || "(none)";
    const invOther = state.invOther[realmId].slice(0, 12).join("; ") || "(none)";

    const timeStr = `${monthName(state.month)} ${state.year}`;
    const relStr =
      rel >= 30 ? "friendly" : rel >= 10 ? "warm" : rel >= -10 ? "neutral" : rel >= -30 ? "cold" : "hostile";

    // take last chat snippets
    const log = state.chats[realmId] || [];
    const recent = log.slice(-10);
    let recap = "";
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      const who = m.who === "player" ? "ENGLAND" : m.who === "other" ? r.name.toUpperCase() : "SYSTEM";
      const t = (m.text || "").replace(/\s+/g, " ").trim();
      recap += `${who}: ${t.slice(0, 280)}\n`;
    }

    const world = state.worldEvents.slice(-6).map((e) => e.text).join(" | ");

    return (
      `TIME: ${timeStr}\n` +
      `TARGET: ${r.name} (capital: ${r.capital})\n` +
      `RELATIONSHIP: ${relStr} (${rel})\n` +
      `ENGLAND_GOLD: ${Math.round(state.playerGold)}\n` +
      `${r.name}_GOLD: ${Math.round(state.goldOther[realmId] || 0)}\n` +
      `ENGLAND_ARTIFACTS: ${invPlayer}\n` +
      `${r.name}_ARTIFACTS: ${invOther}\n` +
      `WORLD_RECENT: ${world || "(none)"}\n\n` +
      `PLAYER_MESSAGE:\n${String(playerText || "").trim()}\n\n` +
      (offerText ? `PLAYER_OFFER:\n${offerText}\n\n` : "") +
      `RECENT_CHAT:\n${recap || "(none)"}\n` +
      `Reminder: short blunt modern English + one [[DIPLOMACY_V1]] block.\n`
    );
  }

  function cancelRequest() {
    if (state.abort) {
      try {
        state.abort.abort();
      } catch {}
    }
    state.abort = null;
    state.busy = false;
  }

  async function callOpenRouter(realmId, playerText, offerText) {
    if (!OR_KEY) return { ok: false, err: "Missing API key (VITE_OPENROUTER_API_KEY)." };
    if (state.busy) return { ok: false, err: "Busy." };

    state.busy = true;
    state.lastError = "";

    const controller = new AbortController();
    state.abort = controller;

    const body = {
      model: state.model,
      messages: [
        { role: "system", content: systemPromptFor(realmId) },
        { role: "user", content: buildContextFor(realmId, playerText, offerText) },
      ],
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
      let full = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = chunk.split("\n");
          for (let li = 0; li < lines.length; li++) {
            const line = lines[li].trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") return { ok: true, text: full };
            const obj = safeJsonParse(payload);
            if (!obj) continue;
            const delta = (((obj.choices || [])[0] || {}).delta || {});
            const c = delta.content || "";
            if (c) full += c;
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
    }
  }

  // ---------------- offer builder helpers ----------------
  function resetOffer() {
    state.offer.giveGold = 0;
    state.offer.takeGold = 0;
    state.offer.giveItems = {};
    state.offer.takeItems = {};
  }

  function offerToText(realmId) {
    const gGold = Math.max(0, (state.offer.giveGold | 0) || 0);
    const tGold = Math.max(0, (state.offer.takeGold | 0) || 0);

    const giveItems = Object.keys(state.offer.giveItems).filter((k) => state.offer.giveItems[k]);
    const takeItems = Object.keys(state.offer.takeItems).filter((k) => state.offer.takeItems[k]);

    if (!gGold && !tGold && !giveItems.length && !takeItems.length) return "";

    let s = "";
    if (gGold) s += `England gives ${gGold}g. `;
    if (tGold) s += `England asks ${tGold}g. `;
    if (giveItems.length) s += `England gives artifacts: ${giveItems.join("; ")}. `;
    if (takeItems.length) s += `England asks artifacts: ${takeItems.join("; ")}. `;
    s += `Target realm: ${REALM_BY_ID[realmId].name}.`;
    return s.trim();
  }

  function applyOfferLocally(realmId) {
    // optional: you can use "Offer as Draft" without applying;
    // this function applies immediately (used if player wants a quick mechanical offer)
    const gGold = Math.max(0, state.offer.giveGold | 0);
    const tGold = Math.max(0, state.offer.takeGold | 0);

    if (gGold > state.playerGold) return false;
    if (tGold > (state.goldOther[realmId] || 0)) return false;

    // transfer gold
    state.playerGold -= gGold;
    state.goldOther[realmId] = Math.max(0, (state.goldOther[realmId] || 0) + gGold);

    state.playerGold += tGold;
    state.goldOther[realmId] = Math.max(0, (state.goldOther[realmId] || 0) - tGold);

    // items
    const giveItems = Object.keys(state.offer.giveItems).filter((k) => state.offer.giveItems[k]);
    const takeItems = Object.keys(state.offer.takeItems).filter((k) => state.offer.takeItems[k]);

    for (let i = 0; i < giveItems.length; i++) {
      const item = giveItems[i];
      const idx = state.invPlayer.indexOf(item);
      if (idx !== -1) {
        state.invPlayer.splice(idx, 1);
        state.invOther[realmId].push(item);
      }
    }
    for (let i = 0; i < takeItems.length; i++) {
      const item = takeItems[i];
      const arr = state.invOther[realmId];
      const idx = arr.indexOf(item);
      if (idx !== -1) {
        arr.splice(idx, 1);
        state.invPlayer.push(item);
      }
    }

    return true;
  }

  // ---------------- UI ----------------
  let ui = null;

  function buildUI() {
    if (!uiRoot) return null;
    uiRoot.innerHTML = "";

    const root = el("div", {
      position: "fixed",
      inset: "12px",
      display: "flex",
      gap: "12px",
      color: "#dff6ff",
      font: "14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      zIndex: "9999",
    });

    const cardStyle = {
      borderRadius: "14px",
      border: "1px solid rgba(120,180,255,0.18)",
      background: "rgba(0,0,0,0.80)",
      backdropFilter: "blur(6px)",
      boxShadow: "0 0 28px rgba(40,120,255,0.10)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      minHeight: "0",
    };

    // Left: realms list + world timeline
    const left = el("div", { ...cardStyle, width: "280px", flex: "0 0 auto" });

    const leftHead = el("div", {
      padding: "12px",
      borderBottom: "1px solid rgba(120,180,255,0.12)",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      gap: "10px",
    });

    const title = el("div", { fontWeight: "950", fontSize: "14px" });
    title.textContent = "Diplomacy";
    const time = el("div", { fontSize: "12px", opacity: "0.85", textAlign: "right" });
    leftHead.appendChild(title);
    leftHead.appendChild(time);

    const realmList = el("div", { padding: "8px", display: "flex", flexDirection: "column", gap: "6px" });

    function realmRow(realmId) {
      const r = REALM_BY_ID[realmId];
      const row = el("button", {
        width: "100%",
        textAlign: "left",
        padding: "10px 10px",
        borderRadius: "12px",
        border: "1px solid rgba(120,180,255,0.14)",
        background: "rgba(8,12,18,0.70)",
        color: "#dff6ff",
        cursor: "pointer",
      });
      row.onmouseenter = () => (row.style.borderColor = "rgba(255,75,216,0.32)");
      row.onmouseleave = () => (row.style.borderColor = "rgba(120,180,255,0.14)");

      const top = el("div", { display: "flex", justifyContent: "space-between", gap: "8px" });
      const name = el("div", { fontWeight: "900", fontSize: "13px" });
      name.textContent = r.name;

      const rel = el("div", { fontWeight: "900", fontSize: "12px", opacity: "0.9" });
      top.appendChild(name);
      top.appendChild(rel);

      const sub = el("div", { marginTop: "3px", fontSize: "12px", opacity: "0.8", display: "flex", justifyContent: "space-between" });
      const cap = el("div", {});
      cap.textContent = r.capital;
      const gold = el("div", { fontWeight: "800" });
      sub.appendChild(cap);
      sub.appendChild(gold);

      row.appendChild(top);
      row.appendChild(sub);

      row.onclick = () => {
        state.selectedRealm = realmId;
        ensureIntro(realmId);
        resetOffer();
        update();
      };

      return { row, rel, gold };
    }

    const realmRows = {};
    for (let i = 0; i < otherIds.length; i++) {
      const id = otherIds[i];
      realmRows[id] = realmRow(id);
      realmList.appendChild(realmRows[id].row);
    }

    const leftMidDivider = el("div", { height: "1px", background: "rgba(120,180,255,0.12)" });

    const worldWrap = el("div", { padding: "10px 12px", display: "flex", flexDirection: "column", gap: "6px", minHeight: "0" });
    const worldTitle = el("div", { fontSize: "12px", fontWeight: "950", opacity: "0.9" });
    worldTitle.textContent = "World feed";
    const worldFeed = el("div", {
      flex: "1 1 auto",
      minHeight: "0",
      overflow: "auto",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.12)",
      padding: "8px",
      background: "rgba(8,12,18,0.45)",
      fontSize: "12px",
      lineHeight: "1.35",
    });

    worldWrap.appendChild(worldTitle);
    worldWrap.appendChild(worldFeed);

    left.appendChild(leftHead);
    left.appendChild(realmList);
    left.appendChild(leftMidDivider);
    left.appendChild(worldWrap);

    // Middle: chat
    const mid = el("div", { ...cardStyle, flex: "1 1 auto", minWidth: "0" });

    const midHead = el("div", {
      padding: "12px",
      borderBottom: "1px solid rgba(120,180,255,0.12)",
      display: "flex",
      gap: "10px",
      alignItems: "center",
      justifyContent: "space-between",
      flexWrap: "wrap",
    });

    const peer = el("div", { display: "flex", flexDirection: "column", gap: "2px", minWidth: "220px" });
    const peerName = el("div", { fontWeight: "950", fontSize: "14px" });
    const peerSub = el("div", { fontSize: "12px", opacity: "0.85" });

    peer.appendChild(peerName);
    peer.appendChild(peerSub);

    const headRight = el("div", { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" });

    const act = el("div", {
      padding: "6px 10px",
      borderRadius: "999px",
      border: "1px solid rgba(120,180,255,0.18)",
      background: "rgba(8,12,18,0.55)",
      fontSize: "12px",
      fontWeight: "900",
      opacity: "0.92",
      whiteSpace: "nowrap",
    });

    const stopBtn = btn("Stop");
    const endTurnBtn = btn("End Month");
    const back = el("a", {
      display: "inline-flex",
      alignItems: "center",
      padding: "9px 12px",
      borderRadius: "12px",
      border: "1px solid rgba(42,162,255,0.22)",
      color: "#2aa2ff",
      textDecoration: "none",
      font: "900 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      background: "rgba(0,0,0,0.25)",
      whiteSpace: "nowrap",
    });
    back.href = "/";
    back.textContent = "Back";

    headRight.appendChild(act);
    headRight.appendChild(stopBtn);
    headRight.appendChild(endTurnBtn);
    headRight.appendChild(back);

    midHead.appendChild(peer);
    midHead.appendChild(headRight);

    const chatScroll = el("div", {
      flex: "1 1 auto",
      minHeight: "0",
      overflow: "auto",
      padding: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      background: "rgba(0,0,0,0.20)",
    });

    function bubble(text, side, meta) {
      const wrap = el("div", {
        display: "flex",
        justifyContent: side === "right" ? "flex-end" : "flex-start",
      });

      const b = el("div", {
        maxWidth: "780px",
        width: "fit-content",
        padding: "10px 12px",
        borderRadius: "14px",
        border: "1px solid rgba(120,180,255,0.16)",
        background: side === "right" ? "rgba(42,162,255,0.16)" : "rgba(176,75,255,0.12)",
        color: "#dff6ff",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: "13px",
        lineHeight: "1.35",
      });

      if (meta) {
        const m = el("div", { fontSize: "11px", opacity: "0.75", marginTop: "6px" });
        m.textContent = meta;
        b.appendChild(m);
      }

      const t = el("div", {});
      t.textContent = text;
      b.insertBefore(t, b.firstChild);

      wrap.appendChild(b);
      return wrap;
    }

    // Composer
    const composer = el("div", {
      borderTop: "1px solid rgba(120,180,255,0.12)",
      padding: "10px",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      background: "rgba(0,0,0,0.25)",
    });

    const statusLine = el("div", { minHeight: "16px", fontSize: "12px", color: "#ff4bd8", whiteSpace: "pre-wrap" });

    const input = el("textarea", {
      width: "100%",
      height: "92px",
      padding: "10px 10px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.20)",
      background: "rgba(8,12,18,0.92)",
      color: "#dff6ff",
      outline: "none",
      resize: "vertical",
      font: "650 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      lineHeight: "1.35",
      boxSizing: "border-box",
    });

    const composeRow = el("div", { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" });
    const sendBtn = btn("Send (Action)");
    const draftBtn = btn("Insert Offer Draft");
    const clearBtn = btn("Clear");
    composeRow.appendChild(sendBtn);
    composeRow.appendChild(draftBtn);
    composeRow.appendChild(clearBtn);

    composer.appendChild(statusLine);
    composer.appendChild(input);
    composer.appendChild(composeRow);

    mid.appendChild(midHead);
    mid.appendChild(chatScroll);
    mid.appendChild(composer);

    // Right: your stats + offer builder + settings
    const right = el("div", { ...cardStyle, width: "360px", flex: "0 0 auto" });

    const rightHead = el("div", {
      padding: "12px",
      borderBottom: "1px solid rgba(120,180,255,0.12)",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      gap: "10px",
    });
    const you = el("div", { fontWeight: "950", fontSize: "14px" });
    you.textContent = "England";
    const youGold = el("div", { fontWeight: "950", fontSize: "13px", opacity: "0.92" });
    rightHead.appendChild(you);
    rightHead.appendChild(youGold);

    const rightBody = el("div", { padding: "12px", display: "flex", flexDirection: "column", gap: "10px", minHeight: "0" });

    const relBox = el("div", {
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.12)",
      padding: "10px",
      background: "rgba(8,12,18,0.45)",
    });
    const relTitle = el("div", { fontWeight: "950", fontSize: "12px", opacity: "0.9" });
    relTitle.textContent = "Relations";
    const relList = el("div", { marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px" });

    relBox.appendChild(relTitle);
    relBox.appendChild(relList);

    const invBox = el("div", {
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.12)",
      padding: "10px",
      background: "rgba(8,12,18,0.45)",
    });
    const invTitle = el("div", { fontWeight: "950", fontSize: "12px", opacity: "0.9" });
    invTitle.textContent = "Artifacts";
    const invBody = el("div", { marginTop: "8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });

    const invYou = el("div", {
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.10)",
      padding: "8px",
      background: "rgba(0,0,0,0.25)",
      minHeight: "64px",
      fontSize: "12px",
      lineHeight: "1.35",
      overflow: "auto",
    });
    const invThem = el("div", {
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.10)",
      padding: "8px",
      background: "rgba(0,0,0,0.25)",
      minHeight: "64px",
      fontSize: "12px",
      lineHeight: "1.35",
      overflow: "auto",
    });

    invBody.appendChild(invYou);
    invBody.appendChild(invThem);

    invBox.appendChild(invTitle);
    invBox.appendChild(invBody);

    const offerBox = el("div", {
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.12)",
      padding: "10px",
      background: "rgba(8,12,18,0.45)",
      minHeight: "0",
    });
    const offerTitle = el("div", { fontWeight: "950", fontSize: "12px", opacity: "0.9" });
    offerTitle.textContent = "Offer Builder (optional)";

    const offerGrid = el("div", { marginTop: "8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });

    const giveGold = el("input", {
      width: "100%",
      padding: "8px 10px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.14)",
      background: "rgba(0,0,0,0.30)",
      color: "#dff6ff",
      outline: "none",
      font: "800 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      boxSizing: "border-box",
    });
    giveGold.type = "number";
    giveGold.min = "0";
    giveGold.step = "1";

    const takeGold = giveGold.cloneNode(true);
    takeGold.min = "0";

    const giveGoldLab = el("div", { fontSize: "11px", opacity: "0.75", fontWeight: "900" });
    giveGoldLab.textContent = "You give gold";
    const takeGoldLab = el("div", { fontSize: "11px", opacity: "0.75", fontWeight: "900" });
    takeGoldLab.textContent = "You ask gold";

    const giveWrap = el("div", {});
    giveWrap.appendChild(giveGoldLab);
    giveWrap.appendChild(giveGold);

    const takeWrap = el("div", {});
    takeWrap.appendChild(takeGoldLab);
    takeWrap.appendChild(takeGold);

    offerGrid.appendChild(giveWrap);
    offerGrid.appendChild(takeWrap);

    const itemPanes = el("div", { marginTop: "10px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });

    function itemPane(titleText) {
      const p = el("div", {
        borderRadius: "12px",
        border: "1px solid rgba(120,180,255,0.10)",
        padding: "8px",
        background: "rgba(0,0,0,0.22)",
        minHeight: "84px",
        overflow: "auto",
      });
      const t = el("div", { fontSize: "11px", opacity: "0.75", fontWeight: "950", marginBottom: "6px" });
      t.textContent = titleText;
      const list = el("div", { display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px" });
      p.appendChild(t);
      p.appendChild(list);
      return { p, list };
    }

    const giveItemsPane = itemPane("You give artifacts");
    const takeItemsPane = itemPane("You ask artifacts");

    itemPanes.appendChild(giveItemsPane.p);
    itemPanes.appendChild(takeItemsPane.p);

    const offerBtns = el("div", { marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap" });
    const offerResetBtn = btn("Reset Offer");
    const offerApplyBtn = btn("Apply Offer Now");
    offerBtns.appendChild(offerResetBtn);
    offerBtns.appendChild(offerApplyBtn);

    offerBox.appendChild(offerTitle);
    offerBox.appendChild(offerGrid);
    offerBox.appendChild(itemPanes);
    offerBox.appendChild(offerBtns);

    const settingsBox = el("div", {
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.12)",
      padding: "10px",
      background: "rgba(8,12,18,0.45)",
    });
    const setTitle = el("div", { fontWeight: "950", fontSize: "12px", opacity: "0.9" });
    setTitle.textContent = "LLM Settings";
    const setGrid = el("div", { marginTop: "8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });

    const inputStyle = {
      width: "100%",
      padding: "8px 10px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.14)",
      background: "rgba(0,0,0,0.30)",
      color: "#dff6ff",
      outline: "none",
      font: "800 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      boxSizing: "border-box",
    };
    const modelIn = el("input", inputStyle);
    modelIn.value = state.model;

    const tempIn = el("input", { width: "100%" });
    tempIn.type = "range";
    tempIn.min = "0";
    tempIn.max = "1.3";
    tempIn.step = "0.05";
    tempIn.value = String(state.temperature);

    const streamWrap = el("label", {
      display: "flex",
      gap: "8px",
      alignItems: "center",
      fontSize: "12px",
      opacity: "0.9",
      cursor: "pointer",
      userSelect: "none",
      padding: "6px 6px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.10)",
      background: "rgba(0,0,0,0.22)",
    });
    const streamBox = document.createElement("input");
    streamBox.type = "checkbox";
    streamBox.checked = state.stream;
    streamWrap.appendChild(streamBox);
    streamWrap.appendChild(document.createTextNode("Stream"));

    const maxTokIn = el("input", inputStyle);
    maxTokIn.type = "number";
    maxTokIn.min = "128";
    maxTokIn.max = "2000";
    maxTokIn.step = "32";
    maxTokIn.value = String(state.maxTokens);

    setGrid.appendChild(modelIn);
    setGrid.appendChild(tempIn);
    setGrid.appendChild(maxTokIn);
    setGrid.appendChild(streamWrap);

    const setHint = el("div", { marginTop: "6px", fontSize: "11px", opacity: "0.70", lineHeight: "1.35" });
    setHint.textContent =
      "Use a better model if replies feel dumb. Lower temperature = more consistent, shorter, less cringe.";

    settingsBox.appendChild(setTitle);
    settingsBox.appendChild(setGrid);
    settingsBox.appendChild(setHint);

    rightBody.appendChild(relBox);
    rightBody.appendChild(invBox);
    rightBody.appendChild(offerBox);
    rightBody.appendChild(settingsBox);

    right.appendChild(rightHead);
    right.appendChild(rightBody);

    // Assemble layout
    root.appendChild(left);
    root.appendChild(mid);
    root.appendChild(right);

    // Responsive tweaks: collapse sidebars if needed
    const css = el("style");
    css.textContent = `
      @media (max-width: 1080px) {
        #simlab-diplo-root { flex-direction: column; }
        #simlab-diplo-left, #simlab-diplo-right { width: auto !important; }
      }
    `;
    root.id = "simlab-diplo-root";
    left.id = "simlab-diplo-left";
    right.id = "simlab-diplo-right";

    uiRoot.appendChild(css);
    uiRoot.appendChild(root);

    // ------------ UI interactions ------------
    input.value = "We should make a deal. Here's what I want, and here's what I'm willing to offer.";
    input.oninput = () => {};
    input.onkeydown = (e) => {
      // DO NOT bind global pause/reset keys; only handle Ctrl+Enter to send.
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        doSend();
      }
      // let space, r, etc work normally
      e.stopPropagation();
    };

    giveGold.value = String(state.offer.giveGold | 0);
    takeGold.value = String(state.offer.takeGold | 0);

    giveGold.oninput = () => {
      state.offer.giveGold = clamp(parseInt(giveGold.value || "0", 10) || 0, 0, 999999);
      update();
    };
    takeGold.oninput = () => {
      state.offer.takeGold = clamp(parseInt(takeGold.value || "0", 10) || 0, 0, 999999);
      update();
    };

    offerResetBtn.onclick = () => {
      resetOffer();
      giveGold.value = "0";
      takeGold.value = "0";
      update();
      flash("Offer reset.", 0.9);
    };

    offerApplyBtn.onclick = () => {
      const rid = state.selectedRealm;
      const ok = applyOfferLocally(rid);
      if (!ok) {
        flash("Offer invalid (not enough gold or missing item).", 1.4);
        update();
        return;
      }
      // Small direct mechanical effect: relation bump (deal goodwill)
      state.relations[rid] = clamp((state.relations[rid] || 0) + 3, -100, 100);
      chatAdd(rid, "system", "You applied a direct trade transfer (mechanical). Mention it in your message if you want them to react.");
      resetOffer();
      giveGold.value = "0";
      takeGold.value = "0";
      update();
      saveNow();
      flash("Offer applied mechanically.", 1.0);
    };

    draftBtn.onclick = () => {
      const rid = state.selectedRealm;
      const offerText = offerToText(rid);
      if (!offerText) {
        flash("Build an offer first (gold or artifacts).", 1.2);
        update();
        return;
      }
      const cur = input.value || "";
      const insert =
        (cur.trim() ? cur.trim() + "\n\n" : "") +
        `Offer draft (copy/edit):\n${offerText}\n`;
      input.value = insert;
      flash("Offer draft inserted into your message.", 1.0);
      update();
    };

    clearBtn.onclick = () => {
      input.value = "";
      update();
    };

    stopBtn.onclick = () => {
      if (!state.busy) return;
      cancelRequest();
      flash("Cancelled.", 0.9);
      update();
    };

    endTurnBtn.onclick = () => {
      if (state.busy) return;
      advanceMonth();
      worldAdd(`Month advanced to ${monthName(state.month)} ${state.year}.`);
      flash("New month.", 0.9);
      update();
      saveNow();
    };

    sendBtn.onclick = () => doSend();

    modelIn.onchange = () => {
      state.model = (modelIn.value || "").trim() || state.model;
      saveNow();
      flash("Model updated.", 0.8);
      update();
    };
    tempIn.oninput = () => {
      state.temperature = clamp(parseFloat(tempIn.value), 0, 2);
      flash(`Temperature: ${state.temperature.toFixed(2)}`, 0.7);
      update();
      saveNow();
    };
    maxTokIn.oninput = () => {
      state.maxTokens = clamp(parseInt(maxTokIn.value || "700", 10) || 700, 128, 2000);
      update();
      saveNow();
    };
    streamBox.onchange = () => {
      state.stream = !!streamBox.checked;
      update();
      saveNow();
    };

    function rebuildOfferLists() {
      const rid = state.selectedRealm;
      const youItems = state.invPlayer.slice(0, 64);
      const themItems = (state.invOther[rid] || []).slice(0, 64);

      giveItemsPane.list.innerHTML = "";
      takeItemsPane.list.innerHTML = "";

      function makeCheck(listEl, item, mapObj) {
        const lab = el("label", { display: "flex", gap: "8px", alignItems: "center", cursor: "pointer", userSelect: "none" });
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!mapObj[item];
        box.onchange = () => {
          mapObj[item] = !!box.checked;
          update();
        };
        const t = el("div", { fontSize: "12px" });
        t.textContent = item;
        lab.appendChild(box);
        lab.appendChild(t);
        listEl.appendChild(lab);
      }

      for (let i = 0; i < youItems.length; i++) makeCheck(giveItemsPane.list, youItems[i], state.offer.giveItems);
      for (let i = 0; i < themItems.length; i++) makeCheck(takeItemsPane.list, themItems[i], state.offer.takeItems);

      // prune stale selections
      const keepGive = {};
      for (let i = 0; i < youItems.length; i++) if (state.offer.giveItems[youItems[i]]) keepGive[youItems[i]] = true;
      state.offer.giveItems = keepGive;

      const keepTake = {};
      for (let i = 0; i < themItems.length; i++) if (state.offer.takeItems[themItems[i]]) keepTake[themItems[i]] = true;
      state.offer.takeItems = keepTake;
    }

    function renderChat() {
      const rid = state.selectedRealm;
      const r = REALM_BY_ID[rid];
      const log = state.chats[rid] || [];

      chatScroll.innerHTML = "";
      for (let i = 0; i < log.length; i++) {
        const m = log[i];
        const side = m.who === "player" ? "right" : "left";
        const who = m.who === "player" ? "England" : m.who === "other" ? r.name : "System";
        const meta = `${who} • ${monthName(m.month)} ${m.year}`;
        chatScroll.appendChild(bubble(m.text, side, meta));
      }

      // autoscroll to bottom
      requestAnimationFrame(() => {
        chatScroll.scrollTop = chatScroll.scrollHeight;
      });
    }

    function renderWorld() {
      worldFeed.innerHTML = "";
      const a = state.worldEvents.slice(-30);
      for (let i = 0; i < a.length; i++) {
        const d = el("div", {
          padding: "6px 8px",
          borderRadius: "10px",
          border: "1px solid rgba(120,180,255,0.10)",
          background: "rgba(0,0,0,0.18)",
          marginBottom: "6px",
        });
        d.textContent = a[i].text;
        worldFeed.appendChild(d);
      }
    }

    function renderRelations() {
      relList.innerHTML = "";
      for (let i = 0; i < otherIds.length; i++) {
        const id = otherIds[i];
        const r = REALM_BY_ID[id];
        const row = el("div", { display: "flex", justifyContent: "space-between", gap: "8px" });
        const name = el("div", { fontWeight: "900", opacity: "0.9" });
        name.textContent = r.name;
        const v = state.relations[id] || 0;
        const val = el("div", {
          fontWeight: "950",
          color: v >= 15 ? "#3dfcff" : v <= -15 ? "#ff4bd8" : "rgba(223,246,255,0.85)",
        });
        val.textContent = fmtRel(v);
        row.appendChild(name);
        row.appendChild(val);
        relList.appendChild(row);
      }
    }

    function renderInventories() {
      const rid = state.selectedRealm;
      const r = REALM_BY_ID[rid];
      const you = state.invPlayer;
      const them = state.invOther[rid] || [];
      invYou.textContent = `You (${you.length}):\n${you.join("\n") || "(none)"}`;
      invThem.textContent = `${r.name} (${them.length}):\n${them.join("\n") || "(none)"}`;
    }

    function updateHeader() {
      time.textContent = `${monthName(state.month)} ${state.year}`;
      youGold.textContent = fmtGold(state.playerGold);
      const rid = state.selectedRealm;
      const r = REALM_BY_ID[rid];
      peerName.textContent = r.name;
      peerSub.textContent = `Capital: ${r.capital} • Their gold: ${fmtGold(state.goldOther[rid] || 0)} • Relation: ${fmtRel(state.relations[rid] || 0)}`;
      act.textContent = state.actionAvailable ? "Action: READY" : "Action: USED";
      act.style.borderColor = state.actionAvailable ? "rgba(61,252,255,0.22)" : "rgba(255,75,216,0.22)";
      act.style.color = state.actionAvailable ? "#3dfcff" : "#ff4bd8";

      // left highlight
      for (let i = 0; i < otherIds.length; i++) {
        const id = otherIds[i];
        const rr = realmRows[id];
        const v = state.relations[id] || 0;
        rr.rel.textContent = fmtRel(v);
        rr.rel.style.color = v >= 15 ? "#3dfcff" : v <= -15 ? "#ff4bd8" : "rgba(223,246,255,0.85)";
        rr.gold.textContent = fmtGold(state.goldOther[id] || 0);
        rr.row.style.outline = id === state.selectedRealm ? "2px solid rgba(61,252,255,0.28)" : "none";
        rr.row.style.background = id === state.selectedRealm ? "rgba(8,12,18,0.88)" : "rgba(8,12,18,0.70)";
      }
    }

    function updateStatusLine() {
      if (state.lastError) {
        statusLine.textContent = `Error: ${state.lastError}`;
        return;
      }
      if (nowSec() < state.statusUntil && state.status) {
        statusLine.textContent = state.status;
        return;
      }
      if (!OR_KEY) {
        statusLine.textContent = "Missing API key. Set VITE_OPENROUTER_API_KEY in .env and restart Vite.";
        return;
      }
      statusLine.textContent = state.busy
        ? "Waiting for reply… (Stop cancels)"
        : "Tip: Ctrl+Enter sends. One action per month.";
    }

    function updateControls() {
      setDisabled(sendBtn, state.busy || !state.actionAvailable || !OR_KEY);
      setDisabled(stopBtn, !state.busy);
      setDisabled(endTurnBtn, state.busy);
      setDisabled(offerApplyBtn, state.busy);
      setDisabled(offerResetBtn, state.busy);
      setDisabled(draftBtn, state.busy);
      setDisabled(clearBtn, state.busy);
    }

    async function doSend() {
      if (state.busy) return;
      if (!state.actionAvailable) {
        flash("You already used your action this month. End Month to continue.", 1.4);
        update();
        return;
      }
      if (!OR_KEY) {
        flash("Missing API key. Set VITE_OPENROUTER_API_KEY in .env and restart Vite.", 2.0);
        update();
        return;
      }
      const rid = state.selectedRealm;
      const text = (input.value || "").trim();
      if (!text) {
        flash("Write something first.", 1.0);
        update();
        return;
      }

      // consume action
      state.actionAvailable = false;

      // add player chat
      chatAdd(rid, "player", text);

      // offer text (optional)
      const offerText = offerToText(rid);

      update();
      renderChat();

      const res = await callOpenRouter(rid, text, offerText);
      if (!res.ok) {
        state.lastError = res.err || "Error";
        chatAdd(rid, "system", `Comms failed: ${state.lastError}`);
        // mild penalty: relation worsens a hair
        state.relations[rid] = clamp((state.relations[rid] || 0) - 2, -100, 100);
        update();
        renderChat();
        saveNow();
        return;
      }

      const full = String(res.text || "");
      const extracted = extractBlock(full);

      if (!extracted) {
        // still show text, but apply a small randomish mechanical outcome
        const reply = full.trim() || "(no reply)";
        chatAdd(rid, "other", reply);
        chatAdd(rid, "system", "Control block missing: applied mild, generic outcome.");
        state.relations[rid] = clamp((state.relations[rid] || 0) - 1, -100, 100);
        worldAdd(`${REALM_BY_ID[rid].name} sends an unclear response. Diplomatic friction rises.`);
        update();
        renderChat();
        renderWorld();
        saveNow();
        return;
      }

      const replyText = extracted.dialogue || "(silent)";
      const ctrl = parseBlock(extracted.block);

      // show only the dialogue (block is not shown)
      chatAdd(rid, "other", replyText);

      // apply mechanical effects
      applyControl(ctrl);

      // show brief suggestion set as system bubbles (optional, capped)
      if (ctrl.suggestions && ctrl.suggestions.length) {
        chatAdd(rid, "system", `Suggestions: ${ctrl.suggestions.slice(0, 4).join(" | ")}`);
      }

      if (ctrl.flags && ctrl.flags.length) {
        chatAdd(rid, "system", `Flags: ${ctrl.flags.slice(0, 5).join(", ")}`);
      }

      update();
      renderChat();
      renderWorld();
      saveNow();
    }

    function update() {
      updateHeader();
      updateControls();
      updateStatusLine();
      renderRelations();
      renderInventories();
      renderWorld();
      rebuildOfferLists();
      renderChat();
    }

    update();
    return { update };
  }

  ui = buildUI();
  if (ui) ui.update();

  // ---------------- engine hooks ----------------
  function update(dt) {
    state.paused = Engine.isPaused();
    if (state.paused) return;

    const tNow = nowSec();
    if (tNow >= state.autosaveAt) {
      saveNow();
      state.autosaveAt = tNow + 10.0;
    }
  }

  function render() {
    Engine.gfx.clearBlack();
    // no background text / no overlay clutter; UI handles everything
  }

  Engine.on("update", update);
  Engine.on("render", render);

  window.addEventListener("beforeunload", () => {
    try {
      saveNow();
    } catch {}
  });

  if (!uiRoot) {
    console.warn("[SimLab] kingdom-diplomacy-chat: ctx.uiRoot missing; UI cannot be created.");
  } else if (!OR_KEY) {
    flash("Missing API key. Set VITE_OPENROUTER_API_KEY in .env then restart Vite.", 6.0);
    ui && ui.update();
  }
}
