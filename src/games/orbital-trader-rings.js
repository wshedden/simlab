import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab_orbital_trader_rings_v1";
  const TAU = Math.PI * 2;

  const CFG = {
    maxRings: 5,
    initialUnlocked: 2,
    initialCaravans: 3,
    initialNodes: 2,

    maxCaravans: 200,
    maxNodesPerRing: 40,

    trailLen: 6,

    clickSnapPx: 14,
    nodeAngleMinSep: 0.22, // rad (~12.6 deg)
    tradeAngleWindow: 0.07, // rad
    tradeCooldown: 0.35, // seconds per node

    sparkMax: 300,
    sparkBurst: 10,

    autosaveEvery: 5.0, // seconds
    offlineCapHours: 4,

    // Visual
    stars: 120,
    ringLineWidth: 1.25,
    ringGlowAlpha: 0.25,

    // Economy tuning
    baseTrade: 1.0,
  };

  const COL = {
    cyan: "#3dfcff",
    blue: "#2aa2ff",
    purple: "#b04bff",
    magenta: "#ff4bd8",
    faint: "rgba(90,140,255,0.20)",
    faint2: "rgba(255,75,216,0.14)",
    white: "#e8f7ff",
  };

  const uiRoot =
    ctx && ctx.uiRoot && typeof ctx.uiRoot === "object" && ctx.uiRoot.appendChild
      ? ctx.uiRoot
      : null;

  // ---------- Helpers ----------
  function clamp(x, a, b) {
    return x < a ? a : x > b ? b : x;
  }
  function wrapAngle(a) {
    a %= TAU;
    if (a < 0) a += TAU;
    return a;
  }
  function shortestAngleDiff(a, b) {
    let d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function powFast(base, exp) {
    return Math.pow(base, exp);
  }
  function fmtMoney(x) {
    if (!isFinite(x)) return "0";
    if (x < 1000) return x.toFixed(0);
    if (x < 1e6) return (x / 1e3).toFixed(2) + "k";
    if (x < 1e9) return (x / 1e6).toFixed(2) + "m";
    return (x / 1e9).toFixed(2) + "b";
  }
  function nowSec() {
    // Engine doesn't expose time; use performance.now
    return performance.now() * 0.001;
  }
  function rand01() {
    return Math.random();
  }
  function randRange(a, b) {
    return a + (b - a) * Math.random();
  }

  // ---------- State ----------
  const state = {
    paused: false,
    t: 0,
    money: 0,

    unlockedRings: CFG.initialUnlocked,

    tradeBoostLevel: 0,
    speedLevel: 0,

    // rolling trades for TPM
    tradeTimes: new Float32Array(480),
    tradeHead: 0,
    tradeCount: 0,

    incomePerSecEMA: 0,
    _incomeAcc: 0,
    _incomeTick: 0,

    // status flash
    statusText: "",
    statusUntil: 0,

    // Geometry (CSS pixels)
    cx: 0,
    cy: 0,
    baseR: 0,
    ringStep: 0,

    stars: [],

    rings: [],
    caravans: [],
    nodesByRing: [],

    sparks: {
      x: new Float32Array(CFG.sparkMax),
      y: new Float32Array(CFG.sparkMax),
      vx: new Float32Array(CFG.sparkMax),
      vy: new Float32Array(CFG.sparkMax),
      life: new Float32Array(CFG.sparkMax),
      max: new Float32Array(CFG.sparkMax),
      n: 0,
      head: 0,
    },

    autosaveAt: 0,
    lastSaveTsMs: 0,
  };

  function makeDefaultRings() {
    state.rings.length = 0;
    for (let i = 0; i < CFG.maxRings; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      // keep speeds gentle; later rings slightly quicker
      const baseOmega = dir * (0.55 + 0.13 * i);
      state.rings.push({
        idx: i,
        unlocked: i < state.unlockedRings,
        baseOmega,
        radius: 0,
      });
    }
  }

  function resetRun(keepSaveLoad = false) {
    state.paused = false;
    state.t = 0;
    state.money = 0;
    state.unlockedRings = CFG.initialUnlocked;
    state.tradeBoostLevel = 0;
    state.speedLevel = 0;

    state.tradeHead = 0;
    state.tradeCount = 0;

    state.incomePerSecEMA = 0;
    state._incomeAcc = 0;
    state._incomeTick = 0;

    state.statusText = "";
    state.statusUntil = 0;

    state.caravans.length = 0;
    state.nodesByRing.length = 0;
    for (let i = 0; i < CFG.maxRings; i++) state.nodesByRing.push([]);

    makeDefaultRings();

    // Initial caravans
    for (let i = 0; i < CFG.initialCaravans; i++) {
      addCaravanAuto(true);
    }

    // Initial nodes
    for (let i = 0; i < CFG.initialNodes; i++) {
      addNodeRandomBest(true);
    }

    if (!keepSaveLoad) {
      state.statusText = "Reset.";
      state.statusUntil = nowSec() + 1.1;
    }
  }

  function ensureGeometry() {
    const { w, h } = Engine.getSize();
    const minDim = Math.max(1, Math.min(w, h));
    state.cx = w * 0.5;
    state.cy = h * 0.5;

    // Rings fit nicely with UI space
    const pad = minDim * 0.10;
    state.baseR = clamp(minDim * 0.18, 60, (minDim - pad) * 0.25);
    state.ringStep = clamp(minDim * 0.085, 40, 85);

    for (let i = 0; i < state.rings.length; i++) {
      state.rings[i].radius = state.baseR + state.ringStep * i;
    }
  }

  function regenStars() {
    state.stars.length = 0;
    const { w, h } = Engine.getSize();
    for (let i = 0; i < CFG.stars; i++) {
      state.stars.push({
        x: rand01() * w,
        y: rand01() * h,
        r: rand01() < 0.85 ? 1 : 2,
        a: randRange(0.25, 0.75),
      });
    }
  }

  // ---------- Economy ----------
  function caravanCost() {
    const n = state.caravans.length;
    return Math.floor(25 * powFast(1.18, n));
  }
  function nodeCost() {
    const totalNodes = totalNodeCount();
    return Math.floor(40 * powFast(1.22, totalNodes));
  }
  function unlockRingCost() {
    // unlock ring index = unlockedRings
    const k = state.unlockedRings; // next ring id (0-based)
    return Math.floor(250 * powFast(2.0, Math.max(0, k - CFG.initialUnlocked)));
  }
  function tradeBoostCost() {
    const l = state.tradeBoostLevel;
    return Math.floor(150 * powFast(1.9, l));
  }
  function speedCost() {
    const l = state.speedLevel;
    return Math.floor(120 * powFast(1.85, l));
  }
  function tradeMult() {
    return 1 + 0.18 * state.tradeBoostLevel;
  }
  function speedMult() {
    return 1 + 0.06 * state.speedLevel;
  }
  function ringValueMult(ringIdx) {
    return 1 + 0.35 * ringIdx;
  }

  function canAfford(cost) {
    return state.money >= cost - 1e-9;
  }
  function spend(cost) {
    if (!canAfford(cost)) return false;
    state.money -= cost;
    return true;
  }
  function earn(amount) {
    if (!isFinite(amount) || amount <= 0) return;
    state.money += amount;
    state._incomeAcc += amount;
  }

  // ---------- Objects ----------
  let caravanIdSeq = 1;

  function makeCaravan(ringIdx) {
    const id = caravanIdSeq++;
    const theta = rand01() * TAU;

    const trailX = new Float32Array(CFG.trailLen);
    const trailY = new Float32Array(CFG.trailLen);
    const trailN = CFG.trailLen;
    let trailHead = 0;
    for (let i = 0; i < trailN; i++) {
      trailX[i] = state.cx;
      trailY[i] = state.cy;
    }

    return {
      id,
      ring: ringIdx,
      theta,
      phaseA: rand01() * TAU,
      phaseB: rand01() * TAU,
      wobA: randRange(0.6, 1.4),
      wobB: randRange(1.8, 3.2),
      trailX,
      trailY,
      trailHead,
    };
  }

  function totalNodeCount() {
    let s = 0;
    for (let i = 0; i < state.nodesByRing.length; i++) s += state.nodesByRing[i].length;
    return s;
  }

  function addCaravanAuto(free = false) {
    if (state.caravans.length >= CFG.maxCaravans) {
      flashStatus("Caravan cap reached.");
      return false;
    }
    const cost = caravanCost();
    if (!free && !spend(cost)) {
      flashStatus("Not enough money.");
      return false;
    }

    // Prefer highest unlocked ring that has at least one node; else highest unlocked ring.
    let best = Math.max(0, state.unlockedRings - 1);
    for (let i = state.unlockedRings - 1; i >= 0; i--) {
      if ((state.nodesByRing[i] && state.nodesByRing[i].length) > 0) {
        best = i;
        break;
      }
    }

    state.caravans.push(makeCaravan(best));
    return true;
  }

  function addNodeOnRing(ringIdx, theta, free = false) {
    if (ringIdx < 0 || ringIdx >= CFG.maxRings) return false;
    if (ringIdx >= state.unlockedRings) return false;

    const list = state.nodesByRing[ringIdx];
    if (!list) return false;
    if (list.length >= CFG.maxNodesPerRing) {
      flashStatus("Node cap on that ring.");
      return false;
    }

    const cost = nodeCost();
    if (!free && !spend(cost)) {
      flashStatus("Not enough money.");
      return false;
    }

    theta = wrapAngle(theta);

    // Ensure not too close to existing nodes; attempt a few jitters.
    for (let tries = 0; tries < 16; tries++) {
      let ok = true;
      for (let i = 0; i < list.length; i++) {
        if (Math.abs(shortestAngleDiff(theta, list[i].theta)) < CFG.nodeAngleMinSep) {
          ok = false;
          break;
        }
      }
      if (ok) break;
      theta = wrapAngle(theta + randRange(-0.35, 0.35));
    }

    list.push({
      theta,
      lastTradeAt: -9999,
      pulse: 0,
    });

    return true;
  }

  function addNodeRandomBest(free = false) {
    const cost = nodeCost();
    if (!free && !canAfford(cost)) {
      flashStatus("Not enough money.");
      return false;
    }

    // Choose best ring: highest unlocked ring with available node slots.
    let ringIdx = -1;
    for (let i = state.unlockedRings - 1; i >= 0; i--) {
      const list = state.nodesByRing[i];
      if (list && list.length < CFG.maxNodesPerRing) {
        ringIdx = i;
        break;
      }
    }
    if (ringIdx < 0) {
      flashStatus("No ring has node space.");
      return false;
    }

    // Find an angle not too close to others.
    const list = state.nodesByRing[ringIdx];
    let theta = rand01() * TAU;
    for (let tries = 0; tries < 30; tries++) {
      let ok = true;
      for (let i = 0; i < list.length; i++) {
        if (Math.abs(shortestAngleDiff(theta, list[i].theta)) < CFG.nodeAngleMinSep) {
          ok = false;
          break;
        }
      }
      if (ok) break;
      theta = rand01() * TAU;
    }

    if (!free && !spend(cost)) {
      flashStatus("Not enough money.");
      return false;
    }

    list.push({ theta, lastTradeAt: -9999, pulse: 0 });
    return true;
  }

  function unlockNextRing() {
    if (state.unlockedRings >= CFG.maxRings) {
      flashStatus("All rings unlocked.");
      return false;
    }
    const cost = unlockRingCost();
    if (!spend(cost)) {
      flashStatus("Not enough money.");
      return false;
    }
    state.unlockedRings++;
    for (let i = 0; i < state.rings.length; i++) state.rings[i].unlocked = i < state.unlockedRings;
    flashStatus("Ring unlocked.");
    return true;
  }

  // ---------- Sparks ----------
  function emitSparks(x, y, ringIdx) {
    const s = state.sparks;
    const burst = CFG.sparkBurst;
    const speed = 70 + ringIdx * 18;

    for (let i = 0; i < burst; i++) {
      const a = rand01() * TAU;
      const v = speed * randRange(0.35, 1.0);
      const vx = Math.cos(a) * v;
      const vy = Math.sin(a) * v;
      const life = randRange(0.18, 0.36);

      const idx = s.n < CFG.sparkMax ? s.n++ : s.head++ % CFG.sparkMax;
      s.x[idx] = x;
      s.y[idx] = y;
      s.vx[idx] = vx;
      s.vy[idx] = vy;
      s.life[idx] = life;
      s.max[idx] = life;
    }
  }

  function updateSparks(dt) {
    const s = state.sparks;
    const n = s.n;
    for (let i = 0; i < n; i++) {
      let life = s.life[i];
      if (life <= 0) continue;
      life -= dt;
      s.life[i] = life;
      if (life <= 0) continue;
      s.x[i] += s.vx[i] * dt;
      s.y[i] += s.vy[i] * dt;
      s.vx[i] *= 0.92;
      s.vy[i] *= 0.92;
    }
  }

  // ---------- Trades / rolling stats ----------
  function recordTrade() {
    state.tradeTimes[state.tradeHead] = nowSec();
    state.tradeHead = (state.tradeHead + 1) % state.tradeTimes.length;
    state.tradeCount = Math.min(state.tradeCount + 1, state.tradeTimes.length);
  }

  function tradesPerMinute() {
    const t = nowSec();
    let c = 0;
    const n = state.tradeCount;
    const arr = state.tradeTimes;
    for (let i = 0; i < n; i++) {
      // scan backwards-ish by indexing from head
      const idx = (state.tradeHead - 1 - i + arr.length) % arr.length;
      const dt = t - arr[idx];
      if (dt <= 60) c++;
      else break; // older than a minute
    }
    return c;
  }

  function flashStatus(txt) {
    state.statusText = txt || "";
    state.statusUntil = nowSec() + 1.0;
  }

  // ---------- Save/load + offline ----------
  function serialise() {
    // Keep it small but complete.
    const caravans = new Array(state.caravans.length);
    for (let i = 0; i < state.caravans.length; i++) {
      const c = state.caravans[i];
      caravans[i] = {
        id: c.id,
        ring: c.ring,
        theta: c.theta,
        phaseA: c.phaseA,
        phaseB: c.phaseB,
        wobA: c.wobA,
        wobB: c.wobB,
      };
    }
    const nodes = new Array(CFG.maxRings);
    for (let r = 0; r < CFG.maxRings; r++) {
      const list = state.nodesByRing[r] || [];
      const out = new Array(list.length);
      for (let i = 0; i < list.length; i++) {
        out[i] = { theta: list[i].theta, lastTradeAt: list[i].lastTradeAt };
      }
      nodes[r] = out;
    }

    return {
      v: 1,
      money: state.money,
      unlockedRings: state.unlockedRings,
      tradeBoostLevel: state.tradeBoostLevel,
      speedLevel: state.speedLevel,
      caravans,
      nodes,
      incomePerSecEMA: state.incomePerSecEMA,
    };
  }

  function applySave(obj) {
    if (!obj || typeof obj !== "object") return false;

    state.money = typeof obj.money === "number" && isFinite(obj.money) ? obj.money : 0;
    state.unlockedRings =
      typeof obj.unlockedRings === "number"
        ? clamp(Math.floor(obj.unlockedRings), 1, CFG.maxRings)
        : CFG.initialUnlocked;
    state.tradeBoostLevel =
      typeof obj.tradeBoostLevel === "number" ? clamp(Math.floor(obj.tradeBoostLevel), 0, 999) : 0;
    state.speedLevel =
      typeof obj.speedLevel === "number" ? clamp(Math.floor(obj.speedLevel), 0, 999) : 0;

    state.incomePerSecEMA =
      typeof obj.incomePerSecEMA === "number" && isFinite(obj.incomePerSecEMA) ? obj.incomePerSecEMA : 0;

    state.caravans.length = 0;
    caravanIdSeq = 1;
    let maxSavedId = 0;

    const savedCaravans = Array.isArray(obj.caravans) ? obj.caravans : [];
    for (let i = 0; i < savedCaravans.length; i++) {
      const sc = savedCaravans[i];
      const ring = typeof sc.ring === "number" ? clamp(Math.floor(sc.ring), 0, CFG.maxRings - 1) : 0;
      const c = makeCaravan(ring);
      if (typeof sc.id === "number") { c.id = sc.id; maxSavedId = Math.max(maxSavedId, sc.id); }
      if (typeof sc.theta === "number") c.theta = wrapAngle(sc.theta);
      if (typeof sc.phaseA === "number") c.phaseA = wrapAngle(sc.phaseA);
      if (typeof sc.phaseB === "number") c.phaseB = wrapAngle(sc.phaseB);
      if (typeof sc.wobA === "number" && isFinite(sc.wobA)) c.wobA = sc.wobA;
      if (typeof sc.wobB === "number" && isFinite(sc.wobB)) c.wobB = sc.wobB;
      state.caravans.push(c);
      if (state.caravans.length >= CFG.maxCaravans) break;
    }
    caravanIdSeq = Math.max(caravanIdSeq, maxSavedId + 1);

    state.nodesByRing.length = 0;
    for (let r = 0; r < CFG.maxRings; r++) state.nodesByRing.push([]);
    const savedNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
    for (let r = 0; r < CFG.maxRings; r++) {
      const list = Array.isArray(savedNodes[r]) ? savedNodes[r] : [];
      const out = state.nodesByRing[r];
      for (let i = 0; i < list.length; i++) {
        if (out.length >= CFG.maxNodesPerRing) break;
        const sn = list[i];
        const theta = typeof sn.theta === "number" ? wrapAngle(sn.theta) : rand01() * TAU;
        // Reset lastTradeAt to allow trades immediately after load
        const lastTradeAt = -9999;
        out.push({ theta, lastTradeAt, pulse: 0 });
      }
    }

    makeDefaultRings();
    for (let i = 0; i < state.rings.length; i++) state.rings[i].unlocked = i < state.unlockedRings;

    // If save had 0 caravans/nodes, restore a playable baseline.
    if (state.caravans.length === 0) {
      for (let i = 0; i < CFG.initialCaravans; i++) addCaravanAuto(true);
    }
    if (totalNodeCount() === 0) {
      for (let i = 0; i < CFG.initialNodes; i++) addNodeRandomBest(true);
    }

    return true;
  }

  function doSave() {
    const payload = serialise();
    Engine.save(SAVE_KEY, payload);
    state.lastSaveTsMs = Date.now();
  }

  function doLoadAndOffline() {
    const saved = Engine.load(SAVE_KEY, null);
    const ok = applySave(saved);

    ensureGeometry();
    regenStars();

    const lastTs = Engine.loadTimestamp(SAVE_KEY);
    const nowMs = Date.now();
    if (ok && lastTs > 0 && nowMs > lastTs) {
      const capMs = CFG.offlineCapHours * 3600 * 1000;
      const dtMs = Math.min(nowMs - lastTs, capMs);
      const dtSec = dtMs * 0.001;

      // Offline progress: use EMA of income/sec (money/sec). Conservative clamp.
      const ips = clamp(state.incomePerSecEMA || 0, 0, 1e6);
      const offlineEarn = ips * dtSec;
      if (offlineEarn > 0.01) {
        state.money += offlineEarn;
        flashStatus(`Offline: +${fmtMoney(offlineEarn)}`);
      }
    }

    return ok;
  }

  // ---------- UI ----------
  let ui = null;

  function makeButton(label) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.display = "block";
    b.style.width = "100%";
    b.style.padding = "8px 10px";
    b.style.margin = "6px 0";
    b.style.borderRadius = "10px";
    b.style.border = "1px solid rgba(120,180,255,0.25)";
    b.style.background = "rgba(8,12,18,0.85)";
    b.style.color = "#dff6ff";
    b.style.cursor = "pointer";
    b.style.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    b.onmouseenter = () => (b.style.borderColor = "rgba(255,75,216,0.45)");
    b.onmouseleave = () => (b.style.borderColor = "rgba(120,180,255,0.25)");
    return b;
  }

  function makeUI() {
    if (!uiRoot) return null;
    uiRoot.innerHTML = "";

    const panel = document.createElement("div");
    panel.style.position = "absolute";
    panel.style.right = "12px";
    panel.style.top = "12px";
    panel.style.width = "260px";
    panel.style.padding = "12px";
    panel.style.borderRadius = "14px";
    panel.style.border = "1px solid rgba(120,180,255,0.25)";
    panel.style.background = "rgba(0,0,0,0.65)";
    panel.style.backdropFilter = "blur(6px)";
    panel.style.boxShadow = "0 0 24px rgba(40,120,255,0.10)";
    panel.style.color = "#dff6ff";
    panel.style.font = "14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    panel.style.userSelect = "none";

    const title = document.createElement("div");
    title.textContent = "Orbital Trader Rings";
    title.style.fontWeight = "800";
    title.style.fontSize = "16px";
    title.style.letterSpacing = "0.2px";
    title.style.marginBottom = "8px";
    panel.appendChild(title);

    const moneyLine = document.createElement("div");
    moneyLine.style.display = "flex";
    moneyLine.style.justifyContent = "space-between";
    moneyLine.style.alignItems = "baseline";
    moneyLine.style.marginBottom = "10px";

    const moneyLabel = document.createElement("div");
    moneyLabel.textContent = "Money";
    moneyLabel.style.opacity = "0.9";
    moneyLabel.style.fontWeight = "700";

    const moneyValue = document.createElement("div");
    moneyValue.textContent = "0";
    moneyValue.style.fontWeight = "900";
    moneyValue.style.fontSize = "18px";
    moneyValue.style.color = COL.cyan;

    moneyLine.appendChild(moneyLabel);
    moneyLine.appendChild(moneyValue);
    panel.appendChild(moneyLine);

    const btnCaravan = makeButton("Buy Caravan");
    const btnNode = makeButton("Buy Node (auto)");
    const btnRing = makeButton("Unlock Next Ring");
    const btnTrade = makeButton("Upgrade: Trade Boost");
    const btnSpeed = makeButton("Upgrade: Caravan Speed");

    const stats = document.createElement("div");
    stats.style.marginTop = "10px";
    stats.style.paddingTop = "10px";
    stats.style.borderTop = "1px solid rgba(120,180,255,0.18)";
    stats.style.fontSize = "12px";
    stats.style.opacity = "0.95";
    stats.style.lineHeight = "1.35";

    const help = document.createElement("div");
    help.textContent = "Tip: click a ring to place a node.";
    help.style.marginTop = "10px";
    help.style.fontSize = "12px";
    help.style.opacity = "0.85";

    const status = document.createElement("div");
    status.style.marginTop = "8px";
    status.style.fontSize = "12px";
    status.style.color = COL.magenta;
    status.style.minHeight = "16px";

    const back = document.createElement("a");
    back.href = "/";
    back.textContent = "Back";
    back.style.display = "inline-block";
    back.style.marginTop = "10px";
    back.style.fontSize = "12px";
    back.style.color = COL.blue;
    back.style.textDecoration = "none";
    back.style.border = "1px solid rgba(42,162,255,0.25)";
    back.style.padding = "6px 10px";
    back.style.borderRadius = "10px";
    back.onmouseenter = () => (back.style.borderColor = "rgba(255,75,216,0.45)");
    back.onmouseleave = () => (back.style.borderColor = "rgba(42,162,255,0.25)");

    btnCaravan.onclick = () => addCaravanAuto(false);
    btnNode.onclick = () => addNodeRandomBest(false);
    btnRing.onclick = () => unlockNextRing();
    btnTrade.onclick = () => {
      const cost = tradeBoostCost();
      if (!spend(cost)) return flashStatus("Not enough money.");
      state.tradeBoostLevel++;
      flashStatus("Trade boosted.");
    };
    btnSpeed.onclick = () => {
      const cost = speedCost();
      if (!spend(cost)) return flashStatus("Not enough money.");
      state.speedLevel++;
      flashStatus("Speed upgraded.");
    };

    panel.appendChild(btnCaravan);
    panel.appendChild(btnNode);
    panel.appendChild(btnRing);
    panel.appendChild(btnTrade);
    panel.appendChild(btnSpeed);
    panel.appendChild(stats);
    panel.appendChild(help);
    panel.appendChild(status);
    panel.appendChild(back);

    uiRoot.appendChild(panel);

    return {
      panel,
      moneyValue,
      btnCaravan,
      btnNode,
      btnRing,
      btnTrade,
      btnSpeed,
      stats,
      status,
      help,
    };
  }

  function updateUI() {
    if (!ui) return;

    ui.moneyValue.textContent = fmtMoney(state.money);

    const caravanC = caravanCost();
    const nodeC = nodeCost();
    const ringC = unlockRingCost();
    const tradeC = tradeBoostCost();
    const speedC = speedCost();

    ui.btnCaravan.textContent = `Buy Caravan (£${fmtMoney(caravanC)})`;
    ui.btnNode.textContent = `Buy Node (£${fmtMoney(nodeC)})`;
    ui.btnRing.textContent =
      state.unlockedRings >= CFG.maxRings ? "All Rings Unlocked" : `Unlock Next Ring (£${fmtMoney(ringC)})`;
    ui.btnTrade.textContent = `Upgrade: Trade Boost L${state.tradeBoostLevel} (£${fmtMoney(tradeC)})`;
    ui.btnSpeed.textContent = `Upgrade: Caravan Speed L${state.speedLevel} (£${fmtMoney(speedC)})`;

    ui.btnCaravan.disabled = !canAfford(caravanC) || state.caravans.length >= CFG.maxCaravans;
    ui.btnNode.disabled = !canAfford(nodeC);
    ui.btnRing.disabled = state.unlockedRings >= CFG.maxRings || !canAfford(ringC);
    ui.btnTrade.disabled = !canAfford(tradeC);
    ui.btnSpeed.disabled = !canAfford(speedC);

    ui.btnCaravan.style.opacity = ui.btnCaravan.disabled ? "0.55" : "1";
    ui.btnNode.style.opacity = ui.btnNode.disabled ? "0.55" : "1";
    ui.btnRing.style.opacity = ui.btnRing.disabled ? "0.55" : "1";
    ui.btnTrade.style.opacity = ui.btnTrade.disabled ? "0.55" : "1";
    ui.btnSpeed.style.opacity = ui.btnSpeed.disabled ? "0.55" : "1";

    const tpm = tradesPerMinute();
    const nodes = totalNodeCount();
    ui.stats.innerHTML =
      `Caravans: <b>${state.caravans.length}</b><br>` +
      `Nodes: <b>${nodes}</b><br>` +
      `Rings unlocked: <b>${state.unlockedRings}/${CFG.maxRings}</b><br>` +
      `Trades/min: <b>${tpm}</b><br>` +
      `Income/sec (est): <b>${fmtMoney(state.incomePerSecEMA)}</b>`;

    ui.status.textContent = nowSec() < state.statusUntil ? state.statusText : "";
  }

  // ---------- Click placement ----------
  function ringFromClick(x, y) {
    const dx = x - state.cx;
    const dy = y - state.cy;
    const dist = Math.hypot(dx, dy);
    let best = -1;
    let bestErr = 1e9;
    for (let i = 0; i < state.unlockedRings; i++) {
      const r = state.rings[i].radius;
      const err = Math.abs(dist - r);
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    return { ringIdx: best, dist, err: bestErr, angle: Math.atan2(dy, dx) };
  }

  function tryPlaceNodeAtClick(event, pos) {
    if (!pos) return;
    const x = pos.x;
    const y = pos.y;

    const snap = ringFromClick(x, y);
    const shift = !!(event && event.shiftKey);

    if (snap.ringIdx < 0) return;
    if (!shift && snap.err > CFG.clickSnapPx) {
      flashStatus("Click nearer the ring (or Shift+Click).");
      return;
    }

    const cost = nodeCost();
    if (!canAfford(cost)) {
      flashStatus(`Need £${fmtMoney(cost)} for a node.`);
      return;
    }

    const ok = addNodeOnRing(snap.ringIdx, snap.angle, false);
    if (ok) {
      flashStatus("Node placed.");
      // Tiny click feedback sound if audio enabled elsewhere (we don't auto-enable).
      if (Engine.audio && Engine.audio.click && Engine.audio.muted === false) {
        try {
          Engine.audio.click(420 + snap.ringIdx * 90);
        } catch (_) {}
      }
    }
  }

  // ---------- Update / render ----------
  function caravanPos(c) {
    const ring = state.rings[c.ring];
    const r = ring ? ring.radius : state.baseR;
    const th = c.theta;

    // Cheap epicycle wobble
    const wob1 = Math.sin(state.t * c.wobA + c.phaseA) * 2.2;
    const wob2 = Math.cos(state.t * c.wobB + c.phaseB) * 1.6;
    const rr = r + wob1 + wob2;

    const x = state.cx + Math.cos(th) * rr;
    const y = state.cy + Math.sin(th) * rr;
    return { x, y };
  }

  function nodePos(ringIdx, theta) {
    const r = state.rings[ringIdx].radius;
    const x = state.cx + Math.cos(theta) * r;
    const y = state.cy + Math.sin(theta) * r;
    return { x, y };
  }

  function doTrade(ringIdx, node, x, y) {
    const base = CFG.baseTrade * ringValueMult(ringIdx) * tradeMult();
    earn(base);
    recordTrade();

    node.lastTradeAt = state.t;
    node.pulse = 1.0;

    emitSparks(x, y, ringIdx);

    if (Engine.audio && Engine.audio.click && Engine.audio.muted === false) {
      try {
        Engine.audio.click(260 + ringIdx * 60);
      } catch (_) {}
    }
  }

  function updateEconomyEstimates(dt) {
    state._incomeTick += dt;
    if (state._incomeTick >= 1.0) {
      const ips = state._incomeAcc / state._incomeTick;
      state._incomeAcc = 0;
      state._incomeTick = 0;

      // Gentle EMA to drive offline estimate
      const a = 0.08;
      state.incomePerSecEMA = lerp(state.incomePerSecEMA, ips, a);
    }
  }

  function updateCaravansAndTrades(dt) {
    const spdMul = speedMult();

    for (let i = 0; i < state.caravans.length; i++) {
      const c = state.caravans[i];
      const ring = state.rings[c.ring];
      if (!ring || !ring.unlocked) {
        c.ring = Math.max(0, state.unlockedRings - 1);
      }
      const omega = ring.baseOmega * spdMul;
      c.theta = wrapAngle(c.theta + omega * dt);

      // Update trail with current position
      const p = caravanPos(c);
      c.trailHead = (c.trailHead + 1) % CFG.trailLen;
      c.trailX[c.trailHead] = p.x;
      c.trailY[c.trailHead] = p.y;

      // Trade detection: check nodes on this ring only
      const nodes = state.nodesByRing[c.ring];
      if (!nodes || nodes.length === 0) continue;

      // If close to multiple nodes, allow at most one trade per update per caravan
      for (let j = 0; j < nodes.length; j++) {
        const n = nodes[j];
        if (state.t - n.lastTradeAt < CFG.tradeCooldown) continue;
        const d = Math.abs(shortestAngleDiff(c.theta, n.theta));
        if (d < CFG.tradeAngleWindow) {
          const np = nodePos(c.ring, n.theta);
          doTrade(c.ring, n, np.x, np.y);
          break;
        }
      }
    }
  }

  function updateNodes(dt) {
    for (let r = 0; r < state.unlockedRings; r++) {
      const list = state.nodesByRing[r];
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        n.pulse = Math.max(0, n.pulse - dt * 2.6);
      }
    }
  }

  function render() {
    const g = Engine.gfx;
    g.clearBlack();

    const c2d = Engine.getCtx();
    const { w, h } = Engine.getSize();

    // Stars
    c2d.save();
    c2d.globalCompositeOperation = "source-over";
    c2d.fillStyle = "rgba(255,255,255,0.0)";
    for (let i = 0; i < state.stars.length; i++) {
      const s = state.stars[i];
      c2d.fillStyle = `rgba(220,245,255,${s.a})`;
      c2d.fillRect(s.x, s.y, s.r, s.r);
    }
    c2d.restore();

    // Rings (faint neon)
    for (let i = 0; i < state.rings.length; i++) {
      const ring = state.rings[i];
      const r = ring.radius;
      if (i >= state.unlockedRings) {
        // Locked rings as very faint dashed hint
        c2d.save();
        c2d.strokeStyle = "rgba(120,180,255,0.08)";
        c2d.lineWidth = 1;
        c2d.setLineDash([4, 8]);
        c2d.beginPath();
        c2d.arc(state.cx, state.cy, r, 0, TAU);
        c2d.stroke();
        c2d.restore();
        continue;
      }

      c2d.save();
      c2d.strokeStyle = i % 2 === 0 ? "rgba(61,252,255,0.20)" : "rgba(176,75,255,0.16)";
      c2d.lineWidth = CFG.ringLineWidth;
      c2d.beginPath();
      c2d.arc(state.cx, state.cy, r, 0, TAU);
      c2d.stroke();
      c2d.restore();
    }

    // Hub
    g.glowCircle(state.cx, state.cy, 10, COL.blue, 24, 0.9);
    g.glowCircle(state.cx, state.cy, 3.2, COL.white, 10, 0.9);

    // Spokes (subtle)
    const spokeN = 10;
    for (let i = 0; i < spokeN; i++) {
      const a = (i / spokeN) * TAU + state.t * 0.03;
      const x1 = state.cx + Math.cos(a) * (state.baseR * 0.35);
      const y1 = state.cy + Math.sin(a) * (state.baseR * 0.35);
      const x2 = state.cx + Math.cos(a) * (state.baseR + state.ringStep * (state.unlockedRings - 1));
      const y2 = state.cy + Math.sin(a) * (state.baseR + state.ringStep * (state.unlockedRings - 1));
      g.line(x1, y1, x2, y2, "rgba(42,162,255,0.06)", 1, 1);
    }

    // Nodes
    for (let r = 0; r < state.unlockedRings; r++) {
      const list = state.nodesByRing[r];
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        const p = nodePos(r, n.theta);

        const baseCol = r % 2 === 0 ? COL.cyan : COL.magenta;
        const pulse = n.pulse;

        g.glowCircle(p.x, p.y, 3.1, baseCol, 14, 0.85);
        if (pulse > 0) {
          g.glowCircle(p.x, p.y, 7.0 + pulse * 5.0, baseCol, 26, 0.22 + pulse * 0.35);
        }
      }
    }

    // Caravan trails + bodies
    for (let i = 0; i < state.caravans.length; i++) {
      const c = state.caravans[i];
      const ringIdx = c.ring;

      const col = ringIdx % 3 === 0 ? COL.cyan : ringIdx % 3 === 1 ? COL.purple : COL.magenta;

      // Trail: explicit history, no smear
      const head = c.trailHead;
      for (let k = 0; k < CFG.trailLen - 1; k++) {
        const i0 = (head - k + CFG.trailLen) % CFG.trailLen;
        const i1 = (head - k - 1 + CFG.trailLen) % CFG.trailLen;
        const x0 = c.trailX[i0],
          y0 = c.trailY[i0];
        const x1 = c.trailX[i1],
          y1 = c.trailY[i1];
        const a = 0.40 * (1 - k / (CFG.trailLen - 1));
        g.line(x0, y0, x1, y1, col, 2, a);
      }

      const p = { x: c.trailX[head], y: c.trailY[head] };
      g.glowCircle(p.x, p.y, 2.6, col, 18, 0.9);
    }

    // Sparks
    const s = state.sparks;
    for (let i = 0; i < s.n; i++) {
      const life = s.life[i];
      if (life <= 0) continue;
      const a = life / (s.max[i] || 1);
      const r = 1.4 + (1 - a) * 0.8;
      g.glowCircle(s.x[i], s.y[i], r, COL.white, 10, 0.25 + a * 0.55);
    }

    // Canvas HUD if no UI
    if (!uiRoot) {
      c2d.save();
      c2d.fillStyle = "rgba(223,246,255,0.95)";
      c2d.font = "700 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      c2d.fillText(`Orbital Trader Rings`, 14, 22);
      c2d.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      c2d.fillText(`Money: £${fmtMoney(state.money)}`, 14, 42);
      c2d.fillStyle = "rgba(61,252,255,0.85)";
      c2d.fillText(`Click ring to place node • Space: pause • R: reset`, 14, 62);
      if (nowSec() < state.statusUntil && state.statusText) {
        c2d.fillStyle = "rgba(255,75,216,0.9)";
        c2d.fillText(state.statusText, 14, 82);
      }
      c2d.restore();
    }

    // Brief status overlay even with UI (optional)
    if (uiRoot && nowSec() < state.statusUntil && state.statusText) {
      c2d.save();
      c2d.fillStyle = "rgba(255,75,216,0.85)";
      c2d.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      c2d.fillText(state.statusText, 14, 22);
      c2d.restore();
    }
  }

  // ---------- Input handlers ----------
  function onKeyDown(ev) {
    const key = ev && ev.key ? ev.key : "";
    if (key === " " || key === "Spacebar") {
      Engine.togglePause();
      state.paused = Engine.isPaused();
      flashStatus(state.paused ? "Paused." : "Running.");
      return;
    }
    if (key === "r" || key === "R") {
      const ok = confirm("Reset this run?");
      if (ok) {
        resetRun(false);
        doSave();
      }
      return;
    }
  }

  function onClick(ev, pos) {
    tryPlaceNodeAtClick(ev, pos);
  }

  // ---------- Boot ----------
  resetRun(true);

  // Load saved state (and offline)
  doLoadAndOffline();

  // UI
  ui = makeUI();

  // ensure geometry after UI potentially changes layout
  ensureGeometry();

  // Seed trails immediately with correct positions
  for (let i = 0; i < state.caravans.length; i++) {
    const c = state.caravans[i];
    const p = caravanPos(c);
    for (let k = 0; k < CFG.trailLen; k++) {
      c.trailX[k] = p.x;
      c.trailY[k] = p.y;
    }
    c.trailHead = CFG.trailLen - 1;
  }

  // Autosave timer
  state.autosaveAt = nowSec() + CFG.autosaveEvery;

  // Prevent missing stars if first load happened before size known
  if (!state.stars.length) regenStars();

  // Hooks
  Engine.on("onResize", () => {
    ensureGeometry();
    regenStars();

    // Re-anchor trails to avoid long jumps after resize
    for (let i = 0; i < state.caravans.length; i++) {
      const c = state.caravans[i];
      const p = caravanPos(c);
      for (let k = 0; k < CFG.trailLen; k++) {
        c.trailX[k] = p.x;
        c.trailY[k] = p.y;
      }
      c.trailHead = CFG.trailLen - 1;
    }
  });

  Engine.on("onClick", onClick);
  Engine.on("onKeyDown", onKeyDown);

  Engine.on("update", (dt) => {
    state.paused = Engine.isPaused();
    if (state.paused) return;

    state.t += dt;

    updateCaravansAndTrades(dt);
    updateNodes(dt);
    updateSparks(dt);
    updateEconomyEstimates(dt);

    if (ui) updateUI();

    const t = nowSec();
    if (t >= state.autosaveAt) {
      doSave();
      state.autosaveAt = t + CFG.autosaveEvery;
    }
  });

  Engine.on("render", () => {
    render();
  });

  // Save on unload (best-effort)
  window.addEventListener("beforeunload", () => {
    try {
      doSave();
    } catch (_) {}
  });
}
