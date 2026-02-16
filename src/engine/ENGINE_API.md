# SimLab Engine API (engine.js)

This project uses a lightweight local engine (`engine.js`) that provides:
- Canvas setup with correct devicePixelRatio scaling (no click-offset bugs)
- Fixed-timestep simulation loop (stable sims)
- Reliable input (mouse coords via getBoundingClientRect)
- localStorage save/load + timestamp helpers
- A few neon drawing helpers (optional)
- Optional Web Audio unlock + tiny SFX

## Files (expected)
- index.html: canvas + HTML UI overlay (buttons/sliders)
- style.css: UI styling
- engine.js: reusable engine (shared; do not rewrite unless asked)
- game.js: game-specific logic (usually the only file you generate)
- ENGINE_API.md: this contract

## Import (in game.js)
```js
import { Engine } from "./engine.js";
```

## Init
- `Engine.init({ canvasId: "c" });`  
Starts the loop, binds input, handles resize.

## Hooks (register callbacks)
- `Engine.on("update", (dt) => { ... })`
  - dt is fixed timestep in seconds (typically 1/60)
- `Engine.on("render", (realDt, alpha) => { ... })`
  - realDt is seconds since last frame (clamped)
  - alpha is 0..1 interpolation factor
- `Engine.on("onResize", (w, h, dpr) => { ... })`
- `Engine.on("onClick", (event, {x,y}) => { ... })`
- `Engine.on("onMouseDown", (event, {x,y}) => { ... })`
- `Engine.on("onMouseUp", (event, {x,y}) => { ... })`
- `Engine.on("onMouseMove", (event, {x,y}) => { ... })`
- `Engine.on("onKeyDown", (event) => { ... })`
- `Engine.on("onKeyUp", (event) => { ... })`

## State / control
- `Engine.isPaused()` -> boolean
- `Engine.pause()`, `Engine.play()`, `Engine.togglePause()`
- `Engine.setSpeed(multiplierNumber)` (e.g. 0.5..4)
- `Engine.setStatus(text)` updates #status if present

## DOM helper
- `Engine.$("selector")` -> document.querySelector(selector)

## Canvas / context
- `Engine.getCanvas()` -> HTMLCanvasElement
- `Engine.getCtx()` -> CanvasRenderingContext2D (created with alpha:false)
- `Engine.getDPR()` -> dpr used
- `Engine.getSize()` -> `{ w, h }` in CSS pixels (clientWidth/clientHeight)

## Input
- `Engine.keyDown("a")`, `Engine.keyDown("ArrowUp")`, etc.
- `Engine.mouse()` -> `{ x,y,px,py,dx,dy,down,button }` in CSS pixels

## Save / load
- `Engine.save(key, obj)` -> stores JSON and also key.__ts timestamp
- `Engine.load(key, fallback)` -> parsed object or fallback
- `Engine.loadTimestamp(key)` -> ms since epoch (or 0)

## Drawing helpers (optional)
- `Engine.gfx.clearBlack()` -> opaque black clear (prevents grey smearing)
- `Engine.gfx.glowCircle(x, y, r, colour, glow, alpha)` -> draws a glowing circle
- `Engine.gfx.line(x1, y1, x2, y2, colour, width, alpha)` -> draws a line with optional alpha and width

## Audio (optional; must be enabled by user gesture)
- `await Engine.audio.enable()` -> creates AudioContext + master gain
- `Engine.audio.click(pitchHz)` -> short beep
- `Engine.audio.setMuted(boolean)`
- `Engine.audio.muted` boolean

## Hard requirements when generating game code
- Unless explicitly asked, OUTPUT ONLY `game.js`.
- Do NOT rewrite or inline engine.js / index.html / style.css.
- Keep UI clickable: use HTML buttons/sliders via `Engine.$()` and `onclick` handlers.
- Do NOT draw clickable UI on the canvas unless explicitly requested.
- Clear the canvas each frame with `Engine.gfx.clearBlack()` unless a deliberate trail system is requested.
- Keep sim updates efficient: avoid O(N^2) neighbour scans unless N is small and capped.
- Persist progress (save/load) and implement offline progress using timestamps.
