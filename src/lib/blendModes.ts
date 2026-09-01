import type { BlendMode } from "../types/editor";

// Order mirrors the grouping Photoshop/After Effects use in their blend mode menus
// (normal, darken group, lighten group, contrast group, comparative, component).
export const BLEND_MODE_ORDER: BlendMode[] = [
  "normal",
  "darken",
  "multiply",
  "colorBurn",
  "lighten",
  "screen",
  "colorDodge",
  "add",
  "overlay",
  "softLight",
  "hardLight",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  darken: "Darken",
  multiply: "Multiply",
  colorBurn: "Color Burn",
  lighten: "Lighten",
  screen: "Screen",
  colorDodge: "Color Dodge",
  add: "Add (Linear Dodge)",
  overlay: "Overlay",
  softLight: "Soft Light",
  hardLight: "Hard Light",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

// Every mode here maps 1:1 onto a native canvas globalCompositeOperation value ("add"
// is the closest native equivalent to Photoshop/AE's "Linear Dodge (Add)"), so applying
// a blend mode is just setting this before the layer's composite draw - no per-pixel
// blending math needed, and it stays fast even on large compositions.
const BLEND_MODE_COMPOSITE_OPERATIONS: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  darken: "darken",
  multiply: "multiply",
  colorBurn: "color-burn",
  lighten: "lighten",
  screen: "screen",
  colorDodge: "color-dodge",
  add: "lighter",
  overlay: "overlay",
  softLight: "soft-light",
  hardLight: "hard-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

export function compositeOperationForBlendMode(blendMode: BlendMode | undefined): GlobalCompositeOperation {
  return BLEND_MODE_COMPOSITE_OPERATIONS[blendMode ?? "normal"] ?? "source-over";
}
