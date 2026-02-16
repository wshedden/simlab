import "./style.css";

const GAMES = [
  { id: "example", name: "Example (Dots)", module: "./games/example-game.js", fn: "startExampleGame" },
  { id: "firefly", name: "Firefly Shepherd", module: "./games/firefly-shepherd.js", fn: "startGame" },
  { id: "orbital-trader-rings", name: "Orbital Trader Rings", module: "./games/orbital-trader-rings.js", fn: "startGame" },
  { id: "signal-amplifier-chain", name: "Signal Amplifier Chain", module: "./games/signal-amplifier-chain.js", fn: "startGame" },
  {id: "neon-merge-foundry", name: "Neon Merge Foundry", module: "./games/neon-merge-foundry.js", fn: "startGame" },
  {id: "language-evolution-mosaic", name: "Language Evolution Mosaic", module: "./games/language-evolution-mosaic.js", fn: "startGame" },
  {id: "market-microstructure-swarm", name: "Market Microstructure Swarm", module: "./games/market-microstructure-swarm.js", fn: "startGame" },
  {id: "openrouter-neon-probe", name: "OpenRouter Neon Probe", module: "./games/openrouter-neon-probe.js", fn: "startGame" },
  {id: "alien-diplomacy-protocol", name: "Alien Diplomacy Protocol", module: "./games/alien-diplomacy-protocol.js", fn: "startGame" },
  {id: "kingdom-diplomacy-chat", name: "Kingdom Diplomacy Chat", module: "./games/kingdom-diplomacy-chat.js", fn: "startGame" },
];

function qs() {
  return Object.fromEntries(new URLSearchParams(location.search).entries());
}

function setQueryGame(id) {
  const url = new URL(location.href);
  url.searchParams.set("game", id);
  history.replaceState({}, "", url);
}

async function boot() {
  // Add a simple picker UI into the existing #ui panel
  const ui = document.querySelector("#ui");
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <label class="pill">
      Game
      <select id="gamePicker"></select>
    </label>
    <button id="btnReloadGame">Load</button>
    <div class="pill" id="gameHint">Tip: you can also use ?game=...</div>
  `;
  ui.appendChild(row);

  const sel = row.querySelector("#gamePicker");
  const btn = row.querySelector("#btnReloadGame");

  for (const g of GAMES) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name;
    sel.appendChild(opt);
  }

  const saved = localStorage.getItem("simlab.selectedGame");
  const fromQuery = qs().game;
  const chosen = GAMES.find(g => g.id === fromQuery) ? fromQuery
               : GAMES.find(g => g.id === saved) ? saved
               : GAMES[0].id;

  sel.value = chosen;

  async function loadGame(id) {
    const g = GAMES.find(x => x.id === id) || GAMES[0];
    localStorage.setItem("simlab.selectedGame", g.id);
    setQueryGame(g.id);

    // Full reload is the simplest, most reliable way to switch games
    // because each game initialises the Engine and binds handlers.
    location.reload();
  }

  btn.onclick = () => loadGame(sel.value);
  sel.onchange = () => {
    // keep selection but only load on button press (less annoying)
    localStorage.setItem("simlab.selectedGame", sel.value);
  };

  // On first boot after reload, actually start the chosen game
  const g = GAMES.find(x => x.id === chosen) || GAMES[0];
  row.querySelector("#gameHint").textContent = `Loaded: ${g.name}  (?game=${g.id})`;

  const mod = await import(g.module);
  const startFn = mod[g.fn];
  if (typeof startFn !== "function") {
    throw new Error(`Game module ${g.module} does not export function ${g.fn}()`);
  }
  startFn();
}

boot();
