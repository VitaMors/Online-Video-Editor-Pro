import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  cloneValue,
  createKeyframe,
  evaluatePathProperty,
  evaluateProperty,
  getWorldPosition,
  keyframeSort,
  upsertKeyframe,
} from "../lib/animation";
import { createComposition, createDefaultProject, createId, createLayer } from "../lib/factories";
import { clampedEffectNumberValue, createEffect, effectNumericControlKeys, isEffectNumberControl, resetEffectControls, withEffectControlDefaults } from "../lib/effects";
import type {
  AnimatableProperty,
  AnimatableValue,
  Composition,
  Effect,
  EditorTool,
  EasePreset,
  EffectPropertyKey,
  EffectType,
  GraphMode,
  Keyframe,
  Layer,
  LayerType,
  Mask,
  MaskPath,
  MaskPropertyKey,
  Project,
  SourcePropertyKey,
  TransformProperties,
  TransformPropertyKey,
} from "../types/editor";

type MaskPropertyValue<K extends MaskPropertyKey> = Mask[K] extends AnimatableProperty<infer T> ? T : never;

type ClipboardKeyframe = {
  layerId: string;
  property: TransformPropertyKey;
  keyframe: Keyframe<AnimatableValue>;
  offset: number;
};

type EditorState = {
  project: Project;
  activeCompositionId: string;
  selectedLayerIds: string[];
  selectedProperty: TransformPropertyKey;
  selectedKeyframeIds: string[];
  selectedMaskId?: string;
  selectedMaskProperty?: MaskPropertyKey;
  selectedSourceProperty?: SourcePropertyKey;
  selectedEffectId?: string;
  selectedEffectProperty?: EffectPropertyKey;
  activeTool: EditorTool;
  clipboardKeyframes: ClipboardKeyframe[];
  pastProjects: Project[];
  futureProjects: Project[];
  playheadFrame: number;
  isPlaying: boolean;
  canvasZoom: number;
  canvasPan: [number, number];
  showGrid: boolean;
  showGuides: boolean;
  timelineZoom: number;
  graphMode: GraphMode;
  setPlayheadFrame: (frame: number) => void;
  togglePlayback: () => void;
  setPlayback: (isPlaying: boolean) => void;
  setCanvasZoom: (zoom: number) => void;
  setCanvasPan: (pan: [number, number]) => void;
  toggleGrid: () => void;
  toggleGuides: () => void;
  setTimelineZoom: (zoom: number) => void;
  setGraphMode: (mode: GraphMode) => void;
  setActiveTool: (tool: EditorTool) => void;
  selectMask: (maskId?: string, property?: MaskPropertyKey) => void;
  selectTimeRemap: (layerId: string) => void;
  selectEffect: (layerId: string, effectId: string, property?: EffectPropertyKey) => void;
  newProject: () => void;
  replaceProject: (project: Project) => void;
  addComposition: (overrides?: Partial<Composition>) => void;
  importComposition: (composition: Composition) => void;
  setActiveComposition: (compositionId: string) => void;
  updateActiveCompositionSettings: (updates: Partial<Pick<Composition, "name" | "width" | "height" | "fps" | "durationFrames" | "backgroundColor" | "backgroundTransparent" | "motionBlur">>) => void;
  undo: () => void;
  redo: () => void;
  addLayer: (type: LayerType, overrides?: Partial<Layer>) => void;
  importImage: (file: File) => void;
  updateMediaLayerSize: (layerId: string, width: number, height: number, previousWidth?: number, previousHeight?: number) => void;
  updateMediaLayerDuration: (layerId: string, durationSeconds: number) => void;
  addEffect: (layerId: string, type: EffectType) => void;
  toggleEffectEnabled: (layerId: string, effectId: string) => void;
  reorderEffect: (layerId: string, effectId: string, direction: -1 | 1) => void;
  duplicateEffect: (layerId: string, effectId: string) => void;
  removeEffect: (layerId: string, effectId: string) => void;
  resetEffect: (layerId: string, effectId: string) => void;
  updateEffectNumberValue: (layerId: string, effectId: string, property: EffectPropertyKey, value: number) => void;
  updateEffectStaticValue: (layerId: string, effectId: string, property: EffectPropertyKey, value: string | boolean) => void;
  toggleEffectAnimation: (layerId: string, effectId: string, property: EffectPropertyKey) => void;
  addOrUpdateEffectKeyframe: (layerId: string, effectId: string, property: EffectPropertyKey) => void;
  moveEffectKeyframe: (layerId: string, effectId: string, property: EffectPropertyKey, keyframeId: string, frame: number) => void;
  toggleTimeRemap: (layerId: string) => void;
  updateTimeRemapValue: (layerId: string, value: number) => void;
  addOrUpdateTimeRemapKeyframe: (layerId: string) => void;
  moveTimeRemapKeyframe: (layerId: string, keyframeId: string, frame: number) => void;
  freezeTimeRemap: (layerId: string) => void;
  reverseTimeRemap: (layerId: string) => void;
  setLayerTiming: (layerId: string, startFrame: number, endFrame: number) => void;
  moveLayerTiming: (layerId: string, startFrame: number) => void;
  splitSelectedLayers: () => void;
  selectLayer: (layerId: string, additive?: boolean) => void;
  selectProperty: (property: TransformPropertyKey) => void;
  selectKeyframe: (keyframeId: string, additive?: boolean) => void;
  toggleLayerFlag: (layerId: string, flag: "visible" | "locked" | "solo" | "motionBlur") => void;
  setParentLayer: (layerId: string, parentId?: string) => void;
  renameLayer: (layerId: string, name: string) => void;
  updateTextLayer: (layerId: string, text: string) => void;
  reorderLayer: (layerId: string, targetLayerId: string, placement: "above" | "below") => void;
  addPolygonMask: (layerId: string, path: MaskPath) => void;
  updateMaskValue: <K extends MaskPropertyKey>(layerId: string, maskId: string, property: K, value: MaskPropertyValue<K>) => void;
  toggleMaskAnimation: (layerId: string, maskId: string, property: MaskPropertyKey) => void;
  addOrUpdateMaskKeyframe: (layerId: string, maskId: string, property: MaskPropertyKey) => void;
  updateTransformValue: <K extends TransformPropertyKey>(
    layerId: string,
    property: K,
    value: TransformProperties[K]["value"],
  ) => void;
  resetTransformProperty: (layerId: string, property: TransformPropertyKey) => void;
  toggleAnimation: (layerId: string, property: TransformPropertyKey) => void;
  addOrUpdateKeyframe: (layerId: string, property: TransformPropertyKey) => void;
  moveKeyframe: (
    layerId: string,
    property: TransformPropertyKey,
    keyframeId: string,
    frame: number,
  ) => void;
  moveMaskKeyframe: (
    layerId: string,
    maskId: string,
    property: MaskPropertyKey,
    keyframeId: string,
    frame: number,
  ) => void;
  updateKeyframe: (
    keyframeId: string,
    updates: Partial<Omit<Keyframe<AnimatableValue>, "id" | "value">> & {
      value?: AnimatableValue;
    },
  ) => void;
  applyEasePreset: (preset: EasePreset) => void;
  deleteSelection: () => void;
  copySelection: () => void;
  pasteKeyframes: () => void;
  previousKeyframe: () => void;
  nextKeyframe: () => void;
};

