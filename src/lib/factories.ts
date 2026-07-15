import type {
  AnimatableProperty,
  AnimatableValue,
  Composition,
  Layer,
  LayerSource,
  LayerType,
  Project,
  TransformProperties,
} from "../types/editor";

export function createId(prefix: string) {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  return `${prefix}-${id}`;
}

export function animatable<T>(value: T): AnimatableProperty<T> {
  return { value, animated: false, keyframes: [] };
}

export function createTransform(
  position: [number, number],
  size: [number, number],
): TransformProperties {
  return {
    position: animatable(position),
    scale: animatable([100, 100]),
    rotation: animatable(0),
    opacity: animatable(100),
    anchorPoint: animatable([size[0] / 2, size[1] / 2]),
  };
}

function sourceForType(type: LayerType): LayerSource {
  if (type === "text") {
    return { text: "Motion Title", color: "#f8fafc", fontSize: 64, width: 520, height: 110 };
  }

  if (type === "shape") {
    return { shape: "rectangle", color: "#39d0c8", width: 460, height: 260 };
  }

  if (type === "solid") {
    return { color: "#293241", width: 520, height: 320 };
  }

  if (type === "null") {
    return { width: 140, height: 140 };
  }

  if (type === "video") {
    return { width: 640, height: 360 };
  }

  if (type === "audio") {
    return { width: 520, height: 80 };
  }

  if (type === "adjustment") {
    return { width: 1920, height: 1080 };
  }

  return { width: 640, height: 360 };
}

function layerName(type: LayerType) {
  const labels: Record<LayerType, string> = {
    text: "Text Layer",
    shape: "Shape Layer",
    image: "Image Layer",
    video: "Video Layer",
    audio: "Audio Layer",
    solid: "Solid Layer",
    adjustment: "Adjustment Layer",
    null: "Null Layer",
  };

  return labels[type];
}

export function createLayer(
  type: LayerType,
  composition: Pick<Composition, "width" | "height" | "durationFrames">,
  overrides: Partial<Layer> = {},
): Layer {
  const source = {
    ...sourceForType(type),
    ...(type === "adjustment" ? { width: composition.width, height: composition.height } : {}),
    ...overrides.source,
  };
  const width = source.width ?? 320;
  const height = source.height ?? 180;

  return {
    id: createId("layer"),
    name: overrides.name ?? layerName(type),
    type,
    visible: overrides.visible ?? true,
    locked: overrides.locked ?? false,
    solo: overrides.solo ?? false,
    motionBlur: overrides.motionBlur ?? false,
    startFrame: overrides.startFrame ?? 0,
    endFrame: overrides.endFrame ?? composition.durationFrames,
    parentId: overrides.parentId,
    blendMode: "normal",
    transform:
      overrides.transform ??
      createTransform([composition.width / 2, composition.height / 2], [width, height]),
    masks: overrides.masks ?? [],
    effects: overrides.effects ?? [],
    source,
  };
}


export function createComposition(overrides: Partial<Composition> = {}): Composition {
  return {
    id: overrides.id ?? createId("comp"),
    name: overrides.name ?? "Composition",
    width: overrides.width ?? 1920,
    height: overrides.height ?? 1080,
    fps: overrides.fps ?? 30,
    durationFrames: overrides.durationFrames ?? 300,
    backgroundColor: overrides.backgroundColor ?? "#10151d",
    backgroundTransparent: overrides.backgroundTransparent ?? false,
    motionBlur: overrides.motionBlur ?? false,
    layers: overrides.layers ?? [],
  };
}
export function createDefaultProject(): Project {
  const composition = createComposition({ name: "Main Composition" });

  const shape = createLayer("shape", composition, {
    name: "Accent Shape",
    transform: createTransform([960, 560], [460, 260]),
  });
  const title = createLayer("text", composition, {
    name: "Motion Title",
    transform: createTransform([960, 490], [520, 110]),
  });

  title.transform.position.animated = true;
  title.transform.position.keyframes = [
    {
      id: createId("key"),
      frame: 0,
      value: [760, 490],
      interpolation: "bezier",
      easeIn: 33,
      easeOut: 55,
      velocityIn: 0,
      velocityOut: 0,
    },
    {
      id: createId("key"),
      frame: 72,
      value: [960, 490],
      interpolation: "bezier",
      easeIn: 55,
      easeOut: 33,
      velocityIn: 0,
      velocityOut: 0,
    },
  ];

  title.transform.opacity.animated = true;
  title.transform.opacity.keyframes = [
    {
      id: createId("key"),
      frame: 0,
      value: 0,
      interpolation: "bezier",
      easeIn: 33,
      easeOut: 45,
      velocityIn: 0,
      velocityOut: 0,
    },
    {
      id: createId("key"),
      frame: 36,
      value: 100,
      interpolation: "bezier",
      easeIn: 45,
      easeOut: 33,
      velocityIn: 0,
      velocityOut: 0,
    },
  ];

  composition.layers = [title, shape];

  return {
    id: createId("project"),
    name: "Untitled Motion Project",
    compositions: [composition],
  };
}