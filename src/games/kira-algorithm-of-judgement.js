import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab.kira.v1";
  const OR_BASE = "https://openrouter.ai/api/v1/chat/completions";
  const CANONICAL_COUNTRIES = [
    "United Kingdom",
    "Ireland",
    "France",
    "Germany",
    "Spain",
    "Portugal",
    "Italy",
    "Netherlands",
    "Belgium",
    "Switzerland",
    "Austria",
    "Poland",
    "Sweden",
    "Norway",
    "Denmark",
    "Finland",
    "Ukraine",
    "Turkey",
    "Russia",
    "United States",
    "Canada",
    "Mexico",
    "Brazil",
    "Argentina",
    "Colombia",
    "China",
    "Japan",
    "South Korea",
    "India",
    "Pakistan",
    "Indonesia",
    "Vietnam",
    "Philippines",
    "Australia",
    "New Zealand",
    "Saudi Arabia",
    "Iran",
    "Israel",
    "Egypt",
    "South Africa",
    "Nigeria",
    "Other"
  ];
  const GEO_BUCKETS = [
    "UK_IE",
    "Europe_W",
    "Europe_E",
    "NorthAmerica",
    "LatAm",
    "MENA",
    "SubSaharan",
    "SouthAsia",
    "EastAsia",
    "SEAsia",
    "Oceania",
    "Other"
  ];
  const COUNTRY_TO_BUCKET = {
    "United Kingdom": "UK_IE",
    Ireland: "UK_IE",
    France: "Europe_W",
    Germany: "Europe_W",
    Spain: "Europe_W",
    Portugal: "Europe_W",
    Italy: "Europe_W",
    Netherlands: "Europe_W",
    Belgium: "Europe_W",
    Switzerland: "Europe_W",
    Austria: "Europe_W",
    Poland: "Europe_E",
    Sweden: "Europe_E",
    Norway: "Europe_E",
    Denmark: "Europe_E",
    Finland: "Europe_E",
    Ukraine: "Europe_E",
    Turkey: "Europe_E",
    Russia: "Europe_E",
    "United States": "NorthAmerica",
    Canada: "NorthAmerica",
    Mexico: "NorthAmerica",
    Brazil: "LatAm",
    Argentina: "LatAm",
    Colombia: "LatAm",
    China: "EastAsia",
    Japan: "EastAsia",
    "South Korea": "EastAsia",
    India: "SouthAsia",
    Pakistan: "SouthAsia",
    Indonesia: "SEAsia",
    Vietnam: "SEAsia",
    Philippines: "SEAsia",
    Australia: "Oceania",
    "New Zealand": "Oceania",
    "Saudi Arabia": "MENA",
    Iran: "MENA",
    Israel: "MENA",
    Egypt: "MENA",
    "South Africa": "SubSaharan",
    Nigeria: "SubSaharan"
  };

  const WORLD_MODELS = [
    "anthropic/claude-3.5-sonnet",
    "anthropic/claude-3.5-haiku",
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash-001"
  ];

  const OR_KEY =
    (typeof import.meta !== "undefined" &&
      import.meta.env &&
      (import.meta.env.VITE_OPENROUTER_API_KEY || import.meta.env.OPENROUTER_API_KEY)) ||
    "";

  const uiRoot =
    ctx && ctx.uiRoot && typeof ctx.uiRoot === "object" && ctx.uiRoot.appendChild ? ctx.uiRoot : null;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const clamp01 = (v) => clamp(v, 0, 1);
  const toNum = (v, f = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : f;
  };
  const toInt = (v, f = 0) => (toNum(v, f) | 0);
  const toFloat = (v, f = 0) => toNum(v, f);
  const cap = (arr, n) => {
    if (arr.length > n) arr.splice(0, arr.length - n);
  };
  const fmtMonth = (st) => `${st.year}-${String(st.month).padStart(2, "0")}`;
  const isInputLike = (el) => {
    if (!el) return false;
    const t = (el.tagName || "").toLowerCase();
    return t === "input" || t === "textarea" || el.isContentEditable;
  };

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function next() {
      t += 0x6d2b79f5;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function safeCountry(c) {
    return CANONICAL_COUNTRIES.includes(c) ? c : "Other";
  }

  function geoOf(country) {
    return COUNTRY_TO_BUCKET[country] || "Other";
  }

  function mkId(prefix, rng) {
    const x = Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, "0")
      .slice(0, 8);
    return `${prefix}_${x}`;
  }

  function parseStrictJson(text) {
    const source = String(text || "").trim();
    if (!source) return { ok: false, error: "Empty response", raw: source, data: null };
    try {
      return { ok: true, data: JSON.parse(source), raw: source, error: "" };
    } catch {}
    const start = source.indexOf("{");
    if (start < 0) return { ok: false, error: "No JSON object found", raw: source, data: null };
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const chunk = source.slice(start, i + 1);
          try {
            return { ok: true, data: JSON.parse(chunk), raw: source, error: "" };
          } catch (err) {
            return { ok: false, error: `JSON parse failed: ${err.message}`, raw: source, data: null };
          }
        }
      }
    }
    return { ok: false, error: "Could not extract balanced JSON object", raw: source, data: null };
  }

  function b64EncodeUtf8(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64DecodeUtf8(str) {
    return decodeURIComponent(escape(atob(str)));
  }

  const SYSTEM_PROMPT = [
    "You are the world simulation engine for KIRA: Algorithm of Judgement.",
    "YOU MUST OUTPUT ONLY JSON. NO MARKDOWN. NO EXPLANATIONS.",
    "Use schema_id exactly as requested.",
    "Modern 2026 tone, cold procedural style, short neutral wording.",
    "No anime tone, no melodrama, no gore.",
    "Use only canonical countries and geo buckets provided.",
    "Do not invent IDs except in new_individuals/new_investigators arrays where allowed.",
    "Do not output user secrets.",
    "If uncertain, conservative deltas.",
    "Required schema references:",
    "WORLD_GEN_MONTHLY_V1: schema_id,time,new_individuals,updated_individuals,crime_events,world_events,news_feed,social_feed,investigator_update,month_deltas,notes_for_player.",
    "WORLD_GEN_DEATH_V1: schema_id,time,victim_id,death,deltas,effects.",
    "WORLD_GEN_PROFILE_V1: schema_id,time,target_individual_id,discovery,intel_snippet.",
    "WORLD_GEN_PSYOPS_V1: schema_id,time,action,deltas,effects.",
    "Text limits: news 2-4 sentences, investigator brief 2-4 sentences, social posts max 4 short lines, notes_for_player max 1 sentence."
  ].join("\n");

  function initialState() {
    const now = Date.now();
    const seed = hashStr(String(now));
    const rng = mulberry32(seed);
    const monthAbs = 0;
    const individualSeed = [
      ["ind_0d4f7a10", "Adrian Pike", "Adrian Pike", true, true, "United Kingdom", "Data broker", 8.0, 2.0, ["Market manipulation", "Witness tampering"]],
      ["ind_77ce1b20", "Marina Volkov", "Marina Volkov", true, true, "Russia", "Arms financier", 9.0, 1.0, ["Arms trafficking", "Sanctions evasion"]],
      ["ind_0c7aa130", "Dorian Hale", "", false, false, "United States", "Security contractor", 7.2, 3.8, ["Excessive force allegations"]],
      ["ind_5c221940", "Leila Nassif", "", false, false, "Egypt", "Political fixer", 7.8, 3.4, ["Corruption", "Intimidation"]],
      ["ind_219ba950", "Riku Matsuda", "", false, false, "Japan", "Pharma executive", 6.9, 4.2, ["Clinical data suppression"]],
      ["ind_6ff2e660", "Stefan Kurz", "", false, false, "Germany", "Logistics owner", 6.1, 4.9, ["Smuggling links"]],
      ["ind_c8dbd870", "Anais Delcourt", "", false, false, "France", "Media strategist", 5.8, 5.3, ["Disinformation contracts"]],
      ["ind_0a15a080", "Pavel Romanenko", "", false, false, "Ukraine", "Militia broker", 7.5, 2.9, ["Weapons procurement fraud"]],
      ["ind_4c8e3290", "Nadia Costa", "", false, false, "Portugal", "Port authority advisor", 4.9, 5.6, ["Bribery probe"]],
      ["ind_9185fba0", "Omar Haddad", "", false, false, "Saudi Arabia", "Energy middleman", 7.0, 3.7, ["Kickback allegations"]],
      ["ind_b4a2a7b0", "Kira Bhandari", "", false, false, "India", "Political media operative", 6.2, 4.6, ["Fabricated leak campaign"]],
      ["ind_d8f966c0", "Tomislav Ersek", "", false, false, "Poland", "Import magnate", 5.4, 4.9, ["Tax evasion"]],
      ["ind_31d931d0", "Maya Ko", "", false, false, "South Korea", "AI startup founder", 6.5, 5.1, ["Illegal data acquisition"]],
      ["ind_e1c910e0", "Bruno Estevez", "", false, false, "Brazil", "Union racketeer", 5.7, 3.2, ["Extortion"]],
      ["ind_456321f0", "Elena Moroz", "", false, false, "Switzerland", "Private banker", 8.3, 4.1, ["Laundering network"]],
      ["ind_560c8701", "Isaac Reid", "", false, false, "Canada", "Procurement director", 4.5, 5.9, ["Contract steering"]],
      ["ind_65dcf112", "Sefa Aksoy", "", false, false, "Turkey", "Construction syndicate head", 6.8, 3.8, ["Coercion cases"]],
      ["ind_8a9ec223", "Mina Okafor", "", false, false, "Nigeria", "Port customs officer", 5.3, 4.7, ["Container diversion"]],
      ["ind_9fbe2334", "Diego Arce", "", false, false, "Mexico", "Cartel accountant", 6.1, 2.4, ["Money laundering"]],
      ["ind_11ce5445", "Hiro Tanaka", "", false, false, "Japan", "Judge", 5.2, 7.1, ["Conflict of interest rumors"]],
      ["ind_44ce2996", "Yara Aziz", "", false, false, "Israel", "Cyber-intel broker", 7.4, 3.9, ["Ransomware enablement"]],
      ["ind_778f7677", "Santiago Ruiz", "", false, false, "Argentina", "State lobbyist", 5.1, 4.8, ["Illicit influence peddling"]],
      ["ind_88ac3088", "Eva Lindgren", "", false, false, "Sweden", "Bio-tech CFO", 4.3, 6.2, ["Accounting irregularities"]],
      ["ind_91eea199", "Basil Harrow", "", false, false, "Australia", "Private military consultant", 7.9, 3.3, ["Arms route advisory"]]
    ];
    const individuals = individualSeed.map((d) => ({
      id: d[0],
      display_name: d[1],
      real_name: d[2],
      real_name_verified: d[3],
      face_known: d[4],
      country: safeCountry(d[5]),
      geo_bucket: geoOf(d[5]),
      role: d[6],
      affiliations: [],
      influence: d[7],
      morality: d[8],
      headline_crimes: d[9],
      evidence_quality: clamp01(0.45 + rng() * 0.35),
      visibility: { media: clamp01(0.2 + rng() * 0.7), law: clamp01(0.2 + rng() * 0.7), underground: clamp01(0.2 + rng() * 0.7) },
      flags: { protected: false, public_figure: rng() > 0.6, masked_identity: !d[4], uses_alias: rng() > 0.65, bait: false },
      alive: true,
      createdMonthAbs: monthAbs,
      lastMentionMonthAbs: monthAbs,
      notes: ""
    }));

    const invs = [
      {
        id: "inv_4f90aa11",
        name: "Inspector Helena Sato",
        style: "statistical",
        skill: 0.83,
        credibility: 0.74,
        aggressiveness: 0.56,
        biases: ["pattern", "metadata"],
        beliefs: mkBeliefs("statistical"),
        current_hypotheses: ["single_actor"],
        focus_geo_bucket: "UK_IE",
        lastAction: "quiet_watch",
        logs: []
      },
      {
        id: "inv_88be7722",
        name: "Analyst Owen Price",
        style: "behavioural",
        skill: 0.76,
        credibility: 0.62,
        aggressiveness: 0.44,
        biases: ["media", "social contagion"],
        beliefs: mkBeliefs("behavioural"),
        current_hypotheses: ["copycats"],
        focus_geo_bucket: "Europe_W",
        lastAction: "quiet_watch",
        logs: []
      },
      {
        id: "inv_a2cf8833",
        name: "Director Miriam Kline",
        style: "authoritarian",
        skill: 0.8,
        credibility: 0.68,
        aggressiveness: 0.86,
        biases: ["deterrence", "centralized control"],
        beliefs: mkBeliefs("authoritarian"),
        current_hypotheses: ["group"],
        focus_geo_bucket: "NorthAmerica",
        lastAction: "international_coordination",
        logs: []
      }
    ];

    return {
      seed,
      year: 2026,
      month: 1,
      monthAbs,
      actionsLeft: 1,
      autoAdvanceAfterAction: true,
      strictExtraction: true,
      strictJson: true,
      debug: false,
      paused: false,
      suspensePulse: 0,

      suspicion: 6,
      publicSupport: 0,
      crackdownRisk: 5,
      lifespanMonths: 720,
      kiraCult: 0,
      money: 100000,
      influence: 15,
      eyeDealActive: false,

      selectedPersonId: individuals[0].id,
      selectedTab: "news",
      chatChannel: "taskforce",
      searchQuery: "",

      people: individuals,
      investigators: invs,
      watchlist: [],
      decoyIds: [],
      news_feed: seedNews(),
      social_feed: seedSocial(),
      crimes: seedCrimes(),
      world_events: seedWorldEvents(),
      chat: [{ id: "sys_init", side: "system", text: "System initialized. Monthly cadence active.", ts: Date.now(), details: null }],
      killRecords: [],
      stats: { Hc: 1, Hg: 1, Ht: 1, R: 0.5, PSS: 0, maxCauseShare: 0, avgPlaus: 1, avgPublicness: 0, Sinf: 0, Sjust: 0, pressure: 0.2 },

      inFlight: false,
      requestSince: 0,
      lastCallAt: 0,
      abortController: null,
      pendingAction: null,
      errorBanner: "",
      parseWarning: "",
      lastRequestPayload: "",
      lastRawResponse: "",
      lastRetry: null,
      rawDebugOpen: false,
      saveNotice: "",
      awayReport: null,

      settings: {
        worldModel: WORLD_MODELS[0],
        narrativeModel: "off",
        temp: 0.25,
        maxTokens: 1200
      }
    };
  }

  function mkBeliefs(style) {
    const geo = {};
    for (let i = 0; i < GEO_BUCKETS.length; i++) geo[GEO_BUCKETS[i]] = 1 / GEO_BUCKETS.length;
    return {
      H: { single_actor: 0.34, group: 0.28, copycats: 0.24, hoax: 0.14 },
      signature: { cause_control: 0.4, pattern_driven: 0.42, moral_crusade: 0.36, influence_seeking: 0.34 },
      geo,
      alertness: style === "authoritarian" ? 0.5 : 0.38,
      resources: 0.45,
      surveillance: style === "authoritarian" ? 0.52 : 0.33,
      psyops: style === "behavioural" ? 0.46 : 0.29
    };
  }

  function seedNews() {
    return [
      { id: "news_seed_1", monthAbs: 0, headline: "Cross-border fraud task force expands data sharing", country: "United Kingdom", geo_bucket: "UK_IE", blurb: "Authorities announced a coordinated financial intelligence channel. Officials say the priority is high-value laundering routes.", tags: ["finance", "investigation"], mentions: ["inv_4f90aa11"] },
      { id: "news_seed_2", monthAbs: 0, headline: "Shipping irregularities trigger customs audit", country: "Portugal", geo_bucket: "Europe_W", blurb: "A customs review flagged unusual container patterns in two ports. Analysts are mapping shell-company ownership.", tags: ["trade", "audit"], mentions: [] },
      { id: "news_seed_3", monthAbs: 0, headline: "Anonymous leak alleges procurement favoritism", country: "Canada", geo_bucket: "NorthAmerica", blurb: "A parliamentary committee requested tender records after an encrypted dossier surfaced online.", tags: ["leak", "politics"], mentions: ["ind_560c8701"] },
      { id: "news_seed_4", monthAbs: 0, headline: "Regional cybercrime arrests reveal broker networks", country: "Israel", geo_bucket: "MENA", blurb: "Investigators traced payment trails through several intermediaries. More warrants are expected.", tags: ["cyber", "crime"], mentions: ["ind_44ce2996"] },
      { id: "news_seed_5", monthAbs: 0, headline: "Commodity shock raises pressure on emerging markets", country: "Nigeria", geo_bucket: "SubSaharan", blurb: "Market volatility is increasing enforcement risk and political stress across export-dependent sectors.", tags: ["economy"], mentions: [] }
    ];
  }

  function seedSocial() {
    return [
      { id: "soc_seed_1", monthAbs: 0, platform: "Pulse", trend: "#NoMoreUntouchables", country: "United Kingdom", geo_bucket: "UK_IE", posts: ["People are tired of closed-door deals.", "If evidence exists, publish it.", "No trust without accountability."] },
      { id: "soc_seed_2", monthAbs: 0, platform: "StreamNet", trend: "#AuditThePorts", country: "Portugal", geo_bucket: "Europe_W", posts: ["Containers vanish on paper, not in real life.", "Follow the invoices."] },
      { id: "soc_seed_3", monthAbs: 0, platform: "ForumX", trend: "#SilentCartels", country: "Mexico", geo_bucket: "NorthAmerica", posts: ["Every crackdown hits small workers first.", "Real controllers never appear on camera."] },
      { id: "soc_seed_4", monthAbs: 0, platform: "Pulse", trend: "#DataIsPower", country: "Germany", geo_bucket: "Europe_W", posts: ["Metadata tells the story.", "Pattern beats rumor."] },
      { id: "soc_seed_5", monthAbs: 0, platform: "Verve", trend: "#SystemFail", country: "Brazil", geo_bucket: "LatAm", posts: ["Corruption is routine unless names are known.", "Pressure is rising."] }
    ];
  }

  function seedCrimes() {
    return [
      { id: "crime_seed_1", monthAbs: 0, type: "Financial fraud", severity: 5, country: "Switzerland", geo_bucket: "Europe_W", summary: "Layered transfer chain tied to shell entities.", refs: ["ind_456321f0"] },
      { id: "crime_seed_2", monthAbs: 0, type: "Extortion", severity: 6, country: "Brazil", geo_bucket: "LatAm", summary: "Union contracts linked to coercive enforcement.", refs: ["ind_e1c910e0"] }
    ];
  }

  function seedWorldEvents() {
    return [
      { id: "evt_seed_1", monthAbs: 0, title: "Joint surveillance memorandum signed", country: "France", geo_bucket: "Europe_W", summary: "European agencies expanded metadata retention agreements." },
      { id: "evt_seed_2", monthAbs: 0, title: "Currency controls tightened", country: "Argentina", geo_bucket: "LatAm", summary: "Emergency capital restrictions alter private transfer routes." }
    ];
  }

  function upgradeLoadedState(raw) {
    if (!raw || typeof raw !== "object") return initialState();
    const base = initialState();
    const s = { ...base, ...raw };
    s.settings = { ...base.settings, ...(raw.settings || {}) };
    s.stats = { ...base.stats, ...(raw.stats || {}) };
    s.people = Array.isArray(raw.people) ? raw.people : base.people;
    s.investigators = Array.isArray(raw.investigators) ? raw.investigators : base.investigators;
    s.news_feed = Array.isArray(raw.news_feed) ? raw.news_feed : base.news_feed;
    s.social_feed = Array.isArray(raw.social_feed) ? raw.social_feed : base.social_feed;
    s.crimes = Array.isArray(raw.crimes) ? raw.crimes : base.crimes;
    s.world_events = Array.isArray(raw.world_events) ? raw.world_events : base.world_events;
    s.chat = Array.isArray(raw.chat) ? raw.chat : base.chat;
    s.killRecords = Array.isArray(raw.killRecords) ? raw.killRecords : base.killRecords;
    s.watchlist = Array.isArray(raw.watchlist) ? raw.watchlist : [];
    s.decoyIds = Array.isArray(raw.decoyIds) ? raw.decoyIds : [];
    s.lastRequestPayload = "";
    s.lastRawResponse = "";
    s.lastRetry = null;
    s.abortController = null;
    s.inFlight = false;
    s.errorBanner = "";
    s.parseWarning = "";
    return s;
  }

  function getSavedOrNew() {
    const fallback = initialState();
    let loaded = fallback;
    try {
      loaded = upgradeLoadedState(Engine.load(SAVE_KEY, fallback));
    } catch {
      loaded = fallback;
    }
    let lastTs = 0;
    try {
      lastTs = Engine.loadTimestamp(SAVE_KEY);
    } catch {}
    if (lastTs > 0) {
      const elapsedSec = Math.max(0, (Date.now() - lastTs) / 1000);
      const cool = clamp(Math.floor(elapsedSec / 300), 0, 2);
      if (cool > 0) loaded.suspicion = clamp(loaded.suspicion - cool, 0, 100);
      const capSec = Math.min(elapsedSec, 21600);
      const monthlyIncome = computeIncome(loaded);
      const fraction = capSec / (30 * 24 * 3600);
      const moneyGain = Math.floor(monthlyIncome.money * fraction);
      const inflGain = Math.floor(monthlyIncome.influence * fraction);
      loaded.money += moneyGain;
      loaded.influence = clamp(loaded.influence + inflGain, 0, 100);
      if (cool > 0 || moneyGain > 0 || inflGain > 0) {
        loaded.awayReport = { cool, moneyGain, inflGain, elapsedSec };
      }
    }
    return loaded;
  }

  const state = getSavedOrNew();
  state.rng = mulberry32(state.seed >>> 0);

  const scanLines = [];
  for (let i = 0; i < 32; i++) scanLines.push({ y: i / 32, phase: state.rng() * Math.PI * 2 });

  function addChat(side, text, details = null) {
    state.chat.push({ id: mkId("msg", state.rng), side, text: String(text || ""), ts: Date.now(), details });
    cap(state.chat, 220);
  }

  function saveNow() {
    try {
      const saveObj = { ...state };
      delete saveObj.rng;
      delete saveObj.abortController;
      delete saveObj.inFlight;
      delete saveObj.requestSince;
      delete saveObj.lastCallAt;
      delete saveObj.lastRequestPayload;
      delete saveObj.lastRawResponse;
      delete saveObj.lastRetry;
      Engine.save(SAVE_KEY, saveObj);
      state.saveNotice = "Saved";
      setTimeout(() => {
        state.saveNotice = "";
        updateTopBar();
      }, 1200);
    } catch {}
  }

  function monthStep() {
    state.monthAbs += 1;
    state.month += 1;
    if (state.month > 12) {
      state.month = 1;
      state.year += 1;
    }
    state.actionsLeft = 1;
    state.lifespanMonths = clamp(state.lifespanMonths - 1, 0, 2400);
    const income = computeIncome(state);
    state.money += income.money;
    state.influence = clamp(state.influence + income.influence, 0, 100);
    state.kiraCult = clamp(state.kiraCult + (state.publicSupport > 25 ? 1 : state.publicSupport < -20 ? -1 : 0), 0, 100);
  }

  function computeIncome(s) {
    const money = Math.max(0, Math.round(50000 + 20000 * (s.publicSupport / 100) + 30000 * (s.kiraCult / 100) - 20000 * (s.crackdownRisk / 100)));
    let influence = 2;
    if (s.publicSupport > 30) influence += 3;
    if (s.kiraCult > 40) influence += 2;
    if (s.crackdownRisk > 50) influence -= 2;
    influence = Math.max(0, influence);
    return { money, influence };
  }

  function findPerson(id) {
    return state.people.find((p) => p.id === id && p.alive !== false) || null;
  }

  function compactStateSummary() {
    const people = state.people
      .filter((p) => p.alive !== false)
      .slice(0, 12)
      .map((p) => ({
        id: p.id,
        display_name: p.display_name,
        country: p.country,
        face_known: !!p.face_known,
        real_name_verified: !!p.real_name_verified,
        influence: Number(p.influence.toFixed(2)),
        morality: Number(p.morality.toFixed(2))
      }));

    const inv = state.investigators.map((x) => {
      const topGeo = Object.entries(x.beliefs.geo || {}).sort((a, b) => b[1] - a[1])[0];
      return { id: x.id, style: x.style, alertness: Number((x.beliefs.alertness || 0).toFixed(2)), top_geo: topGeo ? topGeo[0] : "Other" };
    });

    const events = state.world_events
      .slice(-5)
      .map((e) => ({ id: e.id, summary: (e.summary || "").slice(0, 120) }));

    return {
      time: { year: state.year, month: state.month },
      meters: {
        suspicion: state.suspicion,
        publicSupport: state.publicSupport,
        crackdownRisk: state.crackdownRisk,
        cult: state.kiraCult,
        eyeDealActive: !!state.eyeDealActive,
        influence: state.influence,
        money: state.money
      },
      people,
      investigators: inv,
      recent_events: events,
      canonical_countries: CANONICAL_COUNTRIES,
      geo_buckets: GEO_BUCKETS
    };
  }

  function buildMessages(schemaId, actionPayload) {
    const userPayload = {
      requested_schema_id: schemaId,
      current_time: { year: state.year, month: state.month },
      state_summary: compactStateSummary(),
      player_action: actionPayload || null,
      output_rules: [
        "OUTPUT JSON ONLY",
        "MUST INCLUDE ALL REQUIRED KEYS",
        "Use provided IDs and canonical countries",
        "Keep text concise"
      ]
    };
    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(userPayload) }
    ];
  }

  async function callOpenRouter(messages) {
    if (!OR_KEY) throw new Error("Missing VITE_OPENROUTER_API_KEY.");
    const now = Date.now();
    const wait = Math.max(0, 1500 - (now - state.lastCallAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    state.inFlight = true;
    state.errorBanner = "";
    state.requestSince = performance.now();
    state.abortController = new AbortController();
    updateButtons();
    const payload = {
      model: state.settings.worldModel,
      temperature: clamp(state.settings.temp, 0, 1),
      max_tokens: clamp(toInt(state.settings.maxTokens, 1200), 300, 1800),
      messages
    };
    state.lastRequestPayload = JSON.stringify(payload, null, 2);
    try {
      const res = await fetch(OR_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OR_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://simlab.local",
          "X-Title": "KIRA: Algorithm of Judgement"
        },
        body: JSON.stringify(payload),
        signal: state.abortController.signal
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
      let raw = "";
      try {
        const j = JSON.parse(text);
        raw = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content || "" : "";
      } catch {
        raw = text;
      }
      state.lastRawResponse = String(raw || "");
      state.lastCallAt = Date.now();
      return state.lastRawResponse;
    } finally {
      state.inFlight = false;
      state.abortController = null;
      updateButtons();
    }
  }

  function validateSchema(schemaId, obj) {
    const w = [];
    const o = obj && typeof obj === "object" ? obj : {};
    if (o.schema_id !== schemaId) {
      w.push(`schema mismatch: expected ${schemaId}, got ${o.schema_id || "missing"}`);
      o.schema_id = schemaId;
    }
    if (!o.time || typeof o.time !== "object") o.time = { year: state.year, month: state.month };

    const ensureArr = (k) => {
      if (!Array.isArray(o[k])) {
        o[k] = [];
        w.push(`missing array ${k}`);
      }
    };

    if (schemaId === "WORLD_GEN_MONTHLY_V1") {
      ["new_individuals", "updated_individuals", "crime_events", "world_events", "news_feed", "social_feed"].forEach(ensureArr);
      if (!o.investigator_update || typeof o.investigator_update !== "object") o.investigator_update = { updates: [], briefs: [] };
      if (!o.month_deltas || typeof o.month_deltas !== "object") o.month_deltas = { public_support_delta: 0, crackdown_risk_delta: 0 };
      if (typeof o.notes_for_player !== "string") o.notes_for_player = "No significant shift.";
    } else if (schemaId === "WORLD_GEN_DEATH_V1") {
      if (typeof o.victim_id !== "string") o.victim_id = "";
      if (!o.death || typeof o.death !== "object") o.death = {};
      if (!o.deltas || typeof o.deltas !== "object") o.deltas = {};
      if (!o.effects || typeof o.effects !== "object") o.effects = {};
      if (!o.effects.news_item) o.effects.news_item = null;
      if (!Array.isArray(o.effects.social_items)) o.effects.social_items = [];
      if (!Array.isArray(o.effects.secondary_events)) o.effects.secondary_events = [];
      if (!o.effects.flags || typeof o.effects.flags !== "object") o.effects.flags = { crackdown_triggered: false, new_task_force_formed: false };
    } else if (schemaId === "WORLD_GEN_PROFILE_V1") {
      if (typeof o.target_individual_id !== "string") o.target_individual_id = "";
      if (!o.discovery || typeof o.discovery !== "object") o.discovery = {};
      if (!o.discovery.visibility_deltas || typeof o.discovery.visibility_deltas !== "object") o.discovery.visibility_deltas = { media: 0, law: 0, underground: 0 };
      if (!Array.isArray(o.discovery.new_aliases)) o.discovery.new_aliases = [];
      if (!Array.isArray(o.discovery.new_affiliations)) o.discovery.new_affiliations = [];
      if (!Array.isArray(o.discovery.new_crimes)) o.discovery.new_crimes = [];
      if (typeof o.intel_snippet !== "string") o.intel_snippet = "No additional intelligence.";
    } else if (schemaId === "WORLD_GEN_PSYOPS_V1") {
      if (!o.action || typeof o.action !== "object") o.action = { type: "propaganda", target: "", message: "", resources_spent: { money: 0, influence: 0 } };
      if (!o.deltas || typeof o.deltas !== "object") o.deltas = {};
      if (!o.effects || typeof o.effects !== "object") o.effects = {};
      if (!Array.isArray(o.effects.social_items)) o.effects.social_items = [];
      if (!o.effects.flags || typeof o.effects.flags !== "object") o.effects.flags = { backfire: false, new_leak_thread: false };
      if (typeof o.effects.news_item === "undefined") o.effects.news_item = null;
      if (typeof o.effects.investigator_brief === "undefined") o.effects.investigator_brief = null;
    }

    return { data: o, warnings: w };
  }

  function normalizeCause(cause) {
    const c = String(cause || "").toLowerCase();
    if (c.includes("card") || c.includes("heart")) return "cardiac";
    if (c.includes("accident") || c.includes("collision")) return "accident";
    if (c.includes("suicide")) return "suicide";
    if (c.includes("poison") || c.includes("toxin")) return "poison";
    if (c.includes("fall")) return "fall";
    if (c.includes("fire") || c.includes("burn")) return "fire";
    return "other";
  }

  function entropyFromCounts(mapObj) {
    const vals = Object.values(mapObj).filter((x) => x > 0);
    const total = vals.reduce((a, b) => a + b, 0);
    if (total <= 0 || vals.length <= 1) return 1;
    let h = 0;
    for (let i = 0; i < vals.length; i++) {
      const p = vals[i] / total;
      h -= p * Math.log2(p);
    }
    return clamp01(h / Math.log2(vals.length));
  }

  function timingBin(dt) {
    if (dt <= 0) return "0";
    if (dt === 1) return "1";
    if (dt === 2) return "2";
    if (dt <= 4) return "3-4";
    if (dt <= 7) return "5-7";
    if (dt <= 12) return "8-12";
    if (dt <= 20) return "13-20";
    return "21+";
  }

  function computePatternMetrics() {
    const records = state.killRecords.slice(-30);
    if (!records.length) {
      return { Hc: 1, Hg: 1, Ht: 1, R: 0.5, Sinf: 0, Sjust: 0, maxCauseShare: 0, avgPlaus: 1, avgPublicness: 0, PSS: 0 };
    }

    const causeCounts = { cardiac: 0, accident: 0, suicide: 0, poison: 0, fall: 0, fire: 0, other: 0 };
    const geoCounts = {};
    const timingCounts = { "0": 0, "1": 0, "2": 0, "3-4": 0, "5-7": 0, "8-12": 0, "13-20": 0, "21+": 0 };

    let sumInfluence = 0;
    let sumMorality = 0;
    let sumP = 0;
    let sumPub = 0;

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      causeCounts[r.causeTag] = (causeCounts[r.causeTag] || 0) + 1;
      geoCounts[r.geo_bucket] = (geoCounts[r.geo_bucket] || 0) + 1;
      sumInfluence += toFloat(r.victimInfluence, 4);
      sumMorality += toFloat(r.victimMorality, 5);
      sumP += toFloat(r.plausibility, 1);
      sumPub += toFloat(r.publicness, 0);
      if (i > 0) {
        const dt = Math.max(0, records[i].tMonthAbs - records[i - 1].tMonthAbs);
        timingCounts[timingBin(dt)] += 1;
      }
    }

    const Hc = entropyFromCounts(causeCounts);
    const Hg = entropyFromCounts(geoCounts);
    const Ht = entropyFromCounts(timingCounts);

    const dts = [];
    for (let i = 1; i < records.length; i++) dts.push(Math.max(0.0001, records[i].tMonthAbs - records[i - 1].tMonthAbs));
    let R = 0.5;
    if (dts.length > 1) {
      const mu = dts.reduce((a, b) => a + b, 0) / dts.length;
      let vv = 0;
      for (let i = 0; i < dts.length; i++) vv += (dts[i] - mu) * (dts[i] - mu);
      vv /= dts.length;
      const cv = Math.sqrt(vv) / Math.max(0.0001, mu);
      R = clamp01(1 - cv / 0.9);
    }

    const n = records.length;
    const Ibar = sumInfluence / n;
    const Mbar = sumMorality / n;
    const Pbar = sumP / n;
    const PubBar = sumPub / n;
    const Sinf = clamp01((Ibar - 4.0) / 6.0);
    const Sjust = clamp01((Mbar - 5.0) / 5.0);
    const maxCauseShare = Math.max(...Object.values(causeCounts)) / n;

    const PSS = clamp01((0.3 * (1 - Hc) + 0.2 * (1 - Hg) + 0.1 * (1 - Ht) + 0.15 * R + 0.1 * Sinf + 0.1 * maxCauseShare + 0.25 * (1 - Pbar)) / 1.4);

    return { Hc, Hg, Ht, R, Sinf, Sjust, maxCauseShare, avgPlaus: Pbar, avgPublicness: PubBar, PSS };
  }

  function computePressure() {
    if (!state.investigators.length) return 0;
    let sum = 0;
    for (let i = 0; i < state.investigators.length; i++) {
      const b = state.investigators[i].beliefs || {};
      sum += clamp01(0.5 * toFloat(b.alertness, 0) + 0.5 * toFloat(b.surveillance, 0));
    }
    return clamp01(sum / state.investigators.length);
  }

  function applySuspicionFromKill(record, modelDelta) {
    const m = computePatternMetrics();
    state.stats = { ...state.stats, ...m };
    const base = 2;
    const pattern = Math.round(18 * Math.pow(m.PSS, 1.2));
    const plaus = Math.round(10 * Math.pow(1 - m.avgPlaus, 1.6));
    const pub = Math.round(6 * Math.pow(record.publicness, 1.1));
    const disp = -Math.round(10 * m.Hg);
    const causeRel = -Math.round(8 * m.Hc);
    const irregRel = -Math.round(6 * (1 - m.R));
    let local = clamp(base + pattern + plaus + pub + disp + causeRel + irregRel, -8, 30);
    if (state.publicSupport > 40) local *= 0.85;
    if (state.publicSupport < -40) local *= 1.15;
    const pressure = computePressure();
    state.stats.pressure = pressure;
    local *= 1 + 0.35 * pressure;
    const boundedModel = clamp(toInt(modelDelta, 0), -6, 6);
    const finalDelta = clamp(Math.round(local) + boundedModel, -10, 35);
    state.suspicion = clamp(state.suspicion + finalDelta, 0, 100);
    return finalDelta;
  }

  function coolingNoKill() {
    const pressure = computePressure();
    state.stats.pressure = pressure;
    let cool = state.crackdownRisk > 70 || pressure > 0.65 ? 0 : state.crackdownRisk > 40 || pressure > 0.45 ? 1 : 2;
    state.suspicion = clamp(state.suspicion - cool, 0, 100);
    return cool;
  }

  function invStyleWeight(style) {
    if (style === "statistical") return 1.2;
    if (style === "behavioural") return 0.9;
    if (style === "authoritarian") return 1;
    return 0.8;
  }

  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  function logit(p) {
    const q = clamp(p, 0.001, 0.999);
    return Math.log(q / (1 - q));
  }

  function updateInvestigators(obs) {
    const ePattern = clamp((obs.PSS - 0.5) * 2, -1, 1);
    const eCause = clamp((obs.maxCauseShare - 0.35) * 2.2, -1, 1);
    const eGeo = clamp((0.65 - obs.Hg) * 2, -1, 1);
    const eRegular = clamp((obs.R - 0.5) * 2, -1, 1);
    const eInf = clamp((obs.Sinf - 0.4) * 2, -1, 1);
    const eMoral = clamp((obs.Sjust - 0.4) * 2, -1, 1);
    const ePlausLow = clamp((0.7 - obs.plausibilityAvg) * 2, -1, 1);
    const killFreqHigh = obs.killFrequencyRecent > 0.45 ? 1 : 0;
    const noKillStreakHigh = obs.noKillStreak > 3 ? 1 : 0;

    for (let i = 0; i < state.investigators.length; i++) {
      const inv = state.investigators[i];
      const w = invStyleWeight(inv.style);
      const sig = inv.beliefs.signature;

      const upd = (k, ev, factor = 0.32) => {
        const L = logit(toFloat(sig[k], 0.4)) + w * factor * ev;
        sig[k] = clamp01(sigmoid(L));
      };
      upd("pattern_driven", ePattern + 0.4 * eRegular);
      upd("cause_control", eCause + 0.25 * ePattern);
      upd("influence_seeking", eInf + 0.2 * eGeo);
      upd("moral_crusade", eMoral - 0.15 * eInf);

      const coh = 0.5 * sig.pattern_driven + 0.3 * sig.cause_control + 0.2 * (1 - obs.Hc);
      const chaos = 0.5 * obs.Hc + 0.3 * obs.Hg + 0.2 * (1 - obs.R);
      const ll = {
        single_actor: +1.0 * coh + 0.3 * eGeo + 0.2 * eRegular - 0.6 * chaos,
        group: +0.4 * coh + 0.6 * chaos + 0.2 * killFreqHigh - 0.2 * eRegular,
        copycats: +0.8 * chaos + 0.2 * (state.publicSupport > 50 ? 0.3 : 0) - 0.3 * coh,
        hoax: +0.8 * noKillStreakHigh - 0.8 * coh - 0.5 * ePlausLow
      };
      const eta = 0.5;
      const H = inv.beliefs.H;
      let z = 0;
      for (const k of Object.keys(H)) {
        H[k] = Math.max(0.0001, toFloat(H[k], 0.25) * Math.exp(eta * ll[k]));
        z += H[k];
      }
      for (const k of Object.keys(H)) H[k] /= z;

      const geo = inv.beliefs.geo;
      if (obs.killOccurred && obs.killGeoBucket) {
        const g = obs.killGeoBucket;
        const a = clamp01((0.8 - obs.Hg) / 0.8);
        for (let j = 0; j < GEO_BUCKETS.length; j++) {
          const x = GEO_BUCKETS[j];
          geo[x] = (geo[x] || 1 / GEO_BUCKETS.length) * Math.exp((x === g ? 1 : -0.15) * a);
        }
      } else {
        for (let j = 0; j < GEO_BUCKETS.length; j++) {
          const x = GEO_BUCKETS[j];
          geo[x] = (geo[x] || 1 / GEO_BUCKETS.length) * 0.98 + (1 / GEO_BUCKETS.length) * 0.02;
        }
      }
      let zg = 0;
      for (let j = 0; j < GEO_BUCKETS.length; j++) zg += geo[GEO_BUCKETS[j]];
      for (let j = 0; j < GEO_BUCKETS.length; j++) geo[GEO_BUCKETS[j]] /= zg;

      pickInvestigatorAction(inv);
      inv.focus_geo_bucket = Object.entries(inv.beliefs.geo).sort((a, b) => b[1] - a[1])[0][0];
      inv.current_hypotheses = Object.entries(H)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map((x) => x[0]);
    }

    state.stats.pressure = computePressure();
  }

  function pickInvestigatorAction(inv) {
    const b = inv.beliefs;
    const feasAuthoritarian = clamp01(0.5 - state.publicSupport / 200);
    const feasPsyops = clamp01(0.6 + Math.abs(state.publicSupport) / 200);
    const topGeo = Object.entries(b.geo).sort((a, c) => c[1] - a[1])[0];
    const topGeoP = topGeo ? topGeo[1] : 0.08;

    const scores = {
      pattern_tasking: 0.6 * b.alertness + 0.45 * b.signature.pattern_driven,
      regional_crackdown: 0.5 * b.surveillance + 0.4 * topGeoP + 0.3 * feasAuthoritarian,
      psyops: 0.45 * b.psyops + 0.3 * feasPsyops,
      leak_bait: 0.4 * b.resources + 0.4 * b.signature.pattern_driven,
      international_coordination: 0.35 * b.resources + 0.5 * b.alertness,
      quiet_watch: 0.4 * (1 - b.resources) + 0.25 * inv.credibility
    };
    const ordered = Object.entries(scores).sort((a, c) => c[1] - a[1]);
    const top = ordered.slice(0, 2);
    const choice = top[(state.rng() * top.length) | 0][0];
    inv.lastAction = choice;

    if (choice === "pattern_tasking") {
      b.alertness = clamp01(b.alertness + 0.05);
      b.resources = clamp01(b.resources + 0.02);
    } else if (choice === "regional_crackdown") {
      b.surveillance = clamp01(b.surveillance + 0.06);
      state.crackdownRisk = clamp(state.crackdownRisk + 2, 0, 100);
    } else if (choice === "psyops") {
      const shift = inv.style === "behavioural" ? 2 : 1;
      state.publicSupport = clamp(state.publicSupport + (state.publicSupport > 0 ? -shift : +1), -100, 100);
      b.psyops = clamp01(b.psyops + 0.04);
    } else if (choice === "leak_bait") {
      maybeSpawnDecoys(1 + ((state.rng() * 2) | 0));
      b.resources = clamp01(b.resources - 0.03);
    } else if (choice === "international_coordination") {
      b.surveillance = clamp01(b.surveillance + 0.04);
      b.alertness = clamp01(b.alertness + 0.03);
      state.crackdownRisk = clamp(state.crackdownRisk + 1, 0, 100);
    } else {
      inv.credibility = clamp01(inv.credibility + 0.03);
      b.resources = clamp01(b.resources + 0.04);
    }

    inv.logs.push({ monthAbs: state.monthAbs, action: choice });
    cap(inv.logs, 40);
  }

  function maybeSpawnDecoys(count) {
    for (let i = 0; i < count; i++) {
      const id = mkId("ind", state.rng);
      const countries = ["United Kingdom", "United States", "France", "Japan", "Brazil"];
      const country = countries[(state.rng() * countries.length) | 0];
      const p = {
        id,
        display_name: `Profile ${Math.floor(1000 + state.rng() * 9000)}`,
        real_name: "",
        real_name_verified: false,
        face_known: true,
        country,
        geo_bucket: geoOf(country),
        role: "Anonymous source",
        affiliations: ["Open intelligence thread"],
        influence: clamp(4 + state.rng() * 3, 0, 10),
        morality: clamp(4 + state.rng() * 2, 0, 10),
        headline_crimes: ["Unverified leak narrative"],
        evidence_quality: 0.25,
        visibility: { media: 0.9, law: 0.35, underground: 0.6 },
        flags: { protected: false, public_figure: true, masked_identity: false, uses_alias: true, bait: true },
        alive: true,
        createdMonthAbs: state.monthAbs,
        lastMentionMonthAbs: state.monthAbs,
        notes: ""
      };
      state.people.push(p);
      state.decoyIds.push(id);
    }
    cap(state.people, 200);
    cap(state.decoyIds, 30);
  }

  function mergeNewIndividuals(arr) {
    if (!Array.isArray(arr)) return;
    const idSet = new Set(state.people.map((p) => p.id));
    for (let i = 0; i < arr.length; i++) {
      const inx = arr[i] || {};
      let id = typeof inx.id === "string" ? inx.id : mkId("ind", state.rng);
      if (idSet.has(id)) id = mkId("ind", state.rng);
      const country = safeCountry(inx.country);
      const geo = GEO_BUCKETS.includes(inx.geo_bucket) ? inx.geo_bucket : geoOf(country);
      const p = {
        id,
        display_name: String(inx.display_name || "Unknown"),
        real_name: String(inx.real_name || ""),
        real_name_verified: !!inx.real_name_verified,
        face_known: !!inx.face_known,
        country,
        geo_bucket: geo,
        role: String(inx.role || "Unknown"),
        affiliations: Array.isArray(inx.affiliations) ? inx.affiliations.slice(0, 6).map((x) => String(x)) : [],
        influence: clamp(toFloat(inx.influence, 4), 0, 10),
        morality: clamp(toFloat(inx.morality, 5), 0, 10),
        headline_crimes: Array.isArray(inx.headline_crimes) ? inx.headline_crimes.slice(0, 8).map((x) => String(x)) : [],
        evidence_quality: clamp01(toFloat(inx.evidence_quality, 0.4)),
        visibility: {
          media: clamp01(toFloat(inx.visibility && inx.visibility.media, 0.4)),
          law: clamp01(toFloat(inx.visibility && inx.visibility.law, 0.4)),
          underground: clamp01(toFloat(inx.visibility && inx.visibility.underground, 0.4))
        },
        flags: {
          protected: !!(inx.flags && inx.flags.protected),
          public_figure: !!(inx.flags && inx.flags.public_figure),
          masked_identity: !!(inx.flags && inx.flags.masked_identity),
          uses_alias: !!(inx.flags && inx.flags.uses_alias),
          bait: !!(inx.flags && inx.flags.bait)
        },
        alive: true,
        createdMonthAbs: state.monthAbs,
        lastMentionMonthAbs: state.monthAbs,
        notes: String(inx.notes || "")
      };
      state.people.push(p);
      idSet.add(id);
    }
    cap(state.people, 220);
  }

  function applyUpdatesIndividuals(updates) {
    if (!Array.isArray(updates)) return;
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i] || {};
      if (!u.id) continue;
      const p = state.people.find((x) => x.id === u.id);
      if (!p) continue;
      if (typeof u.display_name === "string") p.display_name = u.display_name;
      if (typeof u.real_name === "string") p.real_name = u.real_name;
      if (typeof u.real_name_verified === "boolean") p.real_name_verified = u.real_name_verified;
      if (typeof u.face_known === "boolean") p.face_known = u.face_known;
      if (typeof u.country === "string") {
        p.country = safeCountry(u.country);
        p.geo_bucket = geoOf(p.country);
      }
      if (typeof u.geo_bucket === "string" && GEO_BUCKETS.includes(u.geo_bucket)) p.geo_bucket = u.geo_bucket;
      if (typeof u.role === "string") p.role = u.role;
      if (Array.isArray(u.affiliations)) p.affiliations = u.affiliations.slice(0, 8).map((x) => String(x));
      if (Array.isArray(u.headline_crimes)) p.headline_crimes = u.headline_crimes.slice(0, 10).map((x) => String(x));
      if (u.visibility && typeof u.visibility === "object") {
        p.visibility.media = clamp01(toFloat(u.visibility.media, p.visibility.media));
        p.visibility.law = clamp01(toFloat(u.visibility.law, p.visibility.law));
        p.visibility.underground = clamp01(toFloat(u.visibility.underground, p.visibility.underground));
      }
      if (typeof u.evidence_quality !== "undefined") p.evidence_quality = clamp01(toFloat(u.evidence_quality, p.evidence_quality));
      if (typeof u.influence !== "undefined") p.influence = clamp(toFloat(u.influence, p.influence), 0, 10);
      if (typeof u.morality !== "undefined") p.morality = clamp(toFloat(u.morality, p.morality), 0, 10);
      if (typeof u.alive === "boolean") p.alive = u.alive;
      p.lastMentionMonthAbs = state.monthAbs;
    }
  }

  function pushFeedItems(kind, arr) {
    if (!Array.isArray(arr)) return;
    if (kind === "news") {
      for (let i = 0; i < arr.length; i++) {
        const x = arr[i] || {};
        state.news_feed.push({
          id: String(x.id || mkId("news", state.rng)),
          monthAbs: state.monthAbs,
          headline: String(x.headline || "Brief"),
          country: safeCountry(x.country),
          geo_bucket: GEO_BUCKETS.includes(x.geo_bucket) ? x.geo_bucket : geoOf(safeCountry(x.country)),
          blurb: String(x.blurb || ""),
          tags: Array.isArray(x.tags) ? x.tags.slice(0, 6).map((k) => String(k)) : [],
          mentions: Array.isArray(x.mentions) ? x.mentions.slice(0, 6).map((k) => String(k)) : []
        });
      }
      cap(state.news_feed, 120);
    } else if (kind === "social") {
      for (let i = 0; i < arr.length; i++) {
        const x = arr[i] || {};
        state.social_feed.push({
          id: String(x.id || mkId("soc", state.rng)),
          monthAbs: state.monthAbs,
          platform: String(x.platform || "Pulse"),
          trend: String(x.trend || "#signal"),
          country: safeCountry(x.country),
          geo_bucket: GEO_BUCKETS.includes(x.geo_bucket) ? x.geo_bucket : geoOf(safeCountry(x.country)),
          posts: Array.isArray(x.posts) ? x.posts.slice(0, 4).map((k) => String(k).slice(0, 180)) : []
        });
      }
      cap(state.social_feed, 120);
    } else if (kind === "crimes") {
      for (let i = 0; i < arr.length; i++) {
        const x = arr[i] || {};
        state.crimes.push({
          id: String(x.id || mkId("crime", state.rng)),
          monthAbs: state.monthAbs,
          type: String(x.type || "Incident"),
          severity: clamp(toInt(x.severity, 4), 1, 10),
          country: safeCountry(x.country),
          geo_bucket: GEO_BUCKETS.includes(x.geo_bucket) ? x.geo_bucket : geoOf(safeCountry(x.country)),
          summary: String(x.summary || ""),
          refs: Array.isArray(x.refs) ? x.refs.slice(0, 6).map((k) => String(k)) : []
        });
      }
      cap(state.crimes, 120);
    } else if (kind === "events") {
      for (let i = 0; i < arr.length; i++) {
        const x = arr[i] || {};
        state.world_events.push({
          id: String(x.id || mkId("evt", state.rng)),
          monthAbs: state.monthAbs,
          title: String(x.title || "World event"),
          country: safeCountry(x.country),
          geo_bucket: GEO_BUCKETS.includes(x.geo_bucket) ? x.geo_bucket : geoOf(safeCountry(x.country)),
          summary: String(x.summary || "")
        });
      }
      cap(state.world_events, 120);
    }
  }

  function boundedDelta(k, val) {
    const table = {
      public_support_delta: [-30, 30],
      suspicion_delta: [-30, 30],
      investigator_alertness_delta: [-20, 20],
      copycat_activity_delta: [-10, 10],
      crackdown_risk_delta: [-15, 15]
    };
    const r = table[k] || [-20, 20];
    return clamp(toInt(val, 0), r[0], r[1]);
  }

  function applyMonthlyTick(obj) {
    mergeNewIndividuals(obj.new_individuals);
    applyUpdatesIndividuals(obj.updated_individuals);
    pushFeedItems("crimes", obj.crime_events);
    pushFeedItems("events", obj.world_events);
    pushFeedItems("news", obj.news_feed);
    pushFeedItems("social", obj.social_feed);

    state.publicSupport = clamp(state.publicSupport + clamp(toInt(obj.month_deltas && obj.month_deltas.public_support_delta, 0), -20, 20), -100, 100);
    state.crackdownRisk = clamp(state.crackdownRisk + clamp(toInt(obj.month_deltas && obj.month_deltas.crackdown_risk_delta, 0), -15, 15), 0, 100);

    const cooldown = coolingNoKill();
    addChat("system", `Month advanced to ${fmtMonth(state)}. Suspicion cooling ${cooldown > 0 ? `-${cooldown}` : "0"}.`, {
      notes: String(obj.notes_for_player || "No additional notes.")
    });

    monthStep();
    updateInvestigators({
      killOccurred: false,
      PSS: state.stats.PSS,
      Hc: state.stats.Hc,
      Hg: state.stats.Hg,
      Ht: state.stats.Ht,
      R: state.stats.R,
      maxCauseShare: state.stats.maxCauseShare,
      Sinf: state.stats.Sinf,
      Sjust: state.stats.Sjust,
      plausibilityAvg: state.stats.avgPlaus,
      killGeoBucket: "",
      publicSupport: state.publicSupport,
      killFrequencyRecent: state.killRecords.slice(-6).length / 6,
      noKillStreak: 1
    });
    checkEndStates();
  }

  function applyDeathResult(obj, action) {
    const victim = findPerson(action.victimId);
    const death = obj.death || {};
    const deltas = obj.deltas || {};
    const effects = obj.effects || {};

    if (victim) victim.alive = false;
    const record = {
      tMonthAbs: state.monthAbs,
      country: safeCountry(death.country || (victim ? victim.country : "Other")),
      geo_bucket: GEO_BUCKETS.includes(death.geo_bucket) ? death.geo_bucket : geoOf(safeCountry(death.country || (victim ? victim.country : "Other"))),
      causeTag: normalizeCause(death.cause || action.cause),
      victimInfluence: victim ? victim.influence : 5,
      victimMorality: victim ? victim.morality : 5,
      publicness: clamp01(toFloat(death.publicness, 0.4)),
      plausibility: clamp01(toFloat(death.plausibility, 0.6))
    };
    state.killRecords.push(record);
    cap(state.killRecords, 200);

    const sDelta = applySuspicionFromKill(record, boundedDelta("suspicion_delta", deltas.suspicion_delta));
    state.publicSupport = clamp(state.publicSupport + boundedDelta("public_support_delta", deltas.public_support_delta), -100, 100);
    state.crackdownRisk = clamp(state.crackdownRisk + boundedDelta("crackdown_risk_delta", deltas.crackdown_risk_delta), 0, 100);

    pushFeedItems("news", effects.news_item ? [effects.news_item] : []);
    pushFeedItems("social", effects.social_items || []);
    pushFeedItems("events", effects.secondary_events || []);

    const brief = effects.investigator_brief;
    if (brief) {
      addChat("left", brief.summary || "Investigator brief updated.", brief);
    }

    addChat("system", `Death Note action resolved. Suspicion ${sDelta >= 0 ? "+" : ""}${sDelta}.`, {
      deltas: {
        suspicion: sDelta,
        publicSupport: boundedDelta("public_support_delta", deltas.public_support_delta),
        crackdown: boundedDelta("crackdown_risk_delta", deltas.crackdown_risk_delta)
      }
    });

    updateInvestigators({
      killOccurred: true,
      PSS: state.stats.PSS,
      Hc: state.stats.Hc,
      Hg: state.stats.Hg,
      Ht: state.stats.Ht,
      R: state.stats.R,
      maxCauseShare: state.stats.maxCauseShare,
      Sinf: state.stats.Sinf,
      Sjust: state.stats.Sjust,
      plausibilityAvg: state.stats.avgPlaus,
      killGeoBucket: record.geo_bucket,
      publicSupport: state.publicSupport,
      killFrequencyRecent: state.killRecords.slice(-6).length / 6,
      noKillStreak: 0
    });

    checkEndStates();
  }

  function applyIntelResult(obj) {
    const target = findPerson(obj.target_individual_id);
    const d = obj.discovery || {};
    if (target) {
      target.face_known = toInt(d.face_known_delta, 0) > 0 ? true : target.face_known;
      target.real_name_verified = toInt(d.real_name_verified_delta, 0) > 0 ? true : target.real_name_verified;
      if (!target.real_name && target.real_name_verified) target.real_name = `${target.display_name} (verified)`;
      if (Array.isArray(d.new_aliases) && d.new_aliases.length) target.affiliations = [...target.affiliations, ...d.new_aliases.slice(0, 2)];
      if (Array.isArray(d.new_affiliations) && d.new_affiliations.length) target.affiliations = [...target.affiliations, ...d.new_affiliations.slice(0, 3)];
      if (Array.isArray(d.new_crimes) && d.new_crimes.length) target.headline_crimes = [...target.headline_crimes, ...d.new_crimes.slice(0, 3)];
      target.evidence_quality = clamp01(target.evidence_quality + clamp(toFloat(d.evidence_quality_delta, 0), -0.3, 0.3));
      if (d.visibility_deltas) {
        target.visibility.media = clamp01(target.visibility.media + clamp(toFloat(d.visibility_deltas.media, 0), -0.3, 0.3));
        target.visibility.law = clamp01(target.visibility.law + clamp(toFloat(d.visibility_deltas.law, 0), -0.3, 0.3));
        target.visibility.underground = clamp01(target.visibility.underground + clamp(toFloat(d.visibility_deltas.underground, 0), -0.3, 0.3));
      }
    }
    state.influence = clamp(state.influence - 3, 0, 100);
    addChat("left", (obj.intel_snippet || "Intel review complete.").slice(0, 420), { discovery: d });
  }

  function applyPsyopsResult(obj) {
    const d = obj.deltas || {};
    state.publicSupport = clamp(state.publicSupport + boundedDelta("public_support_delta", d.public_support_delta), -100, 100);
    state.suspicion = clamp(state.suspicion + clamp(boundedDelta("suspicion_delta", d.suspicion_delta), -6, 6), 0, 100);
    state.crackdownRisk = clamp(state.crackdownRisk + boundedDelta("crackdown_risk_delta", d.crackdown_risk_delta), 0, 100);
    pushFeedItems("social", obj.effects && obj.effects.social_items);
    if (obj.effects && obj.effects.news_item) pushFeedItems("news", [obj.effects.news_item]);
    if (obj.effects && obj.effects.investigator_brief) addChat("left", obj.effects.investigator_brief.summary || "Investigator response updated.", obj.effects.investigator_brief);
    addChat("system", "Social action resolved.", { deltas: d, flags: obj.effects ? obj.effects.flags : {} });
  }

  function checkEndStates() {
    if (state.suspicion >= 100) addChat("system", "End state: identified and captured.", null);
    if (state.lifespanMonths <= 0) addChat("system", "End state: lifespan depleted.", null);
    if (state.crackdownRisk >= 100) addChat("system", "End state: global clampdown in force.", null);
    if (state.monthAbs >= 120 && state.publicSupport > 30 && state.suspicion < 60 && state.crackdownRisk < 70) {
      addChat("system", "Victory condition met: enduring order established.", null);
    }
  }

  async function runSchemaCall(schemaId, actionPayload, applyFn) {
    if (state.inFlight) return;
    const messages = buildMessages(schemaId, actionPayload);
    state.lastRetry = { schemaId, actionPayload };
    try {
      const raw = await callOpenRouter(messages);
      const parsed = parseStrictJson(raw);
      if (!parsed.ok) {
        state.errorBanner = parsed.error;
        addChat("system", "Parsing failure. Use Retry Last LLM Call.", null);
        updateAll();
        return;
      }
      const checked = validateSchema(schemaId, parsed.data);
      state.parseWarning = checked.warnings.join("; ");
      applyFn(checked.data);
      updateAll();
      saveNow();
    } catch (err) {
      state.errorBanner = String(err && err.message ? err.message : err);
      addChat("system", `Network/model error: ${state.errorBanner.slice(0, 240)}`, null);
      updateAll();
    }
  }

  async function doAdvanceMonth(triggerSource = "manual") {
    if (state.actionsLeft > 0 && triggerSource === "manual") {
      addChat("system", "No action used this month. Advancing as stand down.", null);
    }
    await runSchemaCall("WORLD_GEN_MONTHLY_V1", { type: "stand_down", source: triggerSource }, applyMonthlyTick);
  }

  function deathValidation(target, nameWritten) {
    const hasFace = !!(target && target.face_known);
    const verified = !!(target && target.real_name_verified);
    const viaEyes = !!state.eyeDealActive;
    const canProceed = hasFace && (verified || viaEyes);
    const warning = canProceed ? "" : "Requires known face and verified real name, unless Eye Deal active.";
    return { hasFace, verified, viaEyes, canProceed, warning };
  }

  async function performDeathAction(payload) {
    if (state.actionsLeft < 1) {
      addChat("system", "Action already consumed this month.", null);
      return;
    }
    const victim = findPerson(payload.victimId);
    if (!victim) {
      addChat("system", "Invalid victim selection.", null);
      return;
    }
    const val = deathValidation(victim, payload.nameWritten);
    if (!val.canProceed) {
      const isDecoy = !!victim.flags.bait || state.decoyIds.includes(victim.id);
      if (isDecoy) {
        const spike = state.eyeDealActive ? 14 : 23;
        if (state.eyeDealActive) {
          victim.alive = false;
          state.killRecords.push({
            tMonthAbs: state.monthAbs,
            country: victim.country,
            geo_bucket: victim.geo_bucket,
            causeTag: normalizeCause(payload.cause),
            victimInfluence: victim.influence,
            victimMorality: victim.morality,
            publicness: 0.92,
            plausibility: 0.3
          });
          cap(state.killRecords, 200);
        }
        state.suspicion = clamp(state.suspicion + spike, 0, 100);
        addChat("system", `Trap profile triggered. Suspicion +${spike}.`, null);
      } else {
        addChat("system", val.warning, null);
      }
      updateAll();
      return;
    }
    if (!window.confirm("Execute Death Note action for this month?")) return;

    state.actionsLeft = 0;
    addChat("right", `Death Note: ${victim.display_name} / ${payload.cause}`);

    await runSchemaCall("WORLD_GEN_DEATH_V1", {
      type: "death_note",
      victim_id: victim.id,
      name_written: payload.nameWritten,
      cause: payload.cause,
      conditions: payload.conditions
    }, (obj) => applyDeathResult(obj, payload));

    if (state.autoAdvanceAfterAction && !state.inFlight) await doAdvanceMonth("auto-after-action");
  }

  async function performIntelAction(targetId, text) {
    if (state.actionsLeft < 1) {
      addChat("system", "Action already consumed this month.", null);
      return;
    }
    if (!targetId) return;
    state.actionsLeft = 0;
    state.influence = clamp(state.influence - 2, 0, 100);
    addChat("right", `Intel request: ${text.slice(0, 180)}`);

    await runSchemaCall("WORLD_GEN_PROFILE_V1", {
      type: "intel",
      target_individual_id: targetId,
      request_text: text.slice(0, 500)
    }, applyIntelResult);

    if (state.autoAdvanceAfterAction && !state.inFlight) await doAdvanceMonth("auto-after-action");
  }

  async function performPsyopsAction(kind, text, target) {
    if (state.actionsLeft < 1) {
      addChat("system", "Action already consumed this month.", null);
      return;
    }
    const costMoney = 15000;
    const costInfluence = 8;
    if (state.money < costMoney || state.influence < costInfluence) {
      addChat("system", "Insufficient money/influence for social action.", null);
      return;
    }
    state.actionsLeft = 0;
    state.money -= costMoney;
    state.influence = clamp(state.influence - costInfluence, 0, 100);
    addChat("right", `Social action (${kind}): ${text.slice(0, 180)}`);

    await runSchemaCall("WORLD_GEN_PSYOPS_V1", {
      type: "psyops",
      action: {
        type: kind,
        target: target || "public",
        message: text.slice(0, 500),
        resources_spent: { money: costMoney, influence: costInfluence }
      }
    }, applyPsyopsResult);

    if (state.autoAdvanceAfterAction && !state.inFlight) await doAdvanceMonth("auto-after-action");
  }

  let ui = null;

  function make(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (typeof text === "string") e.textContent = text;
    return e;
  }

  function renderBars(m, val, min, max) {
    const pct = clamp01((val - min) / (max - min));
    m.style.width = `${(pct * 100).toFixed(1)}%`;
  }

  function buildUI() {
    if (!uiRoot) return;
    uiRoot.innerHTML = "";

    const style = make("style");
    style.textContent = `
    .kira-wrap{position:absolute;inset:0;color:#eaeef4;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;background:transparent;display:flex;flex-direction:column;overflow:hidden}
    .kira-top{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid #1b1e28;background:rgba(0,0,0,.8);z-index:3}
    .kira-title{font-weight:700;color:#49dfff;letter-spacing:.4px}
    .kira-center{text-align:center;font-size:12px;opacity:.92}
    .kira-right{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
    .pill{border:1px solid #2c3340;border-radius:999px;padding:2px 8px;font-size:11px;background:#0a0c12}
    .meter{width:90px;height:8px;background:#111;border-radius:4px;overflow:hidden;border:1px solid #2f3542;display:inline-block;vertical-align:middle;margin-left:5px}
    .fill{height:100%}
    .main{display:grid;grid-template-columns:1.2fr 1fr 1.2fr;gap:10px;min-height:0;flex:1;padding:10px}
    .col{min-height:0;display:flex;flex-direction:column;gap:8px}
    .panel{background:rgba(0,0,0,.76);border:1px solid #202737;border-radius:10px;padding:8px;min-height:0;box-shadow:0 0 10px rgba(73,223,255,.08)}
    .panel h3{margin:0 0 6px 0;font-size:12px;color:#b6c8df}
    .tabs{display:flex;gap:4px;flex-wrap:wrap}
    .tabs button,.btn{background:#080a0f;border:1px solid #2b3240;color:#d9e3f2;border-radius:8px;padding:5px 8px;font-size:12px;cursor:pointer}
    .tabs button.active{border-color:#49dfff;color:#49dfff}
    .btn.red{border-color:#ff3b3b;color:#ff7d7d}
    .btn.mag{border-color:#ff3bd4;color:#ffa9ef}
    .btn:disabled{opacity:.45;cursor:not-allowed}
    .list{overflow:auto;min-height:0;display:flex;flex-direction:column;gap:6px}
    .card{border:1px solid #222a37;border-radius:8px;padding:6px;background:#05070b}
    .muted{opacity:.75;font-size:11px}
    .person{display:flex;justify-content:space-between;gap:8px;align-items:center}
    .person.active{outline:1px solid #49dfff}
    .chip{border:1px solid #343c4a;border-radius:999px;padding:1px 6px;font-size:10px}
    .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    .inp,.txt,select{width:100%;background:#04060a;color:#e4ecf9;border:1px solid #2a3140;border-radius:8px;padding:6px;font-family:inherit;font-size:12px}
    .txt{resize:vertical;min-height:60px}
    .chat{overflow:auto;min-height:0;display:flex;flex-direction:column;gap:6px;padding-right:4px}
    .msg{max-width:90%;padding:6px 8px;border-radius:10px;border:1px solid #283142;background:#091019;font-size:12px;white-space:pre-wrap}
    .msg.r{align-self:flex-end;border-color:#3c2a56;background:#160b1a}
    .msg.s{align-self:center;border-color:#323744;background:#101318;color:#c8ced9}
    .foot{display:grid;grid-template-columns:1fr auto;gap:6px}
    details{font-size:11px;opacity:.9}
    .error{border:1px solid #663333;background:#180d0d;color:#ff9d9d;padding:6px;border-radius:8px;font-size:12px}
    .modal{position:absolute;inset:0;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;z-index:4}
    .modal.open{display:flex}
    .modalCard{width:min(680px,92vw);max-height:88vh;overflow:auto;background:#06070b;border:1px solid #5a2020;border-radius:10px;padding:10px;box-shadow:0 0 20px rgba(255,59,59,.25)}
    @media (max-width:1060px){.main{grid-template-columns:1fr}.kira-top{grid-template-columns:1fr}.kira-center{text-align:left}.kira-right{justify-content:flex-start}}
    `;

    const wrap = make("div", "kira-wrap");
    const top = make("div", "kira-top");
    const tLeft = make("div", "kira-title", "KIRA: Algorithm of Judgement");
    const tCenter = make("div", "kira-center");
    const tRight = make("div", "kira-right");

    const mSusp = make("span", "pill");
    mSusp.innerHTML = `S <span class='meter'><span class='fill' style='background:#ff3b3b'></span></span>`;
    const mSup = make("span", "pill");
    mSup.innerHTML = `PS <span class='meter'><span class='fill' style='background:#49dfff'></span></span>`;
    const mCrk = make("span", "pill");
    mCrk.innerHTML = `C <span class='meter'><span class='fill' style='background:#9b5cff'></span></span>`;
    const mLife = make("span", "pill");
    const mEye = make("span", "pill");
    const mSave = make("span", "pill");
    tRight.append(mSusp, mSup, mCrk, mLife, mEye, mSave);
    top.append(tLeft, tCenter, tRight);

    const main = make("div", "main");

    const left = make("div", "col");
    const feedPanel = make("div", "panel");
    const tabs = make("div", "tabs");
    const tabButtons = {};
    ["news", "social", "crimes", "events"].forEach((k) => {
      const b = make("button", "", k === "events" ? "World Events" : k[0].toUpperCase() + k.slice(1));
      b.onclick = () => {
        state.selectedTab = k;
        updateFeeds();
      };
      tabs.appendChild(b);
      tabButtons[k] = b;
    });
    const feedList = make("div", "list");
    feedPanel.append(make("h3", "", "World Feed"), tabs, feedList);
    left.appendChild(feedPanel);

    const mid = make("div", "col");
    const peoplePanel = make("div", "panel");
    peoplePanel.appendChild(make("h3", "", "People of Interest"));
    const search = make("input", "inp");
    search.placeholder = "Filter by name/country/role";
    search.oninput = () => {
      state.searchQuery = search.value || "";
      updatePeople();
    };
    const peopleList = make("div", "list");
    const dossier = make("div", "card");
    const watch = make("div", "card");
    peoplePanel.append(search, peopleList, dossier, watch);
    mid.appendChild(peoplePanel);

    const right = make("div", "col");
    const chatPanel = make("div", "panel");
    const rowTop = make("div", "row");
    const channelSel = make("select");
    [
      ["taskforce", "Task Force Feed"],
      ["shinigami", "Shinigami"]
    ].forEach((r) => {
      const o = document.createElement("option");
      o.value = r[0];
      o.textContent = r[1];
      channelSel.appendChild(o);
    });
    channelSel.onchange = () => (state.chatChannel = channelSel.value);
    rowTop.appendChild(channelSel);
    const chatList = make("div", "chat");
    const input = make("textarea", "txt");
    input.placeholder = "Write request (intel or social). Ctrl+Enter to send.";

    const buttons = make("div", "row");
    const btnSendIntel = make("button", "btn", "Send (Intel)");
    const btnSendSocial = make("button", "btn mag", "Send (Diplomacy/Social)");
    const btnDeath = make("button", "btn red", "Death Note");
    const btnAdvance = make("button", "btn", "Advance Month");
    const btnRetry = make("button", "btn", "Retry Last LLM Call");
    buttons.append(btnSendIntel, btnSendSocial, btnDeath, btnAdvance, btnRetry);

    const error = make("div", "error");
    error.style.display = "none";

    const debug = make("details", "");
    const sm = make("summary", "", "Settings / Debug");
    const modelSel = make("select", "");
    WORLD_MODELS.forEach((m) => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      modelSel.appendChild(o);
    });
    modelSel.onchange = () => (state.settings.worldModel = modelSel.value);
    const strictChk = make("input"); strictChk.type = "checkbox"; strictChk.checked = state.strictExtraction;
    strictChk.onchange = () => (state.strictExtraction = !!strictChk.checked);
    const autoChk = make("input"); autoChk.type = "checkbox"; autoChk.checked = state.autoAdvanceAfterAction;
    autoChk.onchange = () => (state.autoAdvanceAfterAction = !!autoChk.checked);
    const dbgChk = make("input"); dbgChk.type = "checkbox"; dbgChk.checked = state.debug;
    dbgChk.onchange = () => (state.debug = !!dbgChk.checked);

    const exportBtn = make("button", "btn", "Export Save");
    const importBtn = make("button", "btn", "Import Save");
    const resetBtn = make("button", "btn red", "Hard Reset");
    const eyeBtn = make("button", "btn red", "Accept Eye Deal");
    const dumpReq = make("details", ""); dumpReq.innerHTML = "<summary>Last request payload</summary><pre></pre>";
    const dumpRes = make("details", ""); dumpRes.innerHTML = "<summary>Last raw response</summary><pre></pre>";

    exportBtn.onclick = async () => {
      try {
        const copy = { ...state };
        delete copy.rng;
        delete copy.abortController;
        const data = b64EncodeUtf8(JSON.stringify(copy));
        await navigator.clipboard.writeText(data);
        addChat("system", "Save exported to clipboard.", null);
      } catch {
        addChat("system", "Export failed.", null);
      }
      updateAll();
    };
    importBtn.onclick = () => {
      const s = window.prompt("Paste base64 save:", "");
      if (!s) return;
      try {
        const parsed = JSON.parse(b64DecodeUtf8(s));
        const loaded = upgradeLoadedState(parsed);
        for (const k of Object.keys(state)) delete state[k];
        Object.assign(state, loaded);
        state.rng = mulberry32(state.seed >>> 0);
        addChat("system", "Save imported.", null);
        saveNow();
        updateAll();
      } catch {
        state.errorBanner = "Import parse failed";
        updateAll();
      }
    };
    resetBtn.onclick = () => {
      if (!window.confirm("Hard reset all progress?")) return;
      const fresh = initialState();
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, fresh);
      state.rng = mulberry32(state.seed >>> 0);
      saveNow();
      updateAll();
    };
    eyeBtn.onclick = () => {
      if (state.eyeDealActive) return;
      if (!window.confirm("Eye Deal halves remaining lifespan immediately.")) return;
      state.eyeDealActive = true;
      state.lifespanMonths = Math.floor(state.lifespanMonths * 0.5);
      addChat("system", "Eye Deal accepted.", null);
      updateAll();
      saveNow();
    };

    const dbgWrap = make("div", "");
    dbgWrap.innerHTML = "<div class='row muted'></div>";
    dbgWrap.firstChild.append(
      document.createTextNode(`OpenRouter key: ${OR_KEY ? "present" : "missing"}`),
      document.createTextNode(" | model: "),
      modelSel,
      document.createTextNode(" strict extraction "),
      strictChk,
      document.createTextNode(" auto-advance "),
      autoChk,
      document.createTextNode(" debug "),
      dbgChk
    );

    const actionsRow = make("div", "row");
    actionsRow.append(exportBtn, importBtn, eyeBtn, resetBtn);
    debug.append(sm, dbgWrap, actionsRow, dumpReq, dumpRes);

    chatPanel.append(make("h3", "", "Actions & Transcript"), rowTop, chatList, input, buttons, error, debug);
    right.appendChild(chatPanel);

    main.append(left, mid, right);

    const modal = make("div", "modal");
    const modalCard = make("div", "modalCard");
    modalCard.appendChild(make("h3", "", "DEATH NOTE"));
    const victimSel = make("select");
    const nameInput = make("input", "inp"); nameInput.placeholder = "Name line";
    const causeInput = make("input", "inp"); causeInput.placeholder = "Cause of death";
    const condInput = make("textarea", "txt"); condInput.placeholder = "Conditions (optional)";
    const valBox = make("div", "card");
    const resultBox = make("div", "card");
    const closeBtn = make("button", "btn", "Close");
    const execBtn = make("button", "btn red", "Execute");
    const rowM = make("div", "row"); rowM.append(execBtn, closeBtn);
    modalCard.append(victimSel, nameInput, causeInput, condInput, valBox, resultBox, rowM);
    modal.appendChild(modalCard);

    wrap.append(top, main, modal);
    uiRoot.append(style, wrap);

    const sendFromInput = (mode) => {
      const target = state.selectedPersonId;
      const txt = (input.value || "").trim();
      if (!txt) return;
      if (mode === "intel") performIntelAction(target, txt);
      else performPsyopsAction("propaganda", txt, target || "public");
      input.value = "";
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        sendFromInput("intel");
      }
    });

    btnSendIntel.onclick = () => sendFromInput("intel");
    btnSendSocial.onclick = () => sendFromInput("social");
    btnAdvance.onclick = () => doAdvanceMonth("button");
    btnRetry.onclick = async () => {
      if (!state.lastRetry) return;
      await runSchemaCall(state.lastRetry.schemaId, state.lastRetry.actionPayload, (obj) => {
        if (state.lastRetry.schemaId === "WORLD_GEN_MONTHLY_V1") applyMonthlyTick(obj);
        if (state.lastRetry.schemaId === "WORLD_GEN_DEATH_V1") applyDeathResult(obj, { victimId: obj.victim_id, cause: obj.death && obj.death.cause });
        if (state.lastRetry.schemaId === "WORLD_GEN_PROFILE_V1") applyIntelResult(obj);
        if (state.lastRetry.schemaId === "WORLD_GEN_PSYOPS_V1") applyPsyopsResult(obj);
      });
    };

    btnDeath.onclick = () => {
      modal.classList.add("open");
      refreshDeathModal();
    };
    closeBtn.onclick = () => modal.classList.remove("open");
    victimSel.onchange = () => {
      const p = findPerson(victimSel.value);
      if (p) {
        state.selectedPersonId = p.id;
        nameInput.value = p.real_name_verified ? p.real_name || p.display_name : p.display_name;
      }
      refreshDeathModal();
      updatePeople();
      updateDossier();
    };
    execBtn.onclick = async () => {
      await performDeathAction({
        victimId: victimSel.value,
        nameWritten: (nameInput.value || "").trim(),
        cause: (causeInput.value || "Unspecified sudden collapse").trim(),
        conditions: (condInput.value || "").trim()
      });
      refreshDeathModal();
    };

    function refreshDeathModal() {
      victimSel.innerHTML = "";
      const alive = state.people.filter((p) => p.alive !== false).slice(0, 140);
      alive.forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = `${p.display_name} (${p.country})`;
        if (p.id === state.selectedPersonId) o.selected = true;
        victimSel.appendChild(o);
      });
      const target = findPerson(victimSel.value || state.selectedPersonId);
      if (target && !nameInput.value) nameInput.value = target.real_name_verified ? target.real_name || target.display_name : target.display_name;
      const val = deathValidation(target, nameInput.value || "");
      valBox.innerHTML = `<div class='muted'>Face known: ${val.hasFace ? "yes" : "no"} | Name verified: ${val.verified ? "yes" : "no"} | Eye Deal: ${val.viaEyes ? "active" : "off"}</div>
      <div>${val.warning || "Validation passed."}</div>
      <div class='muted'>Plausibility hint: ${target ? (target.visibility.media > 0.7 ? "high visibility target; public reaction likely" : "lower visibility target; quieter fallout") : "n/a"}</div>`;
      resultBox.textContent = "Result will appear in transcript and feeds after execution.";
    }

    ui = {
      tCenter,
      mSusp: mSusp.querySelector(".fill"),
      mSup: mSup.querySelector(".fill"),
      mCrk: mCrk.querySelector(".fill"),
      mLife,
      mEye,
      mSave,
      tabButtons,
      feedList,
      search,
      peopleList,
      dossier,
      watch,
      chatList,
      input,
      btnSendIntel,
      btnSendSocial,
      btnDeath,
      btnAdvance,
      btnRetry,
      error,
      modelSel,
      strictChk,
      autoChk,
      dbgChk,
      dumpReqPre: dumpReq.querySelector("pre"),
      dumpResPre: dumpRes.querySelector("pre"),
      channelSel,
      modal,
      refreshDeathModal
    };

    updateAll();

    if (state.awayReport) {
      addChat(
        "system",
        `While you were away: suspicion cooling -${state.awayReport.cool}, +£${state.awayReport.moneyGain.toLocaleString()}, +${state.awayReport.inflGain} influence.`,
        null
      );
      state.awayReport = null;
      updateChat();
    }
  }

  function updateTopBar() {
    if (!ui) return;
    ui.tCenter.textContent = `${fmtMonth(state)}  | actions ${state.actionsLeft} | £${Math.round(state.money).toLocaleString()} | influence ${state.influence}`;
    renderBars(ui.mSusp, state.suspicion, 0, 100);
    renderBars(ui.mSup, state.publicSupport, -100, 100);
    ui.mSup.style.background = state.publicSupport >= 0 ? "#49dfff" : "#ff3bd4";
    renderBars(ui.mCrk, state.crackdownRisk, 0, 100);
    ui.mLife.textContent = `Life ${state.lifespanMonths}m`;
    ui.mEye.textContent = state.eyeDealActive ? "Eye Deal: ON" : "Eye Deal: OFF";
    ui.mEye.style.color = state.eyeDealActive ? "#ff3bd4" : "#cdd5e3";
    ui.mSave.textContent = state.saveNotice || "";
  }

  function updateFeeds() {
    if (!ui) return;
    const tab = state.selectedTab;
    Object.keys(ui.tabButtons).forEach((k) => ui.tabButtons[k].classList.toggle("active", k === tab));
    const src =
      tab === "news"
        ? state.news_feed
        : tab === "social"
        ? state.social_feed
        : tab === "crimes"
        ? state.crimes
        : state.world_events;
    const nearBottom = ui.feedList.scrollHeight - ui.feedList.scrollTop - ui.feedList.clientHeight < 80;
    ui.feedList.innerHTML = "";
    src
      .slice(-80)
      .reverse()
      .forEach((x) => {
        const c = make("div", "card");
        if (tab === "news") {
          c.innerHTML = `<div><b>${x.headline || "Headline"}</b></div><div class='muted'>${x.country || "Other"} • ${fmtMonth({ year: 2026 + Math.floor((x.monthAbs || 0) / 12), month: ((x.monthAbs || 0) % 12) + 1 })}</div><div>${(x.blurb || "").slice(0, 280)}</div><div class='muted'>${(x.tags || []).join(" • ")}</div>`;
        } else if (tab === "social") {
          c.innerHTML = `<div><b>${x.platform || "Pulse"}</b> ${x.trend || ""}</div><div class='muted'>${x.country || "Other"}</div><div>${(x.posts || []).map((p) => `• ${p}`).join("<br>")}</div>`;
        } else if (tab === "crimes") {
          c.innerHTML = `<div><b>${x.type || "Incident"}</b> [S${x.severity || 1}]</div><div class='muted'>${x.country || "Other"}</div><div>${(x.summary || "").slice(0, 260)}</div>`;
        } else {
          c.innerHTML = `<div><b>${x.title || "Event"}</b></div><div class='muted'>${x.country || "Other"}</div><div>${(x.summary || "").slice(0, 260)}</div>`;
        }
        ui.feedList.appendChild(c);
      });
    if (nearBottom) ui.feedList.scrollTop = ui.feedList.scrollHeight;
  }

  function updatePeople() {
    if (!ui) return;
    const q = (state.searchQuery || "").toLowerCase().trim();
    const list = state.people
      .filter((p) => p.alive !== false)
      .filter((p) => !q || `${p.display_name} ${p.country} ${p.role}`.toLowerCase().includes(q))
      .slice(0, 140);

    ui.peopleList.innerHTML = "";
    list.forEach((p) => {
      const c = make("div", "card person");
      if (p.id === state.selectedPersonId) c.classList.add("active");
      c.innerHTML = `<div><b>${p.display_name}</b><div class='muted'>${p.country} • ${p.role}</div></div>`;
      const chips = make("div", "row");
      chips.innerHTML = `<span class='chip'>face ${p.face_known ? "✓" : "?"}</span><span class='chip'>name ${p.real_name_verified ? "✓" : "?"}</span><span class='chip'>inf ${p.influence.toFixed(1)}</span>`;
      c.appendChild(chips);
      c.onclick = () => {
        state.selectedPersonId = p.id;
        updatePeople();
        updateDossier();
        if (ui) ui.refreshDeathModal();
      };
      ui.peopleList.appendChild(c);
    });
    updateDossier();
  }

  function metricBar(label, v) {
    const pct = clamp01(v) * 100;
    return `<div class='muted'>${label}</div><div class='meter' style='width:100%'><div class='fill' style='width:${pct.toFixed(1)}%;background:#49dfff'></div></div>`;
  }

  function updateDossier() {
    if (!ui) return;
    const p = findPerson(state.selectedPersonId);
    if (!p) {
      ui.dossier.textContent = "No target selected.";
      return;
    }
    const aliases = p.affiliations.slice(0, 6).join(" • ");
    const crimes = p.headline_crimes.slice(0, 6).join(" • ");
    ui.dossier.innerHTML = `<div><b>${p.display_name}</b></div>
      <div class='muted'>Real name: ${p.real_name_verified ? p.real_name || p.display_name : "unverified"}</div>
      <div class='muted'>${p.country} • ${p.geo_bucket}</div>
      <div>${p.role}</div>
      <div class='muted'>Affiliations: ${aliases || "n/a"}</div>
      <div class='muted'>Crimes: ${crimes || "n/a"}</div>
      <div class='row'><span class='chip'>influence ${p.influence.toFixed(1)}</span><span class='chip'>morality ${p.morality.toFixed(1)}</span><span class='chip'>evidence ${p.evidence_quality.toFixed(2)}</span>${p.flags.bait ? "<span class='chip'>high visibility</span>" : ""}</div>
      ${metricBar("media visibility", p.visibility.media)}
      ${metricBar("law visibility", p.visibility.law)}
      ${metricBar("underground visibility", p.visibility.underground)}
      <div class='row'>
        <button class='btn' id='reqIntel'>Request Intel</button>
        <button class='btn' id='verName'>Verify Name</button>
        <button class='btn' id='findFace'>Find Face</button>
        <button class='btn' id='traceNet'>Network Trace</button>
        <button class='btn' id='watchBtn'>Add to Watchlist</button>
      </div>`;

    ui.dossier.querySelector("#reqIntel").onclick = () => performIntelAction(p.id, `Investigate ${p.id}, expand profile and evidence.`);
    ui.dossier.querySelector("#verName").onclick = () => {
      if (state.eyeDealActive && p.face_known) {
        p.real_name_verified = true;
        if (!p.real_name) p.real_name = `${p.display_name} (eye-derived)`;
        addChat("system", `Eye Deal resolved true name for ${p.display_name}.`, null);
        updateAll();
      } else {
        performIntelAction(p.id, `Verify legal identity for ${p.id}.`);
      }
    };
    ui.dossier.querySelector("#findFace").onclick = () => performIntelAction(p.id, `Find face confirmation and image provenance for ${p.id}.`);
    ui.dossier.querySelector("#traceNet").onclick = () => performIntelAction(p.id, `Trace network links and affiliated entities for ${p.id}.`);
    ui.dossier.querySelector("#watchBtn").onclick = () => {
      if (!state.watchlist.includes(p.id)) state.watchlist.push(p.id);
      cap(state.watchlist, 30);
      updateDossier();
    };

    const watchPeople = state.watchlist.map((id) => findPerson(id)).filter(Boolean);
    ui.watch.innerHTML = `<div><b>Watchlist</b></div>`;
    watchPeople.forEach((x) => {
      const r = make("div", "row");
      const b = make("button", "btn", x.display_name);
      b.onclick = () => {
        state.selectedPersonId = x.id;
        updatePeople();
      };
      const rm = make("button", "btn", "x");
      rm.onclick = () => {
        state.watchlist = state.watchlist.filter((id) => id !== x.id);
        updateDossier();
      };
      r.append(b, rm);
      ui.watch.appendChild(r);
    });

    const metrics = state.stats;
    const metricsCard = make("div", "card");
    metricsCard.innerHTML = `<div><b>Pattern Metrics</b></div>
      ${metricBar("Cause diversity", metrics.Hc)}
      ${metricBar("Geographic spread", metrics.Hg)}
      ${metricBar("Timing diversity", metrics.Ht)}
      ${metricBar("Regularity", metrics.R)}
      ${metricBar("Pattern signature", metrics.PSS)}
      <div class='muted'>Pressure ${metrics.pressure.toFixed(2)} • max cause share ${metrics.maxCauseShare.toFixed(2)}</div>`;

    const invCard = make("div", "card");
    invCard.innerHTML = "<div><b>Investigators</b></div>";
    state.investigators.forEach((inv) => {
      const topGeo = Object.entries(inv.beliefs.geo || {}).sort((a, b) => b[1] - a[1])[0];
      const e = make("div", "card");
      e.innerHTML = `<div><b>${inv.name}</b> <span class='chip'>${inv.style}</span></div>
      <div class='muted'>action: ${inv.lastAction} • focus: ${topGeo ? topGeo[0] : "Other"}</div>
      ${metricBar("alertness", inv.beliefs.alertness)}
      ${metricBar("surveillance", inv.beliefs.surveillance)}
      <div class='muted'>hypotheses: ${(inv.current_hypotheses || []).join(" / ")}</div>`;
      invCard.appendChild(e);
    });

    if (!ui.dossier.nextSibling || !ui.dossier.nextSibling.classList.contains("metrics-wrap")) {
      const holder = make("div", "metrics-wrap");
      ui.dossier.parentNode.insertBefore(holder, ui.watch.nextSibling);
      holder.append(metricsCard, invCard);
    } else {
      const holder = ui.dossier.nextSibling;
      holder.innerHTML = "";
      holder.append(metricsCard, invCard);
    }
  }

  function updateChat() {
    if (!ui) return;
    const nearBottom = ui.chatList.scrollHeight - ui.chatList.scrollTop - ui.chatList.clientHeight < 100;
    ui.chatList.innerHTML = "";
    state.chat.slice(-140).forEach((m) => {
      const d = make("div", `msg ${m.side === "right" ? "r" : m.side === "system" ? "s" : ""}`);
      d.textContent = m.text;
      if (m.details) {
        const det = make("details", "");
        det.innerHTML = `<summary>Details</summary><pre>${JSON.stringify(m.details, null, 2).slice(0, 1800)}</pre>`;
        d.appendChild(det);
      }
      ui.chatList.appendChild(d);
    });
    if (nearBottom) ui.chatList.scrollTop = ui.chatList.scrollHeight;
  }

  function updateButtons() {
    if (!ui) return;
    const dis = state.inFlight;
    ui.btnSendIntel.disabled = dis;
    ui.btnSendSocial.disabled = dis;
    ui.btnDeath.disabled = dis;
    ui.btnAdvance.disabled = dis;
    ui.btnRetry.disabled = dis || !state.lastRetry;
  }

  function updateDebug() {
    if (!ui) return;
    ui.error.style.display = state.errorBanner ? "block" : "none";
    ui.error.textContent = state.errorBanner || "";
    ui.modelSel.value = state.settings.worldModel;
    ui.strictChk.checked = !!state.strictExtraction;
    ui.autoChk.checked = !!state.autoAdvanceAfterAction;
    ui.dbgChk.checked = !!state.debug;
    ui.dumpReqPre.textContent = state.lastRequestPayload || "(none)";
    ui.dumpResPre.textContent = state.lastRawResponse || "(none)";
  }

  function updateAll() {
    updateTopBar();
    updateFeeds();
    updatePeople();
    updateChat();
    updateButtons();
    updateDebug();
  }

  buildUI();

  const autosave = setInterval(saveNow, 10000);
  window.addEventListener("beforeunload", saveNow);

  Engine.on("onKeyDown", (e) => {
    if (isInputLike(e.target)) return;
    if (e.key === "Escape" && state.abortController) {
      state.abortController.abort();
      state.errorBanner = "Request cancelled.";
      updateDebug();
    }
  });

  Engine.on("update", (dt) => {
    state.suspensePulse = (state.suspensePulse + dt * 0.35) % 1000;
  });

  Engine.on("onClick", () => {
    if (!uiRoot) return;
    state.suspensePulse += 0.1;
  });

  Engine.on("render", () => {
    const g = Engine.gfx;
    g.clearBlack();
    const c = Engine.getCtx();
    const sz = Engine.getSize();

    const t = performance.now() * 0.001;
    c.save();
    for (let i = 0; i < scanLines.length; i++) {
      const s = scanLines[i];
      const y = ((s.y + 0.01 * Math.sin(t * 0.8 + s.phase)) % 1) * sz.h;
      c.fillStyle = `rgba(73,223,255,${0.02 + 0.02 * Math.sin(t + s.phase)})`;
      c.fillRect(0, y, sz.w, 1);
    }
    const cx = sz.w * 0.5;
    const cy = sz.h * 0.84;
    const r = Math.min(110, sz.w * 0.12);
    c.strokeStyle = "rgba(155,92,255,0.22)";
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, r, Math.PI, Math.PI * 2);
    c.stroke();
    c.strokeStyle = "rgba(255,59,59,0.65)";
    c.beginPath();
    const a = Math.PI + (Math.PI * clamp01(state.suspicion / 100));
    c.arc(cx, cy, r, Math.PI, a);
    c.stroke();

    c.fillStyle = "rgba(0,0,0,0.25)";
    c.fillRect(0, 0, sz.w, 16);
    c.fillRect(0, sz.h - 16, sz.w, 16);
    c.restore();

    if (!uiRoot) {
      c.fillStyle = "#fff";
      c.font = "13px monospace";
      c.fillText("No UI root found.", 12, 22);
      c.fillText(`Date: ${fmtMonth(state)}`, 12, 44);
      c.fillText(`Suspicion: ${state.suspicion} Public: ${state.publicSupport} Crackdown: ${state.crackdownRisk}`, 12, 66);
      c.fillText(`Lifespan: ${state.lifespanMonths}m`, 12, 88);
      c.fillText("Use proper runner with #uiRoot for full interface.", 12, 110);
    }
  });

  Engine.on("onResize", () => {
    if (ui) updateAll();
  });

  if (state.suspicion >= 100 || state.crackdownRisk >= 100 || state.lifespanMonths <= 0) checkEndStates();

  // expose cleanup for hot-reload scenarios
  return () => {
    clearInterval(autosave);
    window.removeEventListener("beforeunload", saveNow);
  };
}