function activeComposition(state: Pick<EditorState, "project" | "activeCompositionId">) {
  return state.project.compositions.find((composition) => composition.id === state.activeCompositionId);
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function maxFrameForState(state: Pick<EditorState, "project" | "activeCompositionId">) {
  const composition = activeComposition(state);
  return Math.max(0, Math.round(finiteNumber(composition?.durationFrames, 1)) - 1);
}

function clampFrame(state: Pick<EditorState, "project" | "activeCompositionId">, frame: number) {
  return Math.round(Math.min(maxFrameForState(state), Math.max(0, frame)));
}

function openKeyframeFrame<T>(keyframes: Keyframe<T>[], keyframeId: string, frame: number, maxFrame: number) {
  const target = Math.round(Math.min(maxFrame, Math.max(0, frame)));
  const occupied = new Set(keyframes.filter((keyframe) => keyframe.id !== keyframeId).map((keyframe) => keyframe.frame));
  if (!occupied.has(target)) return target;

  const currentFrame = keyframes.find((keyframe) => keyframe.id === keyframeId)?.frame ?? target;
  const direction = target >= currentFrame ? 1 : -1;

  for (let offset = 1; offset <= maxFrame + 1; offset += 1) {
    const forward = target + offset * direction;
    if (forward >= 0 && forward <= maxFrame && !occupied.has(forward)) return forward;

    const backward = target - offset * direction;
    if (backward >= 0 && backward <= maxFrame && !occupied.has(backward)) return backward;
  }

  return currentFrame;
}

function updateActiveComposition(state: EditorState, updater: (layers: Layer[]) => Layer[]): Project {
  return {
    ...state.project,
    compositions: state.project.compositions.map((composition) =>
      composition.id === state.activeCompositionId
        ? { ...composition, layers: updater(composition.layers) }
        : composition,
    ),
  };
}

function updateLayer(
  state: EditorState,
  layerId: string,
  updater: (layer: Layer, layers: Layer[]) => Layer,
): Project {
  return updateActiveComposition(state, (layers) =>
    layers.map((layer) => (layer.id === layerId ? updater(layer, layers) : layer)),
  );
}

function updateTransformProperty(
  layer: Layer,
  property: TransformPropertyKey,
  updater: (propertyState: AnimatableProperty<AnimatableValue>) => AnimatableProperty<AnimatableValue>,
) {
  const current = layer.transform[property] as AnimatableProperty<AnimatableValue>;

  return {
    ...layer,
    transform: {
      ...layer.transform,
      [property]: updater(current),
    } as TransformProperties,
  };
}

function maskProperty<T>(value: T): AnimatableProperty<T> {
  return { value: cloneValue(value), animated: false, keyframes: [] };
}

function evaluateMaskProperty<K extends MaskPropertyKey>(mask: Mask, property: K, frame: number): MaskPropertyValue<K> {
  const propertyState = mask[property] as AnimatableProperty<MaskPropertyValue<K>>;
  if (property === "path") return evaluatePathProperty(propertyState as AnimatableProperty<MaskPath>, frame) as MaskPropertyValue<K>;
  return evaluateProperty(propertyState as AnimatableProperty<AnimatableValue>, frame) as MaskPropertyValue<K>;
}

function createPolygonMask(path: MaskPath, index: number): Mask {
  return {
    id: createId("mask"),
    name: `Mask ${index + 1}`,
    type: "polygon",
    path: maskProperty(path),
    feather: maskProperty(0),
    position: maskProperty<[number, number]>([0, 0]),
    scale: maskProperty<[number, number]>([100, 100]),
    inverted: false,
  };
}

function cloneKeyframeForLayer<T>(keyframe: Keyframe<T>): Keyframe<T> {
  return {
    ...keyframe,
    id: createId("key"),
    value: cloneValue(keyframe.value),
    velocityInComponents: keyframe.velocityInComponents ? cloneValue(keyframe.velocityInComponents) : undefined,
    velocityOutComponents: keyframe.velocityOutComponents ? cloneValue(keyframe.velocityOutComponents) : undefined,
  };
}

function cloneAnimatableProperty<T>(property: AnimatableProperty<T>): AnimatableProperty<T> {
  return {
    ...property,
    value: cloneValue(property.value),
    keyframes: property.keyframes.map((keyframe) => cloneKeyframeForLayer(keyframe)),
  };
}

function cloneTransformProperties(transform: TransformProperties): TransformProperties {
  const rotationX = transform.rotationX ?? { value: 0, animated: false, keyframes: [] };
  const rotationY = transform.rotationY ?? { value: 0, animated: false, keyframes: [] };

  return {
    position: cloneAnimatableProperty(transform.position),
    scale: cloneAnimatableProperty(transform.scale),
    rotationX: cloneAnimatableProperty(rotationX),
    rotationY: cloneAnimatableProperty(rotationY),
    rotation: cloneAnimatableProperty(transform.rotation),
    opacity: cloneAnimatableProperty(transform.opacity),
    anchorPoint: cloneAnimatableProperty(transform.anchorPoint),
  };
}

function cloneMaskForLayer(mask: Mask): Mask {
  return {
    ...mask,
    id: createId("mask"),
    path: cloneAnimatableProperty(mask.path),
    feather: cloneAnimatableProperty(mask.feather),
    position: cloneAnimatableProperty(mask.position),
    scale: cloneAnimatableProperty(mask.scale),
  };
}

function isAnimatableNumberProperty(value: unknown): value is AnimatableProperty<number> {
  return typeof value === "object" && value !== null && "value" in value && "keyframes" in value && Array.isArray((value as AnimatableProperty<number>).keyframes);
}

function cloneEffectForLayer(effect: Layer["effects"][number]): Layer["effects"][number] {
  const hydrated = withEffectControlDefaults(effect);
  const controls: Layer["effects"][number]["controls"] = {};
  Object.entries(hydrated.controls).forEach(([key, control]) => {
    controls[key] = isAnimatableNumberProperty(control) ? cloneAnimatableProperty(control) : control;
  });
  return withEffectControlDefaults({ ...hydrated, id: createId("effect"), enabled: hydrated.enabled !== false, controls });
}

function mapEffectNumberControls(
  effect: Effect,
  updater: (control: AnimatableProperty<number>, key: string) => AnimatableProperty<number>,
): Effect {
  const controls: Effect["controls"] = { ...effect.controls };
  Object.entries(effect.controls).forEach(([key, control]) => {
    if (isEffectNumberControl(control)) controls[key] = updater(control, key);
  });
  return { ...effect, controls };
}

function selectedEffectFromState(state: EditorState) {
  const layer = selectedLayer(state);
  if (!layer || !state.selectedEffectId) return undefined;
  return layer.effects.find((effect) => effect.id === state.selectedEffectId);
}

function selectedEffectControlFromState(state: EditorState) {
  const effect = selectedEffectFromState(state);
  if (!effect || !state.selectedEffectProperty) return undefined;
  const control = effect.controls[state.selectedEffectProperty];
  return isEffectNumberControl(control) ? control : undefined;
}

function selectedEffectFirstNumber(effect: Effect) {
  return effectNumericControlKeys(effect)[0];
}
function cloneLayerSegment(layer: Layer, startFrame: number, endFrame: number): Layer {
  const hasTimeRemap = Boolean(layer.source?.timeRemap);
  const mediaOffsetFrames = hasTimeRemap
    ? finiteNumber(layer.source?.mediaOffsetFrames, 0)
    : finiteNumber(layer.source?.mediaOffsetFrames, 0) + Math.max(0, startFrame - layer.startFrame);
  const timeRemap = layer.source?.timeRemap ? cloneAnimatableProperty(layer.source.timeRemap) : undefined;

  return {
    ...layer,
    id: createId("layer"),
    startFrame,
    endFrame,
    transform: cloneTransformProperties(layer.transform),
    masks: layer.masks.map(cloneMaskForLayer),
    effects: layer.effects.map(cloneEffectForLayer),
    source: layer.source ? { ...layer.source, mediaOffsetFrames, timeRemap } : undefined,
  };
}
function selectedLayer(state: EditorState) {
  return activeComposition(state)?.layers.find((layer) => layer.id === state.selectedLayerIds[0]);
}

function selectedKeyframes(state: EditorState) {
  const layer = selectedLayer(state);
  if (!layer) return [];

  const effectControl = selectedEffectControlFromState(state);
  if (effectControl) return effectControl.keyframes;

  if (state.selectedSourceProperty === "timeRemap") {
    return layer.source?.timeRemap?.keyframes ?? [];
  }

  if (state.selectedMaskId && state.selectedMaskProperty) {
    const mask = layer.masks.find((candidate) => candidate.id === state.selectedMaskId);
    return mask ? (mask[state.selectedMaskProperty].keyframes as unknown as Keyframe[]) : [];
  }

  return layer.transform[state.selectedProperty]?.keyframes ?? [];
}

function easePreset(preset: EasePreset): Partial<Keyframe<AnimatableValue>> {
  if (preset === "linear") return { interpolation: "linear", easeIn: 0, easeOut: 0 };
  if (preset === "hold") return { interpolation: "hold", easeIn: 0, easeOut: 0 };
  if (preset === "easeIn") return { interpolation: "bezier", easeIn: 70, easeOut: 15 };
  if (preset === "easeOut") return { interpolation: "bezier", easeIn: 15, easeOut: 70 };
  return { interpolation: "bezier", easeIn: 55, easeOut: 55 };
}

function defaultValue(layer: Layer, property: TransformPropertyKey): AnimatableValue {
  const isModel = layer.type === "model";
  if (property === "scale") return isModel ? [100, 100, 100] : [100, 100];
  if (property === "rotation" || property === "rotationX" || property === "rotationY") return 0;
  if (property === "opacity") return 100;
  if (property === "anchorPoint") {
    const width = (layer.source?.width ?? 320) / 2;
    const height = (layer.source?.height ?? 180) / 2;
    return isModel ? [width, height, (layer.source?.depth ?? 0) / 2] : [width, height];
  }
  return cloneValue(layer.transform.position.value);
}

function clampSourceTime(value: number, maxSeconds: number) {
  const upper = maxSeconds > 0 ? maxSeconds : Number.MAX_SAFE_INTEGER;
  return Math.min(upper, Math.max(0, finiteNumber(value, 0)));
}

function sourceDurationSeconds(layer: Layer, fps: number) {
  const safeFps = Math.max(1, Math.round(finiteNumber(fps, 30)));
  const mediaDurationFrames = finiteNumber(layer.source?.mediaDurationFrames, 0);
  if (mediaDurationFrames > 0) return mediaDurationFrames / safeFps;
  return Math.max(0, (finiteNumber(layer.endFrame, 1) - finiteNumber(layer.startFrame, 0)) / safeFps);
}

function sourceTimeAtFrame(layer: Layer, frame: number, fps: number) {
  const safeFps = Math.max(1, Math.round(finiteNumber(fps, 30)));
  const offsetFrames = Math.max(0, finiteNumber(layer.source?.mediaOffsetFrames, 0));
  const rawSeconds = (frame - finiteNumber(layer.startFrame, 0) + offsetFrames) / safeFps;
  return clampSourceTime(rawSeconds, sourceDurationSeconds(layer, safeFps));
}

function timeRemapEndFrame(layer: Layer) {
  return Math.max(Math.round(finiteNumber(layer.startFrame, 0)), Math.round(finiteNumber(layer.endFrame, 1)) - 1);
}

function timeRemapKeyframe(frame: number, value: number): Keyframe<number> {
  return {
    ...createKeyframe(createId("key"), Math.round(frame), Math.round(value * 1000) / 1000),
    interpolation: "linear",
    easeIn: 0,
    easeOut: 0,
    velocityIn: 0,
    velocityOut: 0,
  };
}

function createTimeRemapProperty(layer: Layer, fps: number): AnimatableProperty<number> {
  const startFrame = Math.round(finiteNumber(layer.startFrame, 0));
  const endFrame = timeRemapEndFrame(layer);
  const startValue = sourceTimeAtFrame(layer, startFrame, fps);
  const durationValue = sourceDurationSeconds(layer, fps);
  const fallbackEndValue = sourceTimeAtFrame(layer, endFrame, fps);
  const endValue = durationValue > 0 ? durationValue : fallbackEndValue;
  const keyframes = endFrame === startFrame
    ? [timeRemapKeyframe(startFrame, startValue)]
    : [timeRemapKeyframe(startFrame, startValue), timeRemapKeyframe(endFrame, endValue)];

  return { value: startValue, animated: true, keyframes };
}

function timeRemapValueAt(layer: Layer, frame: number, fps: number) {
  const property = layer.source?.timeRemap;
  return property ? evaluateProperty(property, frame) : sourceTimeAtFrame(layer, frame, fps);
}
function readImageDimensions(url: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      } else {
        reject(new Error("Image dimensions unavailable"));
      }
    };
    image.onerror = () => reject(new Error("Image failed to load"));
    image.src = url;
  });
}

