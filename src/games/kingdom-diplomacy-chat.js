import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab.kingdomDiplomacyChat.v2";
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
    const a = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return a[((m % 12) + 12) % 12];
  }

  function el(tag, styleObj) {
    const e = document.createElement(tag);
    if (styleObj) Object.assign(e.style, styleObj);
    return e;
  }

  function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
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

  // ---------------- world model ----------------
  const REALMS = [
    {
      id: "ENG",
      name: "England",
      colour: "#2aa2ff",
      capital: "London",
      provinces: ["London", "Kent", "Wessex", "Mercia", "York"],
      artifacts: ["Wool Contracts", "Royal Charter Seal"],
      gold: 220,
      military: 115,
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
      military: 80,
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
      military: 60,
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
      military: 140,
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
      military: 105,
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
      military: 70,
      aiStyle: "practical, friendly, modern",
    },
  ];

  const REALM_BY_ID = {};
  for (let i = 0; i < REALMS.length; i++) REALM_BY_ID[REALMS[i].id] = REALMS[i];

  const otherIds = ["SCO", "IRE", "FRA", "CAS", "POR"];

  function defaultRelations() {
    return { SCO: -10, IRE: +5, FRA: -15, CAS: +8, POR: +18 };
  }

  function defaultMilitary() {
    const m = {};
    for (let i = 0; i < REALMS.length; i++) m[REALMS[i].id] = REALMS[i].military | 0;
    return m;
  }

  const state = {
    // time
    year: 1444,
    month: 10, // Nov
    actionAvailable: true,

    // LLM settings
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.35,
    maxTokens: 650,
    stream: true,

    // player
    playerId: "ENG",
    playerGold: REALM_BY_ID.ENG.gold,
    relations: defaultRelations(),

    // military + risk
    military: defaultMilitary(), // ENG etc
    warRisk: 10, // 0..100

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
    chats: { SCO: [], IRE: [], FRA: [], CAS: [], POR: [] },

    // monthly log
    worldEvents: [],
    status: "",
    statusUntil: 0,

    // request lifecycle
    busy: false,
    abort: null,
    lastError: "",
    autosaveAt: 0,

    // last parsed outcome for UI
    lastOutcomeByRealm: {
      SCO: null,
      IRE: null,
      FRA: null,
      CAS: null,
      POR: null,
    },

    // offer builder
    offer: {
      giveGold: 0,
      takeGold: 0,
      giveItems: {},
      takeItems: {},
    },

    // internal UI flags
    _offerUiRealm: "",
    _offerUiVersion: 0,
    _invVersion: 1,
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
    if (arr.length > 240) arr.splice(0, arr.length - 240);
  }

  function worldAdd(text) {
    state.worldEvents.push({ t: Date.now(), text: String(text || "") });
    if (state.worldEvents.length > 100) state.worldEvents.splice(0, state.worldEvents.length - 100);
  }

  function advanceMonth() {
    state.month++;
    if (state.month >= 12) {
      state.month = 0;
      state.year++;
    }
    state.actionAvailable = true;

    // gentle mean reversion
    for (let i = 0; i < otherIds.length; i++) {
      const id = otherIds[i];
      let r = state.relations[id] || 0;
      r += (0 - r) * 0.02;
      state.relations[id] = clamp(Math.round(r), -100, 100);
    }

    // war risk drift: calm down slowly if nothing hot is happening
    state.warRisk = clamp(Math.round(state.warRisk * 0.97), 0, 100);

    // if risk high and relations awful with someone, trigger a border incident occasionally
    if (state.warRisk >= 75) {
      // pick worst relation
      let worstId = "SCO";
      let worst = 999;
      for (let i = 0; i < otherIds.length; i++) {
        const id = otherIds[i];
        const v = state.relations[id] || 0;
        if (v < worst) {
          worst = v;
          worstId = id;
        }
      }
      if (worst <= -45 && Math.random() < 0.35) {
        const them = REALM_BY_ID[worstId].name;
        const cost = 8 + ((Math.random() * 8) | 0);
        state.playerGold = Math.max(0, state.playerGold - cost);
        state.relations[worstId] = clamp((state.relations[worstId] || 0) - 6, -100, 100);
        state.warRisk = clamp(state.warRisk + 6, 0, 100);
        worldAdd(`Border incident with ${them}. You spend ${cost}g on emergency security and bribes. War risk rises.`);
        chatAdd(worstId, "system", `Border incident worsened tensions. (-${cost}g, relations -6, war risk +6)`);
      }
    }
  }

  // ---------------- persistence ----------------
  function saveNow() {
    try {
      Engine.save(SAVE_KEY, {
        v: 2,
        year: state.year,
        month: state.month,
        actionAvailable: state.actionAvailable,
        model: state.model,
        temperature: state.temperature,
        maxTokens: state.maxTokens,
        stream: state.stream,
        playerGold: state.playerGold,
        relations: state.relations,
        military: state.military,
        warRisk: state.warRisk,
        invPlayer: state.invPlayer,
        invOther: state.invOther,
        goldOther: state.goldOther,
        chats: state.chats,
        worldEvents: state.worldEvents,
        selectedRealm: state.selectedRealm,
        lastOutcomeByRealm: state.lastOutcomeByRealm,
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
        for (let i = 0; i < otherIds.length; i++) {
          const id = otherIds[i];
          state.relations[id] = clamp((Number(s.relations[id]) || 0) | 0, -100, 100);
        }
      }

      if (s.military && typeof s.military === "object") {
        for (let i = 0; i < REALMS.length; i++) {
          const id = REALMS[i].id;
          const v = Number(s.military[id]);
          if (isFinite(v)) state.military[id] = clamp(v | 0, 0, 999);
        }
      }
      if (typeof s.warRisk === "number") state.warRisk = clamp((s.warRisk | 0) || 0, 0, 100);

      if (Array.isArray(s.invPlayer)) state.invPlayer = s.invPlayer.slice(0, 64).map(String);
      if (s.invOther && typeof s.invOther === "object") {
        for (let i = 0; i < otherIds.length; i++) {
          const id = otherIds[i];
          const arr = s.invOther[id];
          if (Array.isArray(arr)) state.invOther[id] = arr.slice(0, 64).map(String);
        }
      }
      if (s.goldOther && typeof s.goldOther === "object") {
        for (let i = 0; i < otherIds.length; i++) {
          const id = otherIds[i];
          const g = Number(s.goldOther[id]);
          if (isFinite(g)) state.goldOther[id] = Math.max(0, g);
        }
      }
      if (s.chats && typeof s.chats === "object") {
        for (let i = 0; i < otherIds.length; i++) {
          const id = otherIds[i];
          const arr = s.chats[id];
          if (Array.isArray(arr)) state.chats[id] = arr.slice(0, 240);
        }
      }
      if (Array.isArray(s.worldEvents)) state.worldEvents = s.worldEvents.slice(0, 100);
      if (typeof s.selectedRealm === "string" && state.chats[s.selectedRealm]) state.selectedRealm = s.selectedRealm;

      if (s.lastOutcomeByRealm && typeof s.lastOutcomeByRealm === "object") {
        for (let i = 0; i < otherIds.length; i++) {
          const id = otherIds[i];
          state.lastOutcomeByRealm[id] = s.lastOutcomeByRealm[id] || null;
        }
      }

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
    chatAdd(realmId, "system", `Keep it modern and blunt. Deals, threats, concessions. Outcomes affect gold, artifacts, relations, war risk.`);
  }
  for (let i = 0; i < otherIds.length; i++) ensureIntro(otherIds[i]);

  // ---------------- parsing: robust control extraction + chat sanitising ----------------
  const BLOCK_OPEN = "[[DIPLOMACY_V2]]";
  const BLOCK_CLOSE = "[[/DIPLOMACY_V2]]";

  function stripControlLines(s) {
    // If the model leaks control lines into dialogue, delete them.
    const lines = String(s || "").split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) {
        out.push(lines[i]);
        continue;
      }
      const up = t.toUpperCase();
      if (
        up.startsWith("SPEAKER:") ||
        up.startsWith("TONE:") ||
        up.startsWith("INTENT:") ||
        up.startsWith("SUMMARY:") ||
        up.startsWith("TO_REALM:") ||
        up.startsWith("DELTA_") ||
        up.startsWith("TRANSFER_ITEMS") ||
        up.startsWith("WORLD_EVENTS") ||
        up.startsWith("FLAGS") ||
        up.startsWith("SUGGESTIONS") ||
        up === "DELTA_RELATIONS:" ||
        up === "DELTA_RELATIONS" ||
        up === "TRANSFER_ITEMS:" ||
        up === "WORLD_EVENTS:" ||
        up === "FLAGS:" ||
        up === "SUGGESTIONS:"
      ) {
        continue;
      }
      // also remove obvious block markers if they appear in chat
      if (t.includes("[[DIPLOMACY_")) continue;
      out.push(lines[i]);
    }
    return out.join("\n").trim();
  }

  function extractBlockBestEffort(fullText) {
    const s = String(fullText || "");
    const a = s.indexOf(BLOCK_OPEN);
    const b = s.indexOf(BLOCK_CLOSE);

    if (a !== -1 && b !== -1 && b > a) {
      const block = s.slice(a + BLOCK_OPEN.length, b).trim();
      const dialogue = stripControlLines(s.slice(0, a).trim());
      return { block, dialogue, ok: true };
    }

    // fallback: find where control starts (SPEAKER: or DELTA_RELATIONS:)
    const idxSpeaker = s.search(/^\s*SPEAKER\s*:/im);
    const idxDeltaRel = s.search(/^\s*DELTA_RELATIONS\s*:/im);
    let cut = -1;
    if (idxSpeaker !== -1) cut = idxSpeaker;
    else if (idxDeltaRel !== -1) cut = idxDeltaRel;

    if (cut !== -1) {
      const dialogue = stripControlLines(s.slice(0, cut).trim());
      const block = s.slice(cut).trim();
      return { block, dialogue, ok: true };
    }

    // nothing parseable
    return { block: "", dialogue: stripControlLines(s), ok: false };
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

      deltaRelations: { SCO: 0, IRE: 0, FRA: 0, CAS: 0, POR: 0 },
      deltaGoldPlayer: 0,
      deltaGoldOther: 0,
      deltaWarRisk: 0,
      deltaMilitary: { ENG: 0, SCO: 0, IRE: 0, FRA: 0, CAS: 0, POR: 0 },

      transferGiveItems: [],
      transferTakeItems: [],

      worldEvents: [],
      suggestions: [],
      flags: [],
    };

    let section = "";
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) continue;

      const u = line.toUpperCase();

      if (u === "DELTA_RELATIONS:" || u === "DELTA_RELATIONS") {
        section = "DELTA_REL";
        continue;
      }
      if (u === "DELTA_MILITARY:" || u === "DELTA_MILITARY") {
        section = "DELTA_MIL";
        continue;
      }
      if (u === "TRANSFER_ITEMS:" || u === "TRANSFER_ITEMS") {
        section = "XFER";
        continue;
      }
      if (u === "WORLD_EVENTS:" || u === "WORLD_EVENTS") {
        section = "WORLD";
        continue;
      }
      if (u === "SUGGESTIONS:" || u === "SUGGESTIONS") {
        section = "SUGG";
        continue;
      }
      if (u === "FLAGS:" || u === "FLAGS") {
        section = "FLAGS";
        continue;
      }

      const kv = line.match(/^([A-Z0-9_\- ]+)\s*:\s*(.*)$/);
      if (kv && section !== "DELTA_REL" && section !== "XFER" && section !== "DELTA_MIL") {
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
        else if (key === "DELTA_WAR_RISK") out.deltaWarRisk = clamp((parseInt(val, 10) || 0) | 0, -25, 25);
        continue;
      }

      if (section === "DELTA_REL") {
        const m = line.match(/^([A-Z]{3})\s*:\s*([-+]?\d+)\s*$/);
        if (m) {
          const id = m[1].toUpperCase();
          const v = clamp((parseInt(m[2], 10) || 0) | 0, -25, 25);
          if (id !== "ENG" && out.deltaRelations[id] !== undefined) out.deltaRelations[id] = v;
        }
        continue;
      }

      if (section === "DELTA_MIL") {
        const m = line.match(/^([A-Z]{3})\s*:\s*([-+]?\d+)\s*$/);
        if (m) {
          const id = m[1].toUpperCase();
          const v = clamp((parseInt(m[2], 10) || 0) | 0, -10, 10);
          if (out.deltaMilitary[id] !== undefined) out.deltaMilitary[id] = v;
        }
        continue;
      }

      if (section === "XFER") {
        const mG = line.match(/^GIVE\s*:\s*(.*)$/i);
        const mT = line.match(/^TAKE\s*:\s*(.*)$/i);
        if (mG) {
          const parts = mG[1].split(";").map((p) => p.trim()).filter(Boolean);
          for (let j = 0; j < parts.length && out.transferGiveItems.length < 10; j++) out.transferGiveItems.push(parts[j]);
        } else if (mT) {
          const parts = mT[1].split(";").map((p) => p.trim()).filter(Boolean);
          for (let j = 0; j < parts.length && out.transferTakeItems.length < 10; j++) out.transferTakeItems.push(parts[j]);
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

    // ensure all relation keys exist
    for (let i = 0; i < otherIds.length; i++) {
      const id = otherIds[i];
      if (out.deltaRelations[id] === undefined) out.deltaRelations[id] = 0;
    }

    return out;
  }

  // ---------------- apply control: enforce inventories + affordability ----------------
  function applyControl(ctrl) {
    const rid = ctrl.toRealm || state.selectedRealm;

    // gold deltas: clamp by actual available funds (no going negative)
    const dGP = ctrl.deltaGoldPlayer | 0;
    const dGO = ctrl.deltaGoldOther | 0;

    if (dGP < 0) {
      const spend = Math.min(-dGP, Math.floor(state.playerGold));
      state.playerGold -= spend;
    } else if (dGP > 0) {
      state.playerGold += dGP;
    }

    const og = state.goldOther[rid] || 0;
    if (dGO < 0) {
      const spend = Math.min(-dGO, Math.floor(og));
      state.goldOther[rid] = og - spend;
    } else if (dGO > 0) {
      state.goldOther[rid] = og + dGO;
    }

    // relations deltas
    for (let i = 0; i < otherIds.length; i++) {
      const id = otherIds[i];
      const dv = (ctrl.deltaRelations && ctrl.deltaRelations[id]) | 0;
      state.relations[id] = clamp((state.relations[id] || 0) + dv, -100, 100);
    }

    // war risk
    state.warRisk = clamp(state.warRisk + ((ctrl.deltaWarRisk | 0) || 0), 0, 100);

    // military drift (small)
    if (ctrl.deltaMilitary && typeof ctrl.deltaMilitary === "object") {
      const keys = Object.keys(ctrl.deltaMilitary);
      for (let i = 0; i < keys.length; i++) {
        const id = keys[i];
        if (state.military[id] === undefined) continue;
        const dv = (ctrl.deltaMilitary[id] | 0) || 0;
        if (!dv) continue;
        state.military[id] = clamp((state.military[id] | 0) + dv, 0, 999);
      }
    }

    // item transfers: only allow exact matches in inventories
    const give = Array.isArray(ctrl.transferGiveItems) ? ctrl.transferGiveItems : [];
    const take = Array.isArray(ctrl.transferTakeItems) ? ctrl.transferTakeItems : [];

    // GIVE: player -> other
    for (let i = 0; i < give.length; i++) {
      const item = give[i];
      const idx = state.invPlayer.indexOf(item);
      if (idx !== -1) {
        state.invPlayer.splice(idx, 1);
        state.invOther[rid].push(item);
        state._invVersion++;
      }
    }

    // TAKE: other -> player
    for (let i = 0; i < take.length; i++) {
      const item = take[i];
      const arr = state.invOther[rid];
      const idx = arr.indexOf(item);
      if (idx !== -1) {
        arr.splice(idx, 1);
        state.invPlayer.push(item);
        state._invVersion++;
      }
    }

    // world events
    for (let i = 0; i < ctrl.worldEvents.length && i < 5; i++) worldAdd(ctrl.worldEvents[i]);

    // store outcome for UI
    state.lastOutcomeByRealm[rid] = {
      tone: String(ctrl.tone || "").slice(0, 80),
      intent: String(ctrl.intent || "").slice(0, 120),
      summary: String(ctrl.summary || "").slice(0, 160),
      dGoldP: dGP,
      dGoldO: dGO,
      dWarRisk: ctrl.deltaWarRisk | 0,
      dRel: { ...ctrl.deltaRelations },
      flags: (ctrl.flags || []).slice(0, 6).map(String),
      suggestions: (ctrl.suggestions || []).slice(0, 6).map(String),
    };
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

    const r = REALM_BY_ID[realmId];
    let s = "";
    if (gGold) s += `England gives ${gGold}g. `;
    if (tGold) s += `England asks ${tGold}g. `;
    if (giveItems.length) s += `England gives artifacts: ${giveItems.join("; ")}. `;
    if (takeItems.length) s += `England asks artifacts: ${takeItems.join("; ")}. `;
    s += `Target: ${r.name}.`;
    return s.trim();
  }

  function applyOfferLocally(realmId) {
    const gGold = Math.max(0, state.offer.giveGold | 0);
    const tGold = Math.max(0, state.offer.takeGold | 0);

    if (gGold > state.playerGold) return { ok: false, err: "Not enough gold to give." };
    if (tGold > (state.goldOther[realmId] || 0)) return { ok: false, err: "They don't have that much gold." };

    // validate item presence
    const giveItems = Object.keys(state.offer.giveItems).filter((k) => state.offer.giveItems[k]);
    const takeItems = Object.keys(state.offer.takeItems).filter((k) => state.offer.takeItems[k]);

    for (let i = 0; i < giveItems.length; i++) if (state.invPlayer.indexOf(giveItems[i]) === -1) return { ok: false, err: `You don't have: ${giveItems[i]}` };
    for (let i = 0; i < takeItems.length; i++) if (state.invOther[realmId].indexOf(takeItems[i]) === -1) return { ok: false, err: `They don't have: ${takeItems[i]}` };

    // transfer gold
    state.playerGold -= gGold;
    state.goldOther[realmId] = Math.max(0, (state.goldOther[realmId] || 0) + gGold);

    state.playerGold += tGold;
    state.goldOther[realmId] = Math.max(0, (state.goldOther[realmId] || 0) - tGold);

    // transfer items
    for (let i = 0; i < giveItems.length; i++) {
      const item = giveItems[i];
      const idx = state.invPlayer.indexOf(item);
      state.invPlayer.splice(idx, 1);
      state.invOther[realmId].push(item);
    }
    for (let i = 0; i < takeItems.length; i++) {
      const item = takeItems[i];
      const idx = state.invOther[realmId].indexOf(item);
      state.invOther[realmId].splice(idx, 1);
      state.invPlayer.push(item);
    }

    state._invVersion++;
    return { ok: true, err: "" };
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
      "X-Title": "SimLab Kingdom Diplomacy Chat",
    };
  }

  function systemPromptFor(realmId) {
    const r = REALM_BY_ID[realmId];

    return (
      "You are simulating diplomacy messages in a lightweight strategy sandbox.\n" +
      "Setting: year 1444, but everyone speaks in plain modern-day English.\n" +
      "Player is England. You are the leader/minister of the target realm.\n\n" +
      "Hard style rules:\n" +
      "- Keep replies SHORT: 3–10 sentences.\n" +
      "- No flowery 'esteemed envoy' language. Be blunt, concrete, transactional.\n" +
      "- If you want something: ask clearly, with a reason, and a fallback.\n" +
      "- If you threaten: keep it realistic and tied to military balance.\n\n" +
      "HARD CONSTRAINTS (do not violate):\n" +
      "- Do NOT request artifacts you already own.\n" +
      "- Only request artifacts from PLAYER_CAN_GIVE.\n" +
      "- Only offer artifacts from PLAYER_CAN_TAKE.\n" +
      "- If you want something not in the lists, ask for a concession instead (gold, access, treaty, guarantee).\n" +
      "- The control block must be ONLY the control text and must use the exact wrapper tags.\n\n" +
      "You MUST output TWO parts:\n" +
      "1) A freeform message (dialogue) meant for a chat UI.\n" +
      `2) Exactly one control block delimited by ${BLOCK_OPEN} and ${BLOCK_CLOSE}.\n\n` +
      "Control block format (ASCII only inside the block):\n" +
      "SPEAKER: <must be exactly the target realm name>\n" +
      "TONE: <calm / annoyed / upbeat / threatening / etc>\n" +
      "INTENT: <one line>\n" +
      "SUMMARY: <one line: what just happened>\n" +
      `TO_REALM: ${realmId}\n` +
      "DELTA_GOLD_PLAYER: <int -500..+500>  # England gold change\n" +
      "DELTA_GOLD_OTHER: <int -500..+500>   # target gold change\n" +
      "DELTA_WAR_RISK: <int -25..+25>       # global war risk change\n" +
      "DELTA_RELATIONS:\n" +
      "  SCO: <int -25..+25>\n" +
      "  IRE: <int -25..+25>\n" +
      "  FRA: <int -25..+25>\n" +
      "  CAS: <int -25..+25>\n" +
      "  POR: <int -25..+25>\n" +
      "DELTA_MILITARY:\n" +
      "  ENG: <int -10..+10>\n" +
      "  SCO: <int -10..+10>\n" +
      "  IRE: <int -10..+10>\n" +
      "  FRA: <int -10..+10>\n" +
      "  CAS: <int -10..+10>\n" +
      "  POR: <int -10..+10>\n" +
      "TRANSFER_ITEMS:\n" +
      "  GIVE: <semicolon-separated artifact names that ENGLAND gives>\n" +
      "  TAKE: <semicolon-separated artifact names that ENGLAND receives>\n" +
      "WORLD_EVENTS:\n" +
      "- <0–4 bullet items>\n" +
      "FLAGS:\n" +
      "- <0–5 bullet items>\n" +
      "SUGGESTIONS:\n" +
      "- <0–5 bullet items>\n\n" +
      `Persona for ${r.name}: ${r.aiStyle}.\n`
    );
  }

  function buildContextFor(realmId, playerText, offerText) {
    const r = REALM_BY_ID[realmId];
    const rel = state.relations[realmId] || 0;

    const invPlayer = state.invPlayer.slice(0, 16);
    const invOther = state.invOther[realmId].slice(0, 16);

    const timeStr = `${monthName(state.month)} ${state.year}`;
    const relStr =
      rel >= 30 ? "friendly" : rel >= 10 ? "warm" : rel >= -10 ? "neutral" : rel >= -30 ? "cold" : "hostile";

    const war = state.warRisk | 0;
    const milEng = state.military.ENG | 0;
    const milThem = state.military[realmId] | 0;
    const cred = clamp(milEng / Math.max(1, milThem), 0.2, 3.0);

    const canGiveGold = Math.min(500, Math.floor(state.playerGold));
    const canTakeGold = Math.min(500, Math.floor(state.goldOther[realmId] || 0));

    // recent chat
    const log = state.chats[realmId] || [];
    const recent = log.slice(-10);
    let recap = "";
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      const who =
        m.who === "player" ? "ENGLAND" : m.who === "other" ? r.name.toUpperCase() : "SYSTEM";
      const t = (m.text || "").replace(/\s+/g, " ").trim();
      recap += `${who}: ${t.slice(0, 280)}\n`;
    }

    const world = state.worldEvents.slice(-6).map((e) => e.text).join(" | ");

    return (
      `TIME: ${timeStr}\n` +
      `TARGET: ${r.name} (capital: ${r.capital})\n` +
      `RELATIONSHIP: ${relStr} (${rel})\n` +
      `WAR_RISK: ${war}/100\n` +
      `MILITARY: England=${milEng}  ${r.name}=${milThem}  THREAT_CREDIBILITY=${cred.toFixed(2)}\n` +
      `ENGLAND_GOLD: ${Math.round(state.playerGold)}\n` +
      `${r.name}_GOLD: ${Math.round(state.goldOther[realmId] || 0)}\n` +
      `PLAYER_CAN_GIVE_GOLD_MAX: ${canGiveGold}\n` +
      `PLAYER_CAN_TAKE_GOLD_MAX: ${canTakeGold}\n` +
      `PLAYER_CAN_GIVE (artifacts England can give): ${invPlayer.length ? invPlayer.join("; ") : "(none)"}\n` +
      `PLAYER_CAN_TAKE (artifacts England can receive): ${invOther.length ? invOther.join("; ") : "(none)"}\n` +
      `WORLD_RECENT: ${world || "(none)"}\n\n` +
      `PLAYER_MESSAGE:\n${String(playerText || "").trim()}\n\n` +
      (offerText ? `PLAYER_OFFER_DRAFT:\n${offerText}\n\n` : "") +
      `RECENT_CHAT:\n${recap || "(none)"}\n\n` +
      `Reminder:\n- Dialogue stays short, modern, blunt.\n- Control block MUST use the wrapper tags and MUST obey the inventory constraints.\n`
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
      pointerEvents: "auto",
    });

    const css = el("style");
    css.textContent = `
      #simlab-diplo-root { box-sizing: border-box; }
      #simlab-diplo-root * { box-sizing: border-box; }
      #simlab-diplo-root input[type="checkbox"]{ accent-color:#3dfcff; }
      #simlab-diplo-root ::-webkit-scrollbar{ height:10px; width:10px; }
      #simlab-diplo-root ::-webkit-scrollbar-thumb{ background: rgba(120,180,255,0.22); border-radius: 10px; }
      #simlab-diplo-root ::-webkit-scrollbar-track{ background: rgba(0,0,0,0.25); border-radius: 10px; }
      @media (max-width: 1120px) {
        #simlab-diplo-root { flex-direction: column; }
        #simlab-diplo-left, #simlab-diplo-right { width: auto !important; }
      }
    `;

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

    // Left: realms + world feed
    const left = el("div", { ...cardStyle, width: "280px", flex: "0 0 auto" });
    left.id = "simlab-diplo-left";

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
    // Right side of header: time + reset-all button
    const headRightTop = el("div", { display: "flex", gap: "8px", alignItems: "center" });
    const resetAllBtn = btn("Reset All");
    resetAllBtn.title = "Clear all saved SimLab data for this game and reload";
    resetAllBtn.onclick = () => {
      if (!confirm("Reset all saved Diplomacy data? This will remove saved progress and cannot be undone.")) return;
      // Collect simlab.* keys first (safe to mutate localStorage afterwards)
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("simlab.")) keys.push(k);
      }
      keys.forEach((k) => {
        try { localStorage.removeItem(k); } catch (e) {}
        try { localStorage.removeItem(k + "_ts"); } catch (e) {}
      });
      try { localStorage.removeItem(SAVE_KEY); localStorage.removeItem(SAVE_KEY + "_ts"); } catch (e) {}
      flash("All saved data cleared. Reloading...");
      setTimeout(() => location.reload(), 300);
    };
    headRightTop.appendChild(time);
    headRightTop.appendChild(resetAllBtn);
    leftHead.appendChild(headRightTop);

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

      const sub = el("div", {
        marginTop: "3px",
        fontSize: "12px",
        opacity: "0.8",
        display: "flex",
        justifyContent: "space-between",
        gap: "10px",
      });
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
        updateAll(true);
      };

      return { row, rel, gold };
    }

    const realmRows = {};
    for (let i = 0; i < otherIds.length; i++) {
      const id = otherIds[i];
      realmRows[id] = realmRow(id);
      realmList.appendChild(realmRows[id].row);
    }

    const divider = el("div", { height: "1px", background: "rgba(120,180,255,0.12)" });

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
    left.appendChild(divider);
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
    const peerSub = el("div", { fontSize: "12px", opacity: "0.85", lineHeight: "1.2" });
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
        maxWidth: "820px",
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

      const t = el("div", {});
      t.textContent = text;
      b.appendChild(t);

      if (meta) {
        const m = el("div", { fontSize: "11px", opacity: "0.75", marginTop: "6px" });
        m.textContent = meta;
        b.appendChild(m);
      }

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
      height: "96px",
      padding: "10px 10px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.20)",
      background: "rgba(8,12,18,0.92)",
      color: "#dff6ff",
      outline: "none",
      resize: "vertical",
      font: "650 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      lineHeight: "1.35",
    });

    input.onkeydown = (e) => {
      // Only Ctrl+Enter sends. Let space / r / etc be normal typing.
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        doSend();
      }
      e.stopPropagation();
    };

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

    // Right: stats + offer builder + outcome + settings
    const right = el("div", { ...cardStyle, width: "380px", flex: "0 0 auto" });
    right.id = "simlab-diplo-right";

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

    function box(titleText) {
      const b = el("div", {
        borderRadius: "12px",
        border: "1px solid rgba(120,180,255,0.12)",
        padding: "10px",
        background: "rgba(8,12,18,0.45)",
      });
      const t = el("div", { fontWeight: "950", fontSize: "12px", opacity: "0.9" });
      t.textContent = titleText;
      b.appendChild(t);
      return { b, t };
    }

    const topStats = box("State");
    const topStatsBody = el("div", { marginTop: "8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });

    function statPill(labelText) {
      const p = el("div", {
        padding: "8px",
        borderRadius: "12px",
        border: "1px solid rgba(120,180,255,0.10)",
        background: "rgba(0,0,0,0.24)",
      });
      const l = el("div", { fontSize: "11px", opacity: "0.75", fontWeight: "900" });
      l.textContent = labelText;
      const v = el("div", { fontSize: "13px", fontWeight: "950", marginTop: "4px" });
      p.appendChild(l);
      p.appendChild(v);
      return { p, v };
    }

    const warP = statPill("War risk");
    const milP = statPill("Military");
    topStatsBody.appendChild(warP.p);
    topStatsBody.appendChild(milP.p);
    topStats.b.appendChild(topStatsBody);

    const relBox = box("Relations");
    const relList = el("div", { marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px" });
    relBox.b.appendChild(relList);

    const invBox = box("Artifacts");
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
      whiteSpace: "pre-wrap",
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
      whiteSpace: "pre-wrap",
    });

    invBody.appendChild(invYou);
    invBody.appendChild(invThem);
    invBox.b.appendChild(invBody);

    const offerBox = box("Offer Builder (mechanical, optional)");
    const offerGrid = el("div", { marginTop: "8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });

    function numIn() {
      const i = el("input", {
        width: "100%",
        padding: "8px 10px",
        borderRadius: "12px",
        border: "1px solid rgba(120,180,255,0.14)",
        background: "rgba(0,0,0,0.30)",
        color: "#dff6ff",
        outline: "none",
        font: "800 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      });
      i.type = "number";
      i.min = "0";
      i.step = "1";
      return i;
    }

    function labSmall(t) {
      const d = el("div", { fontSize: "11px", opacity: "0.75", fontWeight: "900", marginBottom: "4px" });
      d.textContent = t;
      return d;
    }

    const giveGold = numIn();
    const takeGold = numIn();

    const giveWrap = el("div");
    giveWrap.appendChild(labSmall("You give gold"));
    giveWrap.appendChild(giveGold);

    const takeWrap = el("div");
    takeWrap.appendChild(labSmall("You ask gold"));
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
        minHeight: "98px",
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

    offerBox.b.appendChild(offerGrid);
    offerBox.b.appendChild(itemPanes);
    offerBox.b.appendChild(offerBtns);

    const outcomeBox = box("Last Outcome (parsed)");
    const outcomeBody = el("div", {
      marginTop: "8px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.10)",
      background: "rgba(0,0,0,0.24)",
      padding: "8px",
      fontSize: "12px",
      lineHeight: "1.35",
      whiteSpace: "pre-wrap",
      overflow: "auto",
      maxHeight: "170px",
      minHeight: "110px",
    });
    outcomeBox.b.appendChild(outcomeBody);

    const settingsBox = box("LLM Settings");
    const setGrid = el("div", { marginTop: "8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });

    const modelIn = el("input", {
      width: "100%",
      padding: "8px 10px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.14)",
      background: "rgba(0,0,0,0.30)",
      color: "#dff6ff",
      outline: "none",
      font: "800 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
    });
    modelIn.value = state.model;

    const tempIn = el("input", { width: "100%" });
    tempIn.type = "range";
    tempIn.min = "0";
    tempIn.max = "1.2";
    tempIn.step = "0.05";
    tempIn.value = String(state.temperature);

    const maxTokIn = el("input", {
      width: "100%",
      padding: "8px 10px",
      borderRadius: "12px",
      border: "1px solid rgba(120,180,255,0.14)",
      background: "rgba(0,0,0,0.30)",
      color: "#dff6ff",
      outline: "none",
      font: "800 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
    });
    maxTokIn.type = "number";
    maxTokIn.min = "256";
    maxTokIn.max = "1600";
    maxTokIn.step = "32";
    maxTokIn.value = String(state.maxTokens);

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

    setGrid.appendChild(modelIn);
    setGrid.appendChild(tempIn);
    setGrid.appendChild(maxTokIn);
    setGrid.appendChild(streamWrap);

    const setHint = el("div", { marginTop: "6px", fontSize: "11px", opacity: "0.70", lineHeight: "1.35" });
    setHint.textContent = "Recommended models: anthropic/claude-3.5-sonnet, openai/gpt-4.1-mini (try whichever feels best).";

    settingsBox.b.appendChild(setGrid);
    settingsBox.b.appendChild(setHint);

    rightBody.appendChild(topStats.b);
    rightBody.appendChild(relBox.b);
    rightBody.appendChild(invBox.b);
    rightBody.appendChild(offerBox.b);
    rightBody.appendChild(outcomeBox.b);
    rightBody.appendChild(settingsBox.b);

    right.appendChild(rightHead);
    right.appendChild(rightBody);

    // assemble
    root.id = "simlab-diplo-root";
    uiRoot.appendChild(css);
    uiRoot.appendChild(root);
    root.appendChild(left);
    root.appendChild(mid);
    root.appendChild(right);

    // ---------------- UI behaviour ----------------
    giveGold.value = String(state.offer.giveGold | 0);
    takeGold.value = String(state.offer.takeGold | 0);

    giveGold.oninput = () => {
      state.offer.giveGold = clamp(parseInt(giveGold.value || "0", 10) || 0, 0, 999999);
      updateAll(false);
    };
    takeGold.oninput = () => {
      state.offer.takeGold = clamp(parseInt(takeGold.value || "0", 10) || 0, 0, 999999);
      updateAll(false);
    };

    offerResetBtn.onclick = () => {
      resetOffer();
      giveGold.value = "0";
      takeGold.value = "0";
      updateAll(true);
      flash("Offer reset.", 0.9);
    };

    offerApplyBtn.onclick = () => {
      const rid = state.selectedRealm;
      const res = applyOfferLocally(rid);
      if (!res.ok) {
        flash(res.err || "Offer invalid.", 1.4);
        updateAll(false);
        return;
      }
      // goodwill bump
      state.relations[rid] = clamp((state.relations[rid] || 0) + 3, -100, 100);
      chatAdd(rid, "system", "You applied a mechanical trade transfer. Mention it if you want them to react in-character.");
      resetOffer();
      giveGold.value = "0";
      takeGold.value = "0";
      updateAll(true);
      saveNow();
      flash("Offer applied mechanically.", 1.0);
    };

    draftBtn.onclick = () => {
      const rid = state.selectedRealm;
      const offerText = offerToText(rid);
      if (!offerText) {
        flash("Build an offer first (gold or artifacts).", 1.2);
        updateAll(false);
        return;
      }
      const cur = input.value || "";
      const insert = (cur.trim() ? cur.trim() + "\n\n" : "") + `Offer draft (copy/edit):\n${offerText}\n`;
      input.value = insert;
      flash("Offer draft inserted.", 0.9);
      updateAll(false);
    };

    clearBtn.onclick = () => {
      input.value = "";
      updateAll(false);
    };

    stopBtn.onclick = () => {
      if (!state.busy) return;
      cancelRequest();
      flash("Cancelled.", 0.9);
      updateAll(false);
    };

    endTurnBtn.onclick = () => {
      if (state.busy) return;
      advanceMonth();
      worldAdd(`Month advanced to ${monthName(state.month)} ${state.year}.`);
      flash("New month.", 0.9);
      updateAll(true);
      saveNow();
    };

    sendBtn.onclick = () => doSend();

    modelIn.onchange = () => {
      state.model = (modelIn.value || "").trim() || state.model;
      saveNow();
      flash("Model updated.", 0.8);
      updateAll(false);
    };
    tempIn.oninput = () => {
      state.temperature = clamp(parseFloat(tempIn.value), 0, 2);
      flash(`Temperature: ${state.temperature.toFixed(2)}`, 0.7);
      updateAll(false);
      saveNow();
    };
    maxTokIn.oninput = () => {
      state.maxTokens = clamp(parseInt(maxTokIn.value || "650", 10) || 650, 256, 2000);
      updateAll(false);
      saveNow();
    };
    streamBox.onchange = () => {
      state.stream = !!streamBox.checked;
      updateAll(false);
      saveNow();
    };

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
      const youItems = state.invPlayer;
      const themItems = state.invOther[rid] || [];
      invYou.textContent = `You (${youItems.length}):\n${youItems.join("\n") || "(none)"}`;
      invThem.textContent = `${r.name} (${themItems.length}):\n${themItems.join("\n") || "(none)"}`;
    }

    function renderOutcome() {
      const rid = state.selectedRealm;
      const out = state.lastOutcomeByRealm[rid];
      if (!out) {
        outcomeBody.textContent = "No parsed outcome yet.";
        return;
      }

      const relLines = [];
      for (let i = 0; i < otherIds.length; i++) {
        const id = otherIds[i];
        const dv = (out.dRel && out.dRel[id]) | 0;
        if (dv) relLines.push(`${id}: ${dv > 0 ? "+" : ""}${dv}`);
      }

      const flags = out.flags && out.flags.length ? `Flags: ${out.flags.join(", ")}\n` : "";
      const sugg = out.suggestions && out.suggestions.length ? `Suggestions: ${out.suggestions.join(" | ")}\n` : "";

      outcomeBody.textContent =
        `Tone: ${out.tone || "(n/a)"}\n` +
        `Intent: ${out.intent || "(n/a)"}\n` +
        `Summary: ${out.summary || "(n/a)"}\n\n` +
        `Δ Gold (You): ${out.dGoldP > 0 ? "+" : ""}${out.dGoldP}\n` +
        `Δ Gold (Them): ${out.dGoldO > 0 ? "+" : ""}${out.dGoldO}\n` +
        `Δ War risk: ${out.dWarRisk > 0 ? "+" : ""}${out.dWarRisk}\n` +
        (relLines.length ? `Δ Relations: ${relLines.join(" | ")}\n` : "Δ Relations: (none)\n") +
        (flags ? `\n${flags}` : "") +
        (sugg ? `${sugg}` : "");
    }

    function updateHeader() {
      time.textContent = `${monthName(state.month)} ${state.year}`;
      youGold.textContent = fmtGold(state.playerGold);

      const rid = state.selectedRealm;
      const r = REALM_BY_ID[rid];
      const rel = state.relations[rid] || 0;

      const milEng = state.military.ENG | 0;
      const milThem = state.military[rid] | 0;
      const cred = clamp(milEng / Math.max(1, milThem), 0.2, 3.0);

      peerName.textContent = r.name;
      peerSub.textContent =
        `Capital: ${r.capital} • Their gold: ${fmtGold(state.goldOther[rid] || 0)} • Relation: ${fmtRel(rel)}\n` +
        `Military: you ${milEng} vs them ${milThem} (cred ${cred.toFixed(2)})`;

      act.textContent = state.actionAvailable ? "Action: READY" : "Action: USED";
      act.style.borderColor = state.actionAvailable ? "rgba(61,252,255,0.22)" : "rgba(255,75,216,0.22)";
      act.style.color = state.actionAvailable ? "#3dfcff" : "#ff4bd8";

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

      // top stats
      warP.v.textContent = `${state.warRisk | 0}/100`;
      warP.v.style.color = state.warRisk >= 70 ? "#ff4bd8" : state.warRisk >= 40 ? "#b54bff" : "#3dfcff";
      milP.v.textContent = `${milEng} (you)`;
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
      statusLine.textContent = state.busy ? "Waiting for reply… (Stop cancels)" : "Tip: Ctrl+Enter sends. One action per month.";
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

    // Offer checkboxes: build ONLY when needed (realm changed or inventory changed)
    function rebuildOfferListsIfNeeded(force) {
      const rid = state.selectedRealm;
      const key = `${rid}:${state._invVersion}`;
      if (!force && state._offerUiRealm === key) return;

      state._offerUiRealm = key;

      giveItemsPane.list.innerHTML = "";
      takeItemsPane.list.innerHTML = "";

      // prune stale selections (only on rebuild)
      const youItems = state.invPlayer.slice(0, 64);
      const themItems = state.invOther[rid].slice(0, 64);

      const keepGive = {};
      for (let i = 0; i < youItems.length; i++) if (state.offer.giveItems[youItems[i]]) keepGive[youItems[i]] = true;
      state.offer.giveItems = keepGive;

      const keepTake = {};
      for (let i = 0; i < themItems.length; i++) if (state.offer.takeItems[themItems[i]]) keepTake[themItems[i]] = true;
      state.offer.takeItems = keepTake;

      function makeCheck(listEl, item, mapObj) {
        const lab = el("label", {
          display: "flex",
          gap: "8px",
          alignItems: "center",
          cursor: "pointer",
          userSelect: "none",
          padding: "6px 6px",
          borderRadius: "10px",
          border: "1px solid rgba(120,180,255,0.08)",
          background: "rgba(0,0,0,0.10)",
        });

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!mapObj[item];
        box.style.pointerEvents = "auto";

        const t = el("div", { fontSize: "12px", lineHeight: "1.2" });
        t.textContent = item;

        // Make sure clicks always toggle reliably even if UI updates elsewhere.
        box.addEventListener("click", (e) => {
          e.stopPropagation();
          mapObj[item] = !!box.checked;
          // no full rebuild on toggle
          updateAll(false);
        });

        lab.addEventListener("click", (e) => {
          // Clicking label should toggle.
          e.stopPropagation();
          if (e.target !== box) {
            box.checked = !box.checked;
            mapObj[item] = !!box.checked;
            updateAll(false);
          }
        });

        lab.appendChild(box);
        lab.appendChild(t);
        listEl.appendChild(lab);
      }

      for (let i = 0; i < youItems.length; i++) makeCheck(giveItemsPane.list, youItems[i], state.offer.giveItems);
      for (let i = 0; i < themItems.length; i++) makeCheck(takeItemsPane.list, themItems[i], state.offer.takeItems);
    }

    function renderWorldAndChat() {
      renderChat();
      renderWorld();
    }

    async function doSend() {
      if (state.busy) return;
      if (!state.actionAvailable) {
        flash("You already used your action this month. End Month to continue.", 1.4);
        updateAll(false);
        return;
      }
      if (!OR_KEY) {
        flash("Missing API key. Set VITE_OPENROUTER_API_KEY in .env and restart Vite.", 2.0);
        updateAll(false);
        return;
      }
      const rid = state.selectedRealm;
      const text = (input.value || "").trim();
      if (!text) {
        flash("Write something first.", 1.0);
        updateAll(false);
        return;
      }

      state.actionAvailable = false;
      chatAdd(rid, "player", text);

      const offerText = offerToText(rid);

      updateAll(false);
      renderChat();

      const res = await callOpenRouter(rid, text, offerText);
      if (!res.ok) {
        state.lastError = res.err || "Error";
        chatAdd(rid, "system", `Comms failed: ${state.lastError}`);
        state.relations[rid] = clamp((state.relations[rid] || 0) - 2, -100, 100);
        state.warRisk = clamp(state.warRisk + 1, 0, 100);
        updateAll(false);
        renderChat();
        saveNow();
        return;
      }

      const full = String(res.text || "");
      const extracted = extractBlockBestEffort(full);
      const dialogue = extracted.dialogue || "";
      const replyText = dialogue.trim() ? dialogue.trim() : "(no message)";

      // always show ONLY cleaned dialogue (never control text)
      chatAdd(rid, "other", replyText);

      if (!extracted.ok || !extracted.block) {
        chatAdd(rid, "system", "Control block missing or malformed. No mechanical effects applied (except minor friction).");
        state.relations[rid] = clamp((state.relations[rid] || 0) - 1, -100, 100);
        state.warRisk = clamp(state.warRisk + 1, 0, 100);
        updateAll(false);
        renderWorldAndChat();
        saveNow();
        return;
      }

      const ctrl = parseBlock(extracted.block);

      // enforce speaker correctness at UI level by ignoring it; still track it in outcome if you want.
      // also enforce toRealm correctness
      ctrl.toRealm = rid;

      applyControl(ctrl);

      // show meta as system bubbles but not the raw control block
      const out = state.lastOutcomeByRealm[rid];
      if (out && out.summary) chatAdd(rid, "system", `Outcome: ${out.summary}`);

      updateAll(true);
      renderWorldAndChat();
      saveNow();
    }

    function updateAll(forceOfferRebuild) {
      updateHeader();
      updateControls();
      updateStatusLine();
      renderRelations();
      renderInventories();
      renderOutcome();
      rebuildOfferListsIfNeeded(!!forceOfferRebuild);
      renderWorld();
      renderChat();
    }

    // initial text
    if (!(input.value || "").trim()) input.value = "What do you want this month? Be specific.";

    updateAll(true);

    return { updateAll };
  }

  ui = buildUI();
  if (ui && ui.updateAll) ui.updateAll(true);

  // ---------------- engine hooks ----------------
  function update(dt) {
    if (Engine.isPaused()) return;

    const tNow = nowSec();
    if (tNow >= state.autosaveAt) {
      saveNow();
      state.autosaveAt = tNow + 10.0;
    }
  }

  function render() {
    Engine.gfx.clearBlack();
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
    ui && ui.updateAll && ui.updateAll(false);
  }
}
