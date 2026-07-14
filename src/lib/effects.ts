import { evaluateProperty } from "./animation";
import { animatable, createId } from "./factories";
import type { AnimatableProperty, Effect, EffectType } from "../types/editor";

export type EffectControlKind = "number" | "color" | "boolean";

type NumberControlDefinition = {
  key: string;
  label: string;
  kind: "number";
  defaultValue: number;
  min: number;
  max: number;
  step: number;
};

type StaticControlDefinition = {
  key: string;
  label: string;
  kind: "color" | "boolean";
  defaultValue: string | boolean;
};

export type EffectControlDefinition = NumberControlDefinition | StaticControlDefinition;

export type EffectDefinition = {
  type: EffectType;
  label: string;
  controls: EffectControlDefinition[];
};

const mixControl: NumberControlDefinition = {
  key: "mix",
  label: "Mix With Original",
  kind: "number",
  defaultValue: 100,
  min: 0,
  max: 100,
  step: 1,
};

export const EFFECT_ORDER: EffectType[] = [
  "hueSaturation",
  "levels",
  "curves",
  "brightnessContrast",
  "exposure",
  "gaussianBlur",
  "directionalBlur",
  "fill",
  "tint",
  "dropShadow",
  "glow",
  "noiseGrain",
  "sharpen",
  "invert",
];

export const EFFECT_DEFINITIONS: Record<EffectType, EffectDefinition> = {
  hueSaturation: {
    type: "hueSaturation",
    label: "Hue/Saturation",
    controls: [
      { key: "hue", label: "Hue", kind: "number", defaultValue: 0, min: -180, max: 180, step: 1 },
      { key: "saturation", label: "Saturation", kind: "number", defaultValue: 0, min: -100, max: 100, step: 1 },
      { key: "lightness", label: "Lightness", kind: "number", defaultValue: 0, min: -100, max: 100, step: 1 },
      mixControl,
    ],
  },
  levels: {
    type: "levels",
    label: "Levels",
    controls: [
      { key: "blackInput", label: "Black Input", kind: "number", defaultValue: 0, min: 0, max: 254, step: 1 },
      { key: "whiteInput", label: "White Input", kind: "number", defaultValue: 255, min: 1, max: 255, step: 1 },
      { key: "gamma", label: "Gamma", kind: "number", defaultValue: 1, min: 0.1, max: 5, step: 0.05 },
      { key: "outputBlack", label: "Output Black", kind: "number", defaultValue: 0, min: 0, max: 255, step: 1 },
      { key: "outputWhite", label: "Output White", kind: "number", defaultValue: 255, min: 0, max: 255, step: 1 },
      mixControl,
    ],
  },
  curves: {
    type: "curves",
    label: "Curves",
    controls: [
      { key: "shadows", label: "Shadows", kind: "number", defaultValue: 0, min: -100, max: 100, step: 1 },
      { key: "midtones", label: "Midtones", kind: "number", defaultValue: 0, min: -100, max: 100, step: 1 },
      { key: "highlights", label: "Highlights", kind: "number", defaultValue: 0, min: -100, max: 100, step: 1 },
      mixControl,
    ],
  },
  brightnessContrast: {
    type: "brightnessContrast",
    label: "Brightness & Contrast",
    controls: [
      { key: "brightness", label: "Brightness", kind: "number", defaultValue: 0, min: -100, max: 100, step: 1 },
      { key: "contrast", label: "Contrast", kind: "number", defaultValue: 0, min: -100, max: 100, step: 1 },
      mixControl,
    ],
  },
  exposure: {
    type: "exposure",
    label: "Exposure",
    controls: [
      { key: "exposure", label: "Exposure", kind: "number", defaultValue: 0, min: -5, max: 5, step: 0.05 },
      { key: "offset", label: "Offset", kind: "number", defaultValue: 0, min: -1, max: 1, step: 0.01 },
      { key: "gamma", label: "Gamma", kind: "number", defaultValue: 1, min: 0.1, max: 5, step: 0.05 },
      mixControl,
    ],
  },
  gaussianBlur: {
    type: "gaussianBlur",
    label: "Gaussian Blur",
    controls: [
      { key: "blur", label: "Blurriness", kind: "number", defaultValue: 0, min: 0, max: 120, step: 0.5 },
      mixControl,
    ],
  },
  directionalBlur: {
    type: "directionalBlur",
    label: "Directional Blur",
    controls: [
      { key: "angle", label: "Direction", kind: "number", defaultValue: 0, min: -180, max: 180, step: 1 },
      { key: "distance", label: "Blur Length", kind: "number", defaultValue: 0, min: 0, max: 240, step: 0.5 },
      mixControl,
    ],
  },
  fill: {
    type: "fill",
    label: "Fill",
    controls: [
      { key: "color", label: "Color", kind: "color", defaultValue: "#39d0c8" },
      { key: "opacity", label: "Opacity", kind: "number", defaultValue: 100, min: 0, max: 100, step: 1 },
      mixControl,
    ],
  },
  tint: {
    type: "tint",
    label: "Tint",
    controls: [
      { key: "blackColor", label: "Map Black To", kind: "color", defaultValue: "#10151d" },
      { key: "whiteColor", label: "Map White To", kind: "color", defaultValue: "#f8fafc" },
      { key: "amount", label: "Amount", kind: "number", defaultValue: 100, min: 0, max: 100, step: 1 },
      mixControl,
    ],
  },
  dropShadow: {
    type: "dropShadow",
    label: "Drop Shadow",
    controls: [
      { key: "color", label: "Color", kind: "color", defaultValue: "#000000" },
      { key: "opacity", label: "Opacity", kind: "number", defaultValue: 55, min: 0, max: 100, step: 1 },
      { key: "angle", label: "Direction", kind: "number", defaultValue: 135, min: -180, max: 180, step: 1 },
      { key: "distance", label: "Distance", kind: "number", defaultValue: 18, min: 0, max: 240, step: 1 },
      { key: "blur", label: "Softness", kind: "number", defaultValue: 18, min: 0, max: 120, step: 0.5 },
      mixControl,
    ],
  },
  glow: {
    type: "glow",
    label: "Glow",
    controls: [
      { key: "color", label: "Color", kind: "color", defaultValue: "#39d0c8" },
      { key: "threshold", label: "Threshold", kind: "number", defaultValue: 55, min: 0, max: 100, step: 1 },
      { key: "radius", label: "Radius", kind: "number", defaultValue: 20, min: 0, max: 160, step: 0.5 },
      { key: "intensity", label: "Intensity", kind: "number", defaultValue: 80, min: 0, max: 300, step: 1 },
      mixControl,
    ],
  },
  noiseGrain: {
    type: "noiseGrain",
    label: "Noise/Grain",
    controls: [
      { key: "amount", label: "Amount", kind: "number", defaultValue: 12, min: 0, max: 100, step: 1 },
      { key: "monochrome", label: "Monochrome", kind: "boolean", defaultValue: true },
      mixControl,
    ],
  },
  sharpen: {
    type: "sharpen",
    label: "Sharpen",
    controls: [
      { key: "amount", label: "Amount", kind: "number", defaultValue: 35, min: 0, max: 200, step: 1 },
      mixControl,
    ],
  },
  invert: {
    type: "invert",
    label: "Invert",
    controls: [
      { key: "amount", label: "Amount", kind: "number", defaultValue: 100, min: 0, max: 100, step: 1 },
      mixControl,
    ],
  },
};

