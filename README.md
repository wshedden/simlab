# SimLab

A collection of interactive simulation games built with a lightweight canvas engine and optional AI integration via OpenRouter.

## Overview

SimLab is a modular framework for building real-time 2D simulations and games. Each game runs in a browser canvas with physics, particle effects, and optional AI-driven narrative features. Games can be played offline, persisted to localStorage, and resumed later.

## Features

- **Lightweight Engine** – Fixed-timestep simulation loop, proper input handling, and canvas scaling
- **10+ Games** – Diverse simulations from agent-based markets to diplomacy sandbox
- **Offline Progress** – Games auto-save and support offline time progression
- **AI Integration** – Optional OpenRouter API for chat-driven games
- **Neon Aesthetics** – Cyberpunk-inspired visuals with glow effects and particle systems
- **Performance Modes** – Auto-scaling to maintain playable framerates

## Quick Start

```bash
npm install
npm run dev
```

Then open http://localhost:5173 in your browser.

### Build for Production

```bash
npm run build
npm run preview
```

## Games

| Game | Description |
|------|-------------|
| **Example Dots** | Click-to-spawn particle system. Demonstrates core engine features. |
| **Firefly Shepherd** | Boid-based swarm steering with cohesion scoring and performance modes. |
| **Orbital Trader Rings** | Trade between orbital rings; upgrade ships and routes for passive income. |
| **Signal Amplifier Chain** | Click-intensive puzzle game with audio-responsive visuals and prestige reset. |
| **Neon Merge Foundry** | Idle/clicker with token merging, upgrades, and neon factory aesthetics. |
| **Language Evolution Mosaic** | CA-based symbolic language evolution with selection and mutation. |
| **Market Microstructure Swarm** | Agent-based order book simulation with news, circuit breakers, and tape. |
| **OpenRouter Neon Probe** | Streaming OpenRouter API requests visualized as pulses and energy flows. |
| **Alien Diplomacy Protocol** | AI-driven negotiation with stats, transcript, and narrative choices (OpenRouter). |
| **Kingdom Diplomacy Chat** | Sandbox diplomacy between medieval realms with AI-driven negotiations. |

## Project Structure

```
simlab/
├── index.html              # Launcher page
├── play.html               # Game play page
├── src/
│   ├── launcher.js         # Game picker UI
│   ├── play.js             # Game loader
│   ├── main.js             # Alternative launcher (unused)
│   ├── counter.js          # (Placeholder)
│   ├── style.css           # Shared UI styles
│   ├── engine/
│   │   ├── engine.js       # Core simulation engine (shared)
│   │   └── ENGINE_API.md   # Engine API reference
│   └── games/
│       ├── example-game.js
│       ├── firefly-shepherd.js
│       ├── orbital-trader-rings.js
│       ├── signal-amplifier-chain.js
│       ├── neon-merge-foundry.js
│       ├── language-evolution-mosaic.js
│       ├── market-microstructure-swarm.js
│       ├── openrouter-neon-probe.js
│       ├── alien-diplomacy-protocol.js
│       └── kingdom-diplomacy-chat.js
├── package.json
└── README.md (this file)
```

## Engine API

The **Engine** (`src/engine/engine.js`) provides a reusable simulation framework:

### Core Methods

- `Engine.init({ canvasId })` – Initialize canvas and start loop
- `Engine.on(hookName, callback)` – Register event handlers (update, render, input, resize)
- `Engine.getCtx()` – Get 2D canvas context
- `Engine.getSize()` – Get canvas dimensions
- `Engine.mouse()` – Get mouse position and state
- `Engine.keyDown(key)` – Check if key is held

### Drawing Helpers

- `Engine.gfx.clearBlack()` – Clear canvas with opaque black
- `Engine.gfx.glowCircle(x, y, r, colour)` – Draw glowing circle
- `Engine.gfx.line(x1, y1, x2, y2, colour, width)` – Draw line with glow

### Save/Load

- `Engine.save(key, object)` – Persist to localStorage with timestamp
- `Engine.load(key, fallback)` – Retrieve from localStorage
- `Engine.loadTimestamp(key)` – Get save time (ms since epoch)

### Control

- `Engine.isPaused()` / `Engine.togglePause()` – Pause/resume simulation
- `Engine.setSpeed(multiplier)` – Adjust simulation speed (0.5–4)
- `Engine.setStatus(text)` – Update status display

For full details, see [ENGINE_API.md](src/engine/ENGINE_API.md).

## Creating a Game

1. Create a new file in `src/games/myGame.js`:

```javascript
import { Engine } from "../engine/engine.js";

export function startGame(ctx = {}) {
  Engine.init({ canvasId: ctx.canvasId || "c" });

  // Your game state
  const state = { /* ... */ };

  // Register hooks
  Engine.on("update", (dt) => {
    // Simulation step (fixed timestep)
  });

  Engine.on("render", (realDt, alpha) => {
    // Draw frame
    Engine.gfx.clearBlack();
    // ... draw game
  });

  Engine.on("onClick", (event, { x, y }) => {
    // Handle clicks
  });
}
```

2. Add to `GAME_REGISTRY` in `src/play.js`:

```javascript
const GAME_REGISTRY = {
  // ... existing
  mygame: () => import("./games/myGame.js"),
};
```

3. Add to launcher in `src/launcher.js`:

```javascript
const GAMES = [
  // ... existing
  { id: "mygame", name: "My Game", desc: "...", href: "/play.html?game=mygame" },
];
```

4. Play at `/play.html?game=mygame`

## OpenRouter Integration (Optional)

Games using AI features (Alien Diplomacy, Kingdom Diplomacy, OpenRouter Neon Probe) require an OpenRouter API key.

Set via environment variable (e.g., in `.env` for Vite):

```env
VITE_OPENROUTER_API_KEY=your_key_here
```

Or pass at build time:

```bash
VITE_OPENROUTER_API_KEY=your_key npm run dev
```

## Save Data

Game progress is stored in browser localStorage under keys like:
- `simlab.lastGame` – Last played game ID
- `simlab.<gameName>.v<N>` – Game state (JSON)
- `simlab.<gameName>.v<N>_ts` – Save timestamp

Clear via DevTools Console:
```javascript
localStorage.clear();
location.reload();
```

## Performance Tuning

Games include adaptive performance modes. If FPS drops, the engine may:
- Reduce particle/agent counts
- Lower trail lengths
- Disable optional visual effects

Adjust via UI sliders (if present) or edit config in each game file.

## Browser Support

- Chrome/Chromium 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (touchscreen events routed to mouse handler)

## Technologies

- **Vite** – Fast bundler and dev server
- **Canvas 2D** – Hardware-accelerated rendering
- **Web Audio** – Optional sound effects
- **OpenRouter API** – LLM streaming for AI games
- **localStorage** – Persistent game state

## Contributing

To add a new game:

1. Write game logic in `src/games/newgame.js`
2. Export `startGame(ctx)` function
3. Register in `play.js` and `launcher.js`
4. Test with `npm run dev`

Keep canvas operations efficient (avoid O(N²) checks for large N), clear canvas each frame (unless intentional trails), and use Engine helpers for consistent visuals.

## License

Personal project. Feel free to fork and modify.

---

**Questions?** Check [ENGINE_API.md](src/engine/ENGINE_API.md) or review existing game implementations.
