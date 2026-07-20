export type LayerType = "text" | "shape" | "image" | "video" | "audio" | "model" | "camera" | "solid" | "adjustment" | "null";
export type InterpolationType = "linear" | "bezier" | "hold";
export type GraphMode = "value" | "speed";
export type EditorTool = "select" | "mask";
export type Vector2 = [number, number];
export type Vector3 = [number, number, number];
export type SpatialVector = Vector2 | Vector3;
export type MaskPath = Vector2[];
export type AnimatableValue = number | Vector2 | Vector3;

export type Keyframe<T = AnimatableValue> = {
  id: string;
  frame: number;
  value: T;
  interpolation: InterpolationType;
  easeIn: number;
  easeOut: number;
  velocityIn: number;
  velocityOut: number;
  velocityInComponents?: number[];
  velocityOutComponents?: number[];
};

export type AnimatableProperty<T> = {
  value: T;
  animated: boolean;
  keyframes: Keyframe<T>[];
};

export type TransformProperties = {
  position: AnimatableProperty<SpatialVector>;
  scale: AnimatableProperty<SpatialVector>;
  rotationX: AnimatableProperty<number>;
  rotationY: AnimatableProperty<number>;
  rotation: AnimatableProperty<number>;
  opacity: AnimatableProperty<number>;
  anchorPoint: AnimatableProperty<SpatialVector>;
};

export type TransformPropertyKey = keyof TransformProperties;
export type MaskPropertyKey = "path" | "feather" | "position" | "scale";
export type SourcePropertyKey = "timeRemap";
export type EffectType =
  | "transform3d"
  | "colorGrading"
  | "hueSaturation"
  | "levels"
  | "curves"
  | "brightnessContrast"
  | "exposure"
  | "gaussianBlur"
  | "directionalBlur"
  | "fill"
  | "tint"
  | "dropShadow"
  | "glow"
  | "noiseGrain"
  | "sharpen"
  | "invert";
export type EffectPropertyKey = string;

export type Mask = {
  id: string;
  name: string;
  type: "polygon";
  path: AnimatableProperty<MaskPath>;
  feather: AnimatableProperty<number>;
  position: AnimatableProperty<Vector2>;
  scale: AnimatableProperty<Vector2>;
  inverted: boolean;
};

export type Effect = {
  id: string;
  name: string;
  type: EffectType;
  enabled: boolean;
  controls: Record<string, AnimatableProperty<number> | string | boolean>;
};

export type LayerSource = {
  text?: string;
  color?: string;
  fontSize?: number;
  fileName?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  modelUrl?: string;
  modelFormat?: "glb" | "gltf";
  cameraFov?: number;
  cameraNear?: number;
  cameraFar?: number;
  mediaOffsetFrames?: number;
  mediaDurationFrames?: number;
  timeRemap?: AnimatableProperty<number>;
  shape?: "rectangle" | "ellipse";
  width?: number;
  height?: number;
  depth?: number;
};

export type Layer = {
  id: string;
  name: string;
  type: LayerType;
  visible: boolean;
  locked: boolean;
  solo: boolean;
  motionBlur?: boolean;
  startFrame: number;
  endFrame: number;
  parentId?: string;
  blendMode: "normal";
  transform: TransformProperties;
  masks: Mask[];
  effects: Effect[];
  source?: LayerSource;
};

export type Composition = {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  backgroundColor: string;
  backgroundTransparent?: boolean;
  motionBlur?: boolean;
  layers: Layer[];
};

export type Project = {
  id: string;
  name: string;
  compositions: Composition[];
};

export type EasePreset = "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold";