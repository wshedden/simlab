import { Engine } from "../engine/engine.js";

const SAVE_KEY = "simlab.neonVenture.v1";

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function nowMs() { return Date.now(); }
function safeInt(n, fallback = 0) {
  const x = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return x;
}

/* ----------------------------- Big Number ----------------------------- */
/**
 * Big = { m, e } meaning m * 10^e, with m in [1,10) (or 0).
 * Optimised for incremental games: stable, fast, readable, safe.
 */
function B(m = 0, e = 0) { return { m, e }; }

function bIsZero(a) { return !a || a.m === 0 || !Number.isFinite(a.m) || !Number.isFinite(a.e); }

function bNorm(a) {
  if (!a || !Number.isFinite(a.m) || !Number.isFinite(a.e)) return B(0, 0);
  if (a.m === 0) return B(0, 0);

  let m = a.m;
  let e = Math.trunc(a.e);

  const sign = m < 0 ? -1 : 1;
  m = Math.abs(m);

  if (m === 0) return B(0, 0);

  // keep m in [1,10)
  const log10 = Math.log10(m);
  if (Number.isFinite(log10)) {
    const shift = Math.floor(log10);
    m = m / Math.pow(10, shift);
    e += shift;
  }

  // guard against rounding drift
  while (m >= 10) { m /= 10; e += 1; }
  while (m < 1 && m > 0) { m *= 10; e -= 1; }

  m *= sign;
  if (!Number.isFinite(m) || !Number.isFinite(e)) return B(0, 0);
  if (m === 0) return B(0, 0);
  return { m, e };
}

function bFromNumber(n) {
  if (!Number.isFinite(n) || n <= 0) return B(0, 0);
  const e = Math.floor(Math.log10(n));
  const m = n / Math.pow(10, e);
  return bNorm(B(m, e));
}

function bClone(a) { return a ? { m: a.m, e: a.e } : B(0, 0); }

function bCmp(a, b) {
  a = bNorm(a); b = bNorm(b);
  const az = bIsZero(a), bz = bIsZero(b);
  if (az && bz) return 0;
  if (az) return -1;
  if (bz) return 1;
  // only support non-negative money values here; clamp negatives away
  const am = a.m < 0 ? 0 : a.m;
  const bm = b.m < 0 ? 0 : b.m;
  const ae = a.e, be = b.e;
  if (ae !== be) return ae < be ? -1 : 1;
  if (am === bm) return 0;
  return am < bm ? -1 : 1;
}

function bAdd(a, b) {
  a = bNorm(a); b = bNorm(b);
  if (bIsZero(a)) return bClone(b);
  if (bIsZero(b)) return bClone(a);

  // Only non-negative expected for core currencies; if negatives slip in, clamp later.
  const ae = a.e, be = b.e;
  let hi = a, lo = b;
  if (be > ae) { hi = b; lo = a; }

  const de = hi.e - lo.e;
  if (de > 12) return bClone(hi); // too small to matter
  const m = hi.m + lo.m / Math.pow(10, de);
  return bNorm(B(m, hi.e));
}

function bSub(a, b) {
  // a - b, clamp at 0 if would go negative (for money/costs)
  a = bNorm(a); b = bNorm(b);
  if (bIsZero(b)) return bClone(a);
  if (bIsZero(a)) return B(0, 0);

  // if b >> a, result 0
  if (bCmp(a, b) <= 0) return B(0, 0);

  const ae = a.e, be = b.e;
  const de = ae - be;
  if (de > 12) return bClone(a); // b too tiny
  const m = a.m - b.m / Math.pow(10, de);
  return bNorm(B(m, a.e));
}

function bMul(a, b) {
  a = bNorm(a); b = bNorm(b);
  if (bIsZero(a) || bIsZero(b)) return B(0, 0);
  return bNorm(B(a.m * b.m, a.e + b.e));
}

function bDiv(a, b) {
  a = bNorm(a); b = bNorm(b);
  if (bIsZero(a)) return B(0, 0);
  if (bIsZero(b)) return B(0, 0);
  return bNorm(B(a.m / b.m, a.e - b.e));
}

function bMulScalar(a, s) {
  a = bNorm(a);
  if (bIsZero(a) || !Number.isFinite(s) || s === 0) return B(0, 0);
  return bNorm(B(a.m * s, a.e));
}

function bPow10(exp) {
  if (!Number.isFinite(exp)) return B(0, 0);
  if (exp < -999999999) return B(0, 0);
  const e = Math.floor(exp);
  const frac = exp - e;
  const m = Math.pow(10, frac);
  return bNorm(B(m, e));
}

function bLog10(a) {
  a = bNorm(a);
  if (bIsZero(a) || a.m <= 0) return -Infinity;
  return Math.log10(a.m) + a.e;
}

const SUFFIXES = [
  "", "K", "M", "B", "T",
  "Qa", "Qi", "Sx", "Sp", "Oc", "No",
  "Dc", "Ud", "Dd", "Td", "Qad", "Qid",
  "Sxd", "Spd", "Ocd", "Nod",
];

function fmtSuffix(a, decimals = 2) {
  a = bNorm(a);
  if (bIsZero(a) || a.m <= 0) return "0";
  const e = a.e;
  if (e < 3) {
    // render as normal number if small
    const n = a.m * Math.pow(10, e);
    if (!Number.isFinite(n)) return fmtSci(a, decimals);
    return n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2);
  }
  const tier = Math.floor(e / 3);
  const idx = clamp(tier, 0, SUFFIXES.length - 1);
  if (tier >= SUFFIXES.length) return fmtSci(a, decimals);
  const rem = e - tier * 3;
  const v = a.m * Math.pow(10, rem);
  const d = v >= 100 ? 0 : v >= 10 ? 1 : decimals;
  return `${v.toFixed(d)}${SUFFIXES[idx]}`;
}

function fmtSci(a, decimals = 2) {
  a = bNorm(a);
  if (bIsZero(a) || a.m <= 0) return "0";
  const d = a.e >= 6 ? decimals : 3;
  return `${a.m.toFixed(d)}e${a.e}`;
}

function fmtMoney(a, notation, decimals = 2) {
  return notation === "sci" ? fmtSci(a, decimals) : fmtSuffix(a, decimals);
}

function bToJSON(a) {
  a = bNorm(a);
  return { m: a.m, e: a.e };
}
function bFromJSON(o) {
  if (!o || !Number.isFinite(o.m) || !Number.isFinite(o.e)) return B(0, 0);
  return bNorm(B(o.m, o.e));
}

// Parse a human-friendly amount string into a Number (not Big). Supports:
// - plain numbers (commas allowed)
// - scientific notation like 1e6
// - suffixes K/M/B/T (case-insensitive)
function parseFriendlyAmount(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().replace(/,/g, "");
  if (s === "") return null;
  // scientific / plain number
  const sci = Number(s);
  if (Number.isFinite(sci)) return sci;
  // suffix handling
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([kmbtq])?$/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suf = (m[2] || "").toLowerCase();
  const mul = suf === "k" ? 1e3 : suf === "m" ? 1e6 : suf === "b" ? 1e9 : suf === "t" ? 1e12 : suf === "q" ? 1e15 : 1;
  return n * mul;
}

/* ----------------------------- Game Data ----------------------------- */

const BUSINESS_TEMPLATES = [
  { id: "lemon",    name: "Lemon Stand",      sigil: "🍋", baseCost: 4,        growth: 1.14, baseProfit: 1.2,        baseCycle: 1.5 },
  { id: "coffee",   name: "Coffee Cart",      sigil: "☕", baseCost: 60,       growth: 1.145, baseProfit: 12,        baseCycle: 2.0 },
  { id: "truck",    name: "Food Truck",       sigil: "🚚", baseCost: 720,      growth: 1.15, baseProfit: 90,        baseCycle: 3.2 },
  { id: "arcade",   name: "Arcade",           sigil: "🕹️", baseCost: 9200,     growth: 1.155, baseProfit: 720,      baseCycle: 5.0 },
  { id: "datac",    name: "Data Centre",      sigil: "🗄️", baseCost: 120000,   growth: 1.16, baseProfit: 5400,     baseCycle: 7.5 },
  { id: "bank",     name: "Bank",             sigil: "🏦", baseCost: 1.7e6,    growth: 1.165, baseProfit: 42000,    baseCycle: 10.0 },
  { id: "biotech",  name: "Biotech Lab",      sigil: "🧬", baseCost: 2.5e7,    growth: 1.17, baseProfit: 330000,   baseCycle: 13.0 },
  { id: "orbital",  name: "Orbital Mining",   sigil: "🛰️", baseCost: 3.9e8,    growth: 1.175, baseProfit: 2.6e6,    baseCycle: 16.0 },
  { id: "quant",    name: "Quantum Exchange", sigil: "🧊", baseCost: 6.2e9,    growth: 1.18, baseProfit: 2.1e7,    baseCycle: 20.0 },
  { id: "dyson",    name: "Dyson Swarm",      sigil: "🟣", baseCost: 1.1e11,   growth: 1.185, baseProfit: 1.7e8,    baseCycle: 25.0 },
];