function readVideoMetadata(url: string) {
  return new Promise<{ width: number; height: number; durationSeconds: number }>((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const durationSeconds = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        resolve({ width: video.videoWidth, height: video.videoHeight, durationSeconds });
      } else {
        reject(new Error("Video metadata unavailable"));
      }
    };
    video.onerror = () => reject(new Error("Video failed to load"));
    video.src = url;
    video.load();
  });
}

function readAudioMetadata(url: string) {
  return new Promise<{ durationSeconds: number }>((resolve, reject) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const durationSeconds = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      if (durationSeconds > 0) resolve({ durationSeconds });
      else reject(new Error("Audio duration unavailable"));
    };
    audio.onerror = () => reject(new Error("Audio failed to load"));
    audio.src = url;
    audio.load();
  });
}

function invertLegacyMixValue(value: unknown) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 100;
  return Math.min(100, Math.max(0, 100 - numeric));
}

function withProjectEffectControlDefaults(project: Project): Project {
  return {
    ...project,
    compositions: project.compositions.map((composition) => ({
      ...composition,
      layers: composition.layers.map((layer) => ({
        ...layer,
        effects: layer.effects.map(withEffectControlDefaults),
      })),
    })),
  };
}

function migrateEffectMixToBlendWithOriginal(project: Project): Project {
  return {
    ...project,
    compositions: project.compositions.map((composition) => ({
      ...composition,
      layers: composition.layers.map((layer) => ({
        ...layer,
        effects: layer.effects.map((effect) => {
          const mix = effect.controls.mix;
          if (!isEffectNumberControl(mix)) return effect;
          return {
            ...effect,
            controls: {
              ...effect.controls,
              mix: {
                ...mix,
                value: invertLegacyMixValue(mix.value),
                keyframes: mix.keyframes.map((keyframe) => ({
                  ...keyframe,
                  value: invertLegacyMixValue(keyframe.value),
                })),
              },
            },
          };
        }),
      })),
    })),
  };
}

function migratePersistedState(persistedState: unknown, version: number) {
  if (typeof persistedState !== "object" || persistedState === null) return persistedState;
  const state = persistedState as Partial<EditorState>;
  if (!state.project) return persistedState;

  let project = state.project;
  if (version < 2) project = migrateEffectMixToBlendWithOriginal(project);
  if (version < 3) project = withProjectEffectControlDefaults(project);

  return { ...state, project };
}

const defaultProject = createDefaultProject();
let lastHistoryAt = 0;
const historyMergeMs = 500;

