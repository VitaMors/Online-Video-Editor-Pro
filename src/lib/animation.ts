import type {
  AnimatableProperty,
  AnimatableValue,
  Composition,
  Keyframe,
  Layer,
  MaskPath,
  TransformPropertyKey,
  Vector2,
} from "../types/editor";

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isVector2(value: unknown): value is Vector2 {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

function isNumericVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isMaskPath(value: unknown): value is MaskPath {
  return Array.isArray(value) && value.every(isVector2);
}

export function cloneValue<T>(value: T): T {
  if (isMaskPath(value)) {
    return value.map((point) => [point[0], point[1]]) as T;
  }

  if (isNumericVector(value)) {
    return [...value] as T;
  }

  return value;
}

export function keyframeSort<T>(a: Keyframe<T>, b: Keyframe<T>) {
  return a.frame - b.frame;
}

export function keyframeVelocity(keyframe: Keyframe, side: "in" | "out", component = 0) {
  const components = side === "in" ? keyframe.velocityInComponents : keyframe.velocityOutComponents;
  const fallback = side === "in" ? keyframe.velocityIn : keyframe.velocityOut;
  return components?.[component] ?? fallback;
}

export function interpolateValue<T extends AnimatableValue>(from: T, to: T, amount: number): T {
  const t = clamp(amount, 0, 1);

  if (Array.isArray(from) && Array.isArray(to)) {
    const length = Math.max(from.length, to.length);
    return Array.from({ length }, (_, index) => {
      const start = typeof from[index] === "number" ? from[index] : to[index] ?? 0;
      const end = typeof to[index] === "number" ? to[index] : start;
      return start + (end - start) * t;
    }) as T;
  }

  return ((from as number) + ((to as number) - (from as number)) * t) as T;
}

function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number) {
  const inverse = 1 - t;
  return inverse ** 3 * p0 + 3 * inverse ** 2 * t * p1 + 3 * inverse * t ** 2 * p2 + t ** 3 * p3;
}

function cubicBezierDerivative(p0: number, p1: number, p2: number, p3: number, t: number) {
  const inverse = 1 - t;
  return 3 * inverse ** 2 * (p1 - p0) + 6 * inverse * t * (p2 - p1) + 3 * t ** 2 * (p3 - p2);
}

function normalizedInfluences(left: Keyframe, right: Keyframe) {
  const outInfluence = clamp(left.easeOut, 0, 100) / 100;
  const inInfluence = clamp(right.easeIn, 0, 100) / 100;
  const scale = outInfluence + inInfluence > 1 ? 1 / (outInfluence + inInfluence) : 1;

  return {
    out: outInfluence * scale,
    in: inInfluence * scale,
  };
}

function solveBezierTForX(x1: number, x2: number, x: number) {
  const target = clamp(x, 0, 1);
  let t = target;

  for (let index = 0; index < 8; index += 1) {
    const estimate = cubicBezier(0, x1, x2, 1, t) - target;
    const slope = cubicBezierDerivative(0, x1, x2, 1, t);
    if (Math.abs(estimate) < 0.00001 || Math.abs(slope) < 0.00001) break;
    t = clamp(t - estimate / slope, 0, 1);
  }

  let low = 0;
  let high = 1;
  for (let index = 0; index < 10; index += 1) {
    const estimate = cubicBezier(0, x1, x2, 1, t);
    if (Math.abs(estimate - target) < 0.00001) break;
    if (estimate < target) low = t;
    else high = t;
    t = (low + high) / 2;
  }

  return t;
}

function bezierComponent(from: number, to: number, left: Keyframe, right: Keyframe, rawT: number, component: number) {
  const frameSpan = Math.max(1, right.frame - left.frame);
  const influences = normalizedInfluences(left, right);
  const x1 = influences.out;
  const x2 = 1 - influences.in;
  const outSpan = frameSpan * influences.out;
  const inSpan = frameSpan * influences.in;
  const p1 = from + keyframeVelocity(left, "out", component) * outSpan;
  const p2 = to - keyframeVelocity(right, "in", component) * inSpan;
  const bezierT = solveBezierTForX(x1, x2, rawT);

  return cubicBezier(from, p1, p2, to, bezierT);
}

function interpolateBezierValue<T extends AnimatableValue>(from: T, to: T, left: Keyframe, right: Keyframe, rawT: number): T {
  if (Array.isArray(from) && Array.isArray(to)) {
    const length = Math.max(from.length, to.length);
    return Array.from({ length }, (_, index) => {
      const start = typeof from[index] === "number" ? from[index] : to[index] ?? 0;
      const end = typeof to[index] === "number" ? to[index] : start;
      return bezierComponent(start, end, left, right, rawT, index);
    }) as T;
  }

  return bezierComponent(from as number, to as number, left, right, rawT, 0) as T;
}

