import { EFFECT_DEFINITIONS, EFFECT_ORDER } from "./effects";
import type { ContextMenuItem } from "../components/ContextMenu";
import type { BlendMode, Composition, Layer } from "../types/editor";

// The set of store actions the layer context menu needs. Kept as a narrow local interface
// (rather than importing the store's own state type) so this file only depends on exactly the
// handful of actions it actually calls.
export type LayerContextMenuActions = {
  duplicateLayer: (layerId?: string) => void;
  splitSelectedLayers: () => void;
  deleteSelection: () => void;
  toggleLayerFlag: (layerId: string, flag: "visible" | "locked" | "solo" | "motionBlur") => void;
  setLayerBlendMode: (layerId: string, blendMode: BlendMode) => void;
  toggleTimeRemap: (layerId: string) => void;
  freezeTimeRemap: (layerId: string) => void;
  reverseTimeRemap: (layerId: string) => void;
  reorderLayer: (layerId: string, targetLayerId: string, placement: "above" | "below") => void;
  addEffect: (layerId: string, type: (typeof EFFECT_ORDER)[number]) => void;
};

const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  darken: "Darken",
  multiply: "Multiply",
  colorBurn: "Color Burn",
  lighten: "Lighten",
  screen: "Screen",
  colorDodge: "Color Dodge",
  add: "Add",
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

const BLEND_MODE_ORDER: BlendMode[] = [
  "normal", "darken", "multiply", "colorBurn", "lighten", "screen", "colorDodge", "add",
  "overlay", "softLight", "hardLight", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

// Mirrors After Effects' own Timeline-panel right-click menu: duplicate/split/delete up top
// (the things you do to a layer most often), Effect / Time / Blending Mode / Arrange as
// submenus further down (the things AE itself buries a level deep), and the visibility/lock/
// solo/motion-blur toggles - which AE exposes as switches/columns rather than menu items, but
// this app's layer rows don't leave room for a full switches column - at the bottom as checked
// items so right-click reaches everything the LayerPanel's icon buttons already do.
export function buildLayerContextMenu(
  layer: Layer,
  composition: Composition,
  actions: LayerContextMenuActions,
): ContextMenuItem[] {
  const index = composition.layers.findIndex((candidate) => candidate.id === layer.id);
  const isFirst = index <= 0;
  const isLast = index === composition.layers.length - 1 || index === -1;
  const canHaveEffects = layer.type !== "audio" && layer.type !== "null" && layer.type !== "camera";
  const isVideo = layer.type === "video";

  const items: ContextMenuItem[] = [
    {
      label: "Duplicate Layer",
      shortcut: "Ctrl+D",
      action: () => actions.duplicateLayer(layer.id),
    },
    {
      label: "Split Layer at Playhead",
      shortcut: "Ctrl+Shift+D",
      action: () => actions.splitSelectedLayers(),
    },
    { kind: "separator" },
    {
      label: "Delete Layer",
      danger: true,
      action: () => actions.deleteSelection(),
    },
  ];

  if (canHaveEffects) {
    items.push(
      { kind: "separator" },
      {
        label: "Effect",
        items: EFFECT_ORDER.map((type) => ({
          label: EFFECT_DEFINITIONS[type].label,
          action: () => actions.addEffect(layer.id, type),
        })),
      },
    );
  }

  if (isVideo) {
    items.push({
      label: "Time",
      items: [
        {
          label: layer.source?.timeRemap ? "Disable Time Remapping" : "Enable Time Remapping",
          checked: Boolean(layer.source?.timeRemap),
          action: () => actions.toggleTimeRemap(layer.id),
        },
        {
          label: "Freeze Frame",
          disabled: !layer.source?.timeRemap,
          action: () => actions.freezeTimeRemap(layer.id),
        },
        {
          label: "Time-Reverse Layer",
          disabled: !layer.source?.timeRemap,
          action: () => actions.reverseTimeRemap(layer.id),
        },
      ],
    });
  }

  items.push(
    { kind: "separator" },
    {
      label: "Blending Mode",
      items: BLEND_MODE_ORDER.map((mode) => ({
        label: BLEND_MODE_LABELS[mode],
        checked: (layer.blendMode ?? "normal") === mode,
        action: () => actions.setLayerBlendMode(layer.id, mode),
      })),
    },
    {
      label: "Arrange",
      items: [
        {
          label: "Bring Layer to Front",
          disabled: isFirst,
          action: () => { if (composition.layers[0]) actions.reorderLayer(layer.id, composition.layers[0].id, "above"); },
        },
        {
          label: "Bring Layer Forward",
          disabled: isFirst,
          action: () => { const previous = composition.layers[index - 1]; if (previous) actions.reorderLayer(layer.id, previous.id, "above"); },
        },
        {
          label: "Send Layer Backward",
          disabled: isLast,
          action: () => { const next = composition.layers[index + 1]; if (next) actions.reorderLayer(layer.id, next.id, "below"); },
        },
        {
          label: "Send Layer to Back",
          disabled: isLast,
          action: () => {
            const last = composition.layers[composition.layers.length - 1];
            if (last) actions.reorderLayer(layer.id, last.id, "below");
          },
        },
      ],
    },
    { kind: "separator" },
    {
      label: layer.visible !== false ? "Hide Layer" : "Show Layer",
      checked: layer.visible !== false,
      action: () => actions.toggleLayerFlag(layer.id, "visible"),
    },
    {
      label: layer.locked ? "Unlock Layer" : "Lock Layer",
      checked: Boolean(layer.locked),
      action: () => actions.toggleLayerFlag(layer.id, "locked"),
    },
    {
      label: "Solo Layer",
      checked: Boolean(layer.solo),
      action: () => actions.toggleLayerFlag(layer.id, "solo"),
    },
    {
      label: "Motion Blur",
      checked: Boolean(layer.motionBlur),
      action: () => actions.toggleLayerFlag(layer.id, "motionBlur"),
    },
  );

  return items;
}