export const useEditorStore = create<EditorState>()(
  persist(
    (baseSet, get) => {
      const set = (partial: Parameters<typeof baseSet>[0]) => baseSet((state) => {
        const nextPartial = typeof partial === "function" ? partial(state) : partial;
        if (!nextPartial || typeof nextPartial !== "object" || !("project" in nextPartial)) {
          return nextPartial as Partial<EditorState>;
        }

        const nextProject = (nextPartial as Partial<EditorState>).project;
        if (!nextProject || nextProject === state.project) return nextPartial as Partial<EditorState>;

        const now = Date.now();
        const mergeWithPrevious = now - lastHistoryAt < historyMergeMs && state.pastProjects.length > 0;
        lastHistoryAt = now;

        return {
          ...nextPartial,
          pastProjects: mergeWithPrevious ? state.pastProjects : [...state.pastProjects.slice(-79), state.project],
          futureProjects: [],
        } as Partial<EditorState>;
      });

      return ({
      project: defaultProject,
      activeCompositionId: defaultProject.compositions[0].id,
      selectedLayerIds: [defaultProject.compositions[0].layers[0].id],
      selectedProperty: "position",
      selectedKeyframeIds: [],
      selectedMaskId: undefined,
      selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
      activeTool: "select",
      clipboardKeyframes: [],
      pastProjects: [],
      futureProjects: [],
      playheadFrame: 0,
      isPlaying: false,
      canvasZoom: 0.48,
      canvasPan: [0, 0],
      showGrid: true,
      showGuides: true,
      timelineZoom: 4,
      graphMode: "value",
      setPlayheadFrame: (frame) => set((state) => ({ playheadFrame: clampFrame(state, frame) })),
      togglePlayback: () => set((state) => ({ isPlaying: !state.isPlaying })),
      setPlayback: (isPlaying) => set({ isPlaying }),
      setCanvasZoom: (zoom) => set({ canvasZoom: Math.min(3, Math.max(0.1, zoom)) }),
      setCanvasPan: (canvasPan) => set((state) => {
        const nextPan: [number, number] = [finiteNumber(canvasPan[0], 0), finiteNumber(canvasPan[1], 0)];
        if (state.canvasPan[0] === nextPan[0] && state.canvasPan[1] === nextPan[1]) return state;
        return { canvasPan: nextPan };
      }),
      toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),
      toggleGuides: () => set((state) => ({ showGuides: !state.showGuides })),
      setTimelineZoom: (timelineZoom) => set({ timelineZoom: Math.min(18, Math.max(1, finiteNumber(timelineZoom, 4))) }),
      setGraphMode: (graphMode) => set({ graphMode }),
      setActiveTool: (activeTool) => set({ activeTool }),
      selectMask: (selectedMaskId, selectedMaskProperty) =>
        set((state) => {
          const layer = selectedLayer(state);
          const mask = selectedMaskId ? layer?.masks.find((candidate) => candidate.id === selectedMaskId) : undefined;
          const propertyState = mask && selectedMaskProperty
            ? (mask[selectedMaskProperty] as AnimatableProperty<unknown>)
            : undefined;
          const keyframe = propertyState?.keyframes.find((candidate) => candidate.frame === state.playheadFrame);
          return { selectedMaskId, selectedMaskProperty, selectedSourceProperty: undefined, selectedEffectId: undefined, selectedEffectProperty: undefined, selectedKeyframeIds: keyframe ? [keyframe.id] : [] };
        }),
      selectTimeRemap: (layerId) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          const property = layer?.source?.timeRemap;
          const keyframe = property?.keyframes.find((candidate) => candidate.frame === state.playheadFrame);
          if (!layer || layer.type !== "video" || !property) return {};
          return {
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: "timeRemap",
            selectedEffectId: undefined,
            selectedEffectProperty: undefined,
            selectedKeyframeIds: keyframe ? [keyframe.id] : [],
          };
        }),
      selectEffect: (layerId, effectId, selectedEffectProperty) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          const effect = layer?.effects.find((candidate) => candidate.id === effectId);
          if (!layer || !effect) return {};
          const property = selectedEffectProperty ?? selectedEffectFirstNumber(effect);
          const control = property ? effect.controls[property] : undefined;
          const keyframe = isEffectNumberControl(control)
            ? control.keyframes.find((candidate) => candidate.frame === state.playheadFrame)
            : undefined;
          return {
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: undefined,
            selectedEffectId: effectId,
            selectedEffectProperty: property,
            selectedKeyframeIds: keyframe ? [keyframe.id] : [],
          };
        }),
      newProject: () => {
        lastHistoryAt = 0;
        const project = createDefaultProject();
        const composition = project.compositions[0];
        baseSet({
          project,
          activeCompositionId: composition.id,
          selectedLayerIds: composition.layers[0] ? [composition.layers[0].id] : [],
          selectedProperty: "position",
          selectedKeyframeIds: [],
          selectedMaskId: undefined,
          selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          pastProjects: [],
          futureProjects: [],
          playheadFrame: 0,
        });
      },
      replaceProject: (project) => {
        lastHistoryAt = 0;
        const nextProject = withProjectEffectControlDefaults(project.compositions.length > 0 ? project : createDefaultProject());
        const composition = nextProject.compositions[0];
        baseSet({
          project: nextProject,
          activeCompositionId: composition.id,
          selectedLayerIds: composition.layers[0] ? [composition.layers[0].id] : [],
          selectedProperty: "position",
          selectedKeyframeIds: [],
          selectedMaskId: undefined,
          selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          pastProjects: [],
          futureProjects: [],
          playheadFrame: 0,
        });
      },
      addComposition: (overrides) =>
        set((state) => {
          const composition = createComposition({ name: `Composition ${state.project.compositions.length + 1}`, ...overrides });
          return {
            project: withProjectEffectControlDefaults({ ...state.project, compositions: [...state.project.compositions, composition] }),
            activeCompositionId: composition.id,
            selectedLayerIds: composition.layers[0] ? [composition.layers[0].id] : [],
            selectedProperty: "position",
            selectedKeyframeIds: [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          playheadFrame: 0,
          };
        }),
      importComposition: (composition) =>
        set((state) => {
          const nextComposition = { ...composition, id: createId("comp"), name: composition.name || `Composition ${state.project.compositions.length + 1}` };
          return {
            project: withProjectEffectControlDefaults({ ...state.project, compositions: [...state.project.compositions, nextComposition] }),
            activeCompositionId: nextComposition.id,
            selectedLayerIds: nextComposition.layers[0] ? [nextComposition.layers[0].id] : [],
            selectedProperty: "position",
            selectedKeyframeIds: [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          playheadFrame: 0,
          };
        }),
      setActiveComposition: (activeCompositionId) =>
        set((state) => {
          const composition = state.project.compositions.find((candidate) => candidate.id === activeCompositionId);
          if (!composition) return {};
          return {
            activeCompositionId,
            selectedLayerIds: composition.layers[0] ? [composition.layers[0].id] : [],
            selectedProperty: "position",
            selectedKeyframeIds: [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          playheadFrame: 0,
          };
        }),
      updateActiveCompositionSettings: (updates) =>
        set((state) => {
          const composition = activeComposition(state);
          if (!composition) return {};
          const width = Math.max(1, Math.round(finiteNumber(updates.width, finiteNumber(composition.width, 1920))));
          const height = Math.max(1, Math.round(finiteNumber(updates.height, finiteNumber(composition.height, 1080))));
          const fps = Math.max(1, Math.round(finiteNumber(updates.fps, finiteNumber(composition.fps, 30))));
          const durationFrames = Math.max(1, Math.round(finiteNumber(updates.durationFrames, finiteNumber(composition.durationFrames, 300))));
          const layers = composition.layers.map((layer) => {
            const currentStartFrame = finiteNumber(layer.startFrame, 0);
            const currentEndFrame = finiteNumber(layer.endFrame, durationFrames);
            const startFrame = Math.min(currentStartFrame, Math.max(0, durationFrames - 1));
            const endFrame = Math.min(Math.max(startFrame + 1, currentEndFrame), durationFrames);
            return { ...layer, startFrame, endFrame };
          });
          const nextComposition = {
            ...composition,
            ...updates,
            width,
            height,
            fps,
            durationFrames,
            backgroundColor: updates.backgroundColor ?? composition.backgroundColor,
            backgroundTransparent: updates.backgroundTransparent ?? composition.backgroundTransparent ?? false,
            layers,
          };

          return {
            project: {
              ...state.project,
              compositions: state.project.compositions.map((candidate) => candidate.id === composition.id ? nextComposition : candidate),
            },
            playheadFrame: Math.min(clampFrame(state, state.playheadFrame), durationFrames - 1),
          };
        }),
      undo: () => {
        lastHistoryAt = 0;
        baseSet((state) => {
          const previousProject = state.pastProjects[state.pastProjects.length - 1];
          if (!previousProject) return {};

          return {
            project: previousProject,
            pastProjects: state.pastProjects.slice(0, -1),
            futureProjects: [state.project, ...state.futureProjects].slice(0, 80),
            selectedKeyframeIds: [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          };
        });
      },
      redo: () => {
        lastHistoryAt = 0;
        baseSet((state) => {
          const nextProject = state.futureProjects[0];
          if (!nextProject) return {};

          return {
            project: nextProject,
            pastProjects: [...state.pastProjects.slice(-79), state.project],
            futureProjects: state.futureProjects.slice(1),
            selectedKeyframeIds: [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          };
        });
      },
      addLayer: (type, overrides) =>
        set((state) => {
          const composition = activeComposition(state);
          if (!composition) return {};
          const layer = createLayer(type, composition, overrides);
          return {
            project: updateActiveComposition(state, (layers) => [layer, ...layers]),
            selectedLayerIds: [layer.id],
            selectedProperty: "position",
            selectedKeyframeIds: [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          };
        }),
      importImage: (file) => {
        const mediaUrl = URL.createObjectURL(file);
        const name = file.name.replace(/\.[^.]+$/, "") || "Imported Media";
        const isVideo = file.type.startsWith("video/") || /\.mp4$/i.test(file.name);
        const isAudio = file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
        const isModel = /\.(glb|gltf)$/i.test(file.name) || file.type === "model/gltf-binary" || file.type === "model/gltf+json";
        const type = isModel ? "model" : isAudio ? "audio" : isVideo ? "video" : "image";
        const fallbackWidth = isAudio ? 520 : isModel ? 420 : 640;
        const fallbackHeight = isAudio ? 80 : isModel ? 420 : 360;
        let importedLayerId: string | undefined;

        set((state) => {
          const composition = activeComposition(state);
          if (!composition) return {};

          const layer = createLayer(type, composition, {
            name,
            source: isModel
              ? { fileName: file.name, modelUrl: mediaUrl, modelFormat: /\.gltf$/i.test(file.name) ? "gltf" : "glb", width: fallbackWidth, height: fallbackHeight, depth: fallbackWidth }
              : isAudio
                ? { fileName: file.name, audioUrl: mediaUrl, width: fallbackWidth, height: fallbackHeight }
                : isVideo
                  ? { fileName: file.name, videoUrl: mediaUrl, width: fallbackWidth, height: fallbackHeight }
                  : { fileName: file.name, imageUrl: mediaUrl, width: fallbackWidth, height: fallbackHeight },
          });
          importedLayerId = layer.id;

          return {
            project: updateActiveComposition(state, (layers) => [layer, ...layers]),
            selectedLayerIds: [layer.id],
            selectedProperty: "position",
            selectedKeyframeIds: [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          };
        });

        if (!importedLayerId) return;

        const layerId = importedLayerId;
        if (isModel) return;

        if (isAudio) {
          readAudioMetadata(mediaUrl)
            .then(({ durationSeconds }) => get().updateMediaLayerDuration(layerId, durationSeconds))
            .catch(() => undefined);
          return;
        }

        if (isVideo) {
          readVideoMetadata(mediaUrl)
            .then(({ width, height, durationSeconds }) => {
              get().updateMediaLayerSize(layerId, width, height, fallbackWidth, fallbackHeight);
              get().updateMediaLayerDuration(layerId, durationSeconds);
            })
            .catch(() => undefined);
          return;
        }

        readImageDimensions(mediaUrl)
          .then(({ width, height }) => get().updateMediaLayerSize(layerId, width, height, fallbackWidth, fallbackHeight))
          .catch(() => undefined);
      },
      updateMediaLayerSize: (layerId, width, height, previousWidth, previousHeight) =>
        baseSet((state) => {
          const safeWidth = Math.max(1, Math.round(width));
          const safeHeight = Math.max(1, Math.round(height));
          const composition = activeComposition(state);
          const currentLayer = composition?.layers.find((layer) => layer.id === layerId);
          if (!currentLayer || (currentLayer.source?.width === safeWidth && currentLayer.source?.height === safeHeight)) return {};

          return {
            project: updateLayer(state, layerId, (layer) => {
              const oldWidth = previousWidth ?? layer.source?.width ?? 320;
              const oldHeight = previousHeight ?? layer.source?.height ?? 180;
              const oldAnchor: [number, number] = [oldWidth / 2, oldHeight / 2];
              const anchorPoint = layer.transform.anchorPoint;
              const currentAnchor = anchorPoint.value;
              const nextAnchor = (currentAnchor.length >= 3 ? [safeWidth / 2, safeHeight / 2, currentAnchor[2] ?? 0] : [safeWidth / 2, safeHeight / 2]) as typeof currentAnchor;
              const shouldRecenterAnchor =
                !anchorPoint.animated &&
                Math.abs(currentAnchor[0] - oldAnchor[0]) < 0.01 &&
                Math.abs(currentAnchor[1] - oldAnchor[1]) < 0.01;

              return {
                ...layer,
                source: { ...layer.source, width: safeWidth, height: safeHeight },
                transform: shouldRecenterAnchor
                  ? { ...layer.transform, anchorPoint: { ...anchorPoint, value: nextAnchor } }
                  : layer.transform,
              };
            }),
          };
        }),
      updateMediaLayerDuration: (layerId, durationSeconds) =>
        baseSet((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          if (!composition || !layer || (layer.type !== "video" && layer.type !== "audio")) return {};
          const safeFps = Math.max(1, Math.round(finiteNumber(composition.fps, 30)));
          const durationFrames = Math.max(1, Math.ceil(finiteNumber(durationSeconds, 0) * safeFps));
          const endFrame = layer.startFrame + durationFrames;
          if (layer.endFrame === endFrame && layer.source?.mediaDurationFrames === durationFrames) return {};

          return {
            project: updateLayer(state, layerId, (currentLayer) => ({
              ...currentLayer,
              endFrame,
              source: { ...currentLayer.source, mediaDurationFrames: durationFrames },
            })),
          };
        }),
      addEffect: (layerId, type) =>
        set((state) => {
          const effect = createEffect(type);
          return {
            project: updateLayer(state, layerId, (layer) => ({
              ...layer,
              effects: [...layer.effects, effect],
            })),
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: undefined,
            selectedEffectId: effect.id,
            selectedEffectProperty: selectedEffectFirstNumber(effect),
            selectedKeyframeIds: [],
          };
        }),
      toggleEffectEnabled: (layerId, effectId) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) => ({
            ...layer,
            effects: layer.effects.map((effect) => effect.id === effectId ? { ...effect, enabled: effect.enabled === false } : effect),
          })),
          selectedLayerIds: [layerId],
          selectedEffectId: effectId,
        })),
      reorderEffect: (layerId, effectId, direction) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) => {
            const index = layer.effects.findIndex((effect) => effect.id === effectId);
            const targetIndex = index + direction;
            if (index < 0 || targetIndex < 0 || targetIndex >= layer.effects.length) return layer;
            const effects = [...layer.effects];
            const [effect] = effects.splice(index, 1);
            effects.splice(targetIndex, 0, effect);
            return { ...layer, effects };
          }),
          selectedLayerIds: [layerId],
          selectedEffectId: effectId,
        })),
      duplicateEffect: (layerId, effectId) =>
        set((state) => {
          let duplicatedEffectId: string | undefined;
          let selectedEffectProperty: EffectPropertyKey | undefined;
          return {
            project: updateLayer(state, layerId, (layer) => {
              const index = layer.effects.findIndex((effect) => effect.id === effectId);
              if (index < 0) return layer;
              const duplicate = cloneEffectForLayer(layer.effects[index]);
              duplicatedEffectId = duplicate.id;
              selectedEffectProperty = selectedEffectFirstNumber(duplicate);
              const effects = [...layer.effects];
              effects.splice(index + 1, 0, duplicate);
              return { ...layer, effects };
            }),
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: undefined,
            selectedEffectId: duplicatedEffectId,
            selectedEffectProperty,
            selectedKeyframeIds: [],
          };
        }),
      removeEffect: (layerId, effectId) =>
        set((state) => {
          let nextEffectId: string | undefined;
          let nextEffectProperty: EffectPropertyKey | undefined;
          return {
            project: updateLayer(state, layerId, (layer) => {
              const index = layer.effects.findIndex((effect) => effect.id === effectId);
              if (index < 0) return layer;
              const effects = layer.effects.filter((effect) => effect.id !== effectId);
              const nextEffect = effects[Math.min(index, effects.length - 1)];
              nextEffectId = nextEffect?.id;
              nextEffectProperty = nextEffect ? selectedEffectFirstNumber(nextEffect) : undefined;
              return { ...layer, effects };
            }),
            selectedLayerIds: [layerId],
            selectedEffectId: nextEffectId,
            selectedEffectProperty: nextEffectProperty,
            selectedKeyframeIds: [],
          };
        }),
      resetEffect: (layerId, effectId) =>
        set((state) => {
          let selectedEffectProperty: EffectPropertyKey | undefined;
          return {
            project: updateLayer(state, layerId, (layer) => ({
              ...layer,
              effects: layer.effects.map((effect) => {
                if (effect.id !== effectId) return effect;
                const reset = resetEffectControls(effect);
                selectedEffectProperty = selectedEffectFirstNumber(reset);
                return reset;
              }),
            })),
            selectedLayerIds: [layerId],
            selectedEffectId: effectId,
            selectedEffectProperty,
            selectedKeyframeIds: [],
          };
        }),
      updateEffectNumberValue: (layerId, effectId, property, value) =>
        set((state) => {
          let selectedKeyframeId: string | undefined;
          return {
            project: updateLayer(state, layerId, (layer) => ({
              ...layer,
              effects: layer.effects.map((effect) => {
                if (effect.id !== effectId) return effect;
                const hydrated = withEffectControlDefaults(effect);
                const control = hydrated.controls[property];
                if (!isEffectNumberControl(control)) return hydrated;
                const nextValue = clampedEffectNumberValue(hydrated, property, value);
                const nextControl = control.animated
                  ? upsertKeyframe(control, state.playheadFrame, nextValue, () => createId("key"))
                  : { ...control, value: nextValue };
                if (control.animated) selectedKeyframeId = nextControl.keyframes.find((keyframe) => keyframe.frame === state.playheadFrame)?.id;
                return { ...hydrated, controls: { ...hydrated.controls, [property]: nextControl } };
              }),
            })),
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: undefined,
            selectedEffectId: effectId,
            selectedEffectProperty: property,
            selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
          };
        }),
      updateEffectStaticValue: (layerId, effectId, property, value) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) => ({
            ...layer,
            effects: layer.effects.map((effect) => effect.id === effectId
              ? (() => {
                const hydrated = withEffectControlDefaults(effect);
                return { ...hydrated, controls: { ...hydrated.controls, [property]: value } };
              })()
              : effect),
          })),
          selectedLayerIds: [layerId],
          selectedEffectId: effectId,
          selectedEffectProperty: property,
        })),
      toggleEffectAnimation: (layerId, effectId, property) =>
        set((state) => {
          let selectedKeyframeId: string | undefined;
          return {
            project: updateLayer(state, layerId, (layer) => ({
              ...layer,
              effects: layer.effects.map((effect) => {
                if (effect.id !== effectId) return effect;
                const hydrated = withEffectControlDefaults(effect);
                const control = hydrated.controls[property];
                if (!isEffectNumberControl(control)) return hydrated;
                const value = evaluateProperty(control, state.playheadFrame);
                const nextControl = control.animated
                  ? { ...control, animated: false, value }
                  : upsertKeyframe(control, state.playheadFrame, value, () => createId("key"));
                if (!control.animated) selectedKeyframeId = nextControl.keyframes.find((keyframe) => keyframe.frame === state.playheadFrame)?.id;
                return { ...hydrated, controls: { ...hydrated.controls, [property]: nextControl } };
              }),
            })),
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: undefined,
            selectedEffectId: effectId,
            selectedEffectProperty: property,
            selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
          };
        }),
      addOrUpdateEffectKeyframe: (layerId, effectId, property) =>
        set((state) => {
          let selectedKeyframeId: string | undefined;
          return {
            project: updateLayer(state, layerId, (layer) => ({
              ...layer,
              effects: layer.effects.map((effect) => {
                if (effect.id !== effectId) return effect;
                const hydrated = withEffectControlDefaults(effect);
                const control = hydrated.controls[property];
                if (!isEffectNumberControl(control)) return hydrated;
                const value = evaluateProperty(control, state.playheadFrame);
                const nextControl = upsertKeyframe(control, state.playheadFrame, value, () => createId("key"));
                selectedKeyframeId = nextControl.keyframes.find((keyframe) => keyframe.frame === state.playheadFrame)?.id;
                return { ...hydrated, controls: { ...hydrated.controls, [property]: nextControl } };
              }),
            })),
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: undefined,
            selectedEffectId: effectId,
            selectedEffectProperty: property,
            selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
          };
        }),
      moveEffectKeyframe: (layerId, effectId, property, keyframeId, frame) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) => ({
            ...layer,
            effects: layer.effects.map((effect) => {
              if (effect.id !== effectId) return effect;
              const hydrated = withEffectControlDefaults(effect);
              const control = hydrated.controls[property];
              if (!isEffectNumberControl(control)) return hydrated;
              const nextFrame = openKeyframeFrame(control.keyframes, keyframeId, frame, maxFrameForState(state));
              return {
                ...hydrated,
                controls: {
                  ...hydrated.controls,
                  [property]: {
                    ...control,
                    keyframes: control.keyframes
                      .map((keyframe) => keyframe.id === keyframeId ? { ...keyframe, frame: nextFrame } : keyframe)
                      .sort(keyframeSort),
                  },
                },
              };
            }),
          })),
        })),
      toggleTimeRemap: (layerId) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          if (!composition || !layer || layer.type !== "video") return {};
          const fps = Math.max(1, Math.round(finiteNumber(composition.fps, 30)));
          let selectedKeyframeIds: string[] = [];
          let selectedSourceProperty: SourcePropertyKey | undefined = "timeRemap";

          const project = updateLayer(state, layerId, (currentLayer) => {
            if (currentLayer.type !== "video") return currentLayer;
            if (currentLayer.source?.timeRemap) {
              const { timeRemap: _timeRemap, ...source } = currentLayer.source;
              selectedSourceProperty = undefined;
              return { ...currentLayer, source };
            }

            const timeRemap = createTimeRemapProperty(currentLayer, fps);
            selectedKeyframeIds = timeRemap.keyframes
              .filter((keyframe) => keyframe.frame === state.playheadFrame)
              .map((keyframe) => keyframe.id);
            return { ...currentLayer, source: { ...currentLayer.source, timeRemap } };
          });

          return {
            project,
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty,
            selectedEffectId: undefined,
            selectedEffectProperty: undefined,
            selectedKeyframeIds,
          };
        }),
      updateTimeRemapValue: (layerId, value) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          if (!composition || !layer || layer.type !== "video") return {};
          const fps = Math.max(1, Math.round(finiteNumber(composition.fps, 30)));
          let selectedKeyframeId: string | undefined;

          return {
            project: updateLayer(state, layerId, (currentLayer) => {
              if (currentLayer.type !== "video") return currentLayer;
              const baseProperty = currentLayer.source?.timeRemap ?? createTimeRemapProperty(currentLayer, fps);
              const nextValue = Math.round(clampSourceTime(value, sourceDurationSeconds(currentLayer, fps)) * 1000) / 1000;
              const nextProperty = baseProperty.animated
                ? upsertKeyframe(baseProperty, state.playheadFrame, nextValue, () => createId("key"))
                : { ...baseProperty, value: nextValue };
              selectedKeyframeId = nextProperty.keyframes.find((keyframe) => keyframe.frame === state.playheadFrame)?.id;
              return { ...currentLayer, source: { ...currentLayer.source, timeRemap: nextProperty } };
            }),
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: "timeRemap",
            selectedEffectId: undefined,
            selectedEffectProperty: undefined,
            selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
          };
        }),
      addOrUpdateTimeRemapKeyframe: (layerId) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          if (!composition || !layer || layer.type !== "video") return {};
          const fps = Math.max(1, Math.round(finiteNumber(composition.fps, 30)));
          let selectedKeyframeId: string | undefined;

          return {
            project: updateLayer(state, layerId, (currentLayer) => {
              if (currentLayer.type !== "video") return currentLayer;
              const baseProperty = currentLayer.source?.timeRemap ?? createTimeRemapProperty(currentLayer, fps);
              const value = Math.round(timeRemapValueAt({ ...currentLayer, source: { ...currentLayer.source, timeRemap: baseProperty } }, state.playheadFrame, fps) * 1000) / 1000;
              const nextProperty = upsertKeyframe(baseProperty, state.playheadFrame, value, () => createId("key"));
              selectedKeyframeId = nextProperty.keyframes.find((keyframe) => keyframe.frame === state.playheadFrame)?.id;
              return { ...currentLayer, source: { ...currentLayer.source, timeRemap: nextProperty } };
            }),
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: "timeRemap",
            selectedEffectId: undefined,
            selectedEffectProperty: undefined,
            selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
          };
        }),
      moveTimeRemapKeyframe: (layerId, keyframeId, frame) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) => {
            const property = layer.source?.timeRemap;
            if (!property) return layer;
            const nextFrame = openKeyframeFrame(property.keyframes, keyframeId, frame, maxFrameForState(state));
            return {
              ...layer,
              source: {
                ...layer.source,
                timeRemap: {
                  ...property,
                  keyframes: property.keyframes
                    .map((keyframe) => keyframe.id === keyframeId ? { ...keyframe, frame: nextFrame } : keyframe)
                    .sort((a, b) => a.frame - b.frame),
                },
              },
            };
          }),
        })),
      freezeTimeRemap: (layerId) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          if (!composition || !layer || layer.type !== "video") return {};
          const fps = Math.max(1, Math.round(finiteNumber(composition.fps, 30)));
          const freezeFrame = clampFrame(state, state.playheadFrame);
          let selectedKeyframeId: string | undefined;

          return {
            project: updateLayer(state, layerId, (currentLayer) => {
              const baseProperty = currentLayer.source?.timeRemap ?? createTimeRemapProperty(currentLayer, fps);
              const currentValue = Math.round(timeRemapValueAt({ ...currentLayer, source: { ...currentLayer.source, timeRemap: baseProperty } }, freezeFrame, fps) * 1000) / 1000;
              const endFrame = timeRemapEndFrame(currentLayer);
              const preservedKeyframes = baseProperty.keyframes.filter((keyframe) => keyframe.frame < freezeFrame || keyframe.frame > endFrame);
              const freezeKey = { ...timeRemapKeyframe(freezeFrame, currentValue), interpolation: "hold" as const };
              const endKey = endFrame === freezeFrame ? undefined : { ...timeRemapKeyframe(endFrame, currentValue), interpolation: "hold" as const };
              const keyframes = [...preservedKeyframes, freezeKey, ...(endKey ? [endKey] : [])].sort(keyframeSort);
              selectedKeyframeId = freezeKey.id;
              return { ...currentLayer, source: { ...currentLayer.source, timeRemap: { ...baseProperty, animated: true, value: currentValue, keyframes } } };
            }),
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: "timeRemap",
            selectedEffectId: undefined,
            selectedEffectProperty: undefined,
            selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
          };
        }),
      reverseTimeRemap: (layerId) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          if (!composition || !layer || layer.type !== "video") return {};
          const fps = Math.max(1, Math.round(finiteNumber(composition.fps, 30)));

          return {
            project: updateLayer(state, layerId, (currentLayer) => {
              const baseProperty = currentLayer.source?.timeRemap ?? createTimeRemapProperty(currentLayer, fps);
              const startFrame = Math.round(finiteNumber(currentLayer.startFrame, 0));
              const endFrame = timeRemapEndFrame(currentLayer);
              const startValue = timeRemapValueAt({ ...currentLayer, source: { ...currentLayer.source, timeRemap: baseProperty } }, startFrame, fps);
              const endValue = timeRemapValueAt({ ...currentLayer, source: { ...currentLayer.source, timeRemap: baseProperty } }, endFrame, fps);
              const sum = startValue + endValue;
              const duration = sourceDurationSeconds(currentLayer, fps);
              const keyframes = baseProperty.keyframes.map((keyframe) => (
                keyframe.frame >= startFrame && keyframe.frame <= endFrame
                  ? { ...keyframe, value: Math.round(clampSourceTime(sum - keyframe.value, duration) * 1000) / 1000 }
                  : keyframe
              )).sort(keyframeSort);
              return { ...currentLayer, source: { ...currentLayer.source, timeRemap: { ...baseProperty, animated: true, keyframes } } };
            }),
            selectedLayerIds: [layerId],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
            selectedSourceProperty: "timeRemap",
            selectedEffectId: undefined,
            selectedEffectProperty: undefined,
            selectedKeyframeIds: [],
          };
        }),      setLayerTiming: (layerId, startFrame, endFrame) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          if (!composition || !layer || layer.locked) return {};

          const durationFrames = Math.max(1, Math.round(finiteNumber(composition.durationFrames, 300)));
          const currentStart = Math.max(0, Math.round(finiteNumber(layer.startFrame, 0)));
          const currentEnd = Math.min(durationFrames, Math.max(currentStart + 1, Math.round(finiteNumber(layer.endFrame, durationFrames))));
          const proposedStart = Math.max(0, Math.round(finiteNumber(startFrame, currentStart)));
          const proposedEnd = Math.max(1, Math.round(finiteNumber(endFrame, currentEnd)));
          const nextStart = Math.min(Math.max(0, proposedStart), Math.max(0, durationFrames - 1));
          const nextEnd = Math.min(durationFrames, Math.max(nextStart + 1, proposedEnd));
          const safeStart = Math.min(nextStart, nextEnd - 1);

          if (safeStart === currentStart && nextEnd === currentEnd) return {};

          return {
            project: updateLayer(state, layerId, (currentLayer) => {
              const startDelta = safeStart - currentStart;
              const shouldOffsetMedia = startDelta !== 0 && (currentLayer.type === "video" || currentLayer.type === "audio") && !currentLayer.source?.timeRemap;
              const source = shouldOffsetMedia && currentLayer.source
                ? {
                    ...currentLayer.source,
                    mediaOffsetFrames: Math.max(0, finiteNumber(currentLayer.source.mediaOffsetFrames, 0) + startDelta),
                  }
                : currentLayer.source;

              return { ...currentLayer, startFrame: safeStart, endFrame: nextEnd, source };
            }),
          };
        }),
      moveLayerTiming: (layerId, startFrame) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          if (!composition || !layer || layer.locked) return {};

          const durationFrames = Math.max(1, Math.round(finiteNumber(composition.durationFrames, 300)));
          const currentStart = Math.max(0, Math.round(finiteNumber(layer.startFrame, 0)));
          const currentEnd = Math.min(durationFrames, Math.max(currentStart + 1, Math.round(finiteNumber(layer.endFrame, durationFrames))));
          const layerDuration = Math.max(1, currentEnd - currentStart);
          const maxStart = Math.max(0, durationFrames - layerDuration);
          const nextStart = Math.min(maxStart, Math.max(0, Math.round(finiteNumber(startFrame, currentStart))));
          const nextEnd = Math.min(durationFrames, nextStart + layerDuration);

          if (nextStart === currentStart && nextEnd === currentEnd) return {};

          return {
            project: updateLayer(state, layerId, (currentLayer) => ({
              ...currentLayer,
              startFrame: nextStart,
              endFrame: nextEnd,
            })),
          };
        }),      splitSelectedLayers: () =>
        set((state) => {
          const composition = activeComposition(state);
          if (!composition || state.selectedLayerIds.length === 0) return {};

          const splitFrame = clampFrame(state, state.playheadFrame);
          const selectedIds = new Set(state.selectedLayerIds);
          const rightLayerIds: string[] = [];
          const hasSplittableLayer = composition.layers.some((layer) =>
            selectedIds.has(layer.id) && !layer.locked && splitFrame > layer.startFrame && splitFrame < layer.endFrame,
          );

          if (!hasSplittableLayer) return {};

          return {
            project: updateActiveComposition(state, (layers) => layers.flatMap((layer) => {
              if (!selectedIds.has(layer.id) || layer.locked || splitFrame <= layer.startFrame || splitFrame >= layer.endFrame) {
                return [layer];
              }

              const leftLayer: Layer = { ...layer, endFrame: splitFrame };
              const rightLayer = cloneLayerSegment(layer, splitFrame, layer.endFrame);
              rightLayerIds.push(rightLayer.id);
              return [rightLayer, leftLayer];
            })),
            selectedLayerIds: rightLayerIds,
            selectedKeyframeIds: [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          };
        }),
      selectLayer: (layerId, additive) =>
        set((state) => ({
          selectedLayerIds: additive
            ? state.selectedLayerIds.includes(layerId)
              ? state.selectedLayerIds.filter((id) => id !== layerId)
              : [...state.selectedLayerIds, layerId]
            : [layerId],
          selectedKeyframeIds: [],
          selectedMaskId: additive ? state.selectedMaskId : undefined,
          selectedMaskProperty: additive ? state.selectedMaskProperty : undefined,
        })),
      selectProperty: (selectedProperty) =>
        set((state) => {
          const layer = selectedLayer(state);
          const keyframe = layer?.transform[selectedProperty].keyframes.find((candidate) => candidate.frame === state.playheadFrame);
          return {
            selectedProperty,
            selectedKeyframeIds: keyframe ? [keyframe.id] : [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          };
        }),
      selectKeyframe: (keyframeId, additive) =>
        set((state) => ({
          selectedKeyframeIds: additive
            ? state.selectedKeyframeIds.includes(keyframeId)
              ? state.selectedKeyframeIds.filter((id) => id !== keyframeId)
              : [...state.selectedKeyframeIds, keyframeId]
            : [keyframeId],
        })),
      toggleLayerFlag: (layerId, flag) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) => ({ ...layer, [flag]: flag === "visible" ? layer.visible === false : !layer[flag] })),
        })),
      setParentLayer: (layerId, parentId) =>
        set((state) => {
          const composition = activeComposition(state);
          const layer = composition?.layers.find((candidate) => candidate.id === layerId);
          if (!composition || !layer || layer.id === parentId) return {};
          const world = getWorldPosition(composition, layer, state.playheadFrame);
          const parent = parentId ? composition.layers.find((candidate) => candidate.id === parentId) : undefined;
          const parentWorld = parent ? getWorldPosition(composition, parent, state.playheadFrame) : [0, 0];
          const local: [number, number] = [world[0] - parentWorld[0], world[1] - parentWorld[1]];
          return {
            project: updateLayer(state, layerId, (current) =>
              updateTransformProperty({ ...current, parentId }, "position", (property) => ({
                ...property,
                value: local,
              })),
            ),
          };
        }),
      renameLayer: (layerId, name) =>
        set((state) => ({ project: updateLayer(state, layerId, (layer) => ({ ...layer, name })) })),
      updateTextLayer: (layerId, text) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) => (
            layer.type === "text"
              ? { ...layer, source: { ...layer.source, text } }
              : layer
          )),
        })),
      reorderLayer: (layerId, targetLayerId, placement) =>
        set((state) => {
          if (layerId === targetLayerId) return {};

          return {
            project: updateActiveComposition(state, (layers) => {
              const sourceIndex = layers.findIndex((layer) => layer.id === layerId);
              const targetIndex = layers.findIndex((layer) => layer.id === targetLayerId);

              if (sourceIndex < 0 || targetIndex < 0) return layers;

              const nextLayers = [...layers];
              const [movedLayer] = nextLayers.splice(sourceIndex, 1);
              const nextTargetIndex = nextLayers.findIndex((layer) => layer.id === targetLayerId);
              const insertionIndex = placement === "above" ? nextTargetIndex : nextTargetIndex + 1;

              nextLayers.splice(insertionIndex, 0, movedLayer);
              return nextLayers;
            }),
          };
        }),
      addPolygonMask: (layerId, path) =>
        set((state) => {
          let createdMaskId: string | undefined;

          return {
            project: updateLayer(state, layerId, (layer) => {
              const mask = createPolygonMask(path, layer.masks.length);
              createdMaskId = mask.id;
              return { ...layer, masks: [...layer.masks, mask] };
            }),
            selectedLayerIds: [layerId],
            selectedMaskId: createdMaskId,
            selectedMaskProperty: "path",
          };
        }),
      updateMaskValue: (layerId, maskId, property, value) =>
        set((state) => {
          let selectedKeyframeId: string | undefined;

          return {
            project: updateLayer(state, layerId, (layer) => ({
              ...layer,
              masks: layer.masks.map((mask) => {
                if (mask.id !== maskId) return mask;
                const propertyState = mask[property] as AnimatableProperty<typeof value>;
                const nextValue = cloneValue(property === "feather" ? Math.max(0, value as number) : value);
                const nextProperty = propertyState.animated
                  ? upsertKeyframe(propertyState, state.playheadFrame, nextValue, () => createId("key"))
                  : { ...propertyState, value: nextValue };

                if (propertyState.animated) {
                  selectedKeyframeId = nextProperty.keyframes.find((keyframe) => keyframe.frame === state.playheadFrame)?.id;
                }

                return { ...mask, [property]: nextProperty } as Mask;
              }),
            })),
            selectedMaskId: maskId,
            selectedMaskProperty: property,
            selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
          };
        }),
      toggleMaskAnimation: (layerId, maskId, property) =>
        set((state) => {
          let selectedKeyframeId: string | undefined;

          return {
            project: updateLayer(state, layerId, (layer) => ({
              ...layer,
              masks: layer.masks.map((mask) => {
                if (mask.id !== maskId) return mask;
                const propertyState = mask[property] as AnimatableProperty<MaskPropertyValue<typeof property>>;
                const value = evaluateMaskProperty(mask, property, state.playheadFrame);
                const nextProperty = propertyState.animated
                  ? { ...propertyState, animated: false, value: cloneValue(value) }
                  : upsertKeyframe(propertyState, state.playheadFrame, value, () => createId("key"));

                if (!propertyState.animated) {
                  selectedKeyframeId = nextProperty.keyframes.find((keyframe) => keyframe.frame === state.playheadFrame)?.id;
                }

                return { ...mask, [property]: nextProperty } as Mask;
              }),
            })),
            selectedMaskId: maskId,
            selectedMaskProperty: property,
            selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
          };
        }),
      addOrUpdateMaskKeyframe: (layerId, maskId, property) =>
        set((state) => {
          let selectedKeyframeId: string | undefined;

          return {
            project: updateLayer(state, layerId, (layer) => ({
              ...layer,
              masks: layer.masks.map((mask) => {
                if (mask.id !== maskId) return mask;
                const propertyState = mask[property] as AnimatableProperty<MaskPropertyValue<typeof property>>;
                const value = evaluateMaskProperty(mask, property, state.playheadFrame);
                const nextProperty = upsertKeyframe(propertyState, state.playheadFrame, value, () => createId("key"));
                selectedKeyframeId = nextProperty.keyframes.find((keyframe) => keyframe.frame === state.playheadFrame)?.id;
                return { ...mask, [property]: nextProperty } as Mask;
              }),
            })),
            selectedMaskId: maskId,
            selectedMaskProperty: property,
            selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
          };
        }),
      updateTransformValue: (layerId, property, value) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) =>
            updateTransformProperty(layer, property, (propertyState) => {
              const nextValue = cloneValue(value as AnimatableValue);
              if (propertyState.animated) {
                return upsertKeyframe(propertyState, state.playheadFrame, nextValue, () => createId("key"));
              }
              return { ...propertyState, value: nextValue };
            }),
          ),
        })),
      resetTransformProperty: (layerId, property) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) =>
            updateTransformProperty(layer, property, (propertyState) => ({
              ...propertyState,
              value: defaultValue(layer, property),
            })),
          ),
        })),
      toggleAnimation: (layerId, property) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) =>
            updateTransformProperty(layer, property, (propertyState) => {
              if (propertyState.animated) return { ...propertyState, animated: false };
              const value = evaluateProperty(propertyState, state.playheadFrame);
              return upsertKeyframe(propertyState, state.playheadFrame, value, () => createId("key"));
            }),
          ),
        })),
      addOrUpdateKeyframe: (layerId, property) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) =>
            updateTransformProperty(layer, property, (propertyState) => {
              const value = evaluateProperty(propertyState, state.playheadFrame);
              return upsertKeyframe(propertyState, state.playheadFrame, value, () => createId("key"));
            }),
          ),
        })),
      moveKeyframe: (layerId, property, keyframeId, frame) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) =>
            updateTransformProperty(layer, property, (propertyState) => {
              const nextFrame = openKeyframeFrame(propertyState.keyframes, keyframeId, frame, maxFrameForState(state));
              return {
                ...propertyState,
                keyframes: propertyState.keyframes
                  .map((keyframe) =>
                    keyframe.id === keyframeId ? { ...keyframe, frame: nextFrame } : keyframe,
                  )
                  .sort((a, b) => a.frame - b.frame),
              };
            }),
          ),
        })),
      moveMaskKeyframe: (layerId, maskId, property, keyframeId, frame) =>
        set((state) => ({
          project: updateLayer(state, layerId, (layer) => ({
            ...layer,
            masks: layer.masks.map((mask) => {
              if (mask.id !== maskId) return mask;
              const propertyState = mask[property] as AnimatableProperty<MaskPropertyValue<typeof property>>;
              const nextFrame = openKeyframeFrame(propertyState.keyframes, keyframeId, frame, maxFrameForState(state));
              return {
                ...mask,
                [property]: {
                  ...propertyState,
                  keyframes: propertyState.keyframes
                    .map((keyframe) =>
                      keyframe.id === keyframeId ? { ...keyframe, frame: nextFrame } : keyframe,
                    )
                    .sort((a, b) => a.frame - b.frame),
                },
              } as Mask;
            }),
          })),
        })),
      updateKeyframe: (keyframeId, updates) =>
        set((state) => {
          const maxFrame = maxFrameForState(state);

          return {
            project: updateActiveComposition(state, (layers) =>
              layers.map((layer) => {
                const applyUpdates = <T,>(keyframe: Keyframe<T>, keyframes: Keyframe<T>[]): Keyframe<T> => {
                  if (keyframe.id !== keyframeId) return keyframe;

                  const value = updates.value === undefined ? keyframe.value : cloneValue(updates.value as T);
                  const syncedUpdates = { ...updates };
                  const valueIsVector = Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number";

                  if (updates.frame !== undefined) {
                    syncedUpdates.frame = openKeyframeFrame(keyframes, keyframe.id, updates.frame, maxFrame);
                  }

                  if (updates.velocityIn !== undefined && updates.velocityInComponents === undefined && valueIsVector) {
                    syncedUpdates.velocityInComponents = [updates.velocityIn, updates.velocityIn];
                  }

                  if (updates.velocityOut !== undefined && updates.velocityOutComponents === undefined && valueIsVector) {
                    syncedUpdates.velocityOutComponents = [updates.velocityOut, updates.velocityOut];
                  }

                  return {
                    ...keyframe,
                    ...syncedUpdates,
                    value,
                  } as Keyframe<T>;
                };

                let nextLayer = layer;
                (Object.keys(layer.transform) as TransformPropertyKey[]).forEach((property) => {
                  nextLayer = updateTransformProperty(nextLayer, property, (propertyState) => ({
                    ...propertyState,
                    keyframes: propertyState.keyframes.map((keyframe) => applyUpdates(keyframe, propertyState.keyframes)).sort(keyframeSort),
                  }));
                });

                const maskProperties: MaskPropertyKey[] = ["path", "feather", "position", "scale"];
                nextLayer = {
                  ...nextLayer,
                  masks: nextLayer.masks.map((mask) => {
                    let nextMask = mask;
                    maskProperties.forEach((property) => {
                      const propertyState = nextMask[property] as AnimatableProperty<unknown>;
                      nextMask = {
                        ...nextMask,
                        [property]: {
                          ...propertyState,
                          keyframes: propertyState.keyframes.map((keyframe) => applyUpdates(keyframe, propertyState.keyframes)).sort(keyframeSort),
                        },
                      } as Mask;
                    });
                    return nextMask;
                  }),
                };

                const timeRemap = nextLayer.source?.timeRemap;
                if (timeRemap) {
                  nextLayer = {
                    ...nextLayer,
                    source: {
                      ...nextLayer.source,
                      timeRemap: {
                        ...timeRemap,
                        keyframes: timeRemap.keyframes.map((keyframe) => applyUpdates(keyframe, timeRemap.keyframes)).sort(keyframeSort),
                      },
                    },
                  };
                }

                nextLayer = {
                  ...nextLayer,
                  effects: nextLayer.effects.map((effect) => mapEffectNumberControls(effect, (control) => ({
                    ...control,
                    keyframes: control.keyframes.map((keyframe) => applyUpdates(keyframe, control.keyframes)).sort(keyframeSort),
                  }))),
                };

                return nextLayer;
              }),
            ),
          };
        }),
      applyEasePreset: (preset) =>
        set((state) => {
          const ids = new Set(state.selectedKeyframeIds);
          const updates = easePreset(preset);
          const maskProperties: MaskPropertyKey[] = ["path", "feather", "position", "scale"];
          return {
            project: updateActiveComposition(state, (layers) =>
              layers.map((layer) => {
                let nextLayer = layer;
                (Object.keys(layer.transform) as TransformPropertyKey[]).forEach((property) => {
                  nextLayer = updateTransformProperty(nextLayer, property, (propertyState) => ({
                    ...propertyState,
                    keyframes: propertyState.keyframes.map((keyframe) =>
                      ids.has(keyframe.id) ? { ...keyframe, ...updates, value: keyframe.value } : keyframe,
                    ),
                  }));
                });

                nextLayer = {
                  ...nextLayer,
                  masks: nextLayer.masks.map((mask) => {
                    let nextMask = mask;
                    maskProperties.forEach((property) => {
                      const propertyState = nextMask[property] as AnimatableProperty<unknown>;
                      nextMask = {
                        ...nextMask,
                        [property]: {
                          ...propertyState,
                          keyframes: propertyState.keyframes.map((keyframe) =>
                            ids.has(keyframe.id) ? { ...keyframe, ...updates, value: keyframe.value } : keyframe,
                          ),
                        },
                      } as Mask;
                    });
                    return nextMask;
                  }),
                };

                const timeRemap = nextLayer.source?.timeRemap;
                if (timeRemap) {
                  nextLayer = {
                    ...nextLayer,
                    source: {
                      ...nextLayer.source,
                      timeRemap: {
                        ...timeRemap,
                        keyframes: timeRemap.keyframes.map((keyframe) =>
                          ids.has(keyframe.id) ? { ...keyframe, ...updates, value: keyframe.value } : keyframe,
                        ),
                      },
                    },
                  };
                }

                nextLayer = {
                  ...nextLayer,
                  effects: nextLayer.effects.map((effect) => mapEffectNumberControls(effect, (control) => ({
                    ...control,
                    keyframes: control.keyframes.map((keyframe) =>
                      ids.has(keyframe.id) ? { ...keyframe, ...updates, value: keyframe.value } : keyframe,
                    ),
                  }))),
                };

                return nextLayer;
              }),
            ),
          };
        }),
      deleteSelection: () =>
        set((state) => {
          if (state.selectedKeyframeIds.length > 0) {
            const ids = new Set(state.selectedKeyframeIds);
            const maskProperties: MaskPropertyKey[] = ["path", "feather", "position", "scale"];
            return {
              project: updateActiveComposition(state, (layers) =>
                layers.map((layer) => {
                  let nextLayer = layer;
                  (Object.keys(layer.transform) as TransformPropertyKey[]).forEach((property) => {
                    nextLayer = updateTransformProperty(nextLayer, property, (propertyState) => ({
                      ...propertyState,
                      keyframes: propertyState.keyframes.filter((keyframe) => !ids.has(keyframe.id)),
                    }));
                  });
                  nextLayer = {
                    ...nextLayer,
                    masks: nextLayer.masks.map((mask) => {
                      let nextMask = mask;
                      maskProperties.forEach((property) => {
                        const propertyState = nextMask[property] as AnimatableProperty<unknown>;
                        nextMask = {
                          ...nextMask,
                          [property]: {
                            ...propertyState,
                            keyframes: propertyState.keyframes.filter((keyframe) => !ids.has(keyframe.id)),
                          },
                        } as Mask;
                      });
                      return nextMask;
                    }),
                  };
                  const timeRemap = nextLayer.source?.timeRemap;
                  if (timeRemap) {
                    nextLayer = {
                      ...nextLayer,
                      source: {
                        ...nextLayer.source,
                        timeRemap: {
                          ...timeRemap,
                          keyframes: timeRemap.keyframes.filter((keyframe) => !ids.has(keyframe.id)),
                        },
                      },
                    };
                  }

                  nextLayer = {
                    ...nextLayer,
                    effects: nextLayer.effects.map((effect) => mapEffectNumberControls(effect, (control) => ({
                      ...control,
                      keyframes: control.keyframes.filter((keyframe) => !ids.has(keyframe.id)),
                    }))),
                  };

                  return nextLayer;
                }),
              ),
              selectedKeyframeIds: [],
            };
          }
          if (state.selectedMaskId) {
            const selectedMaskId = state.selectedMaskId;
            return {
              project: updateActiveComposition(state, (layers) =>
                layers.map((layer) =>
                  layer.masks.some((mask) => mask.id === selectedMaskId)
                    ? { ...layer, masks: layer.masks.filter((mask) => mask.id !== selectedMaskId) }
                    : layer,
                ),
              ),
              selectedKeyframeIds: [],
              selectedMaskId: undefined,
              selectedMaskProperty: undefined,
            };
          }
          const layerIds = new Set(state.selectedLayerIds);
          return {
            project: updateActiveComposition(state, (layers) => layers.filter((layer) => !layerIds.has(layer.id))),
            selectedLayerIds: [],
            selectedMaskId: undefined,
            selectedMaskProperty: undefined,
      selectedSourceProperty: undefined,
      selectedEffectId: undefined,
      selectedEffectProperty: undefined,
          };
        }),
      copySelection: () =>
        set((state) => {
          const ids = new Set(state.selectedKeyframeIds);
          const composition = activeComposition(state);
          if (!composition || ids.size === 0) return { clipboardKeyframes: [] };
          const copied: ClipboardKeyframe[] = [];
          let minFrame = Number.POSITIVE_INFINITY;
          composition.layers.forEach((layer) => {
            (Object.keys(layer.transform) as TransformPropertyKey[]).forEach((property) => {
              layer.transform[property].keyframes.forEach((keyframe) => {
                if (ids.has(keyframe.id)) {
                  minFrame = Math.min(minFrame, keyframe.frame);
                  copied.push({ layerId: layer.id, property, keyframe: keyframe as Keyframe<AnimatableValue>, offset: 0 });
                }
              });
            });
          });
          return {
            clipboardKeyframes: copied.map((item) => ({
              ...item,
              keyframe: { ...item.keyframe, value: cloneValue(item.keyframe.value) },
              offset: item.keyframe.frame - minFrame,
            })),
          };
        }),
      pasteKeyframes: () =>
        set((state) => {
          if (state.clipboardKeyframes.length === 0) return {};
          const pastedIds: string[] = [];
          return {
            project: updateActiveComposition(state, (layers) =>
              layers.map((layer) => {
                const items = state.clipboardKeyframes.filter((item) => item.layerId === layer.id);
                if (items.length === 0) return layer;
                let nextLayer = layer;
                items.forEach((item) => {
                  const id = createId("key");
                  pastedIds.push(id);
                  nextLayer = updateTransformProperty(nextLayer, item.property, (propertyState) => ({
                    ...propertyState,
                    animated: true,
                    keyframes: [
                      ...propertyState.keyframes,
                      {
                        ...item.keyframe,
                        id,
                        frame: clampFrame(state, state.playheadFrame + item.offset),
                        value: cloneValue(item.keyframe.value),
                      },
                    ].sort(keyframeSort),
                  }));
                });
                return nextLayer;
              }),
            ),
            selectedKeyframeIds: pastedIds,
          };
        }),
      previousKeyframe: () =>
        set((state) => {
          const previous = selectedKeyframes(state)
            .filter((keyframe) => keyframe.frame < state.playheadFrame)
            .sort((a, b) => b.frame - a.frame)[0];
          return previous ? { playheadFrame: previous.frame, selectedKeyframeIds: [previous.id] } : {};
        }),
      nextKeyframe: () =>
        set((state) => {
          const next = selectedKeyframes(state)
            .filter((keyframe) => keyframe.frame > state.playheadFrame)
            .sort((a, b) => a.frame - b.frame)[0];
          return next ? { playheadFrame: next.frame, selectedKeyframeIds: [next.id] } : {};
        }),
    });
    },
    {
      name: "ovepro-foundation",
      version: 3,
      migrate: migratePersistedState,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        project: state.project,
        activeCompositionId: state.activeCompositionId,
        selectedLayerIds: state.selectedLayerIds,
        selectedProperty: state.selectedProperty,
        selectedMaskId: state.selectedMaskId,
        selectedMaskProperty: state.selectedMaskProperty,
        selectedSourceProperty: state.selectedSourceProperty,
        activeTool: state.activeTool,
        playheadFrame: state.playheadFrame,
        canvasZoom: state.canvasZoom,
        canvasPan: state.canvasPan,
        showGrid: state.showGrid,
        showGuides: state.showGuides,
        timelineZoom: state.timelineZoom,
        graphMode: state.graphMode,
      }),
    },
  ),
);