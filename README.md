# Awaken the Blade

`Awaken the Blade` is a cinematic dark-fantasy landing page built around a real-time Three.js sword and sheath presentation. Scroll through the experience to draw the blade, inspect its anatomy, and move through the Forge, Origin, Inscription, Legacy, and Finale chapters.

## Highlights

- Real `public/models/weapon.glb` model with independent Sword and Sheath nodes
- Scroll-controlled sword extraction with smooth reverse scrolling
- GSAP ScrollTrigger + Lenis integration
- Persistent Three.js renderer with chapter-specific camera and lighting states
- Cinematic loader with GLB/font readiness progress
- Renderer-native Gradient Waves and sparse Forge embers
- Reduced-motion support and a static fallback when WebGL/model loading fails
- Existing editorial typography, chapter rail, and dark steel palette preserved

## Tech stack

- Vite
- Vanilla JavaScript
- Three.js
- GSAP + ScrollTrigger
- Lenis

## Getting started

Requirements: Node.js 18+ and pnpm (or npm).

```bash
pnpm install
pnpm dev
```

Open the local URL shown by Vite, usually `http://localhost:5173`.

## Production build

```bash
pnpm build
pnpm preview
```

## Project structure

```text
.
├── index.html
├── public/
│   ├── assets/           # PNG fallback assets
│   └── models/weapon.glb
├── src/
│   ├── main.js           # Loader, Lenis, GSAP, ScrollTrigger, chapters
│   ├── style.css         # Layout, typography, chapter styling
│   └── weapon-scene.js   # Three.js scene, GLB rig, lighting, waves, embers
├── inspect-glb.js        # Small GLB hierarchy inspection helper
├── package.json
└── vite.config.js
```

## Model notes

The GLB is expected at `public/models/weapon.glb`. The loader verifies renderable meshes and locates the independent `Sword` and `Sheath` groups before creating the presentation rig. Materials are normalized to safe PBR materials for reliable WebGL rendering.

## License

No license has been specified yet. Add one before distributing the project publicly.
