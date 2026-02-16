import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });
  // Only get canvas/context when needed, not at top-level

  // ---------- State ----------
  const SAVE_KEY = `mmswarm.${ctx.gameId || "market-microstructure-swarm"}`;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand01 = () => Math.random();
  const randN = () => {
    // cheap-ish approx normal via Box-Muller (one call)
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const defaults = {
    agents: 1200,
    bins: 241, // odd so mid bin is centre
    tick: 1.0,
    // levers
    tax: 0.002, // transaction tax (reduces aggressive size)
    spreadFloor: 2, // minimum ticks between bid and ask for makers
    breakerPct: 0.035, // circuit breaker triggers if price moves this fraction over window
    breakerWindowSec: 2.5,
    breakerCooldownSec: 2.0,
    rebate: 0.0008, // liquidity rebate (boosts maker size / stickiness)
    // sim
    speed: 1.0,
    newsRate: 0.012, // probability per tick of pulse (scaled by dt)
    newsStrength: 10.0, // in ticks
    seedVol: 1.0,
    perfMode: false,
    audio: false,
    audioMuted: true
  };

  const saved = Engine.load(SAVE_KEY, null);
  const S = Object.assign({}, defaults, saved || {});
  S.bins = (S.bins | 0);
  if (S.bins < 121) S.bins = 121;
  if ((S.bins & 1) === 0) S.bins += 1;

  // Order book buckets: quantities per bin (rebuilt each tick => O(N + B))
  let B = S.bins | 0;
  let bid = new Float32Array(B);
  let ask = new Float32Array(B);

  // Price is a bin index (float allowed for smoother trace); mid is integer-ish.
  let p = (B >> 1) + 0.0;
  let pVel = 0;
  let lastTradeBin = p | 0;

  // News pulse: shifts belief temporarily (soft purple flash).
  let news = {
    active: 0, // 0..1 intensity
    dir: 0, // -1/ +1
    ttl: 0,
    peak: 0.85
  };

  // Circuit breaker
  let breaker = {
    frozen: 0,
    cooldown: 0,
    refP: p,
    window: [],
    windowMax: 240 // cap
  };

  // Tape / prints
  const prints = [];
  const MAX_PRINTS = 240;

  // Explicit stored price history (no frame-fade trails)
  const priceHist = [];
  const PRICE_HIST_MAX = 900; // ~15s at 60fps

  // Agents
  const agents = [];
  const ROLE = {
    TREND: 0,
    CONTRA: 1,
    MAKER: 2,
    SEEKER: 3,
    SCARED: 4
  };

  function makeAgents(n) {
    agents.length = 0;

    // Interpretable mix:
    // - Trend-followers: chase momentum.
    // - Contrarians: fade deviations from "fair".
    // - Market-makers: post both sides, profit from spread.
    // - Liquidity seekers: sweep into depth when impatient.
    // - Scared money: runs to liquidity in shocks, amplifies cascades.
    const mix = [
      { role: ROLE.TREND, w: 0.28 },
      { role: ROLE.CONTRA, w: 0.22 },
      { role: ROLE.MAKER, w: 0.24 },
      { role: ROLE.SEEKER, w: 0.16 },
      { role: ROLE.SCARED, w: 0.10 }
    ];
    let sumW = 0;
    for (const m of mix) sumW += m.w;
    for (const m of mix) m.w /= sumW;

    const pickRole = () => {
      const r = rand01();
      let t = 0;
      for (const m of mix) {
        t += m.w;
        if (r <= t) return m.role;
      }
      return mix[mix.length - 1].role;
    };

    for (let i = 0; i < n; i++) {
      const role = pickRole();

      // Each agent has a "belief" of fair price (in bins), a risk budget, and a reaction speed.
      const a = {
        role,
        fair: p + randN() * 6.0,
        inv: randN() * 2.0, // inventory (positive = long)
        risk: clamp(0.6 + rand01() * 1.2, 0.4, 2.2),
        alpha: clamp(0.015 + rand01() * 0.04, 0.01, 0.08), // belief update speed
        impat: clamp(rand01(), 0, 1), // impatience / aggression
        size: clamp(0.6 + rand01() * 2.4, 0.4, 4.0),
        // memory for trend (cheap)
        mom: 0,
        fear: 0,
        // spoof-ish feint probability (tiny, not RNG price; just occasional deceptive quotes)
        feint: clamp(rand01() * rand01(), 0, 1) // heavy bias to low
      };
      agents.push(a);
    }
  }

  makeAgents(S.agents | 0);

  // ---------- UI ----------
  function el(tag, attrs = {}, html = "") {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "style") e.setAttribute("style", attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (html) e.innerHTML = html;
    return e;
  }

  function makeSliderRow(label, min, max, step, getVal, setVal, fmt) {
    const row = el("div", { class: "mms-row" });
    const lab = el("div", { class: "mms-lab" }, label);
    const val = el("div", { class: "mms-val" }, "");
    const inp = el("input", {
      class: "mms-slider",
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(getVal())
    });
    const refresh = () => {
      const v = getVal();
      val.textContent = fmt ? fmt(v) : String(v);
      inp.value = String(v);
    };
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      setVal(v);
      refresh();
      persistSoon();
    });
    refresh();
    row.appendChild(lab);
    row.appendChild(inp);
    row.appendChild(val);
    return { row, refresh };
  }

  function makeToggleRow(label, getVal, setVal) {
    const row = el("div", { class: "mms-row" });
    const lab = el("div", { class: "mms-lab" }, label);
    const btn = el("button", { class: "mms-btn" }, "");
    const refresh = () => {
      btn.textContent = getVal() ? "ON" : "OFF";
      btn.style.borderColor = getVal() ? "#54f" : "#333";
      btn.style.color = getVal() ? "#b7f" : "#aaa";
    };
    btn.onclick = () => {
      setVal(!getVal());
      refresh();
      persistSoon();
    };
    refresh();
    row.appendChild(lab);
    row.appendChild(btn);
    const spacer = el("div", { class: "mms-val" }, "");
    row.appendChild(spacer);
    return { row, refresh, btn };
  }

  let persistTimer = 0;
  function persistSoon() {
    persistTimer = 0.2;
  }

  function hardResetMarket() {
    bid = new Float32Array(B);
    ask = new Float32Array(B);
    p = (B >> 1) + 0.0;
    pVel = 0;
    lastTradeBin = p | 0;
    prints.length = 0;
    priceHist.length = 0;
    breaker.frozen = 0;
    breaker.cooldown = 0;
    breaker.refP = p;
    breaker.window.length = 0;
    for (const a of agents) {
      a.fair = p + randN() * 6.0;
      a.inv = randN() * 2.0;
      a.mom = 0;
      a.fear = 0;
    }
  }

  function triggerNewsPulse(dir = 0) {
    // A pulse is a brief belief shift (not a price RNG): agents reinterpret the same tape differently for a moment.
    news.dir = dir !== 0 ? dir : (rand01() < 0.5 ? -1 : 1);
    news.ttl = 0.8 + rand01() * 1.3;
    news.active = news.peak;
  }

  // Build UI inside ctx.uiRoot (no global canvas UI).
  ctx.uiRoot.innerHTML = "";
  const root = el("div", {
    class: "mms-ui",
    style:
      "font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;" +
      "color:#cfe; user-select:none; max-width:520px;" +
      "padding:10px; border:1px solid #1a1a1a; border-radius:12px;" +
      "background: rgba(0,0,0,0.65); backdrop-filter: blur(6px);"
  });

  const title = el(
    "div",
    { style: "font-weight:700; letter-spacing:0.5px; color:#dff; margin-bottom:6px;" },
    "Market Microstructure Swarm"
  );

  const expl = el(
    "div",
    { style: "font-size:12px; line-height:1.25; color:#9bd; margin-bottom:10px;" },
    [
      "<span style='color:#c7f'>Mechanics in plain terms:</span> Agents post tiny buy/sell intents into fixed price bins (bucketed book).",
      "Opposing bins match, and the price nudges toward persistent imbalance from real order flow (no RNG-driven price).",
      "Purple news pulses briefly shift beliefs; policy levers alter incentives and create herding, voids, bubbles, and crashes."
    ].join("<br>")
  );

  const styleTag = el(
    "style",
    {},
    `
    .mms-ui { pointer-events:auto; }
    .mms-row { display:grid; grid-template-columns: 160px 1fr 80px; gap:10px; align-items:center; margin:6px 0; }
    .mms-lab { font-size:12px; color:#bfe; }
    .mms-val { font-size:12px; color:#aef; text-align:right; font-variant-numeric: tabular-nums; }
    .mms-slider { width:100%; accent-color:#7af; }
    .mms-btn {
      padding:6px 10px; border-radius:10px;
      border:1px solid #333; background:#050508; color:#aaa;
      cursor:pointer;
    }
    .mms-btn:hover { border-color:#666; color:#dff; }
    .mms-mini { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
    .mms-pill {
      padding:6px 10px; border-radius:999px; border:1px solid #222;
      background:#050508; color:#aef; font-size:12px; cursor:pointer;
    }
    .mms-pill:hover { border-color:#666; color:#dff; }
    .mms-stat { margin-top:8px; font-size:12px; color:#9bd; display:flex; justify-content:space-between; gap:10px; }
    `
  );

  const statRow = el("div", { class: "mms-stat" }, "");
  const statL = el("div", {}, "");
  const statR = el("div", { style: "text-align:right; font-variant-numeric: tabular-nums;" }, "");
  statRow.appendChild(statL);
  statRow.appendChild(statR);

  const ui = {
    rows: [],
    refreshAll() {
      for (const r of ui.rows) if (r.refresh) r.refresh();
    }
  };

  ui.rows.push(
    makeSliderRow(
      "Agents",
      200,
      3000,
      50,
      () => S.agents | 0,
      (v) => {
        S.agents = v | 0;
        makeAgents(S.agents);
      },
      (v) => String(v | 0)
    )
  );

  ui.rows.push(
    makeSliderRow(
      "Transaction tax",
      0,
      0.02,
      0.0005,
      () => S.tax,
      (v) => (S.tax = v),
      (v) => `${(v * 100).toFixed(2)}%`
    )
  );

  ui.rows.push(
    makeSliderRow(
      "Spread floor (ticks)",
      0,
      12,
      1,
      () => S.spreadFloor | 0,
      (v) => (S.spreadFloor = v | 0),
      (v) => String(v | 0)
    )
  );

  ui.rows.push(
    makeSliderRow(
      "Circuit breaker",
      0.005,
      0.12,
      0.0025,
      () => S.breakerPct,
      (v) => (S.breakerPct = v),
      (v) => `${(v * 100).toFixed(1)}%`
    )
  );

  ui.rows.push(
    makeSliderRow(
      "Liquidity rebate",
      0,
      0.01,
      0.0005,
      () => S.rebate,
      (v) => (S.rebate = v),
      (v) => `${(v * 100).toFixed(2)}%`
    )
  );

  ui.rows.push(
    makeSliderRow(
      "Sim speed",
      0.25,
      4.0,
      0.25,
      () => S.speed,
      (v) => {
        S.speed = v;
        Engine.setSpeed(S.speed);
      },
      (v) => `${v.toFixed(2)}×`
    )
  );

  ui.rows.push(
    makeToggleRow("Performance mode", () => !!S.perfMode, (v) => (S.perfMode = v))
  );

  const audioToggle = makeToggleRow("Audio (subtle)", () => !!S.audio, async (v) => {
    S.audio = v;
    if (S.audio) {
      try {
        await Engine.audio.enable();
        Engine.audio.setMuted(false);
        S.audioMuted = false;
      } catch (_) {
        S.audio = false;
      }
    } else {
      Engine.audio.setMuted(true);
      S.audioMuted = true;
    }
  });
  ui.rows.push(audioToggle);

  const mini = el("div", { class: "mms-mini" });
  const btnNews = el("button", { class: "mms-pill" }, "Trigger news pulse");
  btnNews.onclick = () => {
    triggerNewsPulse(0);
    if (S.audio && !Engine.audio.muted) Engine.audio.click(520);
  };

  const btnReset = el("button", { class: "mms-pill" }, "Reset market");
  btnReset.onclick = () => {
    hardResetMarket();
    if (S.audio && !Engine.audio.muted) Engine.audio.click(260);
  };

  const btnPause = el("button", { class: "mms-pill" }, "Pause/Play");
  btnPause.onclick = () => Engine.togglePause();

  mini.appendChild(btnNews);
  mini.appendChild(btnPause);
  mini.appendChild(btnReset);

  root.appendChild(styleTag);
  root.appendChild(title);
  root.appendChild(expl);
  for (const r of ui.rows) root.appendChild(r.row);
  root.appendChild(mini);
  root.appendChild(statRow);
  ctx.uiRoot.appendChild(root);

  // Apply speed immediately
  Engine.setSpeed(S.speed);

  // ---------- Microstructure ----------
  function clearBook() {
    bid.fill(0);
    ask.fill(0);
  }

  function pushPrint(bin, qty, side) {
    prints.push({ bin, qty, side, ttl: 1.2 });
    if (prints.length > MAX_PRINTS) prints.splice(0, prints.length - MAX_PRINTS);
  }

  function updateBreaker(dt) {
    // track window of past prices to detect fast moves
    breaker.cooldown = Math.max(0, breaker.cooldown - dt);
    breaker.frozen = Math.max(0, breaker.frozen - dt);

    breaker.window.push({ t: 0, p });
    for (let i = 0; i < breaker.window.length; i++) breaker.window[i].t += dt;

    // purge old
    const win = S.breakerWindowSec;
    while (breaker.window.length && breaker.window[0].t > win) breaker.window.shift();
    if (breaker.window.length > breaker.windowMax) breaker.window.shift();

    if (breaker.frozen > 0 || breaker.cooldown > 0) return;

    // compare against oldest in window (simple, explainable)
    const old = breaker.window.length ? breaker.window[0].p : p;
    const denom = Math.max(1e-6, old);
    const frac = Math.abs(p - old) / denom;

    if (frac >= S.breakerPct) {
      breaker.frozen = S.breakerCooldownSec;
      breaker.cooldown = S.breakerCooldownSec;
      // when frozen, makers widen + seekers calm slightly after shock
      for (const a of agents) a.fear = Math.min(1, a.fear + 0.25);
      if (S.audio && !Engine.audio.muted) Engine.audio.click(140);
    }
  }

  function stepNews(dt) {
    // Random news arrival is about "belief shift", not price RNG.
    // It biases agent fair values temporarily and increases fear/greed.
    const pHit = 1 - Math.pow(1 - S.newsRate, dt * 60);
    if (rand01() < pHit && news.ttl <= 0) triggerNewsPulse(0);

    if (news.ttl > 0) {
      news.ttl -= dt;
      news.active = Math.min(news.peak, news.active + dt * 0.9);
      if (news.ttl <= 0) news.ttl = 0;
    } else {
      news.active = Math.max(0, news.active - dt * 1.6);
      if (news.active <= 0.0001) news.active = 0;
    }
  }

  function buildBook(dt) {
    clearBook();

    // Cheap "tape" momentum from pVel and recent prints
    const tapeMom = clamp(pVel * 0.75, -6, 6);

    // Compute an immediate local depth proxy around mid for fear reactions
    const midBin = clamp(Math.round(p), 0, B - 1);
    let nearBid = 0, nearAsk = 0;
    const r = 6;
    for (let i = 1; i <= r; i++) {
      const b = midBin - i;
      const a = midBin + i;
      if (b >= 0) nearBid += bid[b];
      if (a < B) nearAsk += ask[a];
    }
    const nearImb = (nearBid - nearAsk) / (1e-6 + nearBid + nearAsk);

    // Incentive modifiers (policy levers):
    const taxDrag = clamp(1.0 - S.tax * 35.0, 0.2, 1.0); // high tax discourages aggressing
    const rebateBoost = 1.0 + S.rebate * 60.0; // rebate makes makers post more
    const spreadFloor = S.spreadFloor | 0;

    // Each agent contributes intents into bins.
    // This is the whole "no sorting" trick: we accumulate per-bin qty in arrays.
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];

      // Update belief (fair) based on last price + role logic + news bias
      // (explainable: they either chase trend, fade it, quote around fair, or panic)
      const noise = randN() * (S.seedVol * 0.15); // tiny idiosyncratic judgement noise; not a price RNG
      const newsBias = news.active * news.dir * (S.newsStrength * 0.15);

      // Momentum / deviation signals
      const dev = clamp((p - a.fair), -30, 30);
      const mom = clamp(tapeMom + (p - lastTradeBin) * 0.2, -10, 10);

      // Fear rises in shocks + when tape runs against inventory
      const invPain = clamp(a.inv * mom * 0.06, -1.2, 1.2);
      const shock = clamp(Math.abs(pVel) * 0.1 + Math.abs(mom) * 0.02, 0, 0.6);
      a.fear = clamp(a.fear + dt * (shock + Math.max(0, invPain)) - dt * 0.18, 0, 1);

      // Role-specific belief update and desired tilt
      let tilt = 0; // + => wants to buy, - => wants to sell
      let quoteWidth = 2 + (a.fear * 10) + a.impat * 2; // wider in fear

      if (a.role === ROLE.TREND) {
        a.mom = clamp(lerp(a.mom, mom, a.alpha * 1.8), -12, 12);
        a.fair = a.fair + a.alpha * (0.6 * (p - a.fair) + 0.9 * a.mom + newsBias) + noise;
        tilt = clamp(a.mom * 0.12 - dev * 0.02, -1, 1);
        quoteWidth = 2 + a.impat * 2 + (a.fear * 6);
      } else if (a.role === ROLE.CONTRA) {
        a.mom = clamp(lerp(a.mom, mom, a.alpha * 0.8), -10, 10);
        a.fair = a.fair + a.alpha * (0.95 * (p - a.fair) - 0.6 * a.mom + newsBias * 0.8) + noise;
        tilt = clamp(-dev * 0.06 - mom * 0.06, -1, 1);
        quoteWidth = 2 + a.impat * 1 + (a.fear * 8);
      } else if (a.role === ROLE.MAKER) {
        a.fair = a.fair + a.alpha * (0.75 * (p - a.fair) + newsBias * 0.55) + noise * 0.6;
        // Makers mean-revert inventory: if long, bias to sell slightly; if short, bias to buy slightly
        tilt = clamp(-a.inv * 0.08 - dev * 0.01, -1, 1);
        quoteWidth = 1.5 + spreadFloor + (a.fear * 12);
      } else if (a.role === ROLE.SEEKER) {
        a.mom = clamp(lerp(a.mom, mom, a.alpha * 1.2), -12, 12);
        a.fair = a.fair + a.alpha * (0.7 * (p - a.fair) + newsBias) + noise;
        tilt = clamp((a.impat * 0.55) * (a.mom * 0.1 - dev * 0.03) - a.inv * 0.05, -1, 1);
        quoteWidth = 1 + (a.fear * 4) + a.impat * 1.5;
      } else {
        // Scared money: overreacts to shocks and tries to flatten inventory fast
        a.mom = clamp(lerp(a.mom, mom, a.alpha * 2.2), -14, 14);
        a.fair = a.fair + a.alpha * (0.6 * (p - a.fair) + newsBias * 1.4) + noise;
        const panic = clamp(a.fear * 1.2 + Math.abs(a.mom) * 0.05, 0, 1);
        tilt = clamp(-a.inv * 0.18 + (a.mom * 0.06) * (1 - panic) - dev * 0.02, -1, 1);
        quoteWidth = 3 + (a.fear * 14);
      }

      // Keep fair within bounds
      a.fair = clamp(a.fair, 4, B - 5);

      // Decide size (interpretable): base size * risk * (impatience + signal strength), reduced by tax
      const signal = clamp(Math.abs(tilt) + Math.abs(mom) * 0.03 + Math.abs(dev) * 0.01, 0, 2);
      let qty = a.size * a.risk * (0.35 + 0.75 * a.impat + 0.5 * signal);
      qty *= taxDrag;

      // Maker rebate: more size when posting liquidity
      let makerMult = 1.0;
      if (a.role === ROLE.MAKER) makerMult = rebateBoost * (1.0 + 0.35 * (1.0 - a.fear));

      // Small feint: post size on one side slightly away, then switch next ticks if momentum flips.
      // (This is not a "real spoof" model; it's just enough to create feint-like microstructure.)
      const feintOn = a.role !== ROLE.MAKER && a.feint > 0.92 && a.fear < 0.4;
      let feintDir = 0;
      if (feintOn) feintDir = mom >= 0 ? -1 : 1;

      // Determine quotes (bins).
      // Agents "place/cancel" by simply contributing fresh intents each tick.
      const fair = a.fair;
      const w = quoteWidth;

      // Convert tilt into desired side pressure.
      // We'll represent "aggressive" demand by placing closer-to-mid orders (narrower offset).
      const aggress = clamp(a.impat * 0.9 + signal * 0.25 - a.fear * 0.35, 0, 1);

      // Base offsets:
      let buyOff = Math.max(1, Math.round(w - aggress * (w - 1)));
      let sellOff = Math.max(1, Math.round(w - aggress * (w - 1)));

      // Makers enforce spread floor
      if (a.role === ROLE.MAKER) {
        buyOff = Math.max(buyOff, spreadFloor);
        sellOff = Math.max(sellOff, spreadFloor);
      }

      // Scared money pushes further when fearful, but sometimes crosses aggressively to exit
      if (a.role === ROLE.SCARED) {
        const cross = a.fear > 0.75 && a.impat > 0.65;
        if (cross) {
          buyOff = 1;
          sellOff = 1;
          qty *= 1.3;
        } else {
          buyOff = Math.max(2, buyOff + ((a.fear * 8) | 0));
          sellOff = Math.max(2, sellOff + ((a.fear * 8) | 0));
        }
      }

      // Feint shifts posted side away from mid
      if (feintDir !== 0) {
        if (feintDir > 0) sellOff += 6;
        else buyOff += 6;
        qty *= 0.8;
      }

      // Place into bins around fair (not necessarily around last price)
      let buyBin = clamp((fair - buyOff) | 0, 0, B - 1);
      let sellBin = clamp((fair + sellOff) | 0, 0, B - 1);

      // Convert tilt into weighting between bid/ask contributions.
      // Positive tilt => more bid; negative => more ask.
      const buyW = clamp(0.5 + tilt * 0.6, 0.02, 0.98);
      const sellW = 1.0 - buyW;

      let bq = qty * buyW * makerMult;
      let aq = qty * sellW * makerMult;

      // Inventory management: if too long, suppress bids; if too short, suppress asks
      const inv = a.inv;
      const invSkew = clamp(inv * 0.08, -0.6, 0.6);
      bq *= clamp(1.0 - Math.max(0, invSkew), 0.2, 1.3);
      aq *= clamp(1.0 + Math.min(0, invSkew), 0.2, 1.3);

      // Seekers occasionally "sweep": place into opposite side near mid (marketable-ish) to get filled.
      const sweep = a.role === ROLE.SEEKER && a.impat > 0.7 && a.fear < 0.7 && rand01() < 0.02;
      if (sweep) {
        if (tilt > 0) buyBin = clamp(midBin + 1, 0, B - 1);
        else sellBin = clamp(midBin - 1, 0, B - 1);
      }

      // Add to book
      bid[buyBin] += bq;
      ask[sellBin] += aq;
    }
  }

  function matchAndMove(dt) {
    if (breaker.frozen > 0) {
      // While frozen, price velocity decays (book still forms; it's just "halted").
      pVel *= Math.pow(0.1, dt);
      return;
    }

    const mid = clamp(Math.round(p), 0, B - 1);

    // Find best bid/ask around mid (no sorting; just scan outward)
    let bestBid = -1, bestAsk = B;
    for (let i = mid; i >= 0; i--) {
      if (bid[i] > 1e-6) {
        bestBid = i;
        break;
      }
    }
    for (let i = mid; i < B; i++) {
      if (ask[i] > 1e-6) {
        bestAsk = i;
        break;
      }
    }

    // If there's a crossed book, execute in overlap bins.
    let exec = 0;
    let last = lastTradeBin;

    if (bestBid >= 0 && bestAsk < B) {
      if (bestBid >= bestAsk) {
        for (let i = bestAsk; i <= bestBid; i++) {
          const t = Math.min(bid[i], ask[i]);
          if (t > 1e-6) {
            bid[i] -= t;
            ask[i] -= t;
            exec += t;
            last = i;
            pushPrint(i, t, 0);
          }
        }
      } else {
        // Not crossed: allow small "micro prints" when one side aggressively leans into the spread.
        // Represented by shifting price toward the thinner side based on near imbalance.
      }
    }

    // Imbalance around current price drives drift.
    // Explainable: if bids outweigh asks near the price, price tends to rise, and vice-versa.
    let nearBid = 0, nearAsk = 0;
    const R = S.perfMode ? 10 : 16;
    for (let k = 1; k <= R; k++) {
      const b = mid - k;
      const a = mid + k;
      if (b >= 0) nearBid += bid[b];
      if (a < B) nearAsk += ask[a];
    }
    const imb = (nearBid - nearAsk) / (1e-6 + nearBid + nearAsk);

    // Liquidity void detector: if local depth is tiny, moves become more violent.
    const depth = nearBid + nearAsk;
    const voidMult = clamp(1.0 + (2.0 / (0.4 + depth)), 1.0, 4.0);

    // Update velocity and price (continuous, but book is binned)
    const impact = 22.0; // higher => more sensitive
    const damp = 0.92;

    pVel = (pVel * Math.pow(damp, dt * 60)) + imb * impact * voidMult * dt;

    // Trade prints kick velocity too (big prints cause spikes)
    if (exec > 0) {
      const kick = clamp(Math.log(1 + exec) * 0.45, 0, 3.0);
      // direction: if last is above mid, buys dominated; below => sells
      const dir = last > mid ? 1 : last < mid ? -1 : Math.sign(imb);
      pVel += dir * kick;
      lastTradeBin = last;

      // Inventory updates (very cheap approximation): buyers increase inv, sellers decrease
      // We don't track per-order fills; instead, we nudge inventories toward the executed side.
      const invNudge = clamp(exec * 0.0006, 0, 0.08);
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        // more reactive roles adjust more
        const k = a.role === ROLE.SEEKER || a.role === ROLE.SCARED ? 1.2 : 0.8;
        a.inv += (dir * invNudge) * (0.3 + a.impat) * k * (rand01() * 0.6 + 0.7);
        a.inv *= 0.9992; // gentle mean reversion
      }

      if (S.audio && !Engine.audio.muted) {
        // Subtle click on big prints
        if (exec > 18) Engine.audio.click(220 + clamp(exec, 0, 60) * 5);
      }
    }

    // Apply and clamp
    p = clamp(p + pVel * dt, 4, B - 5);

    // Occasional mean reversion when makers dominate (rebate makes them stronger)
    // Explainable: deeper books stabilise.
    const stab = clamp((S.rebate * 90.0) + (depth > 50 ? 0.55 : 0), 0, 1.2);
    p = lerp(p, mid, dt * 0.12 * stab);

    // Tape
    priceHist.push(p);
    if (priceHist.length > PRICE_HIST_MAX) priceHist.splice(0, priceHist.length - PRICE_HIST_MAX);

    // Prints decay
    for (let i = prints.length - 1; i >= 0; i--) {
      prints[i].ttl -= dt;
      if (prints[i].ttl <= 0) prints.splice(i, 1);
    }
  }

  // ---------- Rendering ----------
  function drawBook() {
    const g = Engine.getCtx();
    const { w, h } = Engine.getSize();
    const mid = clamp(Math.round(p), 0, B - 1);

    // Layout:
    // - Book depth heat bars around current price (centre line).
    // - Price trace top half.
    // - Tape prints as tiny marks around centre.
    const cx = w * 0.5;
    const cy = h * 0.62;

    // Book window shown around price
    const span = S.perfMode ? 90 : 120; // bins on each side
    const lo = clamp(mid - span, 0, B - 1);
    const hi = clamp(mid + span, 0, B - 1);
    const count = hi - lo + 1;

    // Determine max depth for normalisation
    let maxD = 1;
    for (let i = lo; i <= hi; i++) {
      const d = bid[i] + ask[i];
      if (d > maxD) maxD = d;
    }

    // Draw a thin central axis
    g.globalAlpha = 1;
    g.lineWidth = 1;
    g.strokeStyle = "#122";
    g.beginPath();
    g.moveTo(0, cy + 0.5);
    g.lineTo(w, cy + 0.5);
    g.stroke();

    // Draw depth bars as crisp vertical heat bars.
    // Bids (cyan) extend downward; asks (magenta) extend upward.
    const x0 = cx - w * 0.46;
    const x1 = cx + w * 0.46;
    const barW = (x1 - x0) / count;

    for (let i = lo; i <= hi; i++) {
      const x = x0 + (i - lo) * barW;
      const b = bid[i];
      const a = ask[i];
      if (b > 0) {
        const t = clamp(b / maxD, 0, 1);
        const hh = Math.round((h * 0.22) * Math.sqrt(t));
        g.fillStyle = `rgba(64, 240, 255, ${0.08 + 0.75 * t})`;
        g.fillRect(x, cy + 1, barW * 0.92, hh);
      }
      if (a > 0) {
        const t = clamp(a / maxD, 0, 1);
        const hh = Math.round((h * 0.22) * Math.sqrt(t));
        g.fillStyle = `rgba(255, 72, 238, ${0.08 + 0.75 * t})`;
        g.fillRect(x, cy - hh, barW * 0.92, hh - 1);
      }
    }

    // Price line (razor sharp cyan)
    {
      const x = x0 + (p - lo) * barW + barW * 0.5;
      g.strokeStyle = "#60ffff";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x + 0.5, cy - h * 0.26);
      g.lineTo(x + 0.5, cy + h * 0.26);
      g.stroke();
    }

    // Prints (tiny ticks)
    for (let i = 0; i < prints.length; i++) {
      const pr = prints[i];
      const t = clamp(pr.ttl / 1.2, 0, 1);
      const x = x0 + (pr.bin - lo) * barW + barW * 0.5;
      const s = clamp(Math.log(1 + pr.qty) * 1.2, 2, 16);
      g.globalAlpha = 0.15 + 0.65 * t;
      g.strokeStyle = pr.side === 0 ? "#baffff" : "#ffb0ff";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, cy - s);
      g.lineTo(x, cy + s);
      g.stroke();
    }
    g.globalAlpha = 1;

    // Price trace panel
    {
      const top = h * 0.08;
      const ph = h * 0.22;
      const left = w * 0.06;
      const right = w * 0.94;

      // frame
      g.strokeStyle = "#14141a";
      g.lineWidth = 1;
      g.strokeRect(left, top, right - left, ph);

      if (priceHist.length >= 2) {
        // scale by recent min/max to keep it readable
        let mn = Infinity, mx = -Infinity;
        const N = priceHist.length;
        for (let i = 0; i < N; i++) {
          const v = priceHist[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const pad = Math.max(6, (mx - mn) * 0.15);
        mn -= pad;
        mx += pad;

        g.strokeStyle = "#52ffff";
        g.lineWidth = 2;
        g.beginPath();
        for (let i = 0; i < N; i++) {
          const t = i / (N - 1);
          const x = lerp(left, right, t);
          const y = top + ph - ((priceHist[i] - mn) / (mx - mn + 1e-6)) * ph;
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();

        // subtle glow line underlay (still crisp)
        g.globalAlpha = 0.18;
        g.strokeStyle = "#52ffff";
        g.lineWidth = 6;
        g.beginPath();
        for (let i = 0; i < N; i++) {
          const t = i / (N - 1);
          const x = lerp(left, right, t);
          const y = top + ph - ((priceHist[i] - mn) / (mx - mn + 1e-6)) * ph;
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
        g.globalAlpha = 1;
      }

      // breaker indicator
      if (breaker.frozen > 0) {
        g.fillStyle = "rgba(255, 72, 238, 0.12)";
        g.fillRect(left, top, right - left, ph);
        g.fillStyle = "#ff9bf7";
        g.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
        g.fillText("CIRCUIT BREAKER HALT", left + 10, top + 18);
      }
    }

    // News pulse flash overlay (soft purple)
    if (news.active > 0) {
      g.globalAlpha = 0.08 + 0.22 * news.active;
      g.fillStyle = news.dir > 0 ? "#7a38ff" : "#5a2cff";
      g.fillRect(0, 0, w, h);
      g.globalAlpha = 1;
    }

    // Stats HUD (text only; crisp)
    {
      g.fillStyle = "#bfe";
      g.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
      const px = 12;
      const py = h - 14;

      // Local depth around price (for "liquidity void" feel)
      let nearBid = 0, nearAsk = 0;
      const R = 14;
      for (let k = 1; k <= R; k++) {
        const b = mid - k;
        const a = mid + k;
        if (b >= 0) nearBid += bid[b];
        if (a < B) nearAsk += ask[a];
      }
      const imb = (nearBid - nearAsk) / (1e-6 + nearBid + nearAsk);

      g.fillText(
        `Price(bin): ${p.toFixed(2)}  |  v: ${pVel.toFixed(2)}  |  Imbalance: ${imb.toFixed(2)}  |  Depth: ${(nearBid + nearAsk).toFixed(1)}`,
        px,
        py
      );
    }
  }

  // ---------- Hooks ----------
  Engine.on("update", (dt) => {
    // persist
    if (persistTimer > 0) {
      persistTimer -= dt;
      if (persistTimer <= 0) {
        Engine.save(SAVE_KEY, S);
      }
    }

    // auto-cap agents in perf mode
    if (S.perfMode && agents.length > 1600) {
      S.agents = 1600;
      makeAgents(1600);
      ui.refreshAll();
    }

    // step systems
    stepNews(dt);
    updateBreaker(dt);

    // Build new bucketed book (represents cancel+replace each tick)
    buildBook(dt);

    // Match and update price from imbalance + executions
    matchAndMove(dt);

    // Update UI stats text
    const mid = clamp(Math.round(p), 0, B - 1);

    let bestBid = -1, bestAsk = B;
    for (let i = mid; i >= 0; i--) {
      if (bid[i] > 1e-6) {
        bestBid = i;
        break;
      }
    }
    for (let i = mid; i < B; i++) {
      if (ask[i] > 1e-6) {
        bestAsk = i;
        break;
      }
    }

    const spread = bestBid >= 0 && bestAsk < B ? Math.max(0, bestAsk - bestBid) : 0;

    statL.textContent =
      `BestBid: ${bestBid >= 0 ? bestBid : "—"}  BestAsk: ${bestAsk < B ? bestAsk : "—"}  Spread: ${spread}`;
    statR.textContent =
      `News: ${news.active > 0 ? (news.dir > 0 ? "UP" : "DOWN") : "—"}  ` +
      `Breaker: ${breaker.frozen > 0 ? `${breaker.frozen.toFixed(1)}s` : "OK"}`;

    // status line (if host has it)
    Engine.setStatus(`Market Microstructure Swarm • Agents ${agents.length} • Spread ${spread} • Tax ${(S.tax * 100).toFixed(2)}%`);
  });

  Engine.on("render", () => {
    Engine.gfx.clearBlack();
    drawBook();
  });

  Engine.on("onResize", () => {
    // keep book arrays tied to bins (UI could change bins later; we keep fixed for now)
  });

  // Keyboard shortcuts (minimal, optional)
  Engine.on("onKeyDown", (e) => {
    if (e.key === " " || e.key === "Spacebar") Engine.togglePause();
    if (e.key === "n" || e.key === "N") triggerNewsPulse(0);
    if (e.key === "r" || e.key === "R") hardResetMarket();
  });

  // Ensure UI reflects saved speed / audio state
  ui.refreshAll();
}