const MILESTONES = [25, 50, 100, 200, 500, 1000];
// deterministic effects by milestone index
const MS_PROFIT = [2, 2, 2.5, 3, 5, 10];
const MS_CYCLE  = [0.9, 0.9, 0.85, 0.8, 0.75, 0.7];

function makeDefaultState() {
  return {
    v: 1,
    money: B(5, 0),
    lifetime: B(0, 0),
    bestIncomeSec: B(0, 0),
    playtimeSec: 0,

    influence: 0,
    influenceSpent: 0,
    meta: {
      // meta upgrades by id -> level
      xProfit: 0, // +5% per level
      xCycle: 0,  // -2% per level (multiplicative)
      xManager: 0 // manager cost -3% per level
    },

    settings: {
      notation: "suffix", // "suffix" | "sci"
      buyMode: "x1", // x1 x10 x100 max
      paused: false,
    },

    businesses: BUSINESS_TEMPLATES.map(t => ({
      id: t.id,
      owned: 0,
      manager: false,
      running: false,
      prog: 0, // 0..1
      // NOTE: effects are computed, not stored
    })),

    upgradesPurchased: {},

    lastKnownIncomeSec: B(0, 0),
    lastSaveMs: nowMs(),
  };
}

/* ----------------------------- Maths helpers for costs ----------------------------- */

function costAtOwned(baseCostBig, growth, owned) {
  // cost = baseCost * growth^owned
  // compute growth^owned in log10 space to avoid overflow: 10^(owned*log10(growth))
  const exp = owned * Math.log10(growth);
  const gp = bPow10(exp);
  return bMul(baseCostBig, gp);
}

function totalCostForK(baseCostBig, growth, owned, k) {
  // sum_{i=0..k-1} baseCost*growth^(owned+i) = c0 * (growth^k - 1)/(growth - 1)
  if (k <= 0) return B(0, 0);
  const c0 = costAtOwned(baseCostBig, growth, owned);
  const exp = k * Math.log10(growth);
  const gk = bPow10(exp);
  const numerator = bSub(gk, B(1, 0)); // gk - 1
  const denom = (growth - 1);
  if (!(denom > 0) || !Number.isFinite(denom)) return bMulScalar(c0, k);
  const frac = bMulScalar(numerator, 1 / denom);
  return bMul(c0, frac);
}

function maxAffordableK(money, baseCostBig, growth, owned) {
  // Solve: money >= c0 * (g^k - 1)/(g - 1)
  // => g^k <= 1 + money*(g-1)/c0
  const c0 = costAtOwned(baseCostBig, growth, owned);
  if (bIsZero(c0) || bCmp(money, c0) < 0) return 0;

  const gMinus = growth - 1;
  if (!(gMinus > 0) || !Number.isFinite(gMinus)) return 0;

  const logMoney = bLog10(money);
  const logC0 = bLog10(c0);
  const logRatio = logMoney + Math.log10(gMinus) - logC0; // log10(money*(g-1)/c0)
  const lg = Math.log10(growth);
  if (!(lg > 0) || !Number.isFinite(lg)) return 0;

  let k = 0;
  if (logRatio < 6) {
    // ratio small enough to compute in Number
    const ratio = Math.pow(10, logRatio);
    const rhs = 1 + ratio;
    k = Math.floor(Math.log(rhs) / Math.log(growth));
  } else {
    // 1 negligible
    k = Math.floor(logRatio / lg);
  }
  if (!Number.isFinite(k) || k < 0) k = 0;
  return clamp(k, 0, 1_000_000);
}

/* ----------------------------- Upgrades ----------------------------- */

function makeUpgrades() {
  // keep ~60ish total: globals + per-business packs at triggers
  const ups = [];

  // globals
  const g = (id, name, desc, cost, effect) => ups.push({
    id, name, desc, cost: bFromNumber(cost),
    kind: "global",
    tag: "Global",
    req: (S) => true,
    apply: effect,
  });

  g("g_profit_1", "Neon Branding", "All profits ×1.5", 500, (E) => { E.globalProfit *= 1.5; });
  g("g_profit_2", "Aggressive Marketing", "All profits ×2", 25_000, (E) => { E.globalProfit *= 2.0; });
  g("g_profit_3", "Corporate Gravity", "All profits ×3", 2.5e6, (E) => { E.globalProfit *= 3.0; });
  g("g_profit_4", "Hyper-Exponential Sales", "All profits ×5", 6.0e8, (E) => { E.globalProfit *= 5.0; });

  g("g_cycle_1", "Tighter Schedules", "All cycle times -10%", 2_000, (E) => { E.globalCycle *= 0.9; });
  g("g_cycle_2", "Automation Pipelines", "All cycle times -15%", 120_000, (E) => { E.globalCycle *= 0.85; });
  g("g_cycle_3", "Realtime Ledger", "All cycle times -20%", 4.0e7, (E) => { E.globalCycle *= 0.8; });

  g("g_manager_1", "Recruiter AI", "Managers cost -15%", 15_000, (E) => { E.managerDiscount *= 0.85; });
  g("g_manager_2", "Talent Firewall", "Managers cost -20%", 7.5e6, (E) => { E.managerDiscount *= 0.8; });

  // business-specific packs
  BUSINESS_TEMPLATES.forEach((t, i) => {
    const bTag = t.name;
    const mk = (n, name, desc, cost, req, apply) => ups.push({
      id: `${t.id}_${n}`,
      name,
      desc,
      cost: bFromNumber(cost),
      kind: "biz",
      bizId: t.id,
      tag: bTag,
      req,
      apply,
    });

    // unlock via owned thresholds + money thresholds so it feels alive
    mk("u1", `${t.sigil} Prime Contract`, `${t.name} profits ×3`, t.baseCost * 40, (S) => S.bizOwned(t.id) >= 10, (E) => { E.bizProfit[t.id] = (E.bizProfit[t.id] || 1) * 3; });
    mk("u2", `${t.sigil} Neon Overclock`, `${t.name} cycle time -20%`, t.baseCost * 120, (S) => S.bizOwned(t.id) >= 25, (E) => { E.bizCycle[t.id] = (E.bizCycle[t.id] || 1) * 0.8; });
    mk("u3", `${t.sigil} Monopoly Angle`, `${t.name} profits ×7`, t.baseCost * 900, (S) => S.bizOwned(t.id) >= 50, (E) => { E.bizProfit[t.id] = (E.bizProfit[t.id] || 1) * 7; });
    mk("u4", `${t.sigil} Dark Pool Access`, `${t.name} profits ×12`, t.baseCost * 6500, (S) => S.bizOwned(t.id) >= 100, (E) => { E.bizProfit[t.id] = (E.bizProfit[t.id] || 1) * 12; });
    mk("u5", `${t.sigil} Post-Human Ops`, `${t.name} cycle time -35%`, t.baseCost * 22000, (S) => S.bizOwned(t.id) >= 200, (E) => { E.bizCycle[t.id] = (E.bizCycle[t.id] || 1) * 0.65; });

    // a money-gated one to create “oh nice” moments
    const gateMoney = Math.pow(10, 2 + i * 2); // escalating, but not too slow
    mk("u6", `${t.sigil} Viral Moment`, `${t.name} profits ×25`, t.baseCost * 120000, (S) => bCmp(S.money(), bFromNumber(gateMoney * t.baseCost)) >= 0, (E) => { E.bizProfit[t.id] = (E.bizProfit[t.id] || 1) * 25; });
  });

  // prestige meta upgrades (purchased with Influence)
  const meta = [
    { id: "m_profit", name: "Influence: Profit", desc: "Permanent +5% profits per level", baseCost: 5, costGrowth: 1.35, key: "xProfit" },
    { id: "m_cycle", name: "Influence: Cycle", desc: "Permanent -2% cycle time per level", baseCost: 8, costGrowth: 1.42, key: "xCycle" },
    { id: "m_mgr", name: "Influence: Managers", desc: "Permanent -3% manager costs per level", baseCost: 6, costGrowth: 1.38, key: "xManager" },
  ];

  return { ups, meta };
}

/* ----------------------------- UI Helpers ----------------------------- */

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function setText(node, text) {
  if (!node) return;
  if (node.textContent !== text) node.textContent = text;
}

function setDisabled(btn, dis) {
  if (!btn) return;
  btn.disabled = !!dis;
  if (dis) btn.classList.add("dis");
  else btn.classList.remove("dis");
}

function tooltipify(node, text) {
  if (!node) return;
  node.setAttribute("title", text);
}

/* ----------------------------- Game Module ----------------------------- */

