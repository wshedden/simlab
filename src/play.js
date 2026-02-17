import "./style.css";

const GAME_REGISTRY = {
  example: () => import("./games/example-game.js"),
  firefly: () => import("./games/firefly-shepherd.js"),
  "orbital-trader-rings": () => import("./games/orbital-trader-rings.js"),
  "signal-amplifier-chain": () => import("./games/signal-amplifier-chain.js"),
  "neon-merge-foundry": () => import("./games/neon-merge-foundry.js"),
  "language-evolution-mosaic": () => import("./games/language-evolution-mosaic.js"),
  "market-microstructure-swarm": () => import("./games/market-microstructure-swarm.js"),
  "openrouter-neon-probe": () => import("./games/openrouter-neon-probe.js"),
  "alien-diplomacy-protocol": () => import("./games/alien-diplomacy-protocol.js"),
  "kingdom-diplomacy-chat": () => import("./games/kingdom-diplomacy-chat.js"),
  "kira-algorithm-of-judgement": () => import("./games/kira-algorithm-of-judgement.js"),
  "neon-capital-flows": () => import("./games/neon-capital-flows.js"),
  "neon-venture": () => import("./games/neon-venture.js"),
};

function getGameId() {
  const p = new URLSearchParams(location.search);
  return (p.get("game") || "").trim();
}

async function boot() {
  const id = getGameId();
  const loader = GAME_REGISTRY[id];

  if (!loader) {
    // If bad/missing ?game=..., show a minimal message and link back
    document.body.innerHTML = `
      <div style="padding:18px; color:#e9ecff; font-family:system-ui; background:#000; min-height:100vh;">
        <h2>Unknown game: ${id || "(none)"} </h2>
        <p><a href="/" style="color:#8fb0ff;">Go back to launcher</a></p>
      </div>
    `;
    return;
  }

  localStorage.setItem("simlab.lastGame", id);

  const mod = await loader();
  const start = mod.startGame || mod.startExampleGame;
  if (typeof start !== "function") throw new Error(`Game "${id}" has no startGame()`);

  start({
    canvasId: "c",
    uiRoot: document.querySelector("#uiRoot"),
    gameId: id,
  });
}

boot();
