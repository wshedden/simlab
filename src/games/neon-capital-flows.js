import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: ctx.canvasId });

  // ---- tiny generic helpers (local, no engine rewrite) ----
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- config ----
  const TYPES = /** @type {const} */ (["bank", "fund", "exchange", "startup", "central"]);
  const TYPE_COLOUR = {
    bank: "#00F5FF", // cyan
    fund: "#FF2BD6", // magenta
    exchange: "#8A4BFF", // purple
    startup: "#2E7BFF", // electric blue
    central: "#CFFFFF", // bright white-cyan
  };
  const TYPE_LABEL = {
    bank: "Bank",
    fund: "Fund",
    exchange: "Exchange",
    startup: "Startup",
    central: "Central Bank",
  };

  const TIER_THRESHOLDS = [0, 2500, 20000, 150000, 1200000, 9000000];
  const ROLL_SECONDS = 30;

  const BASE_RING_SPACING = 92;
  const MAX_NODES = 110; // hard cap
  const BASE_MAX_PACKETS = 260;
  const MAX_MAX_PACKETS = 1550;

  const BASE_PACKET_SPEED = 0.55; // progress per second baseline (scaled by edge length)
  const LIQUIDITY_DECAY = 0.018;
  const LIQUIDITY_SPAWN_THRESHOLD = 0.45;

  // ---- deterministic RNG ----
  function hash32(str) {
    // FNV-1a
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function makeRng(seed) {
    let s = seed >>> 0;
    return {
      nextU32() {
        // xorshift32
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s;
      },
      next() {
        return (this.nextU32() >>> 0) / 4294967296;
      },
      getSeed() {
        return s >>> 0;
      },
      setSeed(v) {
        s = v >>> 0;
      },
    };
  }

  // ---- state ----
  /** @type {{id:number,type:string,x:number,y:number,level:number,capacity:number,liquidity:number,connections:number[],baseGeneration:number,demandBias:number,efficiency:number,ring:number,slot:number}} */
  const nodes = [];
  /** @type {{from:number,to:number,throughputCapacity:number,spread:number,length:number,ux:number,uy:number}} */
  const edges = [];

  // Packets as struct-of-arrays for low churn
  let maxPackets = BASE_MAX_PACKETS;

  /** @type {Int32Array} */ let pEdge = new Int32Array(MAX_MAX_PACKETS);
  /** @type {Float32Array} */ let pProg = new Float32Array(MAX_MAX_PACKETS);
  /** @type {Float32Array} */ let pAmt = new Float32Array(MAX_MAX_PACKETS);
  /** @type {Float32Array} */ let pSpeed = new Float32Array(MAX_MAX_PACKETS);
  /** @type {Uint8Array} */ let pOriginType = new Uint8Array(MAX_MAX_PACKETS);
  /** @type {Int32Array} */ let pNext = new Int32Array(MAX_MAX_PACKETS);
  /** @type {Int32Array} */ let pPrev = new Int32Array(MAX_MAX_PACKETS);
  /** @type {Uint8Array} */ let pAlive = new Uint8Array(MAX_MAX_PACKETS);

  /** @type {Int32Array} */ let edgeActive = new Int32Array(1024);

  let freeHead = -1;
  let aliveHead = -1;
  let aliveCount = 0;

  function packetInitFreeList() {
    freeHead = 0;
    aliveHead = -1;
    aliveCount = 0;
    for (let i = 0; i < MAX_MAX_PACKETS; i++) {
      pAlive[i] = 0;
      pNext[i] = i + 1;
      pPrev[i] = -1;
    }
    pNext[MAX_MAX_PACKETS - 1] = -1;
  }
  packetInitFreeList();

  function packetAlloc() {
    if (freeHead === -1) return -1;
    const i = freeHead;
    freeHead = pNext[i];
    pAlive[i] = 1;

    // insert at aliveHead
    pPrev[i] = -1;
    pNext[i] = aliveHead;
    if (aliveHead !== -1) pPrev[aliveHead] = i;
    aliveHead = i;

    aliveCount++;
    return i;
  }
  function packetFree(i) {
    if (!pAlive[i]) return;
    // unlink from alive list
    const pr = pPrev[i];
    const nx = pNext[i];
    if (pr !== -1) pNext[pr] = nx;
    else aliveHead = nx;
    if (nx !== -1) pPrev[nx] = pr;

    pAlive[i] = 0;
    // push to free list
    pNext[i] = freeHead;
    pPrev[i] = -1;
    freeHead = i;

    aliveCount--;
  }

  // ---- global economy ----
  let totalCapital = 0;
  let liquidCapital = 0;
  let globalThroughput = 0; // rolling average (gross)
  let networkTier = 0;

  let unlocked = {
    bank: true,
    fund: true,
    exchange: false,
    startup: false,
    central: false,
  };

  let policy = {
    taxRate: 0.04, // 0..0.2
    spreadFloor: 0.0, // 0..1, boosts capacity floor
    liquidityRebate: 0.0, // 0..1, boosts speed
  };

  let glowBoost = 1.0;

  // rolling throughput buffer (gross delivered per second)
  /** @type {Float32Array} */ const roll = new Float32Array(ROLL_SECONDS);
  let rollIdx = 0;
  let deliveredThisSecond = 0;
  let secAcc = 0;

  // news pulses (soft purple flashes), sparse
  let newsT = 0;
  let newsMag = 0;

  // audio
  let audioEnabled = false;
  Engine.on("onClick", async () => {
    if (audioEnabled) return;
    try {
      await Engine.audio.enable();
      audioEnabled = true;
    } catch {
      // ignore
    }
  });

  const saveKey = ctx.gameId;
  const rng = makeRng(hash32(ctx.gameId + "::NeonCapitalFlows"));

  // ---- UI ----
  function el(tag, attrs, html) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }

  ctx.uiRoot.innerHTML = "";
  ctx.uiRoot.style.pointerEvents = "auto";

  const root = el(
    "div",
    { style: "position:absolute; inset:0; display:flex; gap:10px; padding:10px; align-items:flex-start;" },
    ""
  );

  const panel = el(
    "div",
    {
      style:
        "width: 360px; max-width: 45vw; background: rgba(0,0,0,0.55); border: 1px solid rgba(140,180,255,0.25); border-radius: 12px; padding: 10px 10px 12px 10px; backdrop-filter: blur(6px);",
    },
    ""
  );

  const title = el(
    "div",
    { style: "font-weight:700; letter-spacing:0.6px; margin-bottom:8px; color:#CFFFFF;" },
    "Neon Capital Flows"
  );

  const overview = el(
    "div",
    { style: "display:grid; grid-template-columns: 1fr 1fr; gap:6px 10px; font-size: 12px; line-height:1.2;" },
    ""
  );

  function statRow(label, id, colour) {
    const a = el("div", { style: `opacity:0.85; color:${colour || "#BFD3FF"};` }, label);
    const b = el("div", { style: "text-align:right; font-variant-numeric: tabular-nums; color:#EAF2FF;" }, `<span id="${id}">0</span>`);
    overview.appendChild(a);
    overview.appendChild(b);
  }

  statRow("Liquid Capital", "s_liquid", "#7FE7FF");
  statRow("Total Capital", "s_total", "#FFD1FF");
  statRow("Throughput /s", "s_thru", "#C9A7FF");
  statRow("Active Packets", "s_packets", "#A7C0FF");
  statRow("Tier", "s_tier", "#CFFFFF");
  statRow("Nodes", "s_nodes", "#A7C0FF");

  const actions = el("div", { style: "margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;" }, "");

  function makeBtn(text, accent) {
    const b = el(
      "button",
      {
        style:
          "cursor:pointer; border-radius:10px; border:1px solid rgba(140,180,255,0.25); background: rgba(0,0,0,0.35); color:#EAF2FF; padding:7px 9px; font-size:12px; line-height:1; " +
          (accent ? `box-shadow: 0 0 14px rgba(120,180,255,0.12); border-color: rgba(140,220,255,0.35);` : ""),
      },
      text
    );
    return b;
  }

  const btnExpand = makeBtn("Expand Network", true);
  const btnSave = makeBtn("Save");
  const btnPause = makeBtn("Pause");
  actions.appendChild(btnExpand);
  actions.appendChild(btnSave);
  actions.appendChild(btnPause);

  const upgradesWrap = el("div", { style: "margin-top:10px;" }, "");
  const upgradesTitle = el("div", { style: "margin: 6px 0 6px 0; font-size:12px; opacity:0.9; color:#BFD3FF;" }, "Node Upgrades");
  upgradesWrap.appendChild(upgradesTitle);

  const upGrid = el("div", { style: "display:grid; grid-template-columns: 1fr; gap:6px;" }, "");
  upgradesWrap.appendChild(upGrid);

  const upgradeButtons = {
    bank: makeBtn("Upgrade Banks", false),
    fund: makeBtn("Upgrade Funds", false),
    exchange: makeBtn("Upgrade Exchanges", false),
    startup: makeBtn("Upgrade Startups", false),
  };

  for (const k of ["bank", "fund", "exchange", "startup"]) upGrid.appendChild(upgradeButtons[k]);

  const policyWrap = el("div", { style: "margin-top:10px;" }, "");
  const policyTitle = el("div", { style: "margin: 6px 0 6px 0; font-size:12px; opacity:0.9; color:#BFD3FF;" }, "Policy Levers");
  policyWrap.appendChild(policyTitle);

  function sliderRow(label, id, min, max, step, value, hint) {
    const row = el(
      "div",
      { style: "display:grid; grid-template-columns: 1fr 110px; gap:8px; align-items:center; margin:6px 0;" },
      ""
    );
    const left = el("div", { style: "font-size:12px; color:#EAF2FF;" }, `<div style="opacity:0.9">${label}</div><div style="opacity:0.55; font-size:11px">${hint}</div>`);
    const right = el("div", { style: "display:flex; flex-direction:column; gap:4px; align-items:flex-end;" }, "");
    const input = el("input", { id, type: "range", min: String(min), max: String(max), step: String(step), value: String(value) }, "");
    input.style.width = "110px";
    const val = el("div", { id: id + "_v", style: "font-size:11px; opacity:0.75; font-variant-numeric: tabular-nums;" }, "");
    right.appendChild(input);
    right.appendChild(val);
    row.appendChild(left);
    row.appendChild(right);
    return { row, input, val };
  }

  const sTax = sliderRow("Transaction Tax", "p_tax", 0, 0.2, 0.01, policy.taxRate, "Cuts delivery; yields passive income.");
  const sSpread = sliderRow("Spread Floor", "p_spread", 0, 1, 0.02, policy.spreadFloor, "Forces baseline liquidity depth.");
  const sRebate = sliderRow("Liquidity Rebate", "p_rebate", 0, 1, 0.02, policy.liquidityRebate, "Speeds packets up (rebate effect).");

  policyWrap.appendChild(sTax.row);
  policyWrap.appendChild(sSpread.row);
  policyWrap.appendChild(sRebate.row);

  const foot = el(
    "div",
    { style: "margin-top:10px; opacity:0.55; font-size:11px; line-height:1.25; color:#BFD3FF;" },
    "Wealth is visible. Throughput is power. Build liquidity; watch it breathe."
  );

  panel.appendChild(title);
  panel.appendChild(overview);
  panel.appendChild(actions);
  panel.appendChild(upgradesWrap);
  panel.appendChild(policyWrap);
  panel.appendChild(foot);
  root.appendChild(panel);

  const rightHint = el(
    "div",
    {
      style:
        "flex:1; min-width: 200px; align-self:stretch; pointer-events:none; display:flex; justify-content:flex-end; padding-right:6px;",
    },
    `<div style="pointer-events:none; opacity:0.35; font-size:11px; color:#BFD3FF; padding-top:4px; text-align:right;">Liquidity breathing in neon.</div>`
  );
  root.appendChild(rightHint);

  ctx.uiRoot.appendChild(root);

  const $liquid = Engine.$("#s_liquid");
  const $total = Engine.$("#s_total");
  const $thru = Engine.$("#s_thru");
  const $packets = Engine.$("#s_packets");
  const $tier = Engine.$("#s_tier");
  const $nodes = Engine.$("#s_nodes");

  function fmt(n) {
    if (n < 1000) return n.toFixed(0);
    if (n < 1000000) return (n / 1000).toFixed(1) + "k";
    if (n < 1000000000) return (n / 1000000).toFixed(2) + "m";
    return (n / 1000000000).toFixed(2) + "b";
  }

  function updatePolicyUI() {
    sTax.val.textContent = Math.round(policy.taxRate * 100) + "%";
    sSpread.val.textContent = policy.spreadFloor.toFixed(2);
    sRebate.val.textContent = policy.liquidityRebate.toFixed(2);
  }
  updatePolicyUI();

  sTax.input.oninput = () => {
    policy.taxRate = clamp(parseFloat(sTax.input.value), 0, 0.2);
    updatePolicyUI();
  };
  sSpread.input.oninput = () => {
    policy.spreadFloor = clamp(parseFloat(sSpread.input.value), 0, 1);
    updatePolicyUI();
  };
  sRebate.input.oninput = () => {
    policy.liquidityRebate = clamp(parseFloat(sRebate.input.value), 0, 1);
    updatePolicyUI();
  };

  btnPause.onclick = () => {
    Engine.togglePause();
    btnPause.textContent = Engine.isPaused() ? "Play" : "Pause";
    if (audioEnabled) Engine.audio.click(Engine.isPaused() ? 180 : 240);
  };

  btnSave.onclick = () => {
    saveGame(true);
    if (audioEnabled) Engine.audio.click(280);
  };

  // ---- network construction ----
  function baseParamsForType(type) {
    switch (type) {
      case "bank":
        return { baseGeneration: 0.9, demandBias: 0.9, efficiency: 1.02, capacity: 14 };
      case "fund":
        return { baseGeneration: 0.55, demandBias: 1.2, efficiency: 1.08, capacity: 10 };
      case "exchange":
        return { baseGeneration: 0.35, demandBias: 1.35, efficiency: 1.12, capacity: 8.5 };
      case "startup":
        return { baseGeneration: 0.25, demandBias: 1.55, efficiency: 1.18, capacity: 7.0 };
      case "central":
        return { baseGeneration: 2.25, demandBias: 1.0, efficiency: 1.10, capacity: 22 };
      default:
        return { baseGeneration: 0.4, demandBias: 1.0, efficiency: 1.0, capacity: 9 };
    }
  }

  function addNode(type, ring, slot, presetLevel) {
    const id = nodes.length;
    const p = baseParamsForType(type);
    nodes.push({
      id,
      type,
      x: 0,
      y: 0,
      level: presetLevel || 1,
      capacity: p.capacity,
      liquidity: 0,
      connections: [],
      baseGeneration: p.baseGeneration,
      demandBias: p.demandBias,
      efficiency: p.efficiency,
      ring,
      slot,
    });
    return id;
  }

  function ensureEdgeActiveSize() {
    if (edgeActive.length >= edges.length + 32) return;
    const next = new Int32Array((edges.length + 128) * 2);
    next.set(edgeActive, 0);
    edgeActive = next;
  }

  function addEdge(from, to, cap, spread) {
    if (from === to) return -1;
    // prevent duplicates
    const a = nodes[from];
    const b = nodes[to];
    for (let i = 0; i < a.connections.length; i++) {
      const ei = a.connections[i];
      const e = edges[ei];
      if (e.from === from && e.to === to) return ei;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.max(1e-3, Math.hypot(dx, dy));
    const ei = edges.length;
    edges.push({
      from,
      to,
      throughputCapacity: cap,
      spread: spread,
      length: len,
      ux: dx / len,
      uy: dy / len,
    });
    a.connections.push(ei);

    ensureEdgeActiveSize();
    edgeActive[ei] = 0;
    return ei;
  }

  function layoutNetwork() {
    const { w, h } = Engine.getSize();
    const cx = w * 0.5;
    const cy = h * 0.5;
    const baseR = Math.min(w, h) * 0.15;

    // Place central if present at centre
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].type === "central") {
        nodes[i].x = cx;
        nodes[i].y = cy;
      }
    }

    // Rings: ring 0 is inner circle around centre (excluding central)
    // slot gives angle ordering per ring; deterministic based on insert
    const ringCounts = new Int32Array(16);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === "central") continue;
      ringCounts[n.ring] += 1;
    }

    const ringSeen = new Int32Array(16);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === "central") continue;

      const count = Math.max(1, ringCounts[n.ring]);
      const idx = ringSeen[n.ring]++;
      const angle = ((idx + n.slot * 0.17) / count) * Math.PI * 2;

      const r = baseR + n.ring * BASE_RING_SPACING;
      const wob = 1 + 0.06 * Math.sin(angle * 3.0 + n.ring * 0.7);
      const rr = r * wob;

      n.x = cx + Math.cos(angle) * rr;
      n.y = cy + Math.sin(angle) * rr;
    }

    // Recompute edge vectors/lengths
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const a = nodes[e.from];
      const b = nodes[e.to];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.max(1e-3, Math.hypot(dx, dy));
      e.length = len;
      e.ux = dx / len;
      e.uy = dy / len;
    }
  }

  function weightedTypePick() {
    const choices = [];
    const weights = [];
    let sum = 0;

    function add(type, w) {
      if (!unlocked[type]) return;
      choices.push(type);
      weights.push(w);
      sum += w;
    }

    add("bank", 1.9);
    add("fund", 1.35);
    add("exchange", 1.0);
    add("startup", 0.9);

    const r = rng.next() * sum;
    let acc = 0;
    for (let i = 0; i < choices.length; i++) {
      acc += weights[i];
      if (r <= acc) return choices[i];
    }
    return choices[choices.length - 1] || "bank";
  }

  function connectNewNode(nodeId) {
    if (edges.length > 950) return;

    const n = nodes[nodeId];
    // Connect to 2-4 targets: prefer near rings and some to high-demand nodes
    const linkCount = 2 + (rng.nextU32() % 3);
    for (let k = 0; k < linkCount; k++) {
      let best = -1;
      let bestScore = -1;

      for (let t = 0; t < 10; t++) {
        const j = (rng.nextU32() % nodes.length) | 0;
        if (j === nodeId) continue;
        const m = nodes[j];
        if (m.type === "central" && !unlocked.central) continue;

        const ringDist = Math.abs(m.ring - n.ring);
        const dx = m.x - n.x;
        const dy = m.y - n.y;
        const d = Math.hypot(dx, dy) + 1e-3;

        // Prefer modest distance (not too tiny, not too huge) + high demand
        const targetDemand = m.demandBias;
        const distScore = 1 / (0.006 * d + 0.9 + 0.25 * ringDist);
        const score = distScore * (0.65 + 0.6 * targetDemand) * (0.8 + 0.25 * rng.next());

        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }

      if (best !== -1) {
        const cap = 1.0 + 0.25 * networkTier + 0.15 * rng.next();
        const spread = 0.02 + 0.08 * rng.next();
        addEdge(nodeId, best, cap, spread);

        // Some reciprocal edges for circulation
        if (rng.next() < 0.45) {
          const cap2 = 0.9 + 0.22 * networkTier + 0.12 * rng.next();
          const spread2 = 0.02 + 0.08 * rng.next();
          addEdge(best, nodeId, cap2, spread2);
        }
      }
    }

    // If central exists, occasionally connect to it for systemic feel
    if (unlocked.central) {
      const cId = nodes.findIndex((x) => x.type === "central");
      if (cId !== -1 && nodeId !== cId) {
        if (rng.next() < 0.75) addEdge(nodeId, cId, 1.35 + 0.35 * networkTier, 0.015 + 0.04 * rng.next());
        if (rng.next() < 0.75) addEdge(cId, nodeId, 1.55 + 0.45 * networkTier, 0.01 + 0.04 * rng.next());
      }
    }
  }

  function rebuildBaseNetwork(seedStyle) {
    nodes.length = 0;
    edges.length = 0;

    // inner core: banks + funds
    const startNodes = seedStyle ? 10 : 12;
    let ring = 0;
    let slot = 0;

    for (let i = 0; i < startNodes; i++) {
      const t = i % 3 === 0 ? "fund" : "bank";
      addNode(t, ring, slot++, 1);
      if (slot >= 14) {
        ring++;
        slot = 0;
      }
    }

    // a few extra for early patterning
    for (let i = 0; i < 6; i++) addNode(weightedTypePick(), 1 + ((i / 4) | 0), slot++ * 0.9, 1);

    layoutNetwork();

    // connect with moderate density
    for (let i = 0; i < nodes.length; i++) {
      connectNewNode(i);
    }

    // A small hub-to-hub backbone around the inner ring
    const inner = nodes.filter((n) => n.type !== "central" && n.ring === 0).map((n) => n.id);
    for (let i = 0; i < inner.length; i++) {
      const a = inner[i];
      const b = inner[(i + 1) % inner.length];
      addEdge(a, b, 1.2, 0.04);
      if (rng.next() < 0.55) addEdge(b, a, 1.05, 0.05);
    }

    // Reset packet system
    packetInitFreeList();
    if (edgeActive.length < edges.length + 32) edgeActive = new Int32Array(edges.length + 256);
    for (let i = 0; i < edges.length; i++) edgeActive[i] = 0;
  }

  function tierFromTotal(total) {
    let t = 0;
    for (let i = 0; i < TIER_THRESHOLDS.length; i++) {
      if (total >= TIER_THRESHOLDS[i]) t = i;
    }
    return t;
  }

  function applyTierUnlocks(newTier) {
    networkTier = newTier;

    unlocked.exchange = networkTier >= 2;
    unlocked.startup = networkTier >= 2;
    if (networkTier >= 3) unlocked.central = true;

    const targetMax = clamp(BASE_MAX_PACKETS + networkTier * 220, BASE_MAX_PACKETS, MAX_MAX_PACKETS);
    maxPackets = clamp(targetMax, BASE_MAX_PACKETS, MAX_MAX_PACKETS);

    glowBoost = 1.0 + 0.08 * networkTier;

    // Add central bank if newly unlocked and not present
    if (unlocked.central && nodes.findIndex((n) => n.type === "central") === -1) {
      const cId = addNode("central", 0, 0, 1);
      nodes[cId].liquidity = 0;
      // central is not counted in ring layout (kept at centre)
      layoutNetwork();

      // Connect central into the network
      const sample = Math.min(10, nodes.length - 1);
      for (let i = 0; i < sample; i++) {
        const j = (rng.nextU32() % nodes.length) | 0;
        if (j === cId) continue;
        addEdge(cId, j, 1.6 + 0.55 * networkTier, 0.01 + 0.03 * rng.next());
        addEdge(j, cId, 1.3 + 0.45 * networkTier, 0.015 + 0.04 * rng.next());
      }
      if (audioEnabled) Engine.audio.click(520);
    }
  }

  // ---- upgrades ----
  function countType(type) {
    let c = 0;
    for (let i = 0; i < nodes.length; i++) if (nodes[i].type === type) c++;
    return c;
  }

  function avgLevel(type) {
    let sum = 0;
    let c = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== type) continue;
      sum += n.level;
      c++;
    }
    return c ? sum / c : 0;
  }

  function upgradeCost(type) {
    const a = avgLevel(type);
    const base = type === "bank" ? 42 : type === "fund" ? 58 : type === "exchange" ? 82 : 70;
    const mult = type === "exchange" ? 1.22 : type === "startup" ? 1.2 : 1.18;
    const cost = base * Math.pow(mult, a);
    const pop = countType(type);
    const scale = 1 + 0.045 * Math.max(0, pop - 10);
    return cost * scale;
  }

  function upgradeType(type) {
    if (!unlocked[type]) return;

    const cost = upgradeCost(type);
    if (liquidCapital < cost) return;

    liquidCapital -= cost;

    // bump levels & tweak edges out of nodes of that type
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== type) continue;
      n.level += 1;

      // capacity and efficiency improvements
      n.capacity *= 1.018;
      n.efficiency *= 1.006;

      // edges slight capacity bump
      for (let k = 0; k < n.connections.length; k++) {
        const ei = n.connections[k];
        edges[ei].throughputCapacity *= 1.012;
      }
    }

    // small boost to max packet cap as network becomes more efficient
    maxPackets = clamp(maxPackets + 6, BASE_MAX_PACKETS, MAX_MAX_PACKETS);

    if (audioEnabled) Engine.audio.click(type === "bank" ? 260 : type === "fund" ? 320 : type === "exchange" ? 390 : 350);
  }

  upgradeButtons.bank.onclick = () => upgradeType("bank");
  upgradeButtons.fund.onclick = () => upgradeType("fund");
  upgradeButtons.exchange.onclick = () => upgradeType("exchange");
  upgradeButtons.startup.onclick = () => upgradeType("startup");

  // ---- expansion ----
  function expansionCost() {
    const n = nodes.length;
    const base = 95;
    const mult = 1.15;
    return base * Math.pow(mult, Math.max(0, n - 14) / 8);
  }

  function expandNetwork() {
    if (nodes.length >= MAX_NODES) return;

    const cost = expansionCost();
    if (liquidCapital < cost) return;
    liquidCapital -= cost;

    // choose ring: add outer rings as tier grows
    const maxRing = clamp(2 + networkTier, 2, 6);
    const ring = clamp(1 + ((nodes.length / 18) | 0), 1, maxRing);
    const slot = nodes.length * 0.73 + (rng.next() * 2.0);

    const type = weightedTypePick();
    const id = addNode(type, ring, slot, 1);

    // slightly prefill liquidity for immediate visibility
    nodes[id].liquidity = 1.2 + 0.6 * rng.next();

    layoutNetwork();
    connectNewNode(id);

    // also add one extra edge between existing nodes for density
    if (edges.length < 980 && nodes.length > 8) {
      const a = (rng.nextU32() % nodes.length) | 0;
      let b = (rng.nextU32() % nodes.length) | 0;
      if (b === a) b = (b + 1) % nodes.length;
      addEdge(a, b, 1.0 + 0.3 * networkTier, 0.02 + 0.08 * rng.next());
    }

    maxPackets = clamp(maxPackets + 18, BASE_MAX_PACKETS, MAX_MAX_PACKETS);

    if (audioEnabled) Engine.audio.click(300);
  }

  btnExpand.onclick = () => expandNetwork();

  // ---- save/load & offline ----
  function serializeState() {
    const nodeLevels = new Int16Array(nodes.length);
    const nodeTypes = new Uint8Array(nodes.length);
    const nodeRing = new Uint8Array(nodes.length);
    const nodeSlot = new Float32Array(nodes.length);

    const typeToIdx = { bank: 0, fund: 1, exchange: 2, startup: 3, central: 4 };

    for (let i = 0; i < nodes.length; i++) {
      nodeLevels[i] = nodes[i].level;
      nodeTypes[i] = typeToIdx[nodes[i].type] ?? 0;
      nodeRing[i] = nodes[i].ring;
      nodeSlot[i] = nodes[i].slot;
    }

    const edgeFrom = new Int16Array(edges.length);
    const edgeTo = new Int16Array(edges.length);
    const edgeCap = new Float32Array(edges.length);
    const edgeSpr = new Float32Array(edges.length);

    for (let i = 0; i < edges.length; i++) {
      edgeFrom[i] = edges[i].from;
      edgeTo[i] = edges[i].to;
      edgeCap[i] = edges[i].throughputCapacity;
      edgeSpr[i] = edges[i].spread;
    }

    return {
      v: 1,
      totalCapital,
      liquidCapital,
      networkTier,
      maxPackets,
      unlocked,
      policy,
      rngSeed: rng.getSeed(),
      lastThroughput: globalThroughput,
      nodes: {
        levels: Array.from(nodeLevels),
        types: Array.from(nodeTypes),
        ring: Array.from(nodeRing),
        slot: Array.from(nodeSlot),
      },
      edges: {
        from: Array.from(edgeFrom),
        to: Array.from(edgeTo),
        cap: Array.from(edgeCap),
        spr: Array.from(edgeSpr),
      },
      roll: Array.from(roll),
      rollIdx,
      timestamp: Date.now(),
    };
  }

  function restoreFromState(s) {
    if (!s || typeof s !== "object") return false;

    totalCapital = typeof s.totalCapital === "number" ? s.totalCapital : 0;
    liquidCapital = typeof s.liquidCapital === "number" ? s.liquidCapital : 0;
    networkTier = typeof s.networkTier === "number" ? s.networkTier : 0;

    if (s.unlocked && typeof s.unlocked === "object") {
      unlocked = {
        bank: !!s.unlocked.bank,
        fund: !!s.unlocked.fund,
        exchange: !!s.unlocked.exchange,
        startup: !!s.unlocked.startup,
        central: !!s.unlocked.central,
      };
    }

    if (s.policy && typeof s.policy === "object") {
      policy.taxRate = clamp(+s.policy.taxRate || 0, 0, 0.2);
      policy.spreadFloor = clamp(+s.policy.spreadFloor || 0, 0, 1);
      policy.liquidityRebate = clamp(+s.policy.liquidityRebate || 0, 0, 1);
      updatePolicyUI();
      sTax.input.value = String(policy.taxRate);
      sSpread.input.value = String(policy.spreadFloor);
      sRebate.input.value = String(policy.liquidityRebate);
    }

    if (typeof s.maxPackets === "number") maxPackets = clamp(s.maxPackets, BASE_MAX_PACKETS, MAX_MAX_PACKETS);
    if (typeof s.rngSeed === "number") rng.setSeed(s.rngSeed >>> 0);

    // rebuild nodes/edges
    nodes.length = 0;
    edges.length = 0;

    const N = s.nodes?.levels?.length || 0;
    const E = s.edges?.from?.length || 0;

    if (N <= 0 || E < 0 || N > MAX_NODES) return false;

    const idxToType = ["bank", "fund", "exchange", "startup", "central"];
    for (let i = 0; i < N; i++) {
      const tIdx = (s.nodes.types?.[i] ?? 0) | 0;
      const t = idxToType[clamp(tIdx, 0, 4)] || "bank";
      const ring = (s.nodes.ring?.[i] ?? 0) | 0;
      const slot = +s.nodes.slot?.[i] || 0;
      const lvl = clamp((s.nodes.levels?.[i] ?? 1) | 0, 1, 999);
      addNode(t, ring, slot, lvl);
    }

    layoutNetwork();

    for (let i = 0; i < E; i++) {
      const from = (s.edges.from?.[i] ?? 0) | 0;
      const to = (s.edges.to?.[i] ?? 0) | 0;
      if (from < 0 || from >= nodes.length || to < 0 || to >= nodes.length) continue;
      const cap = +s.edges.cap?.[i] || 1;
      const spr = clamp(+s.edges.spr?.[i] || 0.04, 0, 0.5);
      addEdge(from, to, cap, spr);
    }

    // reset packet system
    packetInitFreeList();
    if (edgeActive.length < edges.length + 32) edgeActive = new Int32Array(edges.length + 256);
    for (let i = 0; i < edges.length; i++) edgeActive[i] = 0;

    // rolling buffer
    if (Array.isArray(s.roll) && s.roll.length === ROLL_SECONDS) {
      for (let i = 0; i < ROLL_SECONDS; i++) roll[i] = +s.roll[i] || 0;
      rollIdx = clamp((s.rollIdx ?? 0) | 0, 0, ROLL_SECONDS - 1);
      // derive globalThroughput
      let sum = 0;
      for (let i = 0; i < ROLL_SECONDS; i++) sum += roll[i];
      globalThroughput = sum / ROLL_SECONDS;
    } else {
      for (let i = 0; i < ROLL_SECONDS; i++) roll[i] = 0;
      rollIdx = 0;
      globalThroughput = 0;
    }

    applyTierUnlocks(tierFromTotal(totalCapital));
    return true;
  }

  function saveGame(forceTs) {
    const obj = serializeState();
    if (!forceTs) obj.timestamp = Date.now();
    Engine.save(saveKey, obj);
  }

  function loadGame() {
    const fallback = null;
    const loaded = Engine.load(saveKey, fallback);
    const ts = Engine.loadTimestamp(saveKey);

    if (loaded && restoreFromState(loaded)) {
      // offline progress
      const now = Date.now();
      const then = loaded.timestamp || ts || now;
      const elapsed = clamp((now - then) / 1000, 0, 60 * 60 * 24 * 7); // cap 7 days

      // use last known throughput if available, otherwise current roll average
      const lastThru = typeof loaded.lastThroughput === "number" ? loaded.lastThroughput : globalThroughput;
      const offlineCapitalGross = lastThru * elapsed * 0.6;

      if (offlineCapitalGross > 0) {
        const tax = clamp(policy.taxRate, 0, 0.2);
        const net = offlineCapitalGross * (1 - tax);
        liquidCapital += net + offlineCapitalGross * tax * 0.25; // small "tax recycling" trickle
        totalCapital += offlineCapitalGross;
        // also inject a bit of liquidity into nodes to wake the network up
        const inject = offlineCapitalGross * 0.002;
        if (inject > 0) {
          for (let i = 0; i < nodes.length; i++) nodes[i].liquidity += inject / nodes.length;
        }
      }
      applyTierUnlocks(tierFromTotal(totalCapital));
      return true;
    }

    // fresh start
    totalCapital = 0;
    liquidCapital = 70;
    globalThroughput = 0;
    networkTier = 0;
    unlocked = { bank: true, fund: true, exchange: false, startup: false, central: false };
    policy = { taxRate: 0.04, spreadFloor: 0.0, liquidityRebate: 0.0 };
    updatePolicyUI();
    sTax.input.value = String(policy.taxRate);
    sSpread.input.value = String(policy.spreadFloor);
    sRebate.input.value = String(policy.liquidityRebate);

    for (let i = 0; i < ROLL_SECONDS; i++) roll[i] = 0;
    rollIdx = 0;
    deliveredThisSecond = 0;
    secAcc = 0;

    rebuildBaseNetwork(true);
    applyTierUnlocks(0);
    saveGame(false);
    return false;
  }

  // ---- boot ----
  loadGame();
  layoutNetwork();

  // ---- simulation core ----
  function effectiveEdgeCap(e) {
    const floor = 0.6 + 2.4 * policy.spreadFloor; // 0.6..3.0
    return Math.max(e.throughputCapacity, floor);
  }

  function nodeGenPerSec(n) {
    // Throughput-driven growth: base generation rises gently with tier and local liquidity
    const tierBoost = 1 + 0.12 * networkTier;
    const levelBoost = 1 + 0.22 * Math.log2(1 + n.level);
    const liquidityBoost = 1 + 0.03 * Math.sqrt(Math.max(0, n.liquidity));
    let g = n.baseGeneration * tierBoost * levelBoost * liquidityBoost;

    // Subtle type shaping
    if (n.type === "startup") g *= 0.85 + 0.05 * n.level;
    if (n.type === "exchange") g *= 0.92 + 0.03 * n.level;
    if (n.type === "central") g *= 1.35;

    // News pulses can temporarily shift behaviour
    if (newsT > 0) {
      const shock = 1 + newsMag * 0.28;
      if (n.type === "startup") g *= 0.85 + 0.35 * shock;
      else if (n.type === "fund") g *= 0.9 + 0.22 * shock;
      else if (n.type === "bank") g *= 0.98 + 0.12 * shock;
      else if (n.type === "central") g *= 1.05 + 0.18 * shock;
    }

    return g;
  }

  function edgeSaturationLimit(e) {
    // Packet count saturation: scaled by capacity and edge length (longer edges hold a few more in flight)
    const cap = effectiveEdgeCap(e);
    const lenScale = clamp(e.length / 240, 0.7, 1.6);
    return Math.max(1, (cap * 2.25 * lenScale) | 0);
  }

  function spawnPacket(fromNodeId, edgeIndex, amountBase) {
    if (aliveCount >= maxPackets) return false;

    const e = edges[edgeIndex];
    const satLim = edgeSaturationLimit(e);
    if (edgeActive[edgeIndex] >= satLim) return false;

    const i = packetAlloc();
    if (i === -1) return false;

    const from = nodes[fromNodeId];
    const amt = amountBase;

    pEdge[i] = edgeIndex;
    pProg[i] = 0;

    // spread slightly reduces delivery
    const spreadPenalty = 1 - clamp(e.spread, 0, 0.35) * 0.55;
    pAmt[i] = amt * spreadPenalty;

    // speed scales: rebate + tier + from.level + inversely with edge length for consistent feel
    const rebateBoost = 1 + 0.85 * policy.liquidityRebate;
    const tierBoost = 1 + 0.05 * networkTier;
    const lvlBoost = 1 + 0.015 * from.level;

    const lenNorm = clamp(e.length / 260, 0.75, 1.75);
    pSpeed[i] = (BASE_PACKET_SPEED * rebateBoost * tierBoost * lvlBoost) / lenNorm;

    // origin type colour
    pOriginType[i] = from.type === "bank" ? 0 : from.type === "fund" ? 1 : from.type === "exchange" ? 2 : from.type === "startup" ? 3 : 4;

    edgeActive[edgeIndex] += 1;
    return true;
  }

  function chooseOutgoingEdge(n) {
    const conns = n.connections;
    const cLen = conns.length;
    if (cLen === 0) return -1;

    // Weighted pick by destination demand + capacity
    let sum = 0;
    for (let i = 0; i < cLen; i++) {
      const ei = conns[i];
      const e = edges[ei];
      const dest = nodes[e.to];
      sum += dest.demandBias * effectiveEdgeCap(e);
    }
    if (sum <= 0) return conns[(rng.nextU32() % cLen) | 0];

    let r = rng.next() * sum;
    for (let i = 0; i < cLen; i++) {
      const ei = conns[i];
      const e = edges[ei];
      const dest = nodes[e.to];
      r -= dest.demandBias * effectiveEdgeCap(e);
      if (r <= 0) return ei;
    }
    return conns[cLen - 1];
  }

  function maybeTriggerNews(dt) {
    // Very sparse: 0.8% chance per ~10 seconds baseline, scaled slightly with tier
    const rate = 0.00075 + 0.00022 * networkTier;
    if (newsT <= 0 && rng.next() < rate * dt * 60) {
      newsT = 3.2 + 1.4 * rng.next();
      newsMag = 0.7 + 0.6 * rng.next();
    }
    if (newsT > 0) {
      newsT -= dt;
      if (newsT <= 0) {
        newsT = 0;
        newsMag = 0;
      }
    }
  }

  // ---- autosave cadence ----
  let saveAcc = 0;

  // ---- UI refresh cadence ----
  let uiAcc = 0;

  // ---- update loop ----
  Engine.on("update", (dt) => {
    if (Engine.isPaused()) return;

    // Resize-safe layout (rare, but keeps stable if canvas size changes)
    // We do it cheaply: only on tick if sizes changed notably
    // (Engine already handles DPR scaling, so this is fine)
    if (dt > 0.25) dt = 0.25;

    maybeTriggerNews(dt);

    // Passive income from tax: a small fraction of throughput becomes spendable slowly
    const taxPassive = clamp(policy.taxRate, 0, 0.2) * (0.08 + 0.02 * networkTier);
    if (globalThroughput > 0) {
      liquidCapital += globalThroughput * taxPassive * dt * 0.15;
    }

    // Node generation + gentle decay to prevent hoarding
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];

      // Central bank becomes a stabiliser: gently nudges liquidity around
      let gen = nodeGenPerSec(n) * dt;
      n.liquidity += gen;

      // Soft cap: liquidity beyond capacity bleeds into spendable capital (wealth becomes available)
      const cap = n.capacity * (1 + 0.08 * n.level);
      if (n.liquidity > cap * 1.35) {
        const overflow = (n.liquidity - cap * 1.35) * 0.25;
        n.liquidity -= overflow;
        liquidCapital += overflow * 0.25;
        totalCapital += overflow * 0.25;
        deliveredThisSecond += overflow * 0.25;
      }

      // Decay (small)
      n.liquidity *= 1 - LIQUIDITY_DECAY * dt;
      if (n.liquidity < 0) n.liquidity = 0;
    }

    // Spawn packets from nodes with liquidity
    // Limit per tick to keep stable even when maxPackets is high
    const spawnBudget = Math.min(140, 20 + (aliveCount / 8) | 0);
    let spawned = 0;

    for (let i = 0; i < nodes.length && spawned < spawnBudget; i++) {
      const n = nodes[i];
      if (n.connections.length === 0) continue;
      if (n.liquidity < LIQUIDITY_SPAWN_THRESHOLD) continue;

      // Spawn probability rises with liquidity, but stays bounded
      const intensity = clamp(n.liquidity / (n.capacity * 0.75 + 2), 0, 2.0);
      const tries = intensity < 0.55 ? 1 : intensity < 1.15 ? 2 : 3;

      for (let t = 0; t < tries && spawned < spawnBudget; t++) {
        if (aliveCount >= maxPackets) break;

        // don't drain node too aggressively
        const frac = 0.08 + 0.03 * rng.next();
        const raw = Math.min(n.liquidity, (n.capacity * frac + 0.6) * (0.8 + 0.2 * intensity));

        if (raw < 0.08) continue;

        const ei = chooseOutgoingEdge(n);
        if (ei === -1) break;

        // Amount uses node efficiency; central bank tends to issue slightly larger packets
        const eff = n.efficiency * (n.type === "central" ? 1.15 : 1.0);
        const amt = raw * eff;

        if (spawnPacket(n.id, ei, amt)) {
          n.liquidity -= raw;
          if (n.liquidity < 0) n.liquidity = 0;
          spawned++;
        } else {
          break;
        }
      }
    }

    // Update packets (O(P))
    const tax = clamp(policy.taxRate, 0, 0.2);

    let i = aliveHead;
    while (i !== -1) {
      const nextI = pNext[i];

      const ei = pEdge[i];
      const e = edges[ei];
      pProg[i] += pSpeed[i] * dt;

      if (pProg[i] >= 1) {
        // deliver
        const gross = pAmt[i];
        const net = gross * (1 - tax);

        const dest = nodes[e.to];
        dest.liquidity += net * 0.7; // reinvest into destination's local buffer
        liquidCapital += net * 0.55; // make some spendable immediately
        totalCapital += gross;

        // throughput accounting uses gross (the system's raw flow)
        deliveredThisSecond += gross;

        edgeActive[ei] = Math.max(0, edgeActive[ei] - 1);
        packetFree(i);
      }

      i = nextI;
    }

    // Rolling throughput: update once per second
    secAcc += dt;
    if (secAcc >= 1) {
      // handle potential drift: accumulate multiple seconds but keep it tight
      const steps = Math.min(3, (secAcc | 0));
      for (let s = 0; s < steps; s++) {
        roll[rollIdx] = deliveredThisSecond;
        rollIdx = (rollIdx + 1) % ROLL_SECONDS;

        let sum = 0;
        for (let k = 0; k < ROLL_SECONDS; k++) sum += roll[k];
        globalThroughput = sum / ROLL_SECONDS;

        deliveredThisSecond = 0;
      }
      secAcc -= steps;
    }

    // Tier checks
    const newTier = tierFromTotal(totalCapital);
    if (newTier !== networkTier) {
      applyTierUnlocks(newTier);
      // visual + slight liquidity bloom
      for (let k = 0; k < nodes.length; k++) nodes[k].liquidity += 0.35 + 0.2 * rng.next();
      if (audioEnabled) Engine.audio.click(440 + 60 * newTier);
    }

    // Soft auto-expand as the network becomes powerful (throughput-driven growth)
    // Uses spendable capital threshold; doesn't spend, just "pressure" by increasing packet cap a touch.
    if (globalThroughput > 0) {
      const pressure = clamp(globalThroughput / (50 + 120 * networkTier), 0, 1.25);
      maxPackets = clamp(maxPackets + pressure * dt * 2.0, BASE_MAX_PACKETS, MAX_MAX_PACKETS);
    }

    // UI updates
    uiAcc += dt;
    if (uiAcc >= 0.2) {
      uiAcc = 0;

      $liquid.textContent = fmt(liquidCapital);
      $total.textContent = fmt(totalCapital);
      $thru.textContent = fmt(globalThroughput);
      $packets.textContent = String(aliveCount) + " / " + String(maxPackets | 0);
      $tier.textContent = String(networkTier);
      $nodes.textContent = String(nodes.length);

      // Button labels and availability
      const cExp = expansionCost();
      btnExpand.textContent = `Expand Network (£${fmt(cExp)})`;
      btnExpand.disabled = liquidCapital < cExp || nodes.length >= MAX_NODES;

      for (const t of ["bank", "fund", "exchange", "startup"]) {
        const b = upgradeButtons[t];
        const cost = upgradeCost(t);
        const enabled = unlocked[t] && liquidCapital >= cost;
        b.disabled = !enabled;
        b.textContent = `${TYPE_LABEL[t]}s: Upgrade (£${fmt(cost)})`;
        b.style.opacity = unlocked[t] ? "1" : "0.45";
      }
      upgradeButtons.exchange.style.display = unlocked.exchange ? "" : "none";
      upgradeButtons.startup.style.display = unlocked.startup ? "" : "none";
    }

    // Autosave
    saveAcc += dt;
    if (saveAcc >= 6) {
      saveAcc = 0;
      saveGame(false);
    }
  });

  // ---- render loop ----
  Engine.on("render", () => {
    Engine.gfx.clearBlack();

    const { w, h } = Engine.getSize();
    const cx = w * 0.5;
    const cy = h * 0.5;

    // background aura (throughput breathing)
    const aura = clamp(globalThroughput / (120 + 220 * networkTier), 0, 1);
    const auraR = Math.min(w, h) * (0.22 + 0.06 * aura);
    const auraA = 0.08 + 0.18 * aura;

    if (auraA > 0.01) {
      Engine.gfx.glowCircle(cx, cy, auraR, "#3B7CFF", 36 * glowBoost, auraA * 0.35);
      Engine.gfx.glowCircle(cx, cy, auraR * 0.72, "#9B35FF", 30 * glowBoost, auraA * 0.25);
    }

    // news flash overlay (soft purple)
    if (newsT > 0) {
      const pulse = 0.35 + 0.65 * Math.sin((newsT * 2.4 + 0.6) * Math.PI);
      const a = clamp(0.05 + 0.1 * newsMag * pulse, 0, 0.16);
      Engine.gfx.glowCircle(cx, cy, Math.min(w, h) * (0.44 + 0.08 * pulse), "#8A4BFF", 42, a);
    }

    // edges
    const edgeAlphaBase = 0.08 + 0.06 * aura;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const a = nodes[e.from];
      const b = nodes[e.to];

      const cap = effectiveEdgeCap(e);
      const sat = edgeActive[i] / Math.max(1, edgeSaturationLimit(e));
      const hot = clamp(0.15 + 0.85 * sat, 0, 1);

      // Colour by blend of endpoints (cheap: pick origin type colour)
      const colour = TYPE_COLOUR[a.type] || "#7FE7FF";

      // Slight width/alpha with activity
      const width = 1 + hot * 0.65;
      const alpha = clamp(edgeAlphaBase + hot * 0.12, 0.05, 0.28);

      Engine.gfx.line(a.x, a.y, b.x, b.y, colour, width, alpha);

      // Depth heat tick near the mid for readability (subtle)
      if (cap > 1.1 && sat > 0.25) {
        const mx = (a.x + b.x) * 0.5;
        const my = (a.y + b.y) * 0.5;
        const rr = 2.2 + 2.0 * hot;
        Engine.gfx.glowCircle(mx, my, rr, "#FF2BD6", 10 * glowBoost, 0.04 + 0.06 * hot);
      }
    }

    // packets
    let i = aliveHead;
    while (i !== -1) {
      const ei = pEdge[i];
      const e = edges[ei];
      const a = nodes[e.from];

      const t = clamp(pProg[i], 0, 1);
      const x = a.x + e.ux * e.length * t;
      const y = a.y + e.uy * e.length * t;

      const amt = pAmt[i];
      const r = 1.4 + 1.8 * clamp(Math.sqrt(amt) / 6, 0, 1.2);
      const glow = (10 + 16 * clamp(amt / 10, 0, 1.6)) * glowBoost;

      const oc = pOriginType[i];
      const colour = oc === 0 ? "#00F5FF" : oc === 1 ? "#FF2BD6" : oc === 2 ? "#8A4BFF" : oc === 3 ? "#2E7BFF" : "#CFFFFF";

      Engine.gfx.glowCircle(x, y, r, colour, glow, 0.9);

      i = pNext[i];
    }

    // nodes
    for (let n = 0; n < nodes.length; n++) {
      const node = nodes[n];
      const liq = node.liquidity;
      const lvl = node.level;

      const baseR = node.type === "central" ? 13 : 7.5;
      const liqPulse = 1 + 0.08 * Math.sin((liq * 0.18 + n * 0.7) * 0.9);
      const r = baseR * (1 + 0.04 * Math.log2(1 + lvl)) * (1 + 0.02 * Math.sqrt(Math.max(0, liq))) * liqPulse;

      const colour = TYPE_COLOUR[node.type] || "#7FE7FF";
      const g = (18 + 14 * clamp(liq / (node.capacity * 1.1 + 4), 0, 1.2)) * glowBoost;

      // outer halo for high-liquidity nodes
      const haloA = clamp(0.08 + 0.18 * (liq / (node.capacity * 1.25 + 6)), 0.06, 0.3);
      Engine.gfx.glowCircle(node.x, node.y, r + 2.4, colour, g * 1.05, haloA * 0.32);

      // core
      const coreA = node.type === "central" ? 0.95 : 0.9;
      Engine.gfx.glowCircle(node.x, node.y, r, colour, g, coreA);

      // central bank bright core
      if (node.type === "central") {
        Engine.gfx.glowCircle(node.x, node.y, r * 0.45, "#FFFFFF", 14 * glowBoost, 0.7);
      }
    }
  });

  // ---- resize hook ----
  Engine.on("onResize", () => {
    layoutNetwork();
  });

  // Save on tab close best-effort
  window.addEventListener("beforeunload", () => {
    saveGame(true);
  });
}