export function startGame(ctx) {
  const canvasId = (ctx && ctx.canvasId) ? ctx.canvasId : "c";
  Engine.init({ canvasId });

  const c2d = Engine.getCtx();
  const size = Engine.getSize();

  const uiRoot = ctx && ctx.uiRoot ? ctx.uiRoot : null;

  // Fallback if uiRoot missing: show minimal canvas-only notice
  if (!uiRoot) {
    let blink = 0;
    Engine.on("update", (dt) => { blink = (blink + dt) % 2; });
    Engine.on("render", () => {
      Engine.gfx.clearBlack();
      const { w, h } = Engine.getSize();
      if (!c2d) return;
      c2d.save();
      c2d.fillStyle = "rgba(0,255,255,0.95)";
      c2d.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, sans-serif";
      const msg = "Neon Venture needs ctx.uiRoot (DOM).";
      c2d.fillText(msg, 20, 40);
      c2d.fillStyle = blink < 1 ? "rgba(255,0,255,0.9)" : "rgba(120,0,255,0.9)";
      c2d.fillText("Fix runner to pass uiRoot.", 20, 66);
      c2d.restore();
    });
    return;
  }

  // Build UI
  uiRoot.innerHTML = "";
  uiRoot.appendChild(el(`
    <div class="nvWrap">
      <style>
        .nvWrap{position:relative; color:#d7f7ff; font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif; padding:10px; user-select:none;}
        .nvTop{display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; margin-bottom:10px;}
        .nvMoney{font-size:28px; font-weight:800; letter-spacing:0.4px; color:#5ff; text-shadow:0 0 14px rgba(0,255,255,0.22);}
        .nvSub{display:flex; gap:10px; flex-wrap:wrap; align-items:center; opacity:0.95;}
        .pill{display:inline-flex; gap:8px; align-items:center; padding:6px 10px; border:1px solid rgba(140,255,255,0.22); border-radius:999px; background:rgba(0,0,0,0.55);}
        .pill b{color:#fff;}
        .nvRightTop{margin-left:auto; display:flex; gap:8px; align-items:center;}
        .nvInput{padding:6px 8px; border-radius:8px; border:1px solid rgba(140,255,255,0.14); background:rgba(0,0,0,0.45); color:#d7f7ff; font-size:12px; min-width:90px}
        .nvCheatBtn{padding:6px 10px; border-radius:8px}
        .nvLink{font-size:12px; opacity:0.85; color:#bff; text-decoration:none; border:1px solid rgba(140,255,255,0.18); padding:6px 10px; border-radius:10px; background:rgba(0,0,0,0.45);}
        .nvLink:hover{opacity:1;}
        .nvGrid{display:grid; grid-template-columns: 1.3fr 1fr; gap:10px; min-height: 65vh;}
        @media (max-width: 980px){ .nvGrid{grid-template-columns:1fr; } }
        .col{border:1px solid rgba(140,255,255,0.15); border-radius:14px; background:rgba(0,0,0,0.35); overflow:hidden;}
        .colHead{display:flex; justify-content:space-between; align-items:center; padding:10px 10px; border-bottom:1px solid rgba(140,255,255,0.12); background:rgba(0,0,0,0.45);}
        .colHead h3{margin:0; font-size:13px; letter-spacing:0.6px; text-transform:uppercase; opacity:0.9;}
        .buyModes{display:flex; gap:6px; flex-wrap:wrap;}
        .btn{cursor:pointer; border:1px solid rgba(140,255,255,0.18); background:rgba(0,0,0,0.55); color:#d7f7ff; padding:6px 10px; border-radius:10px; font-weight:700; font-size:12px;}
        .btn:hover{border-color:rgba(140,255,255,0.35);}
        .btn:active{transform:translateY(1px);}
        .btn.dis{opacity:0.45; cursor:not-allowed;}
        .btn.on{border-color:rgba(255,0,255,0.35); box-shadow:0 0 0 2px rgba(255,0,255,0.12) inset;}
        .list{max-height: calc(65vh - 40px); overflow:auto; padding:10px; display:flex; flex-direction:column; gap:10px;}
        .card{border:1px solid rgba(140,255,255,0.16); border-radius:14px; background:rgba(0,0,0,0.55); padding:10px;}
        .row{display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap;}
        .title{display:flex; gap:10px; align-items:center;}
        .sig{width:30px; height:30px; display:grid; place-items:center; border-radius:10px; background:rgba(0,255,255,0.08); border:1px solid rgba(0,255,255,0.16);}
        .nm{font-weight:900; color:#fff;}
        .meta{font-size:12px; opacity:0.92; display:flex; gap:10px; flex-wrap:wrap;}
        .kv{opacity:0.92;}
        .kv b{color:#fff;}
        .prog{height:10px; border-radius:999px; background:rgba(255,255,255,0.08); overflow:hidden; border:1px solid rgba(140,255,255,0.12);}
        .prog > i{display:block; height:100%; width:0%; background:linear-gradient(90deg, rgba(0,255,255,0.95), rgba(255,0,255,0.95));}
        .cardBtns{display:flex; gap:6px; flex-wrap:wrap; align-items:center;}
        .small{font-size:12px; opacity:0.9;}
        .pill2{display:inline-flex; gap:6px; align-items:center; padding:5px 8px; border-radius:999px; border:1px solid rgba(255,0,255,0.18); background:rgba(0,0,0,0.45); font-size:12px;}
        .ms{display:flex; gap:6px; align-items:center; flex-wrap:wrap;}
        .pip{width:10px; height:10px; border-radius:999px; border:1px solid rgba(255,0,255,0.25); background:rgba(255,0,255,0.08);}
        .pip.on{background:rgba(255,0,255,0.75); box-shadow:0 0 10px rgba(255,0,255,0.25);}
        .tabs{display:flex; gap:6px; flex-wrap:wrap;}
        .tabBtn{padding:6px 10px; border-radius:999px;}
        .tabPanel{padding:10px; max-height: calc(65vh - 40px); overflow:auto;}
        .grid2{display:grid; grid-template-columns: 1fr; gap:10px;}
        .upItem{display:flex; gap:10px; align-items:flex-start; justify-content:space-between; padding:10px; border-radius:14px; border:1px solid rgba(140,255,255,0.14); background:rgba(0,0,0,0.45);}
        .upItem h4{margin:0; font-size:13px; color:#fff;}
        .upItem p{margin:4px 0 0 0; font-size:12px; opacity:0.9;}
        .tag{font-size:11px; opacity:0.8; padding:3px 8px; border-radius:999px; border:1px solid rgba(140,255,255,0.14);}
        .toast{position:absolute; right:10px; top:54px; max-width: 520px; padding:10px 12px; border-radius:14px; background:rgba(0,0,0,0.7); border:1px solid rgba(255,0,255,0.22); box-shadow:0 0 18px rgba(255,0,255,0.12); font-size:12px;}
        .toast b{color:#fff;}
        .hr{height:1px; background:rgba(140,255,255,0.12); margin:10px 0;}
        .muted{opacity:0.86;}
        .kHint{font-size:11px; opacity:0.8;}
        .danger{border-color: rgba(255,80,120,0.35) !important;}
      </style>

      <div class="nvTop">
        <div>
          <div class="nvMoney" id="nvMoney">$0</div>
          <div class="nvSub">
            <span class="pill"><span class="muted">Income/sec</span> <b id="nvInc">$0</b></span>
            <span class="pill"><span class="muted">Influence</span> <b id="nvInf">0</b></span>
            <span class="pill"><span class="muted">Speed</span> <b id="nvSpeed">1.0×</b></span>
            <span class="pill kHint">Hotkeys: 1/2/3/4 buy-mode · Space pause · S save · L load</span>
          </div>
        </div>

        <div class="nvRightTop">
          <button class="btn" id="nvNotation" title="Toggle number notation">Notation: suffix</button>
          <button class="btn" id="nvSaveNow" title="Save immediately">Save</button>
          <button class="btn" id="nvSpeedBtn" title="Cycle sim speed (1× → 2× → 4× → 1×)">Speed</button>
          <input id="nvCheatAmt" class="nvInput" placeholder="+ amount" />
          <button class="btn nvCheatBtn" id="nvCheatBtn" title="Add money">Cheat</button>
          <a class="nvLink" href="/" title="Back to launcher">Back</a>
        </div>
      </div>

      <div class="nvGrid">
        <div class="col">
          <div class="colHead">
            <h3>Businesses</h3>
            <div class="buyModes" id="nvBuyModes">
              <button class="btn tabBtn" data-bm="x1">x1</button>
              <button class="btn tabBtn" data-bm="x10">x10</button>
              <button class="btn tabBtn" data-bm="x100">x100</button>
              <button class="btn tabBtn" data-bm="max">Max</button>
            </div>
          </div>
          <div class="list" id="nvBizList"></div>
        </div>

        <div class="col">
          <div class="colHead">
            <h3>Control</h3>
            <div class="tabs" id="nvTabs">
              <button class="btn tabBtn" data-tab="upg">Upgrades</button>
              <button class="btn tabBtn" data-tab="mgr">Managers</button>
              <button class="btn tabBtn" data-tab="pre">Prestige</button>
              <button class="btn tabBtn" data-tab="sta">Stats</button>
            </div>
          </div>
          <div class="tabPanel" id="nvPanel"></div>
        </div>
      </div>

      <div class="toast" id="nvToast" style="display:none;"></div>
    </div>
  `));

  const $ = (sel) => uiRoot.querySelector(sel);

  const dom = {
    money: $("#nvMoney"),
    inc: $("#nvInc"),
    inf: $("#nvInf"),
    speed: $("#nvSpeed"),
    notation: $("#nvNotation"),
    saveNow: $("#nvSaveNow"),
    speedBtn: $("#nvSpeedBtn"),
    cheatAmt: $("#nvCheatAmt"),
    cheatBtn: $("#nvCheatBtn"),
    buyModes: $("#nvBuyModes"),
    bizList: $("#nvBizList"),
    tabs: $("#nvTabs"),
    panel: $("#nvPanel"),
    toast: $("#nvToast"),
  };

  // ----------------------------- Toast -----------------------------
  // Define early so callers like handleOfflineProgress can use it.
  let toastT = 0;
  let toastDur = 0;

  function toast(html, dur = 2200) {
    if (!dom.toast) return;
    dom.toast.innerHTML = html;
    dom.toast.style.display = "block";
    toastT = 0;
    toastDur = dur;
  }

  function toastTick(dt) {
    if (!dom.toast || dom.toast.style.display === "none") return;
    toastT += dt;
    if (toastT >= toastDur / 1000) {
      dom.toast.style.display = "none";
    }
  }

  // UI refresh flags (declare early to avoid TDZ when functions run during init)
  let uiAcc = 0;
  let forceUI = true;

  // state
  let S = loadState();
  let simSpeed = 1.0;

  // upgrades definitions
  const { ups: UPGRADE_DEFS, meta: META_DEFS } = makeUpgrades();

  // runtime caches
  const EFFECTS = {
    globalProfit: 1,
    globalCycle: 1,
    managerDiscount: 1,
    bizProfit: Object.create(null),
    bizCycle: Object.create(null),
    prestigeMult: 1,
  };

  // sparks for canvas flair
  const sparks = [];
  function addSpark() {
    const { w, h } = Engine.getSize();
    const mx = Engine.mouse();
    const x = mx && Number.isFinite(mx.x) ? mx.x : (w * (0.25 + Math.random() * 0.5));
    const y = mx && Number.isFinite(mx.y) ? mx.y : (h * (0.2 + Math.random() * 0.6));
    if (sparks.length > 80) sparks.splice(0, 20);
    sparks.push({
      x, y,
      vx: (Math.random() - 0.5) * 120,
      vy: (Math.random() - 0.5) * 120,
      life: 0.45 + Math.random() * 0.35,
      t: 0
    });
  }

  // Build business cards
  const bizDom = Object.create(null);

  for (const t of BUSINESS_TEMPLATES) {
    const card = el(`
      <div class="card" data-biz="${t.id}">
        <div class="row">
          <div class="title">
            <div class="sig" aria-hidden="true">${t.sigil}</div>
            <div>
              <div class="nm">${t.name}</div>
              <div class="meta">
                <span class="kv">Owned: <b class="owned">0</b></span>
                <span class="kv">Cost: <b class="cost">$0</b></span>
                <span class="kv">Payout: <b class="payout">$0</b>/cycle</span>
                <span class="kv">Cycle: <b class="cycle">0.0s</b></span>
              </div>
            </div>
          </div>
          <div class="cardBtns">
            <button class="btn runBtn" title="Run one cycle (if not automated)">Run</button>
            <button class="btn buyBtn" title="Hold to buy repeatedly">Buy</button>
            <button class="btn mgrBtn" title="Hire the manager to automate cycles">Hire Manager</button>
          </div>
        </div>

        <div class="row" style="margin-top:8px;">
          <div style="flex: 1 1 auto; min-width: 220px;">
            <div class="prog" aria-label="Progress"><i class="bar"></i></div>
          </div>
          <span class="pill2 mgrStat">Automated: <b class="auto">No</b></span>
        </div>

        <div class="row" style="margin-top:8px;">
          <div class="ms">
            <span class="small muted">Milestones</span>
            <span class="pip" data-ms="25"></span>
            <span class="pip" data-ms="50"></span>
            <span class="pip" data-ms="100"></span>
            <span class="pip" data-ms="200"></span>
            <span class="pip" data-ms="500"></span>
            <span class="pip" data-ms="1000"></span>
          </div>
          <span class="small muted multTxt"></span>
        </div>
      </div>
    `);

    dom.bizList.appendChild(card);

    const ownedEl = card.querySelector(".owned");
    const costEl = card.querySelector(".cost");
    const payoutEl = card.querySelector(".payout");
    const cycleEl = card.querySelector(".cycle");
    const barEl = card.querySelector(".bar");
    const runBtn = card.querySelector(".runBtn");
    const buyBtn = card.querySelector(".buyBtn");
    const mgrBtn = card.querySelector(".mgrBtn");
    const autoEl = card.querySelector(".auto");
    const multTxt = card.querySelector(".multTxt");
    const pips = Array.from(card.querySelectorAll(".pip"));

    // Tooltips
    tooltipify(runBtn, "Start a cycle manually (not needed once automated).");
    tooltipify(buyBtn, "Buy using the current buy mode (x1/x10/x100/Max). Hold to buy repeatedly.");
    tooltipify(mgrBtn, "Hire manager: runs cycles forever for this business.");

    for (const p of pips) {
      const thr = safeInt(p.getAttribute("data-ms"), 0);
      if (thr > 0) {
        const idx = MILESTONES.indexOf(thr);
        const pm = idx >= 0 ? MS_PROFIT[idx] : 1;
        const cm = idx >= 0 ? MS_CYCLE[idx] : 1;
        tooltipify(p, `At ${thr} owned: Profit ×${pm} · Cycle ×${cm} (faster)`);
      }
    }

    // Hold-to-buy loop
    let holdTimer = null;
    let holdAccel = 0;

    function stopHold() {
      if (holdTimer) {
        clearInterval(holdTimer);
        holdTimer = null;
      }
      holdAccel = 0;
    }

    buyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      doBuy(t.id);
      addSpark();
      stopHold();
      holdAccel = 0;
      holdTimer = setInterval(() => {
        holdAccel += 1;
        // accelerate a bit, but cap
        const reps = clamp(1 + Math.floor(holdAccel / 10), 1, 6);
        for (let i = 0; i < reps; i++) {
          if (!doBuy(t.id)) break;
        }
      }, 90);
    });

    buyBtn.addEventListener("mouseup", stopHold);
    buyBtn.addEventListener("mouseleave", stopHold);
    window.addEventListener("mouseup", stopHold);

    buyBtn.addEventListener("click", (e) => {
      // click also buys once (mousedown already did; avoid double on some browsers)
      e.preventDefault();
    });

    runBtn.addEventListener("click", () => {
      const b = getBiz(t.id);
      if (!b) return;
      if (b.owned <= 0) return;
      if (b.manager) return; // automated; already running
      if (!b.running) b.running = true;
      addSpark();
    });

    mgrBtn.addEventListener("click", () => {
      doHireManager(t.id);
      addSpark();
    });

    bizDom[t.id] = {
      card, ownedEl, costEl, payoutEl, cycleEl, barEl,
      runBtn, buyBtn, mgrBtn, autoEl, multTxt, pips,
    };
  }

  // Tabs content
  let activeTab = "upg";

  function renderPanel() {
    if (!dom.panel) return;
    dom.panel.innerHTML = "";

    if (activeTab === "upg") renderUpgradesPanel();
    else if (activeTab === "mgr") renderManagersPanel();
    else if (activeTab === "pre") renderPrestigePanel();
    else if (activeTab === "sta") renderStatsPanel();
  }

  function renderUpgradesPanel() {
    const wrap = el(`
      <div class="grid2">
        <div class="row">
          <div class="small muted">Upgrades make the line go vertical. Buy what’s affordable and keep stacking multipliers.</div>
          <div class="row" style="gap:6px;">
            <button class="btn" id="uAll">All</button>
            <button class="btn" id="uAff">Affordable</button>
            <button class="btn" id="uNew">New</button>
          </div>
        </div>
        <div class="hr"></div>
        <div id="uList" class="grid2"></div>
      </div>
    `);

    dom.panel.appendChild(wrap);

    const uList = wrap.querySelector("#uList");
    const btnAll = wrap.querySelector("#uAll");
    const btnAff = wrap.querySelector("#uAff");
    const btnNew = wrap.querySelector("#uNew");

    let filter = "all";
    btnAll.classList.add("on");

    const refresh = () => {
      uList.innerHTML = "";
      const money = S.money;

      const view = UPGRADE_DEFS
        .filter(u => !S.upgradesPurchased[u.id])
        .filter(u => u.req(makeStateView()))
        .filter(u => {
          if (filter === "all") return true;
          if (filter === "aff") return bCmp(money, u.cost) >= 0;
          if (filter === "new") {
            // "new" means cost within 100× of money or just unlocked
            const logM = bLog10(money);
            const logC = bLog10(u.cost);
            return (logC - logM) <= 2;
          }
          return true;
        })
        .sort((a, b) => bCmp(a.cost, b.cost));

      if (view.length === 0) {
        uList.appendChild(el(`<div class="small muted">No upgrades here right now. Buy more businesses, earn more, come back.</div>`));
        return;
      }

      const maxItems = 60;
      for (let i = 0; i < Math.min(maxItems, view.length); i++) {
        const u = view[i];
        const item = el(`
          <div class="upItem">
            <div style="min-width: 0;">
              <div class="row" style="justify-content:flex-start; gap:8px;">
                <h4>${u.name}</h4>
                <span class="tag">${u.tag}</span>
              </div>
              <p>${u.desc}</p>
              <p class="muted">Cost: <b>${fmtMoney(u.cost, S.settings.notation)}</b></p>
            </div>
            <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
              <button class="btn buyUp">Buy</button>
            </div>
          </div>
        `);
        const buyBtn = item.querySelector(".buyUp");
        const aff = bCmp(money, u.cost) >= 0;
        setDisabled(buyBtn, !aff);
        buyBtn.addEventListener("click", () => {
          if (buyUpgrade(u.id)) {
            addSpark();
            toast(`Upgrade bought: <b>${u.name}</b>`);
            refresh();
          }
        });
        uList.appendChild(item);
      }

      if (view.length > maxItems) {
        uList.appendChild(el(`<div class="small muted">Showing ${maxItems} upgrades. (There are more — keep buying.)</div>`));
      }
    };

    btnAll.addEventListener("click", () => { filter = "all"; btnAll.classList.add("on"); btnAff.classList.remove("on"); btnNew.classList.remove("on"); refresh(); });
    btnAff.addEventListener("click", () => { filter = "aff"; btnAff.classList.add("on"); btnAll.classList.remove("on"); btnNew.classList.remove("on"); refresh(); });
    btnNew.addEventListener("click", () => { filter = "new"; btnNew.classList.add("on"); btnAll.classList.remove("on"); btnAff.classList.remove("on"); refresh(); });

    refresh();
  }

  function renderManagersPanel() {
    const wrap = el(`
      <div class="grid2">
        <div class="row">
          <div class="small muted">Managers automate cycles forever. Hire them as soon as you can.</div>
          <button class="btn" id="hireAll">Hire All Affordable</button>
        </div>
        <div class="hr"></div>
        <div id="mList" class="grid2"></div>
      </div>
    `);
    dom.panel.appendChild(wrap);

    const mList = wrap.querySelector("#mList");
    const hireAll = wrap.querySelector("#hireAll");

    const refresh = () => {
      mList.innerHTML = "";
      let any = false;
      for (const t of BUSINESS_TEMPLATES) {
        const b = getBiz(t.id);
        if (!b) continue;
        const cost = managerCost(t.id);
        const item = el(`
          <div class="upItem">
            <div style="min-width: 0;">
              <div class="row" style="justify-content:flex-start; gap:8px;">
                <h4>${t.sigil} ${t.name} Manager</h4>
                <span class="tag">${b.manager ? "Hired" : "Available"}</span>
              </div>
              <p>${b.manager ? "Automation enabled." : "Automates cycles for this business."}</p>
              <p class="muted">Cost: <b>${fmtMoney(cost, S.settings.notation)}</b></p>
            </div>
            <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
              <button class="btn hireOne">${b.manager ? "Owned" : "Hire"}</button>
            </div>
          </div>
        `);
        const btn = item.querySelector(".hireOne");
        if (b.manager) setDisabled(btn, true);
        else setDisabled(btn, bCmp(S.money, cost) < 0);
        btn.addEventListener("click", () => {
          if (doHireManager(t.id)) {
            addSpark();
            toast(`Manager hired: <b>${t.name}</b>`);
            refresh();
          }
        });
        mList.appendChild(item);
        any = true;
      }
      if (!any) mList.appendChild(el(`<div class="small muted">No managers found. (That shouldn’t happen.)</div>`));
    };

    hireAll.addEventListener("click", () => {
      let hired = 0;
      for (const t of BUSINESS_TEMPLATES) {
        if (doHireManager(t.id)) hired++;
      }
      if (hired > 0) {
        addSpark();
        toast(`Hired <b>${hired}</b> manager(s).`);
      } else {
        toast(`No affordable managers.`);
      }
      refresh();
    });

    refresh();
  }

  function renderPrestigePanel() {
    const gain = calcInfluenceGain();
    const mult = calcPrestigeMult();

    const wrap = el(`
      <div class="grid2">
        <div class="card">
          <div class="row">
            <div>
              <div class="nm">Reboot Corporation</div>
              <div class="small muted">Resets money, businesses, managers, and upgrades — but grants permanent Influence.</div>
            </div>
            <button class="btn danger" id="doPrestige">Reboot</button>
          </div>
          <div class="hr"></div>
          <div class="meta">
            <span class="kv">Potential Influence gain: <b id="pGain">${gain}</b></span>
            <span class="kv">Current Influence: <b id="pCur">${S.influence}</b></span>
            <span class="kv">Prestige multiplier: <b id="pMult">${mult.toFixed(2)}×</b></span>
          </div>
          <div class="small muted" style="margin-top:8px;">
            Formula: gain = floor((log10(lifetime) - 6)²). First reboot should happen in about 10–20 minutes.
          </div>
        </div>

        <div class="card">
          <div class="row">
            <div>
              <div class="nm">Influence Upgrades</div>
              <div class="small muted">Spend Influence for permanent growth.</div>
            </div>
          </div>
          <div class="hr"></div>
          <div id="metaList" class="grid2"></div>
        </div>
      </div>
    `);

    dom.panel.appendChild(wrap);

    const doPrestigeBtn = wrap.querySelector("#doPrestige");
    const metaList = wrap.querySelector("#metaList");

    const refresh = () => {
      setText(wrap.querySelector("#pGain"), String(calcInfluenceGain()));
      setText(wrap.querySelector("#pCur"), String(S.influence));
      setText(wrap.querySelector("#pMult"), `${calcPrestigeMult().toFixed(2)}×`);

      metaList.innerHTML = "";
      const available = S.influence;

      for (const m of META_DEFS) {
        const level = safeInt(S.meta[m.key], 0);
        const cost = Math.ceil(m.baseCost * Math.pow(m.costGrowth, level));
        const item = el(`
          <div class="upItem">
            <div style="min-width:0;">
              <div class="row" style="justify-content:flex-start; gap:8px;">
                <h4>${m.name}</h4>
                <span class="tag">Level ${level}</span>
              </div>
              <p>${m.desc}</p>
              <p class="muted">Cost: <b>${cost}</b> Influence</p>
            </div>
            <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
              <button class="btn buyMeta">Buy</button>
            </div>
          </div>
        `);
        const btn = item.querySelector(".buyMeta");
        setDisabled(btn, available < cost);
        btn.addEventListener("click", () => {
          if (S.influence >= cost) {
            S.influence -= cost;
            S.influenceSpent += cost;
            S.meta[m.key] = safeInt(S.meta[m.key], 0) + 1;
            recomputeEffects();
            addSpark();
            toast(`Bought: <b>${m.name}</b> (Level ${safeInt(S.meta[m.key], 0)})`);
            refresh();
          }
        });
        metaList.appendChild(item);
      }
    };

    doPrestigeBtn.addEventListener("click", () => {
      const g = calcInfluenceGain();
      if (g <= 0) {
        toast(`Not worth rebooting yet. Push lifetime higher.`);
        return;
      }
      const ok = window.confirm(`Reboot now?\n\nYou will gain ${g} Influence.\nEverything else resets.\n\nThis is permanent progress.`);
      if (!ok) return;

      doPrestige(g);
      addSpark();
      toast(`Reboot complete. +<b>${g}</b> Influence.`);
      renderPanel();
    });

    refresh();
  }

  function renderStatsPanel() {
    const wrap = el(`
      <div class="grid2">
        <div class="card">
          <div class="nm">Stats</div>
          <div class="hr"></div>
          <div class="meta" style="row-gap:6px;">
            <span class="kv">Lifetime earnings: <b id="stLife">$0</b></span>
            <span class="kv">Best income/sec: <b id="stBest">$0</b></span>
            <span class="kv">Playtime: <b id="stPlay">0:00</b></span>
            <span class="kv">Current speed: <b id="stSpd">1.0×</b></span>
            <span class="kv">Notation: <b id="stNot">suffix</b></span>
          </div>
          <div class="hr"></div>
          <div class="small muted">Tip: buy-mode Max + managers = huge jumps. Prestige sooner than you think.</div>
        </div>

        <div class="card">
          <div class="nm">Controls</div>
          <div class="hr"></div>
          <div class="small muted">
            <div><b>1</b> x1, <b>2</b> x10, <b>3</b> x100, <b>4</b> Max</div>
            <div><b>Space</b> pause/unpause</div>
            <div><b>S</b> save now</div>
            <div><b>L</b> load</div>
          </div>
        </div>
      </div>
    `);

    dom.panel.appendChild(wrap);

    const refresh = () => {
      setText(wrap.querySelector("#stLife"), `$${fmtMoney(S.lifetime, S.settings.notation)}`);
      setText(wrap.querySelector("#stBest"), `$${fmtMoney(S.bestIncomeSec, S.settings.notation)}`);
      setText(wrap.querySelector("#stPlay"), fmtTime(S.playtimeSec));
      setText(wrap.querySelector("#stSpd"), `${simSpeed.toFixed(1)}×`);
      setText(wrap.querySelector("#stNot"), S.settings.notation);
    };
    refresh();
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Tabs wiring
  Array.from(dom.tabs.querySelectorAll("[data-tab]")).forEach(btn => {
    btn.addEventListener("click", () => {
      activeTab = btn.getAttribute("data-tab") || "upg";
      updateTabButtons();
      renderPanel();
    });
  });

  function updateTabButtons() {
    Array.from(dom.tabs.querySelectorAll("[data-tab]")).forEach(btn => {
      const tab = btn.getAttribute("data-tab");
      if (tab === activeTab) btn.classList.add("on");
      else btn.classList.remove("on");
    });
  }

  updateTabButtons();
  renderPanel();

  // Buy modes wiring
  Array.from(dom.buyModes.querySelectorAll("[data-bm]")).forEach(btn => {
    btn.addEventListener("click", () => {
      S.settings.buyMode = btn.getAttribute("data-bm") || "x1";
      updateBuyButtons();
      toast(`Buy mode: <b>${S.settings.buyMode.toUpperCase()}</b>`);
    });
  });

  function updateBuyButtons() {
    Array.from(dom.buyModes.querySelectorAll("[data-bm]")).forEach(btn => {
      const bm = btn.getAttribute("data-bm");
      if (bm === S.settings.buyMode) btn.classList.add("on");
      else btn.classList.remove("on");
    });
  }
  updateBuyButtons();

  // Notation toggle
  dom.notation.addEventListener("click", () => {
    S.settings.notation = (S.settings.notation === "suffix") ? "sci" : "suffix";
    dom.notation.textContent = `Notation: ${S.settings.notation}`;
    toast(`Notation: <b>${S.settings.notation}</b>`);
    forceUIRefresh();
  });

  // Cheat button - add a custom amount to money
  if (dom.cheatBtn && dom.cheatAmt) {
    dom.cheatBtn.addEventListener("click", () => {
      const v = dom.cheatAmt.value || "";
      const n = parseFriendlyAmount(v);
      if (!Number.isFinite(n) || n <= 0) {
        toast("Invalid amount.");
        return;
      }
      const add = bFromNumber(n);
      S.money = bAdd(S.money, add);
      toast(`Cheated: +<b>$${fmtMoney(add, S.settings.notation)}</b>`);
      dom.cheatAmt.value = "";
      forceUIRefresh();
    });
  }

  dom.notation.textContent = `Notation: ${S.settings.notation}`;

  // Save now
  dom.saveNow.addEventListener("click", () => {
    saveState();
    toast(`Saved.`);
  });

  // Speed
  dom.speedBtn.addEventListener("click", () => {
    simSpeed = simSpeed === 1 ? 2 : (simSpeed === 2 ? 4 : 1);
    toast(`Speed: <b>${simSpeed.toFixed(1)}×</b>`);
  });

  // Hotkeys / pause / save/load
  Engine.on("onKeyDown", (ev) => {
    const k = ev.key;
    if (k === " " || k === "Spacebar") {
      ev.preventDefault();
      Engine.togglePause();
      S.settings.paused = Engine.isPaused();
      toast(Engine.isPaused() ? "Paused." : "Unpaused.");
      return;
    }
    if (k === "1") { S.settings.buyMode = "x1"; updateBuyButtons(); toast("Buy mode: <b>X1</b>"); return; }
    if (k === "2") { S.settings.buyMode = "x10"; updateBuyButtons(); toast("Buy mode: <b>X10</b>"); return; }
    if (k === "3") { S.settings.buyMode = "x100"; updateBuyButtons(); toast("Buy mode: <b>X100</b>"); return; }
    if (k === "4") { S.settings.buyMode = "max"; updateBuyButtons(); toast("Buy mode: <b>MAX</b>"); return; }
    if (k === "s" || k === "S") { saveState(); toast("Saved."); return; }
    if (k === "l" || k === "L") {
      const ok = window.confirm("Load last save? (Unsaved progress will be lost.)");
      if (!ok) return;
      S = loadState();
      recomputeEffects();
      toast("Loaded.");
      forceUIRefresh();
      renderPanel();
      return;
    }
  });

  // initial pause state
  if (S.settings.paused) Engine.pause();

  // Offline progress message
  handleOfflineProgress();

  // Effects cache init

  // UI refresh (throttled) helpers

  function forceUIRefreshAll() {
    recomputeEffects();
    updateTopBar();
    updateBusinessCards();
    setText(dom.inc, `$${fmtMoney(calcIncomePerSec(), S.settings.notation)}`);
  }

  function forceUIRefresh() {
    forceUI = true;
    // immediate full refresh
    forceUIRefreshAll();
  }

  recomputeEffects();
  forceUIRefresh();

  /* ----------------------------- Core operations ----------------------------- */

  function makeStateView() {
    return {
      bizOwned: (id) => {
        const b = getBiz(id);
        return b ? safeInt(b.owned, 0) : 0;
      },
      money: () => S.money,
    };
  }

  function getBiz(id) {
    return S.businesses.find(b => b.id === id) || null;
  }

  function templateById(id) {
    return BUSINESS_TEMPLATES.find(t => t.id === id) || null;
  }

  function bizMilestoneProfitMult(owned) {
    let m = 1;
    for (let i = 0; i < MILESTONES.length; i++) {
      if (owned >= MILESTONES[i]) m *= MS_PROFIT[i];
    }
    return m;
  }

  function bizMilestoneCycleMult(owned) {
    let m = 1;
    for (let i = 0; i < MILESTONES.length; i++) {
      if (owned >= MILESTONES[i]) m *= MS_CYCLE[i];
    }
    return m;
  }

  function managerBaseCost(id) {
    const t = templateById(id);
    if (!t) return bFromNumber(0);
    // expensive but reachable, scales with tier
    const tier = BUSINESS_TEMPLATES.findIndex(x => x.id === id);
    const base = t.baseCost * (250 + tier * 220);
    return bFromNumber(base);
  }

  function managerCost(id) {
    const base = managerBaseCost(id);
    // global manager discounts
    const disc = EFFECTS.managerDiscount;
    // meta manager discount: -3% per level multiplicative
    const lv = safeInt(S.meta.xManager, 0);
    const metaDisc = Math.pow(0.97, lv);
    return bMulScalar(base, disc * metaDisc);
  }

  function calcPrestigeMult() {
    // base: 1 + influence * 0.05
    const inf = safeInt(S.influence, 0);
    let mult = 1 + inf * 0.05;

    // meta profit: +5% per level multiplicative
    const lp = safeInt(S.meta.xProfit, 0);
    mult *= Math.pow(1.05, lp);

    return mult;
  }

  function recomputeEffects() {
    EFFECTS.globalProfit = 1;
    EFFECTS.globalCycle = 1;
    EFFECTS.managerDiscount = 1;
    EFFECTS.bizProfit = Object.create(null);
    EFFECTS.bizCycle = Object.create(null);

    const view = makeStateView();
    for (const u of UPGRADE_DEFS) {
      if (!S.upgradesPurchased[u.id]) continue;
      // apply into EFFECTS
      u.apply(EFFECTS);
    }

    // prestige multiplier
    EFFECTS.prestigeMult = calcPrestigeMult();
  }

  function bizCycleSeconds(id, owned) {
    const t = templateById(id);
    if (!t) return 1;

    const ms = bizMilestoneCycleMult(owned);
    const up = (EFFECTS.bizCycle[id] || 1);
    const metaLv = safeInt(S.meta.xCycle, 0);
    const meta = Math.pow(0.98, metaLv);
    const global = EFFECTS.globalCycle;

    let cycle = t.baseCycle * ms * up * global * meta;
    cycle = clamp(cycle, 0.05, 1e9);
    return cycle;
  }

  function bizPayoutPerCycle(id, owned) {
    const t = templateById(id);
    if (!t || owned <= 0) return B(0, 0);

    const msP = bizMilestoneProfitMult(owned);
    const up = (EFFECTS.bizProfit[id] || 1);
    const global = EFFECTS.globalProfit;
    const prestige = EFFECTS.prestigeMult;

    // payout = baseProfit * owned * multipliers
    const scalar = t.baseProfit * owned * msP * up * global * prestige;
    return bFromNumber(scalar);
  }

  function currentCost(id) {
    const t = templateById(id);
    const b = getBiz(id);
    if (!t || !b) return bFromNumber(0);
    const base = bFromNumber(t.baseCost);
    return costAtOwned(base, t.growth, safeInt(b.owned, 0));
  }

  function buyCountFromMode(id) {
    const b = getBiz(id);
    const t = templateById(id);
    if (!b || !t) return 0;
    const owned = safeInt(b.owned, 0);
    const base = bFromNumber(t.baseCost);

    if (S.settings.buyMode === "x1") return 1;
    if (S.settings.buyMode === "x10") return 10;
    if (S.settings.buyMode === "x100") return 100;
    if (S.settings.buyMode === "max") {
      return maxAffordableK(S.money, base, t.growth, owned);
    }
    return 1;
  }

  function doBuy(id) {
    const b = getBiz(id);
    const t = templateById(id);
    if (!b || !t) return false;

    const owned = safeInt(b.owned, 0);
    const k = buyCountFromMode(id);
    if (k <= 0) return false;

    const base = bFromNumber(t.baseCost);
    const total = (S.settings.buyMode === "max")
      ? totalCostForK(base, t.growth, owned, k)
      : totalCostForK(base, t.growth, owned, k);

    if (bCmp(S.money, total) < 0) return false;

    S.money = bSub(S.money, total);
    b.owned = owned + k;

    // if automated, keep running; if manual and owned newly >0, no auto-run
    // (player can click run)
    forceUIRefresh();
    return true;
  }

  function doHireManager(id) {
    const b = getBiz(id);
    if (!b || b.manager) return false;
    const cost = managerCost(id);
    if (bCmp(S.money, cost) < 0) return false;

    S.money = bSub(S.money, cost);
    b.manager = true;
    b.running = true; // start immediately
    forceUIRefresh();
    return true;
  }

  function buyUpgrade(upId) {
    const u = UPGRADE_DEFS.find(x => x.id === upId);
    if (!u) return false;
    if (S.upgradesPurchased[upId]) return false;
    if (!u.req(makeStateView())) return false;
    if (bCmp(S.money, u.cost) < 0) return false;

    S.money = bSub(S.money, u.cost);
    S.upgradesPurchased[upId] = true;
    recomputeEffects();
    forceUIRefresh();
    return true;
  }

  function calcIncomePerSec() {
    // income per sec from automated businesses + currently running manual ones
    let total = B(0, 0);
    for (const b of S.businesses) {
      const t = templateById(b.id);
      if (!t) continue;
      const owned = safeInt(b.owned, 0);
      if (owned <= 0) continue;

      const cycle = bizCycleSeconds(b.id, owned);
      const payout = bizPayoutPerCycle(b.id, owned);

      const active = b.manager || b.running; // manual only produces while running
      if (!active) continue;

      // payout per sec = payout / cycle
      const ps = bMulScalar(payout, 1 / cycle);
      total = bAdd(total, ps);
    }
    return total;
  }

  function calcInfluenceGain() {
    const logL = bLog10(S.lifetime);
    if (!Number.isFinite(logL) || logL <= 6) return 0;
    const x = (logL - 6);
    const g = Math.floor(x * x);
    return clamp(g, 0, 2_000_000_000);
  }

  function doPrestige(gain) {
    gain = safeInt(gain, 0);
    if (gain <= 0) return;

    // keep influence, meta, notation/buyMode
    const keepInfluence = safeInt(S.influence, 0) + gain;
    const keepSpent = safeInt(S.influenceSpent, 0);
    const keepMeta = { ...S.meta };
    const keepSettings = { ...S.settings };
    const keepLifetime = bClone(S.lifetime);
    const keepBest = bClone(S.bestIncomeSec);
    const keepPlay = safeInt(S.playtimeSec, 0);

    S = makeDefaultState();
    S.influence = keepInfluence;
    S.influenceSpent = keepSpent;
    S.meta = keepMeta;
    S.settings.notation = keepSettings.notation;
    S.settings.buyMode = keepSettings.buyMode;
    S.settings.paused = keepSettings.paused;
    S.lifetime = keepLifetime;
    S.bestIncomeSec = keepBest;
    S.playtimeSec = keepPlay;

    recomputeEffects();
    saveState();
    forceUIRefresh();
  }

  /* ----------------------------- Save / Load / Offline ----------------------------- */

  function serialiseState(state) {
    return {
      v: state.v,
      money: bToJSON(state.money),
      lifetime: bToJSON(state.lifetime),
      bestIncomeSec: bToJSON(state.bestIncomeSec),
      playtimeSec: safeInt(state.playtimeSec, 0),

      influence: safeInt(state.influence, 0),
      influenceSpent: safeInt(state.influenceSpent, 0),
      meta: {
        xProfit: safeInt(state.meta?.xProfit, 0),
        xCycle: safeInt(state.meta?.xCycle, 0),
        xManager: safeInt(state.meta?.xManager, 0),
      },

      settings: {
        notation: state.settings?.notation === "sci" ? "sci" : "suffix",
        buyMode: ["x1", "x10", "x100", "max"].includes(state.settings?.buyMode) ? state.settings.buyMode : "x1",
        paused: !!state.settings?.paused,
      },

      businesses: state.businesses.map(b => ({
        id: b.id,
        owned: safeInt(b.owned, 0),
        manager: !!b.manager,
        running: !!b.running,
        prog: Number.isFinite(b.prog) ? clamp(b.prog, 0, 10) : 0,
      })),

      upgradesPurchased: state.upgradesPurchased || {},

      lastKnownIncomeSec: bToJSON(state.lastKnownIncomeSec || B(0, 0)),
      lastSaveMs: safeInt(state.lastSaveMs, nowMs()),
    };
  }

  function deserialiseState(obj) {
    const d = makeDefaultState();
    if (!obj || typeof obj !== "object") return d;

    d.v = safeInt(obj.v, 1);
    d.money = bFromJSON(obj.money);
    d.lifetime = bFromJSON(obj.lifetime);
    d.bestIncomeSec = bFromJSON(obj.bestIncomeSec);
    d.playtimeSec = safeInt(obj.playtimeSec, 0);

    d.influence = safeInt(obj.influence, 0);
    d.influenceSpent = safeInt(obj.influenceSpent, 0);

    d.meta = {
      xProfit: safeInt(obj.meta?.xProfit, 0),
      xCycle: safeInt(obj.meta?.xCycle, 0),
      xManager: safeInt(obj.meta?.xManager, 0),
    };

    d.settings = {
      notation: obj.settings?.notation === "sci" ? "sci" : "suffix",
      buyMode: ["x1", "x10", "x100", "max"].includes(obj.settings?.buyMode) ? obj.settings.buyMode : "x1",
      paused: !!obj.settings?.paused,
    };

    if (Array.isArray(obj.businesses)) {
      for (const sb of obj.businesses) {
        const b = d.businesses.find(x => x.id === sb.id);
        if (!b) continue;
        b.owned = safeInt(sb.owned, 0);
        b.manager = !!sb.manager;
        b.running = !!sb.running;
        b.prog = Number.isFinite(sb.prog) ? clamp(sb.prog, 0, 10) : 0;
      }
    }

    d.upgradesPurchased = (obj.upgradesPurchased && typeof obj.upgradesPurchased === "object") ? obj.upgradesPurchased : {};
    d.lastKnownIncomeSec = bFromJSON(obj.lastKnownIncomeSec);
    d.lastSaveMs = safeInt(obj.lastSaveMs, nowMs());

    // clamp any negatives / NaNs
    d.money = bNorm(d.money); if (d.money.m < 0) d.money = B(0, 0);
    d.lifetime = bNorm(d.lifetime); if (d.lifetime.m < 0) d.lifetime = B(0, 0);
    d.bestIncomeSec = bNorm(d.bestIncomeSec); if (d.bestIncomeSec.m < 0) d.bestIncomeSec = B(0, 0);

    return d;
  }

  function saveState() {
    S.lastKnownIncomeSec = calcIncomePerSec();
    S.lastSaveMs = nowMs();
    Engine.save(SAVE_KEY, serialiseState(S));
  }

  function loadState() {
    const raw = Engine.load(SAVE_KEY, null);
    return deserialiseState(raw);
  }

  function handleOfflineProgress() {
    const lastTs = Engine.loadTimestamp(SAVE_KEY);
    const lastSavedMs = safeInt(S.lastSaveMs, lastTs || nowMs());
    const elapsedMs = Math.max(0, nowMs() - lastSavedMs);
    const capMs = 8 * 3600 * 1000;
    const usedMs = Math.min(elapsedMs, capMs);
    if (usedMs < 1500) return;

    // offline earnings based on lastKnownIncomeSec
    const income = bFromJSON(Engine.load(SAVE_KEY, {}).lastKnownIncomeSec);
    const secs = usedMs / 1000;
    const gain = bMulScalar(income, secs);

    if (!bIsZero(gain) && gain.m > 0) {
      S.money = bAdd(S.money, gain);
      S.lifetime = bAdd(S.lifetime, gain);
      toast(`While you were away: +<b>$${fmtMoney(gain, S.settings.notation)}</b>`, 5200);
    }
  }

  // autosave
  let autosaveT = 0;
  window.addEventListener("beforeunload", () => {
    try { saveState(); } catch (_) {}
  });

  /* ----------------------------- UI Refresh (throttled) ----------------------------- */


  function updateTopBar() {
    setText(dom.money, `$${fmtMoney(S.money, S.settings.notation)}`);
    setText(dom.inf, String(safeInt(S.influence, 0)));
    setText(dom.speed, `${simSpeed.toFixed(1)}×`);
    dom.notation.textContent = `Notation: ${S.settings.notation}`;
  }

  function updateBusinessCards() {
    for (const t of BUSINESS_TEMPLATES) {
      const b = getBiz(t.id);
      const d = bizDom[t.id];
      if (!b || !d) continue;

      const owned = safeInt(b.owned, 0);
      const cost = currentCost(t.id);
      const payout = bizPayoutPerCycle(t.id, owned);
      const cycle = bizCycleSeconds(t.id, owned);

      setText(d.ownedEl, String(owned));
      setText(d.costEl, `$${fmtMoney(cost, S.settings.notation)}`);
      setText(d.payoutEl, `$${fmtMoney(payout, S.settings.notation)}`);
      setText(d.cycleEl, `${cycle.toFixed(cycle >= 10 ? 1 : 2)}s`);
      setText(d.autoEl, b.manager ? "Yes" : "No");

      const profitMult = bizMilestoneProfitMult(owned) * (EFFECTS.bizProfit[t.id] || 1) * EFFECTS.globalProfit * EFFECTS.prestigeMult;
      const cycleMult = bizMilestoneCycleMult(owned) * (EFFECTS.bizCycle[t.id] || 1) * EFFECTS.globalCycle * Math.pow(0.98, safeInt(S.meta.xCycle, 0));
      setText(d.multTxt, `×${profitMult.toFixed(2)} profit · ×${cycleMult.toFixed(2)} cycle`);

      // milestone pips
      for (const pip of d.pips) {
        const thr = safeInt(pip.getAttribute("data-ms"), 0);
        if (owned >= thr) pip.classList.add("on");
        else pip.classList.remove("on");
      }

      // buttons enabled/disabled
      const k = buyCountFromMode(t.id);
      const total = (k > 0) ? totalCostForK(bFromNumber(t.baseCost), t.growth, owned, k) : B(0, 0);
      const canBuy = k > 0 && bCmp(S.money, total) >= 0;
      setDisabled(d.buyBtn, !canBuy);

      const canRun = owned > 0 && !b.manager && !b.running;
      setDisabled(d.runBtn, !canRun);

      const mCost = managerCost(t.id);
      const canHire = !b.manager && bCmp(S.money, mCost) >= 0;
      setDisabled(d.mgrBtn, !canHire);
      d.mgrBtn.textContent = b.manager ? "Manager Hired" : `Hire Manager (${fmtMoney(mCost, S.settings.notation)})`;
    }
  }

  /* ----------------------------- Simulation Loop ----------------------------- */

  // canvas: subtle neon grid + sparks
  function renderCanvas(realDt) {
    Engine.gfx.clearBlack();
    const ctx2 = Engine.getCtx();
    if (!ctx2) return;

    const { w, h } = Engine.getSize();
    ctx2.save();

    // grid (cheap)
    ctx2.globalAlpha = 0.12;
    ctx2.lineWidth = 1;
    ctx2.strokeStyle = "rgba(0,255,255,0.35)";
    const step = 90;
    const t = (performance.now() * 0.00008) % step;
    for (let x = -t; x < w; x += step) {
      ctx2.beginPath();
      ctx2.moveTo(x, 0);
      ctx2.lineTo(x, h);
      ctx2.stroke();
    }
    ctx2.strokeStyle = "rgba(255,0,255,0.25)";
    for (let y = t; y < h; y += step) {
      ctx2.beginPath();
      ctx2.moveTo(0, y);
      ctx2.lineTo(w, y);
      ctx2.stroke();
    }

    // sparks
    const dt = clamp(realDt, 0, 0.05);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.t += dt;
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(0.2, dt);
      p.vy *= Math.pow(0.2, dt);

      if (p.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      const a = clamp(p.life / 0.8, 0, 1);
      ctx2.globalAlpha = 0.55 * a;
      ctx2.fillStyle = "rgba(255,0,255,1)";
      ctx2.beginPath();
      ctx2.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx2.fill();

      ctx2.globalAlpha = 0.35 * a;
      ctx2.fillStyle = "rgba(0,255,255,1)";
      ctx2.beginPath();
      ctx2.arc(p.x + 1.8, p.y - 1.2, 1.6, 0, Math.PI * 2);
      ctx2.fill();
    }

    ctx2.restore();
  }

  let incomeCache = B(0, 0);

  Engine.on("update", (dtRaw) => {
    const dt = clamp(dtRaw * simSpeed, 0, 0.1);

    // playtime
    if (!Engine.isPaused()) S.playtimeSec = safeInt(S.playtimeSec, 0) + dt;

    // autosave timer
    autosaveT += dt;
    if (autosaveT >= 5) {
      autosaveT = 0;
      saveState();
    }

    // toast timer
    toastTick(dt);

    // advance businesses
    if (!Engine.isPaused()) {
      for (const b of S.businesses) {
        const t = templateById(b.id);
        if (!t) continue;

        const owned = safeInt(b.owned, 0);
        if (owned <= 0) {
          b.running = false;
          b.prog = 0;
          continue;
        }

        const auto = !!b.manager;
        if (auto) b.running = true;

        if (!b.running) {
          b.prog = clamp(b.prog, 0, 1);
          continue;
        }

        const cycle = bizCycleSeconds(b.id, owned);
        const payout = bizPayoutPerCycle(b.id, owned);

        // Convert progress to time buffer
        const curTime = clamp(b.prog, 0, 10) * cycle;
        const nextTime = curTime + dt;

        let cycles = Math.floor(nextTime / cycle);
        // cap cycles per tick for stability (tiny cycle times can explode)
        cycles = clamp(cycles, 0, 200);

        const rem = nextTime - cycles * cycle;
        b.prog = clamp(rem / cycle, 0, 10);

        if (cycles > 0) {
          const gain = bMulScalar(payout, cycles);
          S.money = bAdd(S.money, gain);
          S.lifetime = bAdd(S.lifetime, gain);
        }

        // manual businesses stop after one completion
        if (!auto && cycles > 0) {
          b.running = false;
          b.prog = 0;
        }
      }
    }

    // compute income cache + best
    incomeCache = calcIncomePerSec();
    if (bCmp(incomeCache, S.bestIncomeSec) > 0) S.bestIncomeSec = bClone(incomeCache);

    // avoid NaNs
    S.money = bNorm(S.money); if (S.money.m < 0) S.money = B(0, 0);
    S.lifetime = bNorm(S.lifetime); if (S.lifetime.m < 0) S.lifetime = B(0, 0);

    // UI tick throttled
    uiAcc += dtRaw;
    if (forceUI || uiAcc >= 0.10) {
      uiAcc = 0;
      forceUI = false;

      // recompute effects occasionally (cheap)
      recomputeEffects();

      updateTopBar();
      setText(dom.inc, `$${fmtMoney(incomeCache, S.settings.notation)}`);

      updateBusinessCards();

      // Keep prestige panel numbers fresh if open
      if (activeTab === "pre") {
        // quick refresh without rebuilding everything: just re-render panel (cheap enough)
        renderPanel();
        updateTabButtons();
      }
      if (activeTab === "sta") {
        renderPanel();
        updateTabButtons();
      }
    }
  });

  Engine.on("render", (realDt) => {
    renderCanvas(realDt);
    // Also keep progress bars smooth without full text refresh
    // (update width each render; minimal DOM touches)
    for (const b of S.businesses) {
      const d = bizDom[b.id];
      if (!d) continue;
      const p = clamp(b.prog, 0, 1);
      const w = `${(p * 100).toFixed(1)}%`;
      if (d.barEl.style.width !== w) d.barEl.style.width = w;
    }
  });

  /* ----------------------------- Final wiring ----------------------------- */

  // initial values
  updateTopBar();
  setText(dom.inc, `$${fmtMoney(calcIncomePerSec(), S.settings.notation)}`);

  // small safety: clicking UI should not pause the engine
  uiRoot.addEventListener("click", () => {
    // no-op; just ensures uiRoot exists + absorbs focus
  });

  // forceUIRefresh is defined earlier; nothing more to do here.
}
