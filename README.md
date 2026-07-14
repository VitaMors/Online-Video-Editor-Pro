# Online Video Editor Pro

Foundation build for a browser-based motion graphics editor. The first target is a focused After Effects-style workflow: layer-based compositions, transform animation, precise keyframes, easing controls, a graph editor, and a canvas preview.

## First slice

- React, TypeScript, Zustand, Vite, and Tailwind scaffold
- Default 1920 x 1080 composition at 30 fps for 10 seconds
- Canvas preview with grid, guides, zoom, pan, direct layer selection, and drag-to-position
- Layer panel with visibility, lock, solo, parent selection, renaming, image import, and basic layer creation
- Transform inspector for position, scale, rotation, opacity, and anchor point
- Shared keyframe data model with linear, bezier, and hold interpolation
- Timeline with layer bars, keyframe diamonds, playhead scrubbing, keyframe selection, and keyframe dragging
- Basic value/speed graph editor shell for selected transform properties
- Local project persistence in the browser

## Commands

```bash
pnpm install
pnpm run dev
pnpm run build
```