export function evaluateProperty<T extends AnimatableValue>(
  property: AnimatableProperty<T>,
  frame: number,
): T {
  if (!property.animated || property.keyframes.length === 0) {
    return cloneValue(property.value);
  }

  const keyframes = [...property.keyframes].sort(keyframeSort);
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];

  if (frame <= first.frame) return cloneValue(first.value);
  if (frame >= last.frame) return cloneValue(last.value);

  const rightIndex = keyframes.findIndex((keyframe) => keyframe.frame >= frame);
  const left = keyframes[rightIndex - 1];
  const right = keyframes[rightIndex];

  if (!left || !right || left.frame === right.frame) {
    return cloneValue(left?.value ?? property.value);
  }

  if (left.interpolation === "hold") {
    return cloneValue(left.value);
  }

  const rawT = (frame - left.frame) / (right.frame - left.frame);

  if (left.interpolation === "linear") {
    return interpolateValue(left.value, right.value, rawT);
  }

  return interpolateBezierValue(left.value, right.value, left, right, rawT);
}

export function interpolateMaskPath(from: MaskPath, to: MaskPath, amount: number): MaskPath {
  if (from.length !== to.length) return cloneValue(amount < 1 ? from : to);
  const t = clamp(amount, 0, 1);
  return from.map((point, index) => [
    point[0] + (to[index][0] - point[0]) * t,
    point[1] + (to[index][1] - point[1]) * t,
  ]);
}

export function evaluatePathProperty(property: AnimatableProperty<MaskPath>, frame: number): MaskPath {
  if (!property.animated || property.keyframes.length === 0) {
    return cloneValue(property.value);
  }

  const keyframes = [...property.keyframes].sort(keyframeSort);
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];

  if (frame <= first.frame) return cloneValue(first.value);
  if (frame >= last.frame) return cloneValue(last.value);

  const rightIndex = keyframes.findIndex((keyframe) => keyframe.frame >= frame);
  const left = keyframes[rightIndex - 1];
  const right = keyframes[rightIndex];

  if (!left || !right || left.frame === right.frame || left.interpolation === "hold") {
    return cloneValue(left?.value ?? property.value);
  }

  return interpolateMaskPath(left.value, right.value, (frame - left.frame) / (right.frame - left.frame));
}

export function createKeyframe<T>(
  id: string,
  frame: number,
  value: T,
): Keyframe<T> {
  return {
    id,
    frame,
    value: cloneValue(value),
    interpolation: "bezier",
    easeIn: 33,
    easeOut: 33,
    velocityIn: 0,
    velocityOut: 0,
    velocityInComponents: isNumericVector(value) ? value.map(() => 0) : undefined,
    velocityOutComponents: isNumericVector(value) ? value.map(() => 0) : undefined,
  };
}

export function upsertKeyframe<T>(
  property: AnimatableProperty<T>,
  frame: number,
  value: T,
  idFactory: () => string,
): AnimatableProperty<T> {
  const existing = property.keyframes.find((keyframe) => keyframe.frame === frame);
  const nextKeyframes = existing
    ? property.keyframes.map((keyframe) =>
        keyframe.id === existing.id ? { ...keyframe, value: cloneValue(value) } : keyframe,
      )
    : [...property.keyframes, createKeyframe(idFactory(), frame, value)];

  return {
    ...property,
    animated: true,
    value: cloneValue(value),
    keyframes: nextKeyframes.sort(keyframeSort),
  };
}

export function getLayerSize(layer: Layer): Vector2 {
  return [layer.source?.width ?? 320, layer.source?.height ?? 180];
}

export function getWorldPosition(
  composition: Composition,
  layer: Layer,
  frame: number,
  visited = new Set<string>(),
): Vector2 {
  const local = evaluateProperty(layer.transform.position, frame);
  const local2D: Vector2 = [local[0], local[1]];

  if (!layer.parentId || visited.has(layer.id)) {
    return local2D;
  }

  visited.add(layer.id);
  const parent = composition.layers.find((candidate) => candidate.id === layer.parentId);

  if (!parent) {
    return local2D;
  }

  const parentPosition = getWorldPosition(composition, parent, frame, visited);

  return [local[0] + parentPosition[0], local[1] + parentPosition[1]];
}

export function valueComponents(value: AnimatableValue): [number, number?] {
  return Array.isArray(value) ? [value[0], value[1]] : [value];
}

export function propertyLabel(property: TransformPropertyKey) {
  const labels: Record<TransformPropertyKey, string> = {
    position: "Position",
    scale: "Scale",
    rotationX: "X Rotation",
    rotationY: "Y Rotation",
    rotation: "Z Rotation",
    opacity: "Opacity",
    anchorPoint: "Anchor Point",
  };

  return labels[property];
}