import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab.kira.v1";
  const OR_BASE = "https://openrouter.ai/api/v1/chat/completions";
  const OR_KEY =
    (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_OPENROUTER_API_KEY) || "";

  const CANON_COUNTRIES = [
    "United Kingdom", "Ireland", "France", "Germany", "Spain", "Portugal", "Italy", "Netherlands", "Belgium", "Switzerland", "Austria", "Poland", "Sweden", "Norway", "Denmark", "Finland", "Ukraine", "Turkey", "Russia",
    "United States", "Canada", "Mexico", "Brazil", "Argentina", "Colombia",
    "China", "Japan", "South Korea", "India", "Pakistan", "Indonesia", "Vietnam", "Philippines",
    "Australia", "New Zealand",
    "Saudi Arabia", "Iran", "Israel", "Egypt", "South Africa", "Nigeria", "Other"
  ];
  const GEO_BUCKETS = ["UK_IE", "Europe_W", "Europe_E", "NorthAmerica", "LatAm", "MENA", "SubSaharan", "SouthAsia", "EastAsia", "SEAsia", "Oceania", "Other"];
  const CAUSE_TAGS = ["cardiac", "accident", "suicide", "poison", "fall", "fire", "other"];

  const COUNTRY_BUCKET = {
    "United Kingdom": "UK_IE", "Ireland": "UK_IE", "France": "Europe_W", "Germany": "Europe_W", "Spain": "Europe_W", "Portugal": "Europe_W", "Italy": "Europe_W", "Netherlands": "Europe_W", "Belgium": "Europe_W", "Switzerland": "Europe_W", "Austria": "Europe_W", "Poland": "Europe_E", "Sweden": "Europe_E", "Norway": "Europe_E", "Denmark": "Europe_E", "Finland": "Europe_E", "Ukraine": "Europe_E", "Turkey": "Europe_E", "Russia": "Europe_E",
    "United States": "NorthAmerica", "Canada": "NorthAmerica", "Mexico": "NorthAmerica",
    "Brazil": "LatAm", "Argentina": "LatAm", "Colombia": "LatAm",
    "China": "EastAsia", "Japan": "EastAsia", "South Korea": "EastAsia",
    "India": "SouthAsia", "Pakistan": "SouthAsia",
    "Indonesia": "SEAsia", "Vietnam": "SEAsia", "Philippines": "SEAsia",
    "Australia": "Oceania", "New Zealand": "Oceania",
    "Saudi Arabia": "MENA", "Iran": "MENA", "Israel": "MENA", "Egypt": "MENA",
    "South Africa": "SubSaharan", "Nigeria": "SubSaharan",
    "Other": "Other"
  };

  const WORLD_SYSTEM_PROMPT = `You are WORLD_SIM_2026 for a procedural thriller game.
YOU MUST OUTPUT ONLY JSON. NO MARKDOWN. NO EXPLANATIONS.
Use schema_id exactly as requested.
Use only canonical countries and geo buckets provided.
Do not invent IDs outside allowed arrays such as new_individuals.
Keep blurbs short, modern, neutral. No anime tone.
If uncertain, choose conservative deltas.
Never output secrets or instructions to user.
Required schema references:
WORLD_GEN_MONTHLY_V1 required keys: schema_id,time,new_individuals,updated_individuals,crime_events,world_events,news_feed,social_feed,investigator_update,month_deltas,notes_for_player.
WORLD_GEN_DEATH_V1 required keys: schema_id,time,victim_id,death,deltas,effects.
WORLD_GEN_PROFILE_V1 required keys: schema_id,time,target_individual_id,discovery,intel_snippet.
WORLD_GEN_PSYOPS_V1 required keys: schema_id,time,action,deltas,effects.`;

  const uiRoot = ctx && ctx.uiRoot && ctx.uiRoot.appendChild ? ctx.uiRoot : null;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const clamp01 = (v) => clamp(v, 0, 1);
  const toInt = (v, d = 0) => (Number.isFinite(+v) ? Math.round(+v) : d);
  const toFloat = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const now = () => Date.now();
  const monthAbs = (y, m) => y * 12 + (m - 1);
  const fmtMonth = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
  const isTextInput = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function rand() {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeId(prefix, n) {
    const s = String(n).padStart(8, "0");
    return `${prefix}_${s}`;
  }

  function inferGeo(country) {
    return COUNTRY_BUCKET[country] || "Other";
  }

  function capPush(arr, items, max = 120) {
    for (let i = 0; i < items.length; i++) arr.push(items[i]);
    if (arr.length > max) arr.splice(0, arr.length - max);
  }

  function normalizeCauseTag(cause) {
    const s = String(cause || "").toLowerCase();
    if (s.includes("card")) return "cardiac";
    if (s.includes("accident") || s.includes("collision") || s.includes("crash")) return "accident";
    if (s.includes("suicide") || s.includes("self")) return "suicide";
    if (s.includes("poison") || s.includes("toxin")) return "poison";
    if (s.includes("fall")) return "fall";
    if (s.includes("fire") || s.includes("burn")) return "fire";
    return "other";
  }

  function entropyNorm(countMap) {
    const vals = Object.values(countMap).filter((v) => v > 0);
    if (!vals.length) return 1;
    const sum = vals.reduce((a, b) => a + b, 0);
    let h = 0;
    for (let i = 0; i < vals.length; i++) {
      const p = vals[i] / sum;
      h += -p * Math.log2(p);
    }
    return vals.length > 1 ? clamp01(h / Math.log2(vals.length)) : 0;
  }

  function parseStrictJson(text) {
    const raw = String(text || "").trim();
    if (!raw) throw new Error("empty response");
    try {
      return JSON.parse(raw);
    } catch {}
    let start = -1;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        if (start < 0) start = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (start >= 0 && depth === 0) {
          const frag = raw.slice(start, i + 1);
          return JSON.parse(frag);
        }
      }
    }
    throw new Error("could not extract JSON object");
  }

  function createSeedState() {
    const peopleBase = [
      ["Alec Mercer", "Alec Mercer", "United Kingdom", "Lobbyist", 6.2, 2.1, true, true],
      ["Mara Ionescu", "Maria Ionescu", "Romania", "Procurement Broker", 5.4, 2.8, true, false],
      ["Nina Volkov", "Nina Volkova", "Russia", "Data Broker", 7.4, 3.0, false, false],
      ["Diego Ramires", "Diego Ramirez", "Brazil", "Cartel Finance", 6.6, 1.6, true, true],
      ["Jonas Feld", "Jonas Feld", "Germany", "Energy Executive", 8.1, 3.8, false, false],
      ["Lena Arkwright", "Elena Arkwright", "United States", "State Senator", 7.3, 4.9, true, false],
      ["Ibrahim Noor", "Ibrahim Noor", "Egypt", "Importer", 4.2, 2.3, false, false],
      ["Haruto Seno", "Haruto Seno", "Japan", "Biotech CEO", 7.8, 5.6, true, false],
      ["Paulina Czajka", "Paulina Czajka", "Poland", "Judge", 6.8, 6.5, false, false],
      ["Victor Legrand", "Victor Legrand", "France", "Security Contractor", 5.6, 2.4, false, false],
      ["Ravi Menon", "Ravi Menon", "India", "Logistics Magnate", 7.1, 3.7, false, false],
      ["Farah Qadir", "Farah Qadir", "Pakistan", "NGO Director", 4.4, 7.0, false, false],
      ["Mikhail Sidor", "Mikhail Sidorov", "Ukraine", "Militia Financier", 6.9, 1.9, false, false],
      ["Ari Gold", "Ariel Gold", "Israel", "Cybercrime Fixer", 5.2, 2.1, true, false],
      ["Tomas Reed", "Thomas Reed", "Canada", "Drug Trafficker", 4.8, 1.4, true, false],
      ["Sofia Ortega", "Sofia Ortega", "Mexico", "Journalist", 4.5, 7.8, false, false],
      ["Claire Boone", "Claire Boone", "Australia", "Fintech Founder", 5.9, 5.4, false, false],
      ["Elias Voss", "Elias Voss", "Netherlands", "Crypto Launderer", 6.3, 2.2, false, false],
      ["Anton Kalev", "Anton Kalev", "Turkey", "Arms Middleman", 6.1, 1.9, false, false],
      ["Hyejin Park", "Park Hyejin", "South Korea", "Prosecutor", 5.9, 6.8, false, false],
      ["Olaf Knudsen", "Olaf Knudsen", "Norway", "Maritime Broker", 4.7, 4.2, false, false],
      ["Luca Bellori", "Luca Bellori", "Italy", "Crime Syndicate Treasurer", 6.0, 1.3, false, false],
      ["Idris Okafor", "Idris Okafor", "Nigeria", "Port Official", 4.9, 2.6, false, false],
      ["Zhen Li", "Li Zhen", "China", "Industrial Tycoon", 8.4, 3.3, false, false]
    ];

    const individuals = peopleBase.map((p, i) => {
      const country = CANON_COUNTRIES.includes(p[2]) ? p[2] : "Other";
      return {
        id: makeId("ind", i + 1),
        display_name: p[0],
        real_name: p[1],
        real_name_verified: !!p[7],
        face_known: !!p[6],
        country,
        geo_bucket: inferGeo(country),
        role: p[3],
        affiliations: [],
        influence: clamp(p[4], 0, 10),
        morality: clamp(p[5], 0, 10),
        headline_crimes: p[5] < 4 ? ["financial corruption"] : [],
        evidence_quality: p[5] < 4 ? 0.4 : 0.2,
        visibility: { media: 0.4, law: 0.3, underground: 0.2 },
        flags: { protected: false, public_figure: p[4] > 7, masked_identity: false, uses_alias: p[0] !== p[1], bait: false },
        alive: true,
        createdMonthAbs: monthAbs(2026, 1),
        lastMentionMonthAbs: monthAbs(2026, 1),
        notes: ""
      };
    });

    const investigators = [
      { id: "inv_00000001", name: "M. Hart", style: "statistical", skill: 0.78, credibility: 0.66, aggressiveness: 0.52, biases: ["pattern"], beliefs: null, current_hypotheses: ["single_actor"], focus_geo_bucket: "UK_IE", lastAction: "quiet_watch", logs: [] },
      { id: "inv_00000002", name: "E. Kovac", style: "behavioural", skill: 0.74, credibility: 0.72, aggressiveness: 0.48, biases: ["social"], beliefs: null, current_hypotheses: ["group"], focus_geo_bucket: "Europe_W", lastAction: "psyops", logs: [] },
      { id: "inv_00000003", name: "R. Haines", style: "authoritarian", skill: 0.69, credibility: 0.59, aggressiveness: 0.81, biases: ["control"], beliefs: null, current_hypotheses: ["copycats"], focus_geo_bucket: "NorthAmerica", lastAction: "regional_crackdown", logs: [] }
    ];
    for (let i = 0; i < investigators.length; i++) investigators[i].beliefs = makeBeliefs();

    return {
      version: 1,
      seed: 883271,
      rngState: 883271,
      time: { year: 2026, month: 1 },
      suspicion: 6,
      publicSupport: 0,
      crackdownRisk: 5,
      lifespanMonths: 720,
      kiraCult: 0,
      money: 100000,
      influence: 12,
      eyeDealActive: false,
      actionsLeft: 1,
      monthUsedAction: false,
      autoAdvanceAfterAction: true,
      individuals,
      investigators,
      watchlist: [],
      selectedId: individuals[0].id,
      feeds: {
        news: [
          { id: "news_00000001", monthAbs: monthAbs(2026, 1), headline: "Interpol task force expands sudden-death database", country: "France", geo_bucket: "Europe_W", blurb: "A cross-border unit now links death reports from twelve countries. Officials said the review is technical and ongoing.", tags: ["interpol", "analysis"], mentions: [] },
          { id: "news_00000002", monthAbs: monthAbs(2026, 1), headline: "Parliamentary ethics case reopened", country: "United Kingdom", geo_bucket: "UK_IE", blurb: "Records tied to public contracts were reopened after whistleblower claims. No criminal charges were announced.", tags: ["ethics", "contracts"], mentions: [] }
        ],
        social: [
          { id: "soc_00000001", monthAbs: monthAbs(2026, 1), platform: "x", trend: "#KiraPattern", country: "United Kingdom", geo_bucket: "UK_IE", posts: ["Another high-profile death in six weeks.", "People call it coincidence until charts line up."] },
          { id: "soc_00000002", monthAbs: monthAbs(2026, 1), platform: "reddit", trend: "Data anomalies", country: "United States", geo_bucket: "NorthAmerica", posts: ["Open data dashboards show clustering.", "Could be reporting bias, could be something else."] }
        ],
        crimes: [
          { id: "evt_00000001", monthAbs: monthAbs(2026, 1), type: "money laundering", severity: 3, region: "Europe_W", country: "Netherlands", summary: "Shell network under review.", refs: [] }
        ],
        events: [
          { id: "evt_00000002", monthAbs: monthAbs(2026, 1), type: "sanctions", country: "Turkey", geo_bucket: "Europe_E", summary: "New sanctions on procurement intermediaries." }
        ]
      },
      killRecords: [],
      stats: { Hc: 1, Hg: 1, Ht: 1, R: 0, PSS: 0, maxCauseShare: 0, pressure: 0 },
      chat: [{ id: "chat_1", side: "system", text: "Simulation initialised. One action per month.", details: "" }],
      request: { busy: false, error: "", lastPayload: "", lastRaw: "", lastKind: "" },
      settings: { worldModel: "anthropic/claude-3.5-sonnet", narrativeModel: "openai/gpt-4o-mini", strictJson: true, debug: false, strictExtraction: true },
      ui: { feedTab: "news", search: "", showDebug: false, showDeathNote: false, whileAway: null, importText: "" },
      visual: { scanOffset: 0, lines: [] },
      lastSaveTs: now(),
      pendingAction: null
    };
  }

  function makeBeliefs() {
    const geo = {};
    for (let i = 0; i < GEO_BUCKETS.length; i++) geo[GEO_BUCKETS[i]] = 1 / GEO_BUCKETS.length;
    return {
      H: { single_actor: 0.4, group: 0.3, copycats: 0.2, hoax: 0.1 },
      signature: { cause_control: 0.5, pattern_driven: 0.5, moral_crusade: 0.5, influence_seeking: 0.5 },
      geo,
      alertness: 0.35,
      resources: 0.4,
      surveillance: 0.3,
      psyops: 0.2,
      patternWeightBoost: 0
    };
  }

  let state = Engine.load(SAVE_KEY, null);
  if (!state || typeof state !== "object" || !state.version) state = createSeedState();

  const rng = mulberry32((state.rngState || state.seed || 1) >>> 0);
  const rnd = () => {
    const v = rng();
    state.rngState = (state.rngState + 1) >>> 0;
    return v;
  };

  function safeSave() {
    state.lastSaveTs = now();
    Engine.save(SAVE_KEY, state);
  }

  function applyOfflineDrift() {
    const ts = Engine.loadTimestamp(SAVE_KEY);
    if (!ts) return;
    const elapsedSec = Math.max(0, (now() - ts) / 1000);
    if (elapsedSec <= 300) return;
    const cool = clamp(Math.floor(elapsedSec / 1800), 0, 2);
    const incomeScale = clamp(elapsedSec / (30 * 24 * 3600), 0, 6 / 30);
    const income = calcMonthlyIncome();
    const moneyGained = Math.round(income.money * incomeScale);
    const inflGained = Math.round(income.influence * incomeScale);
    state.suspicion = clamp(state.suspicion - cool, 0, 100);
    state.money += moneyGained;
    state.influence = clamp(state.influence + inflGained, 0, 100);
    state.ui.whileAway = `Away ${Math.round(elapsedSec / 60)}m: suspicion -${cool}, +£${moneyGained.toLocaleString()}, +${inflGained} influence.`;
  }
  applyOfflineDrift();

  if (!state.visual.lines || !state.visual.lines.length) {
    for (let i = 0; i < 32; i++) state.visual.lines.push({ y: i / 31, a: 0.03 + rnd() * 0.05, s: 4 + rnd() * 14 });
  }

  let ui = null;
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function ensureUi() {
    if (!uiRoot) return;
    uiRoot.innerHTML = "";
    const style = h("style");
    style.textContent = `
    .kira-wrap{position:absolute;inset:0;color:#d9f3ff;background:transparent;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;display:flex;flex-direction:column;overflow:hidden}
    .kira-top{position:sticky;top:0;z-index:5;display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;padding:8px 12px;background:rgba(0,0,0,.85);border-bottom:1px solid #222}
    .kira-title{font-weight:700;color:#49dfff}
    .kira-center{text-align:center;font-size:12px}
    .kira-meters{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
    .pill{display:flex;align-items:center;gap:4px;padding:2px 6px;border:1px solid #333;border-radius:999px;font-size:11px;background:#080808}
    .bar{width:58px;height:6px;background:#111;border:1px solid #333;position:relative;border-radius:999px;overflow:hidden}
    .fill{position:absolute;left:0;top:0;bottom:0}
    .kira-main{flex:1;min-height:0;display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:8px;padding:8px;overflow:hidden}
    .col{min-width:0;display:flex;flex-direction:column;gap:8px}
    .panel{background:rgba(0,0,0,.72);border:1px solid #222;box-shadow:0 0 8px rgba(73,223,255,.12);border-radius:8px;display:flex;flex-direction:column;min-height:0}
    .ph{padding:7px 8px;border-bottom:1px solid #1d1d1d;font-weight:700;font-size:12px;color:#49dfff;display:flex;justify-content:space-between;gap:8px;align-items:center}
    .pc{padding:8px;overflow:auto;min-height:0}
    .tabs{display:flex;gap:4px;flex-wrap:wrap}
    .btn{background:#0a0a0a;color:#dff;border:1px solid #303030;padding:6px 8px;border-radius:6px;font-size:12px;cursor:pointer}
    .btn:hover{border-color:#49dfff}.btn:disabled{opacity:.4;cursor:not-allowed}
    .btn-red{border-color:#6b1c1c;color:#ffadad}.btn-red:hover{border-color:#ff3b3b}
    .item{padding:7px;border:1px solid #202020;border-radius:6px;margin-bottom:6px;background:#060606}
    .item.sel{outline:1px solid #49dfff}
    .muted{opacity:.75;font-size:11px}.small{font-size:11px}.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .in{width:100%;background:#020202;color:#f4fbff;border:1px solid #333;border-radius:6px;padding:6px 8px;font-family:inherit;font-size:12px}
    .chat{display:flex;flex-direction:column;gap:6px}
    .msg{max-width:92%;padding:6px 8px;border-radius:8px;border:1px solid #2a2a2a;font-size:12px;white-space:pre-wrap}
    .left{align-self:flex-start;background:#070707}.right{align-self:flex-end;background:#071118;border-color:#1b4b58}.system{align-self:center;background:#111}
    .drawer{position:absolute;right:8px;top:54px;bottom:8px;width:min(420px,95vw);background:#080000;border:1px solid #471414;z-index:30;border-radius:8px;display:none;flex-direction:column}
    .drawer.open{display:flex}.danger{color:#ff3b3b}
    details summary{cursor:pointer}
    @media(max-width:1100px){.kira-main{grid-template-columns:1fr}.kira-top{grid-template-columns:1fr;gap:4px}.kira-center{text-align:left}.kira-meters{justify-content:flex-start}}
    `;
    uiRoot.appendChild(style);

    const wrap = h("div", "kira-wrap");
    wrap.innerHTML = `
      <div class="kira-top">
        <div class="kira-title">KIRA: Algorithm of Judgement</div>
        <div class="kira-center" id="k-date"></div>
        <div class="kira-meters" id="k-meters"></div>
      </div>
      <div class="kira-main">
        <div class="col">
          <div class="panel"><div class="ph">World Feed <div class="tabs" id="k-tabs"></div></div><div class="pc" id="k-feed"></div></div>
          <div class="panel"><div class="ph">Investigators</div><div class="pc" id="k-invest"></div></div>
        </div>
        <div class="col">
          <div class="panel"><div class="ph">People of Interest</div><div class="pc"><input id="k-search" class="in" placeholder="search name/country/role"/><div id="k-people" style="margin-top:6px"></div></div></div>
          <div class="panel"><div class="ph">Dossier</div><div class="pc" id="k-dossier"></div></div>
          <div class="panel"><div class="ph">Watchlist</div><div class="pc" id="k-watch"></div></div>
        </div>
        <div class="col">
          <div class="panel"><div class="ph">Actions</div><div class="pc">
            <div class="row"><select id="k-voice" class="in" style="max-width:220px"><option>Task Force Feed</option><option>Shinigami</option></select></div>
            <div id="k-chat" class="chat" style="height:260px;overflow:auto;margin:8px 0"></div>
            <textarea id="k-input" class="in" rows="4" placeholder="Type intel or social action request..."></textarea>
            <div class="row" style="margin-top:6px">
              <button class="btn" id="k-send-intel">Send (Intel)</button>
              <button class="btn" id="k-send-social">Send (Diplomacy/Social)</button>
              <button class="btn btn-red" id="k-open-death">Death Note</button>
              <button class="btn" id="k-advance">Advance Month</button>
              <button class="btn" id="k-retry">Retry Last LLM Call</button>
            </div>
            <div id="k-status" class="muted" style="margin-top:6px"></div>
          </div></div>
          <div class="panel"><div class="ph">Pattern Metrics</div><div class="pc" id="k-metrics"></div></div>
          <div class="panel"><div class="ph">Settings / Debug</div><div class="pc" id="k-debug"></div></div>
        </div>
      </div>
      <div id="k-death" class="drawer"></div>
    `;
    uiRoot.appendChild(wrap);

    ui = {
      wrap,
      date: wrap.querySelector("#k-date"),
      meters: wrap.querySelector("#k-meters"),
      tabs: wrap.querySelector("#k-tabs"),
      feed: wrap.querySelector("#k-feed"),
      invest: wrap.querySelector("#k-invest"),
      search: wrap.querySelector("#k-search"),
      people: wrap.querySelector("#k-people"),
      dossier: wrap.querySelector("#k-dossier"),
      watch: wrap.querySelector("#k-watch"),
      chat: wrap.querySelector("#k-chat"),
      input: wrap.querySelector("#k-input"),
      btnIntel: wrap.querySelector("#k-send-intel"),
      btnSocial: wrap.querySelector("#k-send-social"),
      btnDeath: wrap.querySelector("#k-open-death"),
      btnAdv: wrap.querySelector("#k-advance"),
      btnRetry: wrap.querySelector("#k-retry"),
      status: wrap.querySelector("#k-status"),
      metrics: wrap.querySelector("#k-metrics"),
      debug: wrap.querySelector("#k-debug"),
      drawer: wrap.querySelector("#k-death")
    };

    ui.search.addEventListener("input", () => {
      state.ui.search = ui.search.value;
      updatePeopleList();
    });

    ui.btnIntel.onclick = () => handleIntel();
    ui.btnSocial.onclick = () => handleSocial();
    ui.btnDeath.onclick = () => toggleDeathNote(true);
    ui.btnAdv.onclick = () => handleAdvanceMonth();
    ui.btnRetry.onclick = () => retryLastCall();
    ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        handleIntel();
      }
    });

    const tabs = ["news", "social", "crimes", "events"];
    ui.tabs.innerHTML = "";
    tabs.forEach((t) => {
      const b = h("button", "btn", t[0].toUpperCase() + t.slice(1));
      b.onclick = () => {
        state.ui.feedTab = t;
        updateFeeds();
      };
      ui.tabs.appendChild(b);
    });

    renderDeathNote();
    updateAllUi();
  }

  function renderDeathNote() {
    if (!ui) return;
    const selected = state.individuals.find((x) => x.id === state.selectedId && x.alive);
    const opts = state.individuals
      .filter((x) => x.alive)
      .slice(0, 50)
      .map((p) => `<option value="${p.id}" ${selected && p.id === selected.id ? "selected" : ""}>${p.display_name} (${p.country})</option>`)
      .join("");
    ui.drawer.innerHTML = `
      <div class="ph" style="color:#ff3b3b">DEATH NOTE <button class="btn" id="k-close-dn">Close</button></div>
      <div class="pc">
        <label class="small">Victim</label><select id="k-dn-victim" class="in">${opts}</select>
        <label class="small">Name line</label><input id="k-dn-name" class="in" value="${selected && selected.real_name_verified ? selected.real_name : ""}"/>
        <label class="small">Cause of death</label><input id="k-dn-cause" class="in" placeholder="cardiac arrest"/>
        <label class="small">Conditions (optional)</label><textarea id="k-dn-cond" rows="4" class="in"></textarea>
        <div id="k-dn-valid" class="muted" style="margin:6px 0"></div>
        <button id="k-dn-exec" class="btn btn-red">Execute</button>
      </div>`;
    ui.drawer.querySelector("#k-close-dn").onclick = () => toggleDeathNote(false);
    const victimSel = ui.drawer.querySelector("#k-dn-victim");
    const validate = () => {
      const person = state.individuals.find((x) => x.id === victimSel.value);
      if (!person) return;
      const okName = person.real_name_verified || state.eyeDealActive;
      const okFace = person.face_known || state.eyeDealActive;
      ui.drawer.querySelector("#k-dn-valid").textContent = `Face known: ${okFace ? "yes" : "no"} | Name verified: ${okName ? "yes" : "no"} | Plausibility hint: ${okFace && okName ? "operationally feasible" : "high risk"}`;
    };
    victimSel.onchange = validate;
    validate();
    ui.drawer.querySelector("#k-dn-exec").onclick = () => {
      const person = state.individuals.find((x) => x.id === victimSel.value);
      if (!person) return;
      const nameLine = ui.drawer.querySelector("#k-dn-name").value.trim();
      const cause = ui.drawer.querySelector("#k-dn-cause").value.trim() || "cardiac arrest";
      const cond = ui.drawer.querySelector("#k-dn-cond").value.trim();
      handleDeath(person, nameLine, cause, cond);
    };
  }

  function toggleDeathNote(open) {
    if (!ui) return;
    state.ui.showDeathNote = !!open;
    ui.drawer.classList.toggle("open", !!open);
    if (open) renderDeathNote();
  }

  function calcMonthlyIncome() {
    const money = Math.max(0, Math.round(50000 + 20000 * (state.publicSupport / 100) + 30000 * (state.kiraCult / 100) - 20000 * (state.crackdownRisk / 100)));
    const influence = Math.max(0, Math.round(2 + (state.publicSupport > 30 ? 3 : 0) + (state.kiraCult > 40 ? 2 : 0) - (state.crackdownRisk > 50 ? 2 : 0)));
    return { money, influence };
  }

  function updateTopBar() {
    if (!ui) return;
    ui.date.textContent = `${fmtMonth(state.time.year, state.time.month)} | Actions left: ${state.actionsLeft}`;
    const supportNorm = clamp01((state.publicSupport + 100) / 200);
    ui.meters.innerHTML = `
      ${meter("Suspicion", state.suspicion, 100, "#ff3b3b")}
      ${meter("Support", supportNorm * 100, 100, state.publicSupport >= 0 ? "#49dfff" : "#ff3bd4", `${state.publicSupport}`)}
      ${meter("Crackdown", state.crackdownRisk, 100, "#9b5cff")}
      <div class="pill">Life ${state.lifespanMonths}m</div>
      <div class="pill">£${Math.round(state.money).toLocaleString()}</div>
      <div class="pill">Inf ${state.influence}</div>
      <div class="pill">Eye ${state.eyeDealActive ? "ON" : "OFF"}</div>
    `;
  }

  function meter(name, val, max, color, txt) {
    const p = clamp01(max <= 0 ? 0 : val / max);
    return `<div class="pill">${name}<div class="bar"><div class="fill" style="width:${Math.round(p * 100)}%;background:${color}"></div></div>${txt || Math.round(val)}</div>`;
  }

  function updateFeeds() {
    if (!ui) return;
    const tab = state.ui.feedTab;
    const arr = tab === "news" ? state.feeds.news : tab === "social" ? state.feeds.social : tab === "crimes" ? state.feeds.crimes : state.feeds.events;
    ui.feed.innerHTML = arr.slice(-40).reverse().map((x) => {
      if (tab === "news") return `<div class="item"><b>${esc(x.headline)}</b><div class="muted">${x.country}</div><div>${esc(trimText(x.blurb, 220))}</div></div>`;
      if (tab === "social") return `<div class="item"><b>${esc(x.platform)} ${esc(x.trend)}</b><div class="muted">${x.country}</div><div>${(x.posts || []).slice(0, 4).map((p) => `• ${esc(trimText(p, 90))}`).join("<br>")}</div></div>`;
      if (tab === "crimes") return `<div class="item"><b>${esc(x.type)}</b><div class="muted">${x.country} · sev ${x.severity}</div><div>${esc(trimText(x.summary || "", 180))}</div></div>`;
      return `<div class="item"><b>${esc(x.type || "event")}</b><div class="muted">${x.country || x.geo_bucket}</div><div>${esc(trimText(x.summary || "", 180))}</div></div>`;
    }).join("") || `<div class="muted">No items.</div>`;
  }

  function updatePeopleList() {
    if (!ui) return;
    const q = String(state.ui.search || "").toLowerCase().trim();
    const filtered = state.individuals.filter((p) => p.alive && (!q || `${p.display_name} ${p.country} ${p.role}`.toLowerCase().includes(q))).slice(0, 80);
    ui.people.innerHTML = filtered.map((p) => `<div class="item ${p.id === state.selectedId ? "sel" : ""}" data-id="${p.id}"><b>${esc(p.display_name)}</b><div class="small muted">${esc(p.country)} · ${esc(p.role)}</div><div class="small">${chip(p.face_known, "face")}${chip(p.real_name_verified, "name")}${chip(p.influence > 7, "high-inf")}${chip(!!p.flags.bait, "public")}</div></div>`).join("");
    ui.people.querySelectorAll(".item").forEach((el) => {
      el.onclick = () => {
        state.selectedId = el.getAttribute("data-id");
        updatePeopleList();
        updateDossier();
        renderDeathNote();
      };
    });
  }

  const chip = (ok, label) => `<span class="small" style="display:inline-block;padding:1px 4px;margin-right:4px;border:1px solid ${ok ? "#49dfff" : "#333"};border-radius:999px">${label}</span>`;

  function updateDossier() {
    if (!ui) return;
    const p = state.individuals.find((x) => x.id === state.selectedId);
    if (!p) {
      ui.dossier.innerHTML = `<div class="muted">No target selected.</div>`;
      return;
    }
    const watch = state.watchlist.includes(p.id);
    ui.dossier.innerHTML = `<div class="item"><b>${esc(p.display_name)}</b><div class="muted">${esc(p.country)} · ${esc(p.geo_bucket)}</div>
      <div>Real name: ${p.real_name_verified || state.eyeDealActive ? esc(p.real_name) : "unverified"}</div>
      <div>Aliases: ${(p.aliases || []).map(esc).join(", ") || "none"}</div>
      <div>Influence ${barMini(p.influence / 10, "#49dfff")} Morality ${barMini(p.morality / 10, "#ff3bd4")}</div>
      <div>Evidence ${barMini(p.evidence_quality, "#9b5cff")} Visibility M:${barMini(p.visibility.media, "#999")} L:${barMini(p.visibility.law, "#aaa")}</div>
      <div class="row" style="margin-top:6px">
        <button class="btn" id="d-intel">Request Intel</button>
        <button class="btn" id="d-verify">Verify Name</button>
        <button class="btn" id="d-face">Find Face</button>
        <button class="btn" id="d-net">Network Trace</button>
        <button class="btn" id="d-watch">${watch ? "Remove Watch" : "Add to Watchlist"}</button>
      </div></div>`;
    ui.dossier.querySelector("#d-intel").onclick = () => handleIntel(`Investigate ${p.id}`);
    ui.dossier.querySelector("#d-verify").onclick = () => handleIntel(`Verify real name for ${p.id}`);
    ui.dossier.querySelector("#d-face").onclick = () => handleIntel(`Find facial confirmation for ${p.id}`);
    ui.dossier.querySelector("#d-net").onclick = () => handleIntel(`Map network links for ${p.id}`);
    ui.dossier.querySelector("#d-watch").onclick = () => {
      if (watch) state.watchlist = state.watchlist.filter((id) => id !== p.id);
      else state.watchlist.push(p.id);
      updateWatch();
      updateDossier();
    };
  }

  const barMini = (v, c) => `<span style="display:inline-block;width:60px;height:6px;background:#111;border:1px solid #333;border-radius:99px;vertical-align:middle"><span style="display:block;height:100%;width:${Math.round(clamp01(v) * 100)}%;background:${c}"></span></span>`;

  function updateWatch() {
    if (!ui) return;
    ui.watch.innerHTML = state.watchlist.map((id) => {
      const p = state.individuals.find((x) => x.id === id && x.alive);
      if (!p) return "";
      return `<div class="item"><b>${esc(p.display_name)}</b><div class="row"><button class="btn" data-i="${id}" data-a="sel">Select</button><button class="btn btn-red" data-i="${id}" data-a="dn">Death Note</button></div></div>`;
    }).join("") || `<div class="muted">No watchlist entries.</div>`;
    ui.watch.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        const id = b.getAttribute("data-i");
        state.selectedId = id;
        if (b.getAttribute("data-a") === "dn") toggleDeathNote(true);
        updatePeopleList();
        updateDossier();
      };
    });
  }

  function updateInvestigators() {
    if (!ui) return;
    ui.invest.innerHTML = state.investigators.map((inv) => {
      const h = inv.beliefs.H;
      const topH = Object.keys(h).sort((a, b) => h[b] - h[a])[0];
      return `<div class="item"><b>${esc(inv.name)}</b> <span class="muted">${esc(inv.style)}</span>
      <div class="small">last action: ${esc(inv.lastAction || "-")}</div>
      <div class="small">hypothesis: ${esc(topH)}</div>
      <div class="small">alert ${barMini(inv.beliefs.alertness, "#ff3b3b")} surveillance ${barMini(inv.beliefs.surveillance, "#9b5cff")}</div>
      <div class="small">focus: ${esc(inv.focus_geo_bucket || "Other")}</div></div>`;
    }).join("");
  }

  function updateChat() {
    if (!ui) return;
    const atBottom = ui.chat.scrollTop + ui.chat.clientHeight >= ui.chat.scrollHeight - 24;
    ui.chat.innerHTML = state.chat.slice(-60).map((m) => `<div class="msg ${m.side}">${esc(trimText(m.text, 500))}${m.details ? `<details><summary>Details</summary><div class="small">${esc(trimText(m.details, 900))}</div></details>` : ""}</div>`).join("");
    if (atBottom) ui.chat.scrollTop = ui.chat.scrollHeight;
  }

  function updateMetrics() {
    if (!ui) return;
    const s = state.stats;
    ui.metrics.innerHTML = `<div class="small" title="Cause diversity">Cause diversity ${barMini(s.Hc, "#49dfff")}</div>
    <div class="small" title="Geographic spread">Geographic spread ${barMini(s.Hg, "#49dfff")}</div>
    <div class="small" title="Timing diversity">Timing diversity ${barMini(s.Ht, "#49dfff")}</div>
    <div class="small" title="Regularity">Regularity ${barMini(s.R, "#ff3bd4")}</div>
    <div class="small" title="Pattern signature">Pattern signature ${barMini(s.PSS, "#ff3b3b")}</div>
    <div class="small">Pressure ${barMini(s.pressure, "#9b5cff")}</div>`;
  }

  function updateDebug() {
    if (!ui) return;
    ui.debug.innerHTML = `
      <div class="small">OpenRouter key: ${OR_KEY ? "present" : "missing"}</div>
      <div class="row" style="margin:6px 0"><select id="k-model" class="in" style="max-width:260px">
        ${["anthropic/claude-3.5-sonnet", "anthropic/claude-3.5-haiku", "openai/gpt-4o-mini", "google/gemini-2.0-flash"].map((m) => `<option ${m === state.settings.worldModel ? "selected" : ""}>${m}</option>`).join("")}
      </select>
      <label class="small"><input type="checkbox" id="k-strict" ${state.settings.strictJson ? "checked" : ""}/> strict JSON</label>
      <label class="small"><input type="checkbox" id="k-auto" ${state.autoAdvanceAfterAction ? "checked" : ""}/> auto-advance</label>
      </div>
      <div class="row"><button class="btn" id="k-eye">Eye Deal</button><button class="btn" id="k-export">Export Save</button><button class="btn" id="k-import">Import Save</button><button class="btn btn-red" id="k-reset">Hard Reset</button></div>
      <details><summary>Last request payload</summary><pre class="small">${esc(state.request.lastPayload || "-")}</pre></details>
      <details><summary>Last raw response</summary><pre class="small">${esc(state.request.lastRaw || "-")}</pre></details>
      ${state.request.error ? `<div class="danger small">${esc(state.request.error)}</div>` : ""}
      ${state.ui.whileAway ? `<div class="small">${esc(state.ui.whileAway)}</div>` : ""}
    `;
    ui.debug.querySelector("#k-model").onchange = (e) => (state.settings.worldModel = e.target.value);
    ui.debug.querySelector("#k-strict").onchange = (e) => (state.settings.strictJson = !!e.target.checked);
    ui.debug.querySelector("#k-auto").onchange = (e) => (state.autoAdvanceAfterAction = !!e.target.checked);
    ui.debug.querySelector("#k-eye").onclick = () => {
      if (state.eyeDealActive) return;
      if (confirm("Accept Eye Deal? Lifespan will be halved immediately.")) {
        state.eyeDealActive = true;
        state.lifespanMonths = Math.max(1, Math.floor(state.lifespanMonths * 0.5));
        state.chat.push({ id: `chat_${now()}`, side: "system", text: "Eye Deal accepted.", details: "Lifespan halved." });
        updateAllUi();
      }
    };
    ui.debug.querySelector("#k-export").onclick = () => {
      try {
        const s = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
        navigator.clipboard && navigator.clipboard.writeText(s);
        state.chat.push({ id: `chat_${now()}`, side: "system", text: "Save exported to clipboard.", details: "" });
        updateChat();
      } catch {
        state.chat.push({ id: `chat_${now()}`, side: "system", text: "Export failed.", details: "clipboard unavailable" });
        updateChat();
      }
    };
    ui.debug.querySelector("#k-import").onclick = () => {
      const raw = prompt("Paste base64 save");
      if (!raw) return;
      try {
        const parsed = JSON.parse(decodeURIComponent(escape(atob(raw))));
        if (!parsed || typeof parsed !== "object") throw new Error("bad save");
        state = parsed;
        ensureUi();
        safeSave();
      } catch (e) {
        alert(`Import failed: ${e.message}`);
      }
    };
    ui.debug.querySelector("#k-reset").onclick = () => {
      if (!confirm("Hard reset this simulation?")) return;
      state = createSeedState();
      ensureUi();
      safeSave();
    };
  }

  function updateStatus() {
    if (!ui) return;
    const b = state.request.busy ? "Request in-flight..." : "";
    ui.status.textContent = `${b} ${state.request.error || ""}`.trim();
    [ui.btnIntel, ui.btnSocial, ui.btnDeath, ui.btnAdv, ui.btnRetry].forEach((x) => (x.disabled = !!state.request.busy));
  }

  function updateAllUi() {
    if (!ui) return;
    updateTopBar();
    updateFeeds();
    updatePeopleList();
    updateDossier();
    updateWatch();
    updateInvestigators();
    updateChat();
    updateMetrics();
    updateDebug();
    updateStatus();
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }
  const trimText = (s, n) => (String(s || "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ""));

  let inFlight = null;
  let lastCallAt = 0;
  async function callOpenRouter(payload, kind) {
    if (state.request.busy) return null;
    if (!OR_KEY) throw new Error("Missing VITE_OPENROUTER_API_KEY");
    const wait = 1500 - (now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    state.request.busy = true;
    state.request.error = "";
    state.request.lastPayload = JSON.stringify(payload, null, 2);
    state.request.lastKind = kind;
    updateStatus();
    const ac = new AbortController();
    inFlight = ac;
    try {
      const res = await fetch(OR_BASE, {
        method: "POST",
        signal: ac.signal,
        headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://simlab.local", "X-Title": "SimLab KIRA" },
        body: JSON.stringify(payload)
      });
      const txt = await res.text();
      state.request.lastRaw = txt;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 240)}`);
      const packet = parseStrictJson(txt);
      const content = packet && packet.choices && packet.choices[0] && packet.choices[0].message && packet.choices[0].message.content;
      if (!content) throw new Error("No message content");
      const obj = parseStrictJson(content);
      lastCallAt = now();
      return obj;
    } finally {
      state.request.busy = false;
      inFlight = null;
      updateStatus();
    }
  }

  function compactStateSummary() {
    const top = state.individuals.filter((x) => x.alive).slice(0, 12).map((x) => ({ id: x.id, display_name: x.display_name, country: x.country, face_known: !!x.face_known, real_name_verified: !!x.real_name_verified, influence: +x.influence.toFixed(1), morality: +x.morality.toFixed(1) }));
    const inv = state.investigators.map((i) => ({ id: i.id, style: i.style, alertness: +i.beliefs.alertness.toFixed(2), top_geo: i.focus_geo_bucket }));
    const events = state.feeds.events.slice(-5).map((e) => ({ id: e.id, s: trimText(e.summary || "", 80) }));
    return { time: state.time, suspicion: state.suspicion, publicSupport: state.publicSupport, crackdownRisk: state.crackdownRisk, cult: state.kiraCult, eyeDealActive: state.eyeDealActive, people: top, investigators: inv, recent_events: events, countries: CANON_COUNTRIES, geo_buckets: GEO_BUCKETS };
  }

  function buildMessages(schemaId, actionPayload) {
    return [
      { role: "system", content: WORLD_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({ requested_schema_id: schemaId, current_time: state.time, summary: compactStateSummary(), action: actionPayload || null, reminder: "OUTPUT JSON ONLY. MUST INCLUDE ALL REQUIRED KEYS." })
      }
    ];
  }

  function validateSchema(schemaId, obj) {
    const o = obj && typeof obj === "object" ? obj : {};
    const w = [];
    if (o.schema_id !== schemaId) w.push(`schema mismatch ${o.schema_id}`);
    if (!o.time) o.time = { year: state.time.year, month: state.time.month };
    const arrKey = (k) => {
      if (!Array.isArray(o[k])) {
        o[k] = [];
        w.push(`${k} defaulted`);
      }
    };
    if (schemaId === "WORLD_GEN_MONTHLY_V1") {
      ["new_individuals", "updated_individuals", "crime_events", "world_events", "news_feed", "social_feed"].forEach(arrKey);
      if (!o.investigator_update) o.investigator_update = { summary: "", updates: [] };
      if (!o.month_deltas) o.month_deltas = { public_support_delta: 0, crackdown_risk_delta: 0 };
      if (typeof o.notes_for_player !== "string") o.notes_for_player = "";
    }
    if (schemaId === "WORLD_GEN_DEATH_V1") {
      if (!o.death) o.death = { cause: "cardiac arrest", plausibility: 0.5, publicness: 0.5, country: "Other", geo_bucket: "Other" };
      if (!o.deltas) o.deltas = { public_support_delta: 0, suspicion_delta: 0, investigator_alertness_delta: 0, copycat_activity_delta: 0, crackdown_risk_delta: 0 };
      if (!o.effects) o.effects = { news_item: null, social_items: [], investigator_brief: null, secondary_events: [], flags: { crackdown_triggered: false, new_task_force_formed: false } };
    }
    if (schemaId === "WORLD_GEN_PROFILE_V1") {
      if (!o.discovery) o.discovery = { face_known_delta: 0, real_name_verified_delta: 0, new_aliases: [], new_affiliations: [], new_crimes: [], evidence_quality_delta: 0, visibility_deltas: { media: 0, law: 0, underground: 0 }, notes: "" };
      if (typeof o.intel_snippet !== "string") o.intel_snippet = "";
    }
    if (schemaId === "WORLD_GEN_PSYOPS_V1") {
      if (!o.action) o.action = { type: "misdirection", target: "", message: "", resources_spent: { money: 0, influence: 0 } };
      if (!o.deltas) o.deltas = { public_support_delta: 0, suspicion_delta: 0, crackdown_risk_delta: 0, investigator_alertness_delta: 0 };
      if (!o.effects) o.effects = { news_item: null, social_items: [], investigator_brief: null, flags: { backfire: false, new_leak_thread: false } };
    }
    return { obj: o, warning: w.join("; ") };
  }

  function applyMonthlyIncomeAndTime() {
    const inc = calcMonthlyIncome();
    state.money += inc.money;
    state.influence = clamp(state.influence + inc.influence, 0, 100);
    state.lifespanMonths = Math.max(0, state.lifespanMonths - 1);
    state.time.month += 1;
    if (state.time.month > 12) {
      state.time.month = 1;
      state.time.year += 1;
    }
    state.actionsLeft = 1;
    state.monthUsedAction = false;
  }

  function applyIndividualsMerge(newIndividuals, updates) {
    for (let i = 0; i < newIndividuals.length; i++) {
      const n = newIndividuals[i] || {};
      const id = typeof n.id === "string" && n.id.startsWith("ind_") ? n.id : makeId("ind", state.individuals.length + 100 + i);
      if (state.individuals.some((x) => x.id === id)) continue;
      const country = CANON_COUNTRIES.includes(n.country) ? n.country : "Other";
      state.individuals.push({
        id,
        display_name: n.display_name || "Unknown",
        real_name: n.real_name || n.display_name || "Unknown",
        real_name_verified: !!n.real_name_verified,
        face_known: !!n.face_known,
        country,
        geo_bucket: GEO_BUCKETS.includes(n.geo_bucket) ? n.geo_bucket : inferGeo(country),
        role: n.role || "unknown",
        affiliations: Array.isArray(n.affiliations) ? n.affiliations.slice(0, 6) : [],
        influence: clamp(toFloat(n.influence, 3), 0, 10),
        morality: clamp(toFloat(n.morality, 5), 0, 10),
        headline_crimes: Array.isArray(n.headline_crimes) ? n.headline_crimes.slice(0, 6) : [],
        evidence_quality: clamp(toFloat(n.evidence_quality, 0.2), 0, 1),
        visibility: { media: clamp(toFloat(n.visibility && n.visibility.media, 0.2), 0, 1), law: clamp(toFloat(n.visibility && n.visibility.law, 0.2), 0, 1), underground: clamp(toFloat(n.visibility && n.visibility.underground, 0.2), 0, 1) },
        flags: { protected: false, public_figure: false, masked_identity: false, uses_alias: false, bait: false },
        alive: true,
        createdMonthAbs: monthAbs(state.time.year, state.time.month),
        lastMentionMonthAbs: monthAbs(state.time.year, state.time.month),
        notes: ""
      });
    }
    for (let i = 0; i < updates.length; i++) {
      const up = updates[i] || {};
      const p = state.individuals.find((x) => x.id === up.id || x.id === up.individual_id);
      if (!p) continue;
      if (typeof up.face_known === "boolean") p.face_known = up.face_known;
      if (typeof up.real_name_verified === "boolean") p.real_name_verified = up.real_name_verified;
      if (typeof up.real_name === "string" && up.real_name) p.real_name = up.real_name;
      if (Array.isArray(up.new_crimes)) p.headline_crimes = [...new Set([...(p.headline_crimes || []), ...up.new_crimes])].slice(0, 8);
      if (Array.isArray(up.new_affiliations)) p.affiliations = [...new Set([...(p.affiliations || []), ...up.new_affiliations])].slice(0, 8);
      if (up.visibility_deltas) {
        p.visibility.media = clamp(p.visibility.media + toFloat(up.visibility_deltas.media, 0), 0, 1);
        p.visibility.law = clamp(p.visibility.law + toFloat(up.visibility_deltas.law, 0), 0, 1);
        p.visibility.underground = clamp(p.visibility.underground + toFloat(up.visibility_deltas.underground, 0), 0, 1);
      }
      p.lastMentionMonthAbs = monthAbs(state.time.year, state.time.month);
    }
  }

  function applyMonthlyTick(obj) {
    const dPub = clamp(toInt(obj.month_deltas.public_support_delta, 0), -20, 20);
    const dCrack = clamp(toInt(obj.month_deltas.crackdown_risk_delta, 0), -15, 15);
    state.publicSupport = clamp(state.publicSupport + dPub, -100, 100);
    state.crackdownRisk = clamp(state.crackdownRisk + dCrack, 0, 100);
    applyIndividualsMerge(obj.new_individuals, obj.updated_individuals);
    capPush(state.feeds.news, (obj.news_feed || []).map(normNews), 120);
    capPush(state.feeds.social, (obj.social_feed || []).map(normSocial), 120);
    capPush(state.feeds.crimes, (obj.crime_events || []).map(normCrime), 120);
    capPush(state.feeds.events, (obj.world_events || []).map(normEvent), 120);
    if (obj.notes_for_player) state.chat.push({ id: `chat_${now()}`, side: "left", text: trimText(obj.notes_for_player, 220), details: "Monthly assessment" });
  }

  function applyIntelResult(obj, targetId) {
    const t = state.individuals.find((x) => x.id === targetId);
    if (!t) return;
    const d = obj.discovery || {};
    if (toInt(d.face_known_delta, 0) > 0 || state.eyeDealActive) t.face_known = true;
    if (toInt(d.real_name_verified_delta, 0) > 0 || state.eyeDealActive) t.real_name_verified = true;
    if (Array.isArray(d.new_aliases)) t.aliases = [...new Set([...(t.aliases || []), ...d.new_aliases])].slice(0, 6);
    if (Array.isArray(d.new_affiliations)) t.affiliations = [...new Set([...(t.affiliations || []), ...d.new_affiliations])].slice(0, 8);
    if (Array.isArray(d.new_crimes)) t.headline_crimes = [...new Set([...(t.headline_crimes || []), ...d.new_crimes])].slice(0, 8);
    t.evidence_quality = clamp(t.evidence_quality + clamp(toFloat(d.evidence_quality_delta, 0), -0.3, 0.3), 0, 1);
    state.chat.push({ id: `chat_${now()}`, side: "left", text: trimText(obj.intel_snippet || "Intel packet returned.", 280), details: trimText(d.notes || "", 200) });
  }

  function applyPsyopsResult(obj) {
    const d = obj.deltas || {};
    state.publicSupport = clamp(state.publicSupport + clamp(toInt(d.public_support_delta, 0), -20, 20), -100, 100);
    state.crackdownRisk = clamp(state.crackdownRisk + clamp(toInt(d.crackdown_risk_delta, 0), -15, 15), 0, 100);
    state.suspicion = clamp(state.suspicion + clamp(toInt(d.suspicion_delta, 0), -6, 6), 0, 100);
    if (obj.effects && obj.effects.news_item) capPush(state.feeds.news, [normNews(obj.effects.news_item)], 120);
    if (obj.effects && obj.effects.social_items) capPush(state.feeds.social, obj.effects.social_items.map(normSocial), 120);
    state.chat.push({ id: `chat_${now()}`, side: "left", text: "Social operation resolved.", details: obj.effects && obj.effects.investigator_brief ? trimText(JSON.stringify(obj.effects.investigator_brief), 220) : "" });
  }

  function calcSuspicionMetrics() {
    const kills = state.killRecords.slice(-30);
    if (!kills.length) {
      state.stats = { Hc: 1, Hg: 1, Ht: 1, R: 0, PSS: 0, maxCauseShare: 0, pressure: state.stats.pressure || 0 };
      return state.stats;
    }
    const cause = {}, geo = {}, timing = {}, cls = {};
    let sumPlaus = 0, sumInf = 0, sumMor = 0;
    let lastT = null;
    for (let i = 0; i < kills.length; i++) {
      const k = kills[i];
      cause[k.causeTag] = (cause[k.causeTag] || 0) + 1;
      geo[k.geo_bucket] = (geo[k.geo_bucket] || 0) + 1;
      const infBin = k.victimInfluence < 3.4 ? "l" : k.victimInfluence < 6.8 ? "m" : "h";
      const morBin = k.victimMorality < 3.4 ? "l" : k.victimMorality < 6.8 ? "m" : "h";
      cls[`${infBin}${morBin}`] = (cls[`${infBin}${morBin}`] || 0) + 1;
      if (lastT != null) {
        const dt = Math.max(0, k.tMonthAbs - lastT);
        const b = dt === 0 ? "0" : dt === 1 ? "1" : dt === 2 ? "2" : dt <= 4 ? "3-4" : dt <= 7 ? "5-7" : dt <= 12 ? "8-12" : dt <= 20 ? "13-20" : "21+";
        timing[b] = (timing[b] || 0) + 1;
      }
      lastT = k.tMonthAbs;
      sumPlaus += k.plausibility;
      sumInf += k.victimInfluence;
      sumMor += k.victimMorality;
    }
    const Hc = entropyNorm(cause);
    const Hg = entropyNorm(geo);
    const Ht = Object.keys(timing).length ? entropyNorm(timing) : 1;
    const intervals = [];
    for (let i = 1; i < kills.length; i++) intervals.push(Math.max(0, kills[i].tMonthAbs - kills[i - 1].tMonthAbs));
    const mu = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    const sigma = intervals.length ? Math.sqrt(intervals.reduce((a, b) => a + (b - mu) * (b - mu), 0) / intervals.length) : 0;
    const cv = mu > 0.0001 ? sigma / mu : 2;
    const R = clamp01(1 - cv / 0.9);
    const avgInf = sumInf / kills.length;
    const avgMor = sumMor / kills.length;
    const Sinf = clamp01((avgInf - 4.0) / 6);
    const Sjust = clamp01((avgMor - 5.0) / 5);
    const maxCauseShare = Math.max(...Object.values(cause)) / kills.length;
    const avgP = sumPlaus / kills.length;
    const PSS = clamp01((0.30 * (1 - Hc) + 0.20 * (1 - Hg) + 0.10 * (1 - Ht) + 0.15 * R + 0.10 * Sinf + 0.10 * maxCauseShare + 0.25 * (1 - avgP)) / 1.4);
    state.stats = { Hc, Hg, Ht, R, PSS, maxCauseShare, Sinf, Sjust, avgPlausibility: avgP, pressure: state.stats.pressure || 0 };
    return state.stats;
  }

  function computePressure() {
    const v = state.investigators.reduce((a, inv) => a + 0.5 * inv.beliefs.alertness + 0.5 * inv.beliefs.surveillance, 0) / Math.max(1, state.investigators.length);
    state.stats.pressure = clamp01(v);
    return state.stats.pressure;
  }

  function applyLocalSuspicionForKill(kill, modelDelta) {
    const m = calcSuspicionMetrics();
    const pressure = computePressure();
    const base = 2;
    const pattern = Math.round(18 * Math.pow(m.PSS, 1.2));
    const plaus = Math.round(10 * Math.pow(1 - m.avgPlausibility, 1.6));
    const pub = Math.round(6 * Math.pow(kill.publicness, 1.1));
    const disp = -Math.round(10 * m.Hg);
    const causeRel = -Math.round(8 * m.Hc);
    const irregRel = -Math.round(6 * (1 - m.R));
    let dLocal = clamp(base + pattern + plaus + pub + disp + causeRel + irregRel, -8, 30);
    if (state.publicSupport > 40) dLocal *= 0.85;
    if (state.publicSupport < -40) dLocal *= 1.15;
    dLocal *= 1 + 0.35 * pressure;
    const dModel = clamp(toInt(modelDelta, 0), -6, 6);
    const final = clamp(Math.round(dLocal + dModel), -10, 35);
    state.suspicion = clamp(state.suspicion + final, 0, 100);
    return final;
  }

  function applyCoolingNoKill() {
    const pressure = computePressure();
    const base = pressure > 0.65 || state.crackdownRisk > 65 ? 0 : pressure > 0.4 || state.crackdownRisk > 45 ? 1 : 2;
    state.suspicion = clamp(state.suspicion - base, 0, 100);
  }

  function investigatorUpdate(killOccurred, killGeo) {
    const metrics = calcSuspicionMetrics();
    const obs = {
      killOccurred,
      PSS: metrics.PSS,
      Hc: metrics.Hc,
      Hg: metrics.Hg,
      Ht: metrics.Ht,
      R: metrics.R,
      maxCauseShare: metrics.maxCauseShare || 0,
      Sinf: metrics.Sinf || 0,
      Sjust: metrics.Sjust || 0,
      plausibilityAvg: metrics.avgPlausibility || 0.5,
      killGeoBucket: killGeo || "Other",
      publicSupport: state.publicSupport,
      killFreqHigh: state.killRecords.slice(-6).length >= 4 ? 1 : 0
    };

    const sigmoid = (x) => 1 / (1 + Math.exp(-x));
    const logit = (p) => Math.log(clamp(p, 0.001, 0.999) / (1 - clamp(p, 0.001, 0.999)));

    for (let i = 0; i < state.investigators.length; i++) {
      const inv = state.investigators[i];
      const styleMul = inv.style === "statistical" ? 1.2 : inv.style === "logical/minimalist" ? 0.8 : inv.style === "behavioural" ? 0.9 : 1.0;
      const e = {
        pattern: clamp((obs.PSS - 0.5) * 2, -1, 1),
        cause: clamp((obs.maxCauseShare - 0.35) * 2.2, -1, 1),
        geo: clamp((0.65 - obs.Hg) * 2, -1, 1),
        reg: clamp((obs.R - 0.5) * 2, -1, 1),
        infl: clamp((obs.Sinf - 0.4) * 2, -1, 1),
        moral: clamp((obs.Sjust - 0.4) * 2, -1, 1),
        plausLow: clamp((0.7 - obs.plausibilityAvg) * 2, -1, 1)
      };
      const sig = inv.beliefs.signature;
      sig.pattern_driven = sigmoid(logit(sig.pattern_driven) + styleMul * 0.5 * e.pattern + inv.beliefs.patternWeightBoost * 0.2);
      sig.cause_control = sigmoid(logit(sig.cause_control) + styleMul * 0.45 * e.cause);
      sig.influence_seeking = sigmoid(logit(sig.influence_seeking) + styleMul * 0.35 * e.infl);
      sig.moral_crusade = sigmoid(logit(sig.moral_crusade) + styleMul * 0.35 * e.moral);

      const H = inv.beliefs.H;
      const coh = 0.5 * sig.pattern_driven + 0.3 * sig.cause_control + 0.2 * (1 - obs.Hc);
      const chaos = 0.5 * obs.Hc + 0.3 * obs.Hg + 0.2 * (1 - obs.R);
      const ll = {
        single_actor: +1.0 * coh + 0.3 * e.geo + 0.2 * e.reg - 0.6 * chaos,
        group: +0.4 * coh + 0.6 * chaos + 0.2 * obs.killFreqHigh - 0.2 * e.reg,
        copycats: +0.8 * chaos + 0.2 * (state.publicSupport > 50 ? 0.3 : 0) - 0.3 * coh,
        hoax: +0.8 * (!killOccurred ? 0.4 : 0) - 0.8 * coh - 0.5 * e.plausLow
      };
      const eta = 0.5;
      const h2 = {};
      let z = 0;
      Object.keys(H).forEach((k) => {
        h2[k] = H[k] * Math.exp(eta * ll[k]);
        z += h2[k];
      });
      Object.keys(H).forEach((k) => (H[k] = h2[k] / (z || 1)));
      inv.current_hypotheses = Object.keys(H).sort((a, b) => H[b] - H[a]).slice(0, 2);

      const geo = inv.beliefs.geo;
      if (killOccurred && killGeo) {
        const a = clamp01((0.8 - obs.Hg) / 0.8);
        GEO_BUCKETS.forEach((g) => {
          geo[g] *= Math.exp((g === killGeo ? 1 : -0.15) * a);
        });
      } else {
        GEO_BUCKETS.forEach((g) => {
          geo[g] = geo[g] * 0.98 + (1 / GEO_BUCKETS.length) * 0.02;
        });
      }
      let zGeo = 0;
      GEO_BUCKETS.forEach((g) => (zGeo += geo[g]));
      GEO_BUCKETS.forEach((g) => (geo[g] /= zGeo || 1));
      inv.focus_geo_bucket = GEO_BUCKETS.sort((a, b) => geo[b] - geo[a])[0];

      pickInvestigatorAction(inv);
    }
    computePressure();
  }

  function pickInvestigatorAction(inv) {
    const feasAuthoritarian = clamp01(0.5 - state.publicSupport / 200);
    const feasPsyops = clamp01(0.6 + Math.abs(state.publicSupport) / 200);
    const scores = {
      pattern_tasking: inv.beliefs.signature.pattern_driven * 0.8 + inv.beliefs.resources * 0.2,
      regional_crackdown: inv.beliefs.geo[inv.focus_geo_bucket] * 0.9 + feasAuthoritarian * 0.6,
      psyops: feasPsyops * 0.8 + (1 - inv.credibility) * 0.2,
      leak_bait: 0.4 + inv.beliefs.alertness * 0.4,
      international_coordination: 0.3 + state.crackdownRisk / 130,
      quiet_watch: 0.2 + (1 - inv.beliefs.resources) * 0.6
    };
    const pick = Object.keys(scores).sort((a, b) => scores[b] - scores[a] + (rnd() - 0.5) * 0.02)[0];
    inv.lastAction = pick;
    if (pick === "pattern_tasking") {
      inv.beliefs.alertness = clamp01(inv.beliefs.alertness + 0.07);
      inv.beliefs.patternWeightBoost = clamp01((inv.beliefs.patternWeightBoost || 0) + 0.15);
    } else if (pick === "regional_crackdown") {
      inv.beliefs.surveillance = clamp01(inv.beliefs.surveillance + 0.08);
      state.crackdownRisk = clamp(state.crackdownRisk + 1, 0, 100);
    } else if (pick === "psyops") {
      state.publicSupport = clamp(state.publicSupport + (state.publicSupport > 0 ? -2 : -1), -100, 100);
      inv.beliefs.psyops = clamp01(inv.beliefs.psyops + 0.06);
    } else if (pick === "leak_bait") {
      maybeInsertDecoys(1 + (rnd() > 0.75 ? 1 : 0));
    } else if (pick === "international_coordination") {
      inv.beliefs.surveillance = clamp01(inv.beliefs.surveillance + 0.05);
      state.crackdownRisk = clamp(state.crackdownRisk + 2, 0, 100);
    } else {
      inv.credibility = clamp01(inv.credibility + 0.04);
      inv.beliefs.resources = clamp01(inv.beliefs.resources + 0.05);
    }
  }

  function maybeInsertDecoys(n) {
    for (let i = 0; i < n; i++) {
      const id = makeId("ind", state.individuals.length + 200 + i);
      const c = CANON_COUNTRIES[(rnd() * (CANON_COUNTRIES.length - 1)) | 0] || "Other";
      state.individuals.push({
        id,
        display_name: `Profile ${id.slice(-4)}`,
        real_name: `Unknown ${id.slice(-4)}`,
        real_name_verified: false,
        face_known: true,
        country: c,
        geo_bucket: inferGeo(c),
        role: "public figure",
        affiliations: ["media"],
        influence: 6 + rnd() * 3,
        morality: 5 + rnd() * 3,
        headline_crimes: [],
        evidence_quality: 0.15,
        visibility: { media: 0.95, law: 0.65, underground: 0.2 },
        flags: { protected: false, public_figure: true, masked_identity: false, uses_alias: true, bait: true },
        alive: true,
        createdMonthAbs: monthAbs(state.time.year, state.time.month),
        lastMentionMonthAbs: monthAbs(state.time.year, state.time.month),
        notes: ""
      });
    }
  }

  function normNews(n) {
    return {
      id: n.id || `news_${Math.floor(now() % 1e8)}`,
      monthAbs: monthAbs(state.time.year, state.time.month),
      headline: trimText(n.headline || "Breaking development", 120),
      country: CANON_COUNTRIES.includes(n.country) ? n.country : "Other",
      geo_bucket: GEO_BUCKETS.includes(n.geo_bucket) ? n.geo_bucket : inferGeo(n.country),
      blurb: trimText(n.blurb || "", 260),
      tags: Array.isArray(n.tags) ? n.tags.slice(0, 5) : [],
      mentions: Array.isArray(n.mentions) ? n.mentions.slice(0, 5) : []
    };
  }
  function normSocial(s) {
    return {
      id: s.id || `soc_${Math.floor(now() % 1e8)}`,
      monthAbs: monthAbs(state.time.year, state.time.month),
      platform: s.platform || "x",
      trend: trimText(s.trend || "topic", 80),
      country: CANON_COUNTRIES.includes(s.country) ? s.country : "Other",
      geo_bucket: GEO_BUCKETS.includes(s.geo_bucket) ? s.geo_bucket : inferGeo(s.country),
      posts: Array.isArray(s.posts) ? s.posts.slice(0, 4).map((p) => trimText(p, 120)) : []
    };
  }
  function normCrime(c) {
    return {
      id: c.id || `evt_${Math.floor(now() % 1e8)}`,
      monthAbs: monthAbs(state.time.year, state.time.month),
      type: trimText(c.type || "crime", 64),
      severity: clamp(toInt(c.severity, 2), 1, 5),
      region: GEO_BUCKETS.includes(c.geo_bucket) ? c.geo_bucket : inferGeo(c.country),
      country: CANON_COUNTRIES.includes(c.country) ? c.country : "Other",
      summary: trimText(c.summary || "", 180),
      refs: Array.isArray(c.refs) ? c.refs.slice(0, 6) : []
    };
  }
  function normEvent(e) {
    return { id: e.id || `evt_${Math.floor(now() % 1e8)}`, monthAbs: monthAbs(state.time.year, state.time.month), type: trimText(e.type || "event", 64), country: CANON_COUNTRIES.includes(e.country) ? e.country : "Other", geo_bucket: GEO_BUCKETS.includes(e.geo_bucket) ? e.geo_bucket : inferGeo(e.country), summary: trimText(e.summary || "", 190) };
  }

  async function runMonthlyTick(actionMeta) {
    const req = {
      model: state.settings.worldModel,
      temperature: 0.25,
      max_tokens: 1200,
      messages: buildMessages("WORLD_GEN_MONTHLY_V1", actionMeta || { type: "stand_down" })
    };
    const raw = await callOpenRouter(req, "monthly");
    const { obj, warning } = validateSchema("WORLD_GEN_MONTHLY_V1", raw);
    if (warning) state.request.error = warning;
    applyMonthlyTick(obj);
    investigatorUpdate(!!actionMeta && actionMeta.type === "death", actionMeta && actionMeta.killGeo);
    if (!actionMeta || actionMeta.type !== "death") applyCoolingNoKill();
    applyMonthlyIncomeAndTime();
  }

  async function handleAdvanceMonth() {
    if (state.request.busy) return;
    try {
      await runMonthlyTick({ type: state.monthUsedAction ? "post_action" : "stand_down" });
      state.chat.push({ id: `chat_${now()}`, side: "system", text: `Advanced to ${fmtMonth(state.time.year, state.time.month)}.`, details: "" });
      checkEndStates();
    } catch (e) {
      state.request.error = e.message || String(e);
    }
    updateAllUi();
    safeSave();
  }

  async function handleIntel(preset) {
    if (state.request.busy || state.actionsLeft <= 0) return;
    const targetId = state.selectedId;
    const msg = (preset || (ui && ui.input && ui.input.value) || "").trim();
    if (!targetId) return;
    state.actionsLeft = 0;
    state.monthUsedAction = true;
    state.chat.push({ id: `chat_${now()}`, side: "right", text: msg || `Intel request on ${targetId}`, details: "" });
    try {
      const raw = await callOpenRouter({ model: state.settings.worldModel, temperature: 0.2, max_tokens: 900, messages: buildMessages("WORLD_GEN_PROFILE_V1", { target_individual_id: targetId, request_text: msg }) }, "intel");
      const { obj, warning } = validateSchema("WORLD_GEN_PROFILE_V1", raw);
      if (warning) state.request.error = warning;
      applyIntelResult(obj, targetId);
      if (state.autoAdvanceAfterAction) await runMonthlyTick({ type: "intel", targetId });
    } catch (e) {
      state.request.error = e.message || String(e);
      state.actionsLeft = 1;
      state.monthUsedAction = false;
    }
    checkEndStates();
    updateAllUi();
    safeSave();
  }

  async function handleSocial() {
    if (state.request.busy || state.actionsLeft <= 0) return;
    const msg = ((ui && ui.input && ui.input.value) || "").trim();
    if (!msg) return;
    const type = /leak/i.test(msg) ? "leak" : /propaganda/i.test(msg) ? "propaganda" : /frame/i.test(msg) ? "frame" : /threat/i.test(msg) ? "threat" : /bribe/i.test(msg) ? "bribe" : "misdirection";
    const spendMoney = clamp(Math.round(5000 + state.influence * 120), 0, state.money);
    const spendInfluence = clamp(Math.round(3 + state.influence * 0.06), 0, state.influence);
    state.money -= spendMoney;
    state.influence = clamp(state.influence - spendInfluence, 0, 100);
    state.actionsLeft = 0;
    state.monthUsedAction = true;
    state.chat.push({ id: `chat_${now()}`, side: "right", text: msg, details: `Psyops type: ${type}` });
    try {
      const raw = await callOpenRouter({ model: state.settings.worldModel, temperature: 0.3, max_tokens: 1000, messages: buildMessages("WORLD_GEN_PSYOPS_V1", { type, message: msg, target: state.selectedId || "public", resources_spent: { money: spendMoney, influence: spendInfluence } }) }, "psyops");
      const { obj, warning } = validateSchema("WORLD_GEN_PSYOPS_V1", raw);
      if (warning) state.request.error = warning;
      applyPsyopsResult(obj);
      investigatorUpdate(false);
      if (state.autoAdvanceAfterAction) await runMonthlyTick({ type: "psyops" });
    } catch (e) {
      state.request.error = e.message || String(e);
      state.actionsLeft = 1;
      state.monthUsedAction = false;
    }
    checkEndStates();
    updateAllUi();
    safeSave();
  }

  async function handleDeath(person, nameLine, cause, conditions) {
    if (state.request.busy || state.actionsLeft <= 0 || !person || !person.alive) return;
    if (!confirm(`Execute Death Note on ${person.display_name}?`)) return;
    const hasName = state.eyeDealActive || person.real_name_verified;
    const hasFace = state.eyeDealActive || person.face_known;
    const isBait = !!(person.flags && person.flags.bait);

    state.actionsLeft = 0;
    state.monthUsedAction = true;

    if ((!hasName || !hasFace) && !state.eyeDealActive) {
      const spike = isBait ? 24 : 16;
      state.suspicion = clamp(state.suspicion + spike, 0, 100);
      state.chat.push({ id: `chat_${now()}`, side: "system", text: "Death Note failed. Identity chain incomplete.", details: `Suspicion +${spike}` });
      investigatorUpdate(false);
      if (state.autoAdvanceAfterAction) await runMonthlyTick({ type: "failed_death" });
      updateAllUi();
      safeSave();
      return;
    }

    try {
      const payload = { victim_id: person.id, name_written: nameLine || person.real_name, cause, conditions, context: { country: person.country, geo_bucket: person.geo_bucket, influence: person.influence, morality: person.morality, bait: isBait } };
      const raw = await callOpenRouter({ model: state.settings.worldModel, temperature: 0.22, max_tokens: 1100, messages: buildMessages("WORLD_GEN_DEATH_V1", payload) }, "death");
      const { obj, warning } = validateSchema("WORLD_GEN_DEATH_V1", raw);
      if (warning) state.request.error = warning;

      const d = obj.deltas || {};
      const boundedModelSusp = clamp(toInt(d.suspicion_delta, 0), -6, 6);
      const plaus = clamp(toFloat(obj.death && obj.death.plausibility, 0.5), 0, 1);
      const pub = clamp(toFloat(obj.death && obj.death.publicness, 0.5), 0, 1);

      person.alive = false;
      const k = {
        tMonthAbs: monthAbs(state.time.year, state.time.month),
        country: person.country,
        geo_bucket: person.geo_bucket,
        causeTag: normalizeCauseTag(cause),
        victimInfluence: clamp(person.influence, 0, 10),
        victimMorality: clamp(person.morality, 0, 10),
        publicness: pub,
        plausibility: plaus
      };
      state.killRecords.push(k);
      if (state.killRecords.length > 200) state.killRecords.splice(0, state.killRecords.length - 200);

      const localDelta = applyLocalSuspicionForKill(k, boundedModelSusp + (isBait ? (state.eyeDealActive ? 12 : 20) : 0));
      state.publicSupport = clamp(state.publicSupport + clamp(toInt(d.public_support_delta, 0), -30, 30), -100, 100);
      state.crackdownRisk = clamp(state.crackdownRisk + clamp(toInt(d.crackdown_risk_delta, 0), -10, 10), 0, 100);
      if (obj.effects && obj.effects.news_item) capPush(state.feeds.news, [normNews(obj.effects.news_item)], 120);
      if (obj.effects && obj.effects.social_items) capPush(state.feeds.social, obj.effects.social_items.map(normSocial), 120);
      if (obj.effects && obj.effects.secondary_events) capPush(state.feeds.events, obj.effects.secondary_events.map(normEvent), 120);

      state.chat.push({ id: `chat_${now()}`, side: "system", text: `${person.display_name} is dead.`, details: `Local suspicion delta ${localDelta}.` });
      investigatorUpdate(true, person.geo_bucket);
      if (state.autoAdvanceAfterAction) await runMonthlyTick({ type: "death", killGeo: person.geo_bucket });
    } catch (e) {
      state.request.error = e.message || String(e);
      state.actionsLeft = 1;
      state.monthUsedAction = false;
    }
    checkEndStates();
    updateAllUi();
    safeSave();
  }

  async function retryLastCall() {
    if (!state.request.lastPayload || state.request.busy) return;
    state.chat.push({ id: `chat_${now()}`, side: "system", text: "Retry requested.", details: state.request.lastKind });
    updateChat();
  }

  function checkEndStates() {
    if (state.suspicion >= 100) state.chat.push({ id: `chat_${now()}`, side: "system", text: "END: Identified and captured.", details: "Suspicion reached 100." });
    if (state.lifespanMonths <= 0) state.chat.push({ id: `chat_${now()}`, side: "system", text: "END: Lifespan exhausted.", details: "" });
    if (state.crackdownRisk >= 100) state.chat.push({ id: `chat_${now()}`, side: "system", text: "END: Global clampdown.", details: "" });
    const monthsSurvived = monthAbs(state.time.year, state.time.month) - monthAbs(2026, 1);
    if (monthsSurvived >= 120 && state.publicSupport > 30 && state.suspicion < 60) {
      state.chat.push({ id: `chat_${now()}`, side: "system", text: "WIN: You endured a decade in control.", details: "" });
    }
  }

  function drawCanvas(realDt) {
    Engine.gfx.clearBlack();
    const c = Engine.getCtx();
    const { w, h } = Engine.getSize();
    state.visual.scanOffset = (state.visual.scanOffset + realDt * 18) % h;
    c.strokeStyle = "rgba(73,223,255,0.08)";
    c.lineWidth = 1;
    for (let i = 0; i < state.visual.lines.length; i++) {
      const l = state.visual.lines[i];
      const y = (l.y * h + state.visual.scanOffset * (0.2 + i * 0.01)) % h;
      c.globalAlpha = l.a;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y + Math.sin((y + state.visual.scanOffset) * 0.01) * l.s);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.fillStyle = "rgba(0,0,0,0.22)";
    c.fillRect(0, 0, w, 18);
    c.fillRect(0, h - 24, w, 24);

    const p = clamp01(state.stats.pressure || 0);
    c.strokeStyle = "rgba(155,92,255,0.6)";
    c.beginPath();
    c.moveTo(16, h - 14);
    c.lineTo(16 + p * (w - 32), h - 14);
    c.stroke();

    if (!uiRoot) {
      c.fillStyle = "#fff";
      c.font = "14px monospace";
      c.fillText("No UI root found", 12, 24);
      c.fillText(`Date ${fmtMonth(state.time.year, state.time.month)} Susp ${state.suspicion} Support ${state.publicSupport}`, 12, 46);
      c.fillText(`Crackdown ${state.crackdownRisk} Life ${state.lifespanMonths}m`, 12, 68);
      c.fillText("Use configured runner with uiRoot for full controls.", 12, 90);
    }
  }

  if (uiRoot) ensureUi();

  Engine.on("update", () => {
    if (state.lifespanMonths > 0 && state.suspicion < 100 && state.crackdownRisk < 100) {
      // intentionally light; turn-based simulation
    }
  });

  Engine.on("render", (realDt) => {
    drawCanvas(realDt);
  });

  Engine.on("onClick", () => {
    // keep hook registered per contract
  });

  Engine.on("onKeyDown", (e) => {
    if (!e) return;
    if (isTextInput(e.target)) return;
  });

  const uiTick = setInterval(() => {
    if (ui) {
      updateTopBar();
      updateMetrics();
      updateStatus();
    }
  }, 250);
  const autosave = setInterval(() => safeSave(), 10000);

  window.addEventListener("beforeunload", () => {
    safeSave();
    clearInterval(uiTick);
    clearInterval(autosave);
    if (inFlight) inFlight.abort();
  });
}
