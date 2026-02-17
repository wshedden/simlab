import "./style.css";

const GAMES = [
  { id: "example", name: "Example Dots", desc: "Click to spawn. Space to pause.", href: "/play.html?game=example" },
  { id: "firefly", name: "Firefly Shepherd", desc: "Swarm steering + cohesion score.", href: "/play.html?game=firefly" },
  { id: "orbital-trader-rings", name: "Orbital Trader Rings", desc: "Trade between rings of nodes.", href: "/play.html?game=orbital-trader-rings" },
  { id: "signal-amplifier-chain", name: "Signal Amplifier Chain", desc: "Chain reaction puzzle game.", href: "/play.html?game=signal-amplifier-chain" },
  { id: "neon-merge-foundry", name: "Neon Merge Foundry", desc: "Merge and upgrade in this neon factory.", href: "/play.html?game=neon-merge-foundry" },
  { id: "language-evolution-mosaic", name: "Language Evolution Mosaic", desc: "Simulate the evolution of symbolic languages.", href: "/play.html?game=language-evolution-mosaic" },
  { id: "market-microstructure-swarm", name: "Market Microstructure Swarm", desc: "Agent-based order book simulation.", href: "/play.html?game=market-microstructure-swarm" },
  { id: "openrouter-neon-probe", name: "OpenRouter Neon Probe", desc: "Visual probe for OpenRouter API streaming.", href: "/play.html?game=openrouter-neon-probe" },
  { id: "alien-diplomacy-protocol", name: "Alien Diplomacy Protocol", desc: "Interact with an alien polity using OpenRouter-driven narrative.", href: "/play.html?game=alien-diplomacy-protocol" },
  { id: "kingdom-diplomacy-chat", name: "Kingdom Diplomacy Chat", desc: "Diplomacy sandbox with AI-driven realm negotiation.", href: "/play.html?game=kingdom-diplomacy-chat" },
  { id: "neon-capital-flows", name: "Neon Capital Flows", desc: "Visualise capital movement between neon markets (placeholder).", href: "/play.html?game=neon-capital-flows" },
  { id: "neon-venture", name: "Neon Venture", desc: "Startup/venture flow visualisation (placeholder).", href: "/play.html?game=neon-venture" },
];

const app = document.querySelector("#app");

app.innerHTML = `
  <div class="launcher">
    <h1>SimLab</h1>
    <p class="muted">Pick a game. The URL will lock in your choice.</p>
    <div class="grid">
      ${GAMES.map(g => `
        <a class="card" href="${g.href}">
          <div class="cardTitle">${g.name}</div>
          <div class="cardDesc">${g.desc}</div>
          <div class="cardMeta">/${g.href.replace("/", "")}</div>
        </a>
      `).join("")}
    </div>
  </div>
`;

// optional: remember last played and show quick link
const last = localStorage.getItem("simlab.lastGame");
if (last) {
  const quick = document.createElement("a");
  quick.href = `/play.html?game=${encodeURIComponent(last)}`;
  quick.className = "quick";
  quick.textContent = `Resume last: ${last}`;
  app.querySelector(".launcher").appendChild(quick);
}