export function isEffectNumberControl(value: unknown): value is AnimatableProperty<number> {
  return typeof value === "object" && value !== null && "value" in value && "keyframes" in value && Array.isArray((value as AnimatableProperty<number>).keyframes);
}

export function createEffect(type: EffectType): Effect {
  const definition = EFFECT_DEFINITIONS[type];
  const controls: Effect["controls"] = {};

  definition.controls.forEach((control) => {
    controls[control.key] = control.kind === "number" ? animatable(control.defaultValue) : control.defaultValue;
  });

  return {
    id: createId("effect"),
    name: definition.label,
    type,
    enabled: true,
    controls,
  };
}

export function resetEffectControls(effect: Effect): Effect {
  const fresh = createEffect(effect.type);
  return { ...fresh, id: effect.id, name: effect.name, enabled: effect.enabled };
}

export function effectDefinition(effect: Effect | EffectType) {
  return EFFECT_DEFINITIONS[typeof effect === "string" ? effect : effect.type];
}

export function effectControlDefinition(effect: Effect | EffectType, key: string) {
  return effectDefinition(effect).controls.find((control) => control.key === key);
}

export function effectNumericControlKeys(effect: Effect) {
  return effectDefinition(effect).controls
    .filter((control) => control.kind === "number" && isEffectNumberControl(effect.controls[control.key]))
    .map((control) => control.key);
}

export function effectNumberValue(effect: Effect, key: string, frame: number) {
  const control = effect.controls[key];
  return isEffectNumberControl(control) ? evaluateProperty(control, frame) : 0;
}

export function clampedEffectNumberValue(effect: Effect, key: string, value: number) {
  const definition = effectControlDefinition(effect, key);
  if (!definition || definition.kind !== "number") return value;
  const safe = Number.isFinite(value) ? value : definition.defaultValue;
  return Math.min(definition.max, Math.max(definition.min, safe));
}

export function effectStaticValue(effect: Effect, key: string) {
  const value = effect.controls[key];
  return isEffectNumberControl(value) ? undefined : value;
}