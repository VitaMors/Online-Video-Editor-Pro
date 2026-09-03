import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  ALL_FORMATS,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  MediaStreamAudioTrackSource,
  Mp4OutputFormat,
  Output,
  Quality,
  UrlSource,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import type { AudioCodec, VideoCodec, WrappedCanvas } from "mediabunny";
import { evaluatePathProperty, evaluateProperty, getLayerSize, getWorldPosition } from "../lib/animation";
import { compositeOperationForBlendMode } from "../lib/blendModes";
import { applyColorGradingShader } from "../lib/colorGradingShader";
import { effectNumberValue, effectStaticValue, isEffectNumberControl } from "../lib/effects";
import {
  DEFAULT_VIDEO_EXPORT_SETTINGS,
  normalizeVideoExportSettings,
  scaledExportDimensions,
  type VideoExportSettings,
} from "../lib/videoExportSettings";
import { useEditorStore } from "../store/editorStore";
import type { Composition, Effect, Layer, Mask, MaskPath, SpatialVector, Vector2 } from "../types/editor";

type DragState =
  | { type: "layer"; layerId: string; startPoint: Vector2; startPosition: SpatialVector }
  | { type: "maskVertex"; layerId: string; maskId: string; pointIndex: number; startPath: MaskPath; startPointer: Vector2; startScale: Vector2 }
  | { type: "pan"; startScreen: Vector2; startPan: Vector2 };

type MaskDraft = {
  layerId: string;
  points: MaskPath;
  hover?: Vector2;
};

type TextEdit = {
  layerId: string;
  value: string;
};

type CachedVideoFrame = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
};

type CachedModel = {
  status: "loading" | "ready" | "error";
  scene?: THREE.Object3D;
  error?: unknown;
  promise?: Promise<void>;
};

type ModelRenderRuntime = {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
};
const EXPORT_VIDEO_EVENT = "bbvep:export-composition-video";
const EXPORT_VIDEO_STATUS_EVENT = "bbvep:export-composition-video-status";
const videoFrameCache = new Map<string, CachedVideoFrame>();
const modelCache = new Map<string, CachedModel>();
const modelRenderCache = new Map<string, ModelRenderRuntime>();

// Rendering a single frame (live preview or export) walks every layer through a tree of
// masking/effects helpers that each need scratch canvases. Allocating a brand-new
// HTMLCanvasElement for every one of those on every single frame (up to 60x/sec while
// playing, or once per exported frame) is what made playback and export stutter - the
// browser was constantly creating and garbage-collecting full-resolution canvases.
// This pool hands out reusable canvases keyed by pixel size instead. Call
// resetScratchCanvasPool() once at the top of a full frame render; every borrowScratchCanvas()
// call during that render gets a cleared canvas, reusing previous frames' allocations
// whenever the requested size repeats (the common case for a stable composition).
type ScratchCanvasEntry = { canvas: HTMLCanvasElement; inUse: boolean };
const scratchCanvasPool: ScratchCanvasEntry[] = [];
const SCRATCH_CANVAS_POOL_CAP = 128;

function resetScratchCanvasPool() {
  scratchCanvasPool.forEach((entry) => {
    entry.inUse = false;
  });
  if (scratchCanvasPool.length > SCRATCH_CANVAS_POOL_CAP) {
    scratchCanvasPool.length = SCRATCH_CANVAS_POOL_CAP;
  }
}

function borrowScratchCanvas(width: number, height: number) {
  const pixelWidth = Math.max(1, Math.round(width));
  const pixelHeight = Math.max(1, Math.round(height));
  let entry = scratchCanvasPool.find((candidate) => !candidate.inUse && candidate.canvas.width === pixelWidth && candidate.canvas.height === pixelHeight);
  if (!entry) {
    const canvas = document.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    entry = { canvas, inUse: false };
    scratchCanvasPool.push(entry);
  }
  entry.inUse = true;
  // Deliberately NOT willReadFrequently here. This pool backs every scratch canvas in the
  // render pipeline - most of what runs through it is pure drawImage compositing (layer draws,
  // blend modes, blur/filter compositing, the main per-frame content canvas), which is exactly
  // what GPU-accelerated canvases are fast at. Forcing the whole pool into software rendering
  // (which was tried here previously) helps the handful of call sites that actually round-trip
  // through getImageData/putImageData, but drags down every other draw call along with them -
  // on a real GPU-accelerated browser that's a net loss. The few effects that truly need
  // repeated pixel readback (Levels, Hue/Saturation, Fill, Tint, Noise, ...) get their own
  // dedicated software-backed canvas from borrowReadbackCanvas() instead - see imageDataCanvas.
  const context = entry.canvas.getContext("2d");
  if (context) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, pixelWidth, pixelHeight);
  }
  return entry.canvas;
}

// Separate, smaller pool for canvases that are actually read back via getImageData
// (see imageDataCanvas). These are deliberately created with willReadFrequently: true, which
// browsers only honor on a canvas's first getContext() call - keeping them out of the general
// scratchCanvasPool above means that hint never leaks onto canvases that are only ever
// drawImage'd into/from.
const readbackCanvasPool: ScratchCanvasEntry[] = [];
const READBACK_CANVAS_POOL_CAP = 32;

function resetReadbackCanvasPool() {
  readbackCanvasPool.forEach((entry) => {
    entry.inUse = false;
  });
  if (readbackCanvasPool.length > READBACK_CANVAS_POOL_CAP) {
    readbackCanvasPool.length = READBACK_CANVAS_POOL_CAP;
  }
}

function borrowReadbackCanvas(width: number, height: number) {
  const pixelWidth = Math.max(1, Math.round(width));
  const pixelHeight = Math.max(1, Math.round(height));
  let entry = readbackCanvasPool.find((candidate) => !candidate.inUse && candidate.canvas.width === pixelWidth && candidate.canvas.height === pixelHeight);
  if (!entry) {
    const canvas = document.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    entry = { canvas, inUse: false };
    readbackCanvasPool.push(entry);
  }
  entry.inUse = true;
  const context = entry.canvas.getContext("2d", { willReadFrequently: true });
  if (context) context.clearRect(0, 0, pixelWidth, pixelHeight);
  return entry.canvas;
}

function configureHighQualityContext(context: CanvasRenderingContext2D | null | undefined) {
  if (!context) return;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
}

function shouldDrawLayer(layer: Layer, frame: number, soloActive: boolean) {
  if (layer.visible === false || layer.type === "null" || layer.type === "audio") return false;
  if (soloActive && !layer.solo) return false;
  return frame >= layer.startFrame && frame < layer.endFrame;
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function placement(canvas: HTMLCanvasElement, composition: Composition, zoom: number, pan: Vector2) {
  const canvasWidth = Math.max(1, finiteNumber(canvas.width, 1));
  const canvasHeight = Math.max(1, finiteNumber(canvas.height, 1));
  const compositionWidth = Math.max(1, finiteNumber(composition.width, 1920));
  const compositionHeight = Math.max(1, finiteNumber(composition.height, 1080));
  const safeZoom = Math.max(0.1, finiteNumber(zoom, 0.48));
  const panX = finiteNumber(pan[0], 0);
  const panY = finiteNumber(pan[1], 0);
  const fitScale = Math.min(canvasWidth / compositionWidth, canvasHeight / compositionHeight);
  const scale = fitScale * safeZoom;

  return {
    scale,
    x: (canvasWidth - compositionWidth * scale) / 2 + panX,
    y: (canvasHeight - compositionHeight * scale) / 2 + panY,
  };
}

function compositionIsOffscreen(canvas: HTMLCanvasElement, composition: Composition, zoom: number, pan: Vector2) {
  const current = placement(canvas, composition, zoom, pan);
  const width = composition.width * current.scale;
  const height = composition.height * current.scale;
  const margin = 24;

  return (
    current.x > canvas.width - margin ||
    current.y > canvas.height - margin ||
    current.x + width < margin ||
    current.y + height < margin
  );
}

function screenToComposition(
  canvas: HTMLCanvasElement,
  composition: Composition,
  zoom: number,
  pan: Vector2,
  clientX: number,
  clientY: number,
): Vector2 {
  const rect = canvas.getBoundingClientRect();
  const current = placement(canvas, composition, zoom, pan);
  const canvasX = (clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
  const canvasY = (clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
  return [(canvasX - current.x) / current.scale, (canvasY - current.y) / current.scale];
}

type LayerTransform2D = {
  position: Vector2;
  scale: Vector2;
  rotation: number;
  anchor: Vector2;
};

function transform3DEffect(layer: Layer) {
  if (layer.type === "model" || layer.type === "camera" || layer.type === "audio" || layer.type === "null" || layer.type === "adjustment") return undefined;
  return layer.effects.find((effect) => effect.enabled !== false && effect.type === "transform3d");
}

function layerTransform2D(composition: Composition, layer: Layer, frame: number, activeCamera?: Layer): LayerTransform2D {
  const worldPosition2D = getWorldPosition(composition, layer, frame);
  const baseScale = evaluateProperty(layer.transform.scale, frame);
  const baseRotation = evaluateProperty(layer.transform.rotation, frame);
  const anchorValue = evaluateProperty(layer.transform.anchorPoint, frame);
  const anchor: Vector2 = [anchorValue[0], anchorValue[1]];
  const effect = transform3DEffect(layer);

  if (!effect) {
    return {
      position: worldPosition2D,
      scale: [baseScale[0] / 100, baseScale[1] / 100],
      rotation: baseRotation,
      anchor,
    };
  }

  const cameraPosition = activeCamera ? evaluateProperty(activeCamera.transform.position, frame) : [composition.width / 2, composition.height / 2, -900] as SpatialVector;
  const cameraRotationX = activeCamera ? finiteNumber(evaluateProperty(activeCamera.transform.rotationX, frame), 0) : 0;
  const cameraRotationY = activeCamera ? finiteNumber(evaluateProperty(activeCamera.transform.rotationY, frame), 0) : 0;
  const cameraRotationZ = activeCamera ? finiteNumber(evaluateProperty(activeCamera.transform.rotation, frame), 0) : 0;
  const cameraFov = Math.max(5, Math.min(140, finiteNumber(activeCamera?.source?.cameraFov, 35)));
  const focus = 900 * Math.tan(radians(35) / 2) / Math.tan(radians(cameraFov) / 2);
  const localX = effectNumberValue(effect, "positionX", frame);
  const localY = effectNumberValue(effect, "positionY", frame);
  const localZ = effectNumberValue(effect, "positionZ", frame);
  const world = new THREE.Vector3(worldPosition2D[0] + localX, -(worldPosition2D[1] + localY), localZ);
  const camera = new THREE.Vector3(
    numericVectorComponent(cameraPosition, 0, composition.width / 2),
    -numericVectorComponent(cameraPosition, 1, composition.height / 2),
    numericVectorComponent(cameraPosition, 2, -900),
  );
  const relative = world.sub(camera);
  relative.applyEuler(new THREE.Euler(radians(-cameraRotationX), radians(-cameraRotationY), radians(-cameraRotationZ), "YXZ"));
  const distance = Math.max(10, relative.z);
  const projectionScale = Math.max(0.01, Math.min(80, focus / distance));
  const billboard = Boolean(effectStaticValue(effect, "billboard"));
  const effectScaleX = effectNumberValue(effect, "scaleX", frame) / 100;
  const effectScaleY = effectNumberValue(effect, "scaleY", frame) / 100;
  const rotateX = effectNumberValue(effect, "rotationX", frame);
  const rotateY = effectNumberValue(effect, "rotationY", frame);
  const rotateZ = effectNumberValue(effect, "rotationZ", frame);
  const xFacing = billboard ? 1 : Math.max(0.05, Math.abs(Math.cos(radians(rotateY))));
  const yFacing = billboard ? 1 : Math.max(0.05, Math.abs(Math.cos(radians(rotateX))));

  return {
    position: [composition.width / 2 + relative.x * projectionScale, composition.height / 2 - relative.y * projectionScale],
    scale: [baseScale[0] / 100 * effectScaleX * projectionScale * xFacing, baseScale[1] / 100 * effectScaleY * projectionScale * yFacing],
    rotation: baseRotation + rotateZ,
    anchor,
  };
}

function compositionToLayerPoint(composition: Composition, layer: Layer, frame: number, point: Vector2, activeCamera?: Layer): Vector2 {
  const transform = layerTransform2D(composition, layer, frame, activeCamera);
  const angle = radians(-transform.rotation);
  const translatedX = point[0] - transform.position[0];
  const translatedY = point[1] - transform.position[1];
  const rotatedX = translatedX * Math.cos(angle) - translatedY * Math.sin(angle);
  const rotatedY = translatedX * Math.sin(angle) + translatedY * Math.cos(angle);

  return [
    rotatedX / Math.max(0.001, transform.scale[0]) + transform.anchor[0],
    rotatedY / Math.max(0.001, transform.scale[1]) + transform.anchor[1],
  ];
}

function layerPointToComposition(composition: Composition, layer: Layer, frame: number, point: Vector2, activeCamera?: Layer): Vector2 {
  const transform = layerTransform2D(composition, layer, frame, activeCamera);
  const angle = radians(transform.rotation);
  const scaledX = (point[0] - transform.anchor[0]) * transform.scale[0];
  const scaledY = (point[1] - transform.anchor[1]) * transform.scale[1];

  return [
    transform.position[0] + scaledX * Math.cos(angle) - scaledY * Math.sin(angle),
    transform.position[1] + scaledX * Math.sin(angle) + scaledY * Math.cos(angle),
  ];
}

function textEditBox(
  canvas: HTMLCanvasElement,
  wrapper: HTMLDivElement,
  composition: Composition,
  layer: Layer,
  frame: number,
  zoom: number,
  pan: Vector2,
) {
  const [width, height] = getLayerSize(layer);
  const layerScale = evaluateProperty(layer.transform.scale, frame);
  const rotation = evaluateProperty(layer.transform.rotation, frame);
  const center = layerPointToComposition(composition, layer, frame, [width / 2, height / 2]);
  const current = placement(canvas, composition, zoom, pan);
  const canvasRect = canvas.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();
  const cssScaleX = canvasRect.width / Math.max(1, canvas.width);
  const cssScaleY = canvasRect.height / Math.max(1, canvas.height);
  const centerX = canvasRect.left - wrapperRect.left + (current.x + center[0] * current.scale) * cssScaleX;
  const centerY = canvasRect.top - wrapperRect.top + (current.y + center[1] * current.scale) * cssScaleY;
  const boxWidth = Math.max(96, Math.abs(width * (layerScale[0] / 100) * current.scale * cssScaleX));
  const boxHeight = Math.max(28, Math.abs(height * (layerScale[1] / 100) * current.scale * cssScaleY));
  const fontSize = Math.max(12, (layer.source?.fontSize ?? 64) * Math.abs(layerScale[1] / 100) * current.scale * cssScaleY);

  return {
    left: centerX - boxWidth / 2,
    top: centerY - boxHeight / 2,
    width: boxWidth,
    height: boxHeight,
    rotation,
    fontSize,
    color: layer.source?.color ?? "#f8fafc",
  };
}

function applyLayerTransform(context: CanvasRenderingContext2D, composition: Composition, layer: Layer, frame: number, activeCamera?: Layer) {
  const transform = layerTransform2D(composition, layer, frame, activeCamera);

  context.translate(transform.position[0], transform.position[1]);
  context.rotate(radians(transform.rotation));
  context.scale(transform.scale[0], transform.scale[1]);
  context.translate(-transform.anchor[0], -transform.anchor[1]);
}

function drawGrid(context: CanvasRenderingContext2D, composition: Composition) {
  context.save();
  context.strokeStyle = "rgba(139, 148, 158, 0.16)";
  context.lineWidth = 1;
  for (let x = 0; x <= composition.width; x += 120) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, composition.height);
    context.stroke();
  }
  for (let y = 0; y <= composition.height; y += 120) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(composition.width, y);
    context.stroke();
  }
  context.restore();
}

function drawGuides(context: CanvasRenderingContext2D, composition: Composition) {
  context.save();
  context.strokeStyle = "rgba(242, 184, 75, 0.45)";
  context.lineWidth = 2;
  context.setLineDash([12, 10]);
  context.beginPath();
  context.moveTo(composition.width / 2, 0);
  context.lineTo(composition.width / 2, composition.height);
  context.moveTo(0, composition.height / 2);
  context.lineTo(composition.width, composition.height / 2);
  context.stroke();
  context.restore();
}

function drawTransparencyGrid(context: CanvasRenderingContext2D, composition: Composition) {
  const size = 40;
  context.save();
  for (let y = 0; y < composition.height; y += size) {
    for (let x = 0; x < composition.width; x += size) {
      context.fillStyle = ((x / size + y / size) % 2 === 0) ? "#18202b" : "#101722";
      context.fillRect(x, y, size, size);
    }
  }
  context.restore();
}

function drawMediaPlaceholder(context: CanvasRenderingContext2D, width: number, height: number, label: string) {
  context.fillStyle = "#1b2330";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#39d0c8";
  context.strokeRect(0, 0, width, height);
  if (label.trim()) {
    context.fillStyle = "#8b949e";
    context.font = "600 24px Inter, system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, width / 2, height / 2);
  }
}
function drawModelPlaceholder(context: CanvasRenderingContext2D, width: number, height: number, label: string) {
  context.save();
  context.fillStyle = "#141b26";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#39d0c8";
  context.lineWidth = 3;
  context.strokeRect(0, 0, width, height);

  const size = Math.min(width, height) * 0.42;
  const cx = width / 2;
  const cy = height / 2 - size * 0.08;
  const offset = size * 0.28;
  const left = cx - size / 2;
  const top = cy - size / 2;
  const right = cx + size / 2;
  const bottom = cy + size / 2;
  context.strokeStyle = "rgba(57, 208, 200, 0.9)";
  context.lineWidth = Math.max(2, size * 0.018);
  context.beginPath();
  context.rect(left, top, size, size);
  context.rect(left + offset, top - offset, size, size);
  context.moveTo(left, top);
  context.lineTo(left + offset, top - offset);
  context.moveTo(right, top);
  context.lineTo(right + offset, top - offset);
  context.moveTo(left, bottom);
  context.lineTo(left + offset, bottom - offset);
  context.moveTo(right, bottom);
  context.lineTo(right + offset, bottom - offset);
  context.stroke();

  context.fillStyle = "#e6edf3";
  context.font = `700 ${Math.max(18, Math.round(size * 0.12))}px Inter, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, width / 2, height - Math.max(36, height * 0.16));
  context.restore();
}

function modelRenderKey(modelUrl: string, width: number, height: number) {
  return `${modelUrl}::${Math.max(1, Math.round(width))}x${Math.max(1, Math.round(height))}`;
}

function modelRuntime(modelUrl: string, width: number, height: number) {
  const pixelWidth = Math.max(1, Math.round(width));
  const pixelHeight = Math.max(1, Math.round(height));
  const key = modelRenderKey(modelUrl, pixelWidth, pixelHeight);
  const cached = modelRenderCache.get(key);
  if (cached) return cached;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(pixelWidth, pixelHeight, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, pixelWidth / pixelHeight, 0.01, 1000);
    const runtime = { canvas, renderer, scene, camera };
    modelRenderCache.set(key, runtime);
    return runtime;
  } catch {
    return undefined;
  }
}

function clearThreeScene(scene: THREE.Scene) {
  while (scene.children.length > 0) scene.remove(scene.children[0]);
}

function numericVectorComponent(value: unknown, index: number, fallback: number) {
  return Array.isArray(value) && typeof value[index] === "number" && Number.isFinite(value[index]) ? value[index] : fallback;
}

function activeCameraLayer(composition: Composition, frame: number) {
  return composition.layers.find((layer) => layer.type === "camera" && layer.visible !== false && frame >= layer.startFrame && frame < layer.endFrame);
}

function radians(value: number) {
  return (value * Math.PI) / 180;
}

function configureModelCamera(
  camera: THREE.PerspectiveCamera,
  composition: Composition,
  modelLayer: Layer,
  cameraLayer: Layer | undefined,
  frame: number,
  width: number,
  height: number,
  modelZPosition: number,
) {
  camera.aspect = Math.max(1, Math.round(width)) / Math.max(1, Math.round(height));

  if (!cameraLayer) {
    const cameraDistance = Math.max(1.35, Math.min(14, 4.4 - modelZPosition / 260));
    camera.fov = 35;
    camera.near = 0.01;
    camera.far = 1000;
    camera.position.set(0, 0, cameraDistance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    return;
  }

  const cameraPosition = evaluateProperty(cameraLayer.transform.position, frame);
  const modelPosition = evaluateProperty(modelLayer.transform.position, frame);
  const cameraRotationX = finiteNumber(evaluateProperty(cameraLayer.transform.rotationX, frame), 0);
  const cameraRotationY = finiteNumber(evaluateProperty(cameraLayer.transform.rotationY, frame), 0);
  const cameraRotationZ = finiteNumber(evaluateProperty(cameraLayer.transform.rotation, frame), 0);
  const source = cameraLayer.source;
  const cameraZ = numericVectorComponent(cameraPosition, 2, -900);
  const relativeX = numericVectorComponent(cameraPosition, 0, composition.width / 2) - numericVectorComponent(modelPosition, 0, composition.width / 2);
  const relativeY = numericVectorComponent(cameraPosition, 1, composition.height / 2) - numericVectorComponent(modelPosition, 1, composition.height / 2);
  const cameraX = (relativeX / Math.max(1, width)) * 3.2;
  const cameraY = -(relativeY / Math.max(1, height)) * 3.2;
  const cameraDistance = Math.max(0.35, Math.min(60, 4.4 - (cameraZ + 900) / 260 - modelZPosition / 260));

  camera.fov = Math.max(5, Math.min(140, finiteNumber(source?.cameraFov, 35)));
  camera.near = Math.max(0.001, finiteNumber(source?.cameraNear, 0.01));
  camera.far = Math.max(camera.near + 1, finiteNumber(source?.cameraFar, 1000));
  camera.position.set(cameraX, cameraY, cameraDistance);
  camera.rotation.set(radians(cameraRotationX), radians(cameraRotationY), radians(cameraRotationZ), "YXZ");
  camera.updateProjectionMatrix();
}

function drawModelScene(
  context: CanvasRenderingContext2D,
  composition: Composition,
  layer: Layer,
  activeCamera: Layer | undefined,
  modelScene: THREE.Object3D,
  modelUrl: string,
  frame: number,
  width: number,
  height: number,
) {
  const runtime = modelRuntime(modelUrl, width, height);
  if (!runtime) return false;

  const clonedModel = modelScene.clone(true);
  const bounds = new THREE.Box3().setFromObject(clonedModel);
  if (bounds.isEmpty()) return false;

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const largestAxis = Math.max(size.x, size.y, size.z, 0.001);
  clonedModel.position.sub(center);

  const scale = evaluateProperty(layer.transform.scale, frame);
  const position = evaluateProperty(layer.transform.position, frame);
  const rotationX = evaluateProperty(layer.transform.rotationX, frame);
  const rotationY = evaluateProperty(layer.transform.rotationY, frame);
  const zScale = Math.max(0.001, numericVectorComponent(scale, 2, 100) / 100);
  const zPosition = numericVectorComponent(position, 2, 0);

  const group = new THREE.Group();
  group.add(clonedModel);
  const normalizedScale = 2.35 / largestAxis;
  group.scale.set(normalizedScale, normalizedScale, normalizedScale * zScale);
  group.rotation.x = (finiteNumber(rotationX, 0) * Math.PI) / 180;
  group.rotation.y = (finiteNumber(rotationY, 0) * Math.PI) / 180;

  clearThreeScene(runtime.scene);
  runtime.scene.add(new THREE.AmbientLight(0xffffff, 1.8));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(3, 4, 5);
  runtime.scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x39d0c8, 0.8);
  rimLight.position.set(-4, 2, 3);
  runtime.scene.add(rimLight);
  runtime.scene.add(group);

  configureModelCamera(runtime.camera, composition, layer, activeCamera, frame, width, height, zPosition);

  runtime.renderer.clear(true, true, true);
  runtime.renderer.render(runtime.scene, runtime.camera);
  context.drawImage(runtime.canvas, 0, 0, width, height);
  return true;
}
function mediaTimeForFrame(layer: Layer, frame: number, fps: number, duration = 0) {
  const timeRemap = layer.type === "video" ? layer.source?.timeRemap : undefined;
  if (timeRemap) {
    const remappedTime = Math.max(0, finiteNumber(evaluateProperty(timeRemap, frame), 0));
    return duration > 0 ? Math.min(remappedTime, Math.max(0, duration - 0.02)) : remappedTime;
  }

  const safeFps = Math.max(1, finiteNumber(fps, 30));
  const mediaOffsetFrames = Math.max(0, finiteNumber(layer.source?.mediaOffsetFrames, 0));
  const rawTime = Math.max(0, (frame - layer.startFrame + mediaOffsetFrames) / safeFps);
  return duration > 0 ? Math.min(rawTime, Math.max(0, duration - 0.02)) : rawTime;
}
function bufferedSecondsBetween(ranges: TimeRanges, start: number, end: number) {
  let total = 0;

  for (let index = 0; index < ranges.length; index += 1) {
    const rangeStart = ranges.start(index);
    const rangeEnd = ranges.end(index);
    const overlapStart = Math.max(start, rangeStart);
    const overlapEnd = Math.min(end, rangeEnd);
    if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
  }

  return total;
}

function videoPreviewBufferRatio(video: HTMLVideoElement, layer: Layer, frame: number, fps: number) {
  const safeFps = Math.max(1, finiteNumber(fps, 30));
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  if (video.readyState < 1 || duration <= 0) return 0;
  if (video.readyState >= 4) return 1;

  const targetTime = mediaTimeForFrame(layer, frame, safeFps, duration);
  const visiblePlaybackSeconds = Math.max(1 / safeFps, Math.min(2, (layer.endFrame - frame) / safeFps));
  const mediaPlaybackSeconds = Math.max(1 / safeFps, duration - targetTime);
  const previewSeconds = Math.min(visiblePlaybackSeconds, mediaPlaybackSeconds);
  const windowStart = Math.max(0, Math.min(duration, targetTime));
  const windowEnd = Math.max(windowStart, Math.min(duration, windowStart + previewSeconds));
  const targetFrames = Math.max(1, Math.ceil((windowEnd - windowStart) * safeFps));
  const bufferedFrames = Math.floor(bufferedSecondsBetween(video.buffered, windowStart, windowEnd) * safeFps);

  return Math.min(1, bufferedFrames / targetFrames);
}

function hasEnoughPreviewBuffer(video: HTMLVideoElement, layer: Layer, frame: number, fps: number) {
  return videoPreviewBufferRatio(video, layer, frame, fps) >= 0.6;
}

function safeSeekMedia(media: HTMLMediaElement, time: number) {
  try {
    media.currentTime = time;
  } catch {
    // Some browsers reject seeks while metadata is still settling.
  }
}

function syncVideoToFrame(video: HTMLVideoElement, layer: Layer, frame: number, fps: number, tolerance = 0.04) {
  if (video.readyState < 1) return;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const targetTime = mediaTimeForFrame(layer, frame, fps, duration);
  if (Math.abs(video.currentTime - targetTime) > tolerance && !video.seeking) {
    safeSeekMedia(video, targetTime);
  }
}

function videoCacheKey(videoUrl: string, width: number, height: number) {
  return `${videoUrl}::${Math.max(1, Math.round(width))}x${Math.max(1, Math.round(height))}`;
}

function drawCachedVideoFrame(context: CanvasRenderingContext2D, videoUrl: string, width: number, height: number) {
  const cached = videoFrameCache.get(videoCacheKey(videoUrl, width, height));
  if (!cached) return false;
  context.drawImage(cached.canvas, 0, 0, width, height);
  return true;
}

function rememberVideoFrame(videoUrl: string, video: HTMLVideoElement, width: number, height: number) {
  const cacheKey = videoCacheKey(videoUrl, width, height);
  const pixelWidth = Math.max(1, Math.round(width));
  const pixelHeight = Math.max(1, Math.round(height));
  const cached = videoFrameCache.get(cacheKey);
  const canvas = cached?.width === pixelWidth && cached.height === pixelHeight
    ? cached.canvas
    : document.createElement("canvas");
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.drawImage(video, 0, 0, pixelWidth, pixelHeight);
  videoFrameCache.set(cacheKey, { canvas, width: pixelWidth, height: pixelHeight });
}

// A layer with Time Remapping on can never use native <video>.play() (see canUseLivePlayback in
// the live-sync effect below) - every composition frame reseeks the element to whatever source
// time the remap curve maps to, and drawLayerContent (immediately below) deliberately shows the
// last known-good cached frame rather than the live element while a seek is still in flight, so
// scrubbing doesn't flash a stale pre-seek frame. That trade-off is fine for scrubbing, where
// seeks are occasional and resolve in well under a frame. It stops being fine for continuous
// Time Remap PLAYBACK under real render load (multiple video layers, an adjustment layer running
// Levels + Gaussian Blur): every single composition frame issues a fresh seek, and if the main
// thread is busy compositing those effects for long enough that a seek doesn't resolve before
// the NEXT frame's draw, video.seeking is true at literally every sample - so the cache never
// gets refreshed past whichever frame happened to land first, and playback looks like a dead
// freeze-frame even though the underlying <video> element's currentTime is quietly tracking the
// remap curve correctly the whole time (confirmed while diagnosing this: currentTime advances
// exactly as expected, only the drawn pixels don't). videoSeekStallStartedAt tracks, per source
// url, how long the CURRENT seek has been pending; once it's been stuck for longer than a person
// would read as "still catching up" rather than "frozen," drawLayerContent draws the live element
// anyway - a frame that's a little behind its exact target beats a frame that never changes.
const videoSeekStallStartedAt = new Map<string, number>();
const VIDEO_SEEK_STALL_DRAW_ANYWAY_MS = 200;

function videoSeekStallMs(videoUrl: string, seeking: boolean, now: number) {
  if (!seeking) {
    videoSeekStallStartedAt.delete(videoUrl);
    return 0;
  }
  const startedAt = videoSeekStallStartedAt.get(videoUrl);
  if (startedAt === undefined) {
    videoSeekStallStartedAt.set(videoUrl, now);
    return 0;
  }
  return now - startedAt;
}

// videoSeekStallMs above helps when a seek would have resolved quickly if the main thread
// weren't busy compositing effects, but it can't help when the seek itself is just slow: a
// native <video> element seeking to an arbitrary/distant timestamp in a longer source file
// (especially one with widely-spaced keyframes, like a screen recording) can genuinely take
// well over a second to decode forward from the last keyframe to the target frame, no matter
// how idle the main thread is - and a browser doesn't reveal any new pixels for an in-progress
// seek, so forcing an early drawImage(video) during one just keeps showing the same stale
// pre-seek frame anyway. That's what turns into the "frozen for ~1-2s, then hard-cuts to a new
// frame" pattern under real Time Remap playback, as opposed to the smoother main-thread-starved
// stalls videoSeekStallMs recovers from. This is architecturally the exact same problem export
// already solved (see buildExportVideoDecoders/exportFrameLocked branch below): read exact
// frames straight out of a dedicated mediabunny/WebCodecs decoder by timestamp, which has no
// seek-latency gap at all, instead of trusting a live element's seek to have already resolved.
// LiveTimeRemapDecoder is that same decoder, kept open and reused across ticks (one per
// time-remapped video layer, managed by a reconciliation effect in CompositionCanvas()) rather
// than opened once per export - so `cache` holds only the handful of composition frames it's
// actually been asked for recently rather than every output frame up front.
type LiveTimeRemapDecoder = {
  input: Input;
  sink: CanvasSink;
  videoUrl: string;
  // Keyed by composition `frame` number (not float seconds) so a lookup during drawing is an
  // exact match against the same `frame` renderCompositionFrame is already drawing.
  cache: Map<number, WrappedCanvas | null>;
  cacheOrder: number[];
  pendingFrame: number | null;
  desiredFrame: number | null;
  desiredTargetTime: number | null;
  disposed: boolean;
};

const LIVE_TIME_REMAP_CACHE_LIMIT = 90;

// getCanvas() calls against the same underlying WebCodecs decoder aren't safe to run
// concurrently, so only one is ever in flight per decoder at a time. If the desired frame
// changes again while one is already pending (the playhead advances every tick during
// playback), the newer request just overwrites desiredFrame/desiredTargetTime and gets picked
// up as soon as the in-flight one resolves - rather than queuing every intermediate frame,
// which would only fall further and further behind real time under sustained playback.
function requestLiveTimeRemapFrame(decoder: LiveTimeRemapDecoder, frame: number, targetTime: number, onResolved: () => void) {
  decoder.desiredFrame = frame;
  decoder.desiredTargetTime = targetTime;
  if (decoder.pendingFrame !== null) return;

  const runNext = () => {
    const nextFrame = decoder.desiredFrame;
    const nextTime = decoder.desiredTargetTime;
    if (decoder.disposed || nextFrame === null || nextTime === null) {
      decoder.pendingFrame = null;
      return;
    }
    decoder.pendingFrame = nextFrame;
    decoder.sink.getCanvas(nextTime)
      .then((canvas) => {
        if (decoder.disposed) return;
        decoder.cache.set(nextFrame, canvas);
        decoder.cacheOrder.push(nextFrame);
        while (decoder.cacheOrder.length > LIVE_TIME_REMAP_CACHE_LIMIT) {
          const evicted = decoder.cacheOrder.shift();
          if (evicted !== undefined) decoder.cache.delete(evicted);
        }
        onResolved();
        if (decoder.desiredFrame !== nextFrame) runNext();
        else decoder.pendingFrame = null;
      })
      .catch((error: unknown) => {
        if (decoder.disposed) return;
        console.error(`Live time-remap decode failed for frame ${nextFrame}:`, error);
        decoder.cache.set(nextFrame, null);
        if (decoder.desiredFrame !== nextFrame) runNext();
        else decoder.pendingFrame = null;
      });
  };
  runNext();
}
function drawLayerContent(
  context: CanvasRenderingContext2D,
  composition: Composition,
  layer: Layer,
  images: Map<string, HTMLImageElement>,
  videos: Map<string, HTMLVideoElement>,
  frame: number,
  fps: number,
  liveVideoPlayback = false,
  activeCamera?: Layer,
  exportFrameLocked = false,
  exportVideoFrames?: ExportVideoFrames,
  liveTimeRemapFrames?: Map<string, WrappedCanvas | null>,
) {
  const [width, height] = getLayerSize(layer);
  const source = layer.source;

  if (layer.type === "shape") {
    context.fillStyle = source?.color ?? "#39d0c8";
    if (source?.shape === "ellipse") {
      context.beginPath();
      context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      context.fill();
    } else {
      context.fillRect(0, 0, width, height);
    }
  }

  if (layer.type === "solid") {
    context.fillStyle = source?.color ?? "#293241";
    context.fillRect(0, 0, width, height);
  }

  if (layer.type === "text") {
    context.fillStyle = source?.color ?? "#f8fafc";
    context.font = `700 ${source?.fontSize ?? 64}px Inter, system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(source?.text ?? layer.name, width / 2, height / 2);
  }

  if (layer.type === "image" && source?.imageUrl) {
    const image = images.get(source.imageUrl);
    if (image?.complete && image.naturalWidth > 0) {
      context.drawImage(image, 0, 0, width, height);
    } else {
      drawMediaPlaceholder(context, width, height, "Loading Image");
    }
  }

  if (layer.type === "model" && source?.modelUrl) {
    const cachedModel = modelCache.get(source.modelUrl);
    const label = source.fileName ? `3D Model: ${source.fileName}` : "3D Model";
    if (cachedModel?.status === "ready" && cachedModel.scene && drawModelScene(context, composition, layer, activeCamera, cachedModel.scene, source.modelUrl, frame, width, height)) {
      return;
    }
    drawModelPlaceholder(context, width, height, cachedModel?.status === "error" ? "Could not load 3D Model" : cachedModel?.status === "loading" ? "Loading 3D Model" : label);
  }

  if (layer.type === "video" && source?.videoUrl) {
    const video = videos.get(source.videoUrl);
    const enoughPreviewBuffer = video ? hasEnoughPreviewBuffer(video, layer, frame, fps) : false;
    const playbackDriven = liveVideoPlayback && !source.timeRemap;
    if (video && !playbackDriven) syncVideoToFrame(video, layer, frame, fps);

    if (exportFrameLocked) {
      // The authoritative source of pixels for an exported video layer is a deterministic,
      // seek-free decode: buildExportVideoDecoders (see exportCompositionVideo) opens a
      // dedicated mediabunny/WebCodecs decoder per video layer and feeds it the exact list of
      // composition timestamps it will need, one per output frame, resolved via
      // canvasesAtTimestamps. That path never touches a live, possibly-still-playing <video>
      // element's currentTime/seek state at all, which is what finally eliminates this export's
      // long-standing "jumping forward and backward" corruption: every earlier fix here
      // (pause-before-seek, sequential seeking, retry-with-yield, pinning only
      // verification-confirmed frames into videoFrameCache) was still built on the premise that
      // a <video> element's currentTime reading back correct means the picture drawImage would
      // grab is also correct - and under this app's real multi-layer/heavy-effects load, that
      // premise kept turning out false: the element could report the right time while still
      // handing back a stale or wrong decoded picture. Reading exact frames straight out of a
      // WebCodecs decoder by timestamp has no such gap.
      const decodedFrame = exportVideoFrames?.get(layer.id);
      if (decodedFrame) {
        context.drawImage(decodedFrame.canvas, 0, 0, width, height);
        return;
      }
      // Fallback only: the layer's dedicated decoder failed to initialize (e.g. an
      // unsupported/undetectable codec) or hasn't produced a frame yet for this exact
      // timestamp (before the track's first frame). Reuse the old live-element/cache path
      // rather than drawing nothing.
      if (!drawCachedVideoFrame(context, source.videoUrl, width, height)) {
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
          context.drawImage(video, 0, 0, width, height);
          rememberVideoFrame(source.videoUrl, video, width, height);
        } else {
          drawMediaPlaceholder(context, width, height, enoughPreviewBuffer ? "" : "Loading Video");
        }
      }
      return;
    }

    // Time Remapped layers: prefer an exact WebCodecs-decoded frame for this precise
    // composition frame (see LiveTimeRemapDecoder above) over the live <video> element's
    // seek-and-draw path below. Falls through to that path when the decoder hasn't produced
    // this exact frame yet (still initializing, or the request just went out this tick) -
    // requestLiveTimeRemapFrame runs the decode in the background and the next natural
    // re-render (playheadFrame changes every tick during playback) picks it up once resolved.
    if (source.timeRemap && liveTimeRemapFrames) {
      const decodedFrame = liveTimeRemapFrames.get(layer.id);
      if (decodedFrame) {
        context.drawImage(decodedFrame.canvas, 0, 0, width, height);
        return;
      }
    }

    // While a seek is in flight the video element still displays its pre-seek frame, so
    // drawing it here would flash the wrong frame during scrubbing/timeline dragging.
    // Prefer the last known-good cached frame until the seek actually resolves - UNLESS this
    // seek has been pending long enough that it's no longer "about to resolve" (see
    // videoSeekStallMs above): that's what a Time Remapped layer's continuous per-frame
    // reseeking looks like once heavy effects on the same composition are slow enough to starve
    // it, and refusing to ever draw a mid-seek frame there is what turns into a permanent freeze
    // rather than merely-imperfect playback.
    const seeking = video?.seeking ?? false;
    const seekStalled = video ? videoSeekStallMs(source.videoUrl, seeking, performance.now()) > VIDEO_SEEK_STALL_DRAW_ANYWAY_MS : false;
    if (video && video.readyState >= 2 && video.videoWidth > 0 && (!seeking || seekStalled)) {
      try {
        context.drawImage(video, 0, 0, width, height);
        rememberVideoFrame(source.videoUrl, video, width, height);
      } catch {
        if (!drawCachedVideoFrame(context, source.videoUrl, width, height)) {
          drawMediaPlaceholder(context, width, height, enoughPreviewBuffer ? "" : "Loading Video");
        }
      }
    } else if (!drawCachedVideoFrame(context, source.videoUrl, width, height)) {
      drawMediaPlaceholder(context, width, height, enoughPreviewBuffer ? "" : "Loading Video");
    }
  }
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value));
}

function colorFromHex(value: unknown): [number, number, number] {
  const fallback: [number, number, number] = [255, 255, 255];
  if (typeof value !== "string") return fallback;
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return fallback;
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function hueToRgb(p: number, q: number, t: number) {
  let hue = t;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta <= 0.00001) return [0, 0, lightness];

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue /= 6;
  if (hue < 0) hue += 1;

  return [hue, saturation, lightness];
}

function hslToRgb(hsl: [number, number, number]): [number, number, number] {
  const hue = ((hsl[0] % 1) + 1) % 1;
  const saturation = clampUnit(hsl[1]);
  const lightness = clampUnit(hsl[2]);
  if (saturation <= 0.00001) {
    const value = clampByte(lightness * 255);
    return [value, value, value];
  }

  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [
    clampByte(hueToRgb(p, q, hue + 1 / 3) * 255),
    clampByte(hueToRgb(p, q, hue) * 255),
    clampByte(hueToRgb(p, q, hue - 1 / 3) * 255),
  ];
}

function canvasLike(source: HTMLCanvasElement) {
  return borrowScratchCanvas(source.width, source.height);
}

function filteredCanvas(source: HTMLCanvasElement, filter: string) {
  const canvas = canvasLike(source);
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.filter = filter;
  context.drawImage(source, 0, 0);
  context.filter = "none";
  return canvas;
}

function blendCanvas(original: HTMLCanvasElement, processed: HTMLCanvasElement, mix: number) {
  if (mix >= 0.999) return processed;
  const canvas = canvasLike(original);
  const context = canvas.getContext("2d");
  if (!context) return processed;
  context.drawImage(original, 0, 0);
  context.globalAlpha = clampUnit(mix);
  context.drawImage(processed, 0, 0);
  context.globalAlpha = 1;
  return canvas;
}

function mixWithOriginalAmount(effect: Effect, frame: number) {
  return clampUnit(effectNumberValue(effect, "mix", frame) / 100);
}

function blendWithOriginal(original: HTMLCanvasElement, processed: HTMLCanvasElement, amount: number) {
  const originalAmount = clampUnit(amount);
  if (originalAmount <= 0.001) return processed;
  if (originalAmount >= 0.999) return original;
  const canvas = canvasLike(original);
  const context = canvas.getContext("2d");
  if (!context) return processed;
  context.drawImage(processed, 0, 0);
  context.globalAlpha = originalAmount;
  context.drawImage(original, 0, 0);
  context.globalAlpha = 1;
  return canvas;
}

function imageDataCanvas(source: HTMLCanvasElement, mutator: (data: Uint8ClampedArray) => void) {
  const canvas = borrowReadbackCanvas(source.width, source.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return source;
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  mutator(image.data);
  context.putImageData(image, 0, 0);
  return canvas;
}

function cssFilterEffect(source: HTMLCanvasElement, effect: Effect, frame: number, filter: string) {
  const mix = mixWithOriginalAmount(effect, frame);
  if (mix >= 0.999) return source;
  return blendWithOriginal(source, filteredCanvas(source, filter), mix);
}

function hueSaturationCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  if (mix >= 0.999) return source;
  const hueShift = effectNumberValue(effect, "hue", frame) / 360;
  const saturationScale = Math.max(0, 1 + effectNumberValue(effect, "saturation", frame) / 100);
  const lightnessShift = effectNumberValue(effect, "lightness", frame) / 100;

  return blendWithOriginal(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      const hsl = rgbToHsl(data[index], data[index + 1], data[index + 2]);
      hsl[0] = ((hsl[0] + hueShift) % 1 + 1) % 1;
      hsl[1] = clampUnit(hsl[1] * saturationScale);
      hsl[2] = clampUnit(hsl[2] + lightnessShift);
      const [r, g, b] = hslToRgb(hsl);
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
    }
  }), mix);
}

function booleanEffectValue(effect: Effect, key: string, fallback = false) {
  const value = effectStaticValue(effect, key);
  return typeof value === "boolean" ? value : fallback;
}

function numericEffectValue(effect: Effect, key: string, frame: number, fallback: number) {
  const control = effect.controls[key];
  return isEffectNumberControl(control) ? effectNumberValue(effect, key, frame) : fallback;
}

function glowSpreadPadding(layer: Layer, frame: number) {
  return layer.effects.reduce((padding, effect) => {
    if (effect.enabled === false || effect.type !== "glow") return padding;
    const radius = Math.max(0, numericEffectValue(effect, "radius", frame, 20));
    const intensity = Math.max(0, numericEffectValue(effect, "intensity", frame, 100));
    const mix = mixWithOriginalAmount(effect, frame);
    if (radius <= 0 || intensity <= 0 || mix >= 0.999) return padding;
    return Math.max(padding, Math.ceil(radius * 2.5));
  }, 0);
}

function directionalBlurCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  const distance = Math.max(0, effectNumberValue(effect, "distance", frame));
  if (mix >= 0.999 || distance <= 0) return source;
  const angle = (effectNumberValue(effect, "angle", frame) * Math.PI) / 180;
  const steps = Math.max(3, Math.min(25, Math.ceil(distance / 6)));
  const canvas = canvasLike(source);
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.globalAlpha = 1 / steps;
  for (let index = 0; index < steps; index += 1) {
    const t = steps === 1 ? 0 : index / (steps - 1) - 0.5;
    context.drawImage(source, Math.cos(angle) * distance * t, Math.sin(angle) * distance * t);
  }
  context.globalAlpha = 1;
  return blendWithOriginal(source, canvas, mix);
}

function fillCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  const opacity = effectNumberValue(effect, "opacity", frame) / 100;
  if (mix >= 0.999 || opacity <= 0) return source;
  const [r, g, b] = colorFromHex(effectStaticValue(effect, "color"));
  return blendWithOriginal(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = clampByte(data[index + 3] * opacity);
    }
  }), mix);
}

function tintCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  const amount = effectNumberValue(effect, "amount", frame) / 100;
  if (mix >= 0.999 || amount <= 0) return source;
  const black = colorFromHex(effectStaticValue(effect, "blackColor"));
  const white = colorFromHex(effectStaticValue(effect, "whiteColor"));
  return blendWithOriginal(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      const luminance = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
      const target = [
        black[0] + (white[0] - black[0]) * luminance,
        black[1] + (white[1] - black[1]) * luminance,
        black[2] + (white[2] - black[2]) * luminance,
      ];
      data[index] = clampByte(data[index] + (target[0] - data[index]) * amount);
      data[index + 1] = clampByte(data[index + 1] + (target[1] - data[index + 1]) * amount);
      data[index + 2] = clampByte(data[index + 2] + (target[2] - data[index + 2]) * amount);
    }
  }), mix);
}

// Levels only has 256 possible input byte values per channel, so the black/white/gamma/output
// curve can be precomputed once into a lookup table instead of recomputed per pixel. Doing the
// Math.pow-based gamma curve inline in the pixel loop below meant ~6.2 million Math.pow calls
// for a single 1920x1080 frame (2,073,600 pixels x 3 channels) - measured at 150-250ms of
// blocking main-thread work per Levels application. On an Adjustment Layer (which reprocesses
// the full composite every frame, not just one layer) stacked with just a few video layers,
// that was enough to drop live-preview playback to ~1fps - looking indistinguishable from a
// frozen canvas even though the playhead was technically still advancing. The LUT reduces the
// per-pixel cost to a cheap array read.
function buildLevelsLut(blackInput: number, whiteInput: number, gamma: number, outputBlack: number, outputWhite: number) {
  const lut = new Uint8ClampedArray(256);
  const invGamma = 1 / gamma;
  for (let value = 0; value < 256; value += 1) {
    const normalized = clampUnit((value - blackInput) / (whiteInput - blackInput));
    lut[value] = clampByte(outputBlack + normalized ** invGamma * (outputWhite - outputBlack));
  }
  return lut;
}

function levelsCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  if (mix >= 0.999) return source;
  const blackInput = effectNumberValue(effect, "blackInput", frame);
  const whiteInput = Math.max(blackInput + 1, effectNumberValue(effect, "whiteInput", frame));
  const gamma = Math.max(0.1, effectNumberValue(effect, "gamma", frame));
  const outputBlack = effectNumberValue(effect, "outputBlack", frame);
  const outputWhite = effectNumberValue(effect, "outputWhite", frame);
  const lut = buildLevelsLut(blackInput, whiteInput, gamma, outputBlack, outputWhite);
  return blendWithOriginal(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      data[index] = lut[data[index]];
      data[index + 1] = lut[data[index + 1]];
      data[index + 2] = lut[data[index + 2]];
    }
  }), mix);
}

function curvesCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  if (mix >= 0.999) return source;
  const shadows = effectNumberValue(effect, "shadows", frame);
  const midtones = effectNumberValue(effect, "midtones", frame);
  const highlights = effectNumberValue(effect, "highlights", frame);
  return blendWithOriginal(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      const lum = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
      const delta = shadows * (1 - lum) ** 2 + midtones * Math.max(0, 1 - Math.abs(lum - 0.5) * 2) + highlights * lum ** 2;
      data[index] = clampByte(data[index] + delta);
      data[index + 1] = clampByte(data[index + 1] + delta);
      data[index + 2] = clampByte(data[index + 2] + delta);
    }
  }), mix);
}

// Same fix as Levels above (see buildLevelsLut): the exposure/offset/gamma curve only
// depends on the input byte value, so it's precomputed once into a 256-entry table instead
// of running Math.pow per channel per pixel (~6.2 million calls/frame at 1080p otherwise).
function buildExposureLut(exposure: number, offset: number, gamma: number) {
  const lut = new Uint8ClampedArray(256);
  const invGamma = 1 / gamma;
  for (let value = 0; value < 256; value += 1) {
    const normalized = clampUnit((value / 255) * exposure + offset);
    lut[value] = clampByte(normalized ** invGamma * 255);
  }
  return lut;
}

function exposureCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  if (mix >= 0.999) return source;
  const exposure = 2 ** effectNumberValue(effect, "exposure", frame);
  const offset = effectNumberValue(effect, "offset", frame);
  const gamma = Math.max(0.1, effectNumberValue(effect, "gamma", frame));
  const lut = buildExposureLut(exposure, offset, gamma);
  return blendWithOriginal(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      data[index] = lut[data[index]];
      data[index + 1] = lut[data[index + 1]];
      data[index + 2] = lut[data[index + 2]];
    }
  }), mix);
}

function glowCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  const radius = Math.max(0, numericEffectValue(effect, "radius", frame, 20));
  const intensity = Math.max(0, numericEffectValue(effect, "intensity", frame, 100)) / 100;
  if (mix >= 0.999 || radius <= 0 || intensity <= 0) return source;

  const threshold = clampUnit(numericEffectValue(effect, "threshold", frame, 60) / 100);
  const compositeOriginal = Math.max(0, Math.min(2, Math.round(numericEffectValue(effect, "compositeOriginal", frame, 0))));
  const basedOnAlpha = booleanEffectValue(effect, "basedOnAlpha", false);
  const useSourceColors = booleanEffectValue(effect, "useSourceColors", true);
  const glowColor = colorFromHex(effectStaticValue(effect, "color"));
  const thresholdRange = Math.max(0.001, 1 - threshold);

  const glowSource = imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] / 255;
      const luminance = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
      const rawWeight = basedOnAlpha ? alpha : (luminance - threshold) / thresholdRange;
      const weight = clampUnit(rawWeight) ** 0.75;

      if (useSourceColors) {
        data[index] = clampByte(data[index]);
        data[index + 1] = clampByte(data[index + 1]);
        data[index + 2] = clampByte(data[index + 2]);
      } else {
        data[index] = glowColor[0];
        data[index + 1] = glowColor[1];
        data[index + 2] = glowColor[2];
      }
      data[index + 3] = clampByte(alpha * weight * 255);
    }
  });

  const wideGlow = filteredCanvas(glowSource, `blur(${radius}px)`);
  const tightGlow = filteredCanvas(glowSource, `blur(${Math.max(0.25, radius * 0.35)}px)`);
  const glow = canvasLike(source);
  const glowContext = glow.getContext("2d");
  if (!glowContext) return source;
  glowContext.globalCompositeOperation = "lighter";
  glowContext.globalAlpha = 0.85;
  glowContext.drawImage(wideGlow, 0, 0);
  glowContext.globalAlpha = 0.45;
  glowContext.drawImage(tightGlow, 0, 0);
  glowContext.globalAlpha = 0.18;
  glowContext.drawImage(glowSource, 0, 0);
  glowContext.globalAlpha = 1;
  glowContext.globalCompositeOperation = "source-over";

  const output = canvasLike(source);
  const context = output.getContext("2d");
  if (!context) return source;

  if (compositeOriginal === 1) {
    context.globalCompositeOperation = "lighter";
    context.globalAlpha = intensity;
    context.drawImage(glow, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.drawImage(source, 0, 0);
  } else if (compositeOriginal === 2) {
    context.globalAlpha = intensity;
    context.drawImage(glow, 0, 0);
    context.globalAlpha = 1;
  } else {
    context.drawImage(source, 0, 0);
    context.globalCompositeOperation = "lighter";
    context.globalAlpha = intensity;
    context.drawImage(glow, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  }

  return blendWithOriginal(source, output, mix);
}

function dropShadowCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  if (mix >= 0.999) return source;
  const opacity = effectNumberValue(effect, "opacity", frame) / 100;
  const distance = effectNumberValue(effect, "distance", frame);
  const angle = (effectNumberValue(effect, "angle", frame) * Math.PI) / 180;
  const blur = effectNumberValue(effect, "blur", frame);
  const [r, g, b] = colorFromHex(effectStaticValue(effect, "color"));
  const canvas = canvasLike(source);
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.shadowColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;
  context.shadowBlur = blur;
  context.shadowOffsetX = Math.cos(angle) * distance;
  context.shadowOffsetY = Math.sin(angle) * distance;
  context.drawImage(source, 0, 0);
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.drawImage(source, 0, 0);
  return blendWithOriginal(source, canvas, mix);
}

function noiseCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  const amount = effectNumberValue(effect, "amount", frame) * 1.28;
  if (mix >= 0.999 || amount <= 0) return source;
  const monochrome = Boolean(effectStaticValue(effect, "monochrome"));
  const seedFrame = Math.round(frame);
  return blendWithOriginal(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      const seed = (index * 9301 + seedFrame * 49297) % 233280;
      const noise = (seed / 233280 - 0.5) * amount;
      if (monochrome) {
        data[index] = clampByte(data[index] + noise);
        data[index + 1] = clampByte(data[index + 1] + noise);
        data[index + 2] = clampByte(data[index + 2] + noise);
      } else {
        data[index] = clampByte(data[index] + noise);
        data[index + 1] = clampByte(data[index + 1] - noise * 0.7);
        data[index + 2] = clampByte(data[index + 2] + noise * 0.4);
      }
    }
  }), mix);
}

function sharpenCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  const amount = effectNumberValue(effect, "amount", frame) / 100;
  if (mix >= 0.999 || amount <= 0) return source;
  const blurred = filteredCanvas(source, "blur(1px)");
  // Both of these get read back via getImageData below, every frame this effect is active -
  // pull them from the dedicated readback pool (see imageDataCanvas) rather than the general
  // one, same reasoning as Levels/Exposure: without it, `blurred.getContext(2d, {willReadFrequently})`
  // was a no-op anyway, since filteredCanvas() had already created that canvas's context (via
  // the general pool) a moment earlier - the hint only takes on a canvas's *first* getContext call.
  const canvas = borrowReadbackCanvas(source.width, source.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const softCanvas = borrowReadbackCanvas(source.width, source.height);
  const blurredContext = softCanvas.getContext("2d", { willReadFrequently: true });
  if (!context || !blurredContext) return source;
  context.drawImage(source, 0, 0);
  blurredContext.drawImage(blurred, 0, 0);
  const sharp = context.getImageData(0, 0, canvas.width, canvas.height);
  const soft = blurredContext.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < sharp.data.length; index += 4) {
    sharp.data[index] = clampByte(sharp.data[index] + (sharp.data[index] - soft.data[index]) * amount);
    sharp.data[index + 1] = clampByte(sharp.data[index + 1] + (sharp.data[index + 1] - soft.data[index + 1]) * amount);
    sharp.data[index + 2] = clampByte(sharp.data[index + 2] + (sharp.data[index + 2] - soft.data[index + 2]) * amount);
  }
  context.putImageData(sharp, 0, 0);
  return blendWithOriginal(source, canvas, mix);
}

// Suppresses green/blue-screen fringing left on kept foreground pixels (hair, motion
// blur edges) by pulling the key color's dominant channel back down toward the other two
// whenever it's still spiking - the same "simple" spill-suppression approach used by
// OBS's chroma key filter, just applied per pixel here.
function suppressChromaSpill(r: number, g: number, b: number, dominantIndex: 0 | 1 | 2, amount: number): [number, number, number] {
  if (amount <= 0) return [r, g, b];
  const channels: [number, number, number] = [r, g, b];
  const dominant = channels[dominantIndex];
  const otherA = channels[(dominantIndex + 1) % 3];
  const otherB = channels[(dominantIndex + 2) % 3];
  const maxOther = Math.max(otherA, otherB);
  if (dominant <= maxOther) return [r, g, b];
  channels[dominantIndex] = dominant - (dominant - maxOther) * amount;
  return channels;
}

function chromaKeyCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = mixWithOriginalAmount(effect, frame);
  if (mix >= 0.999) return source;

  const [kr, kg, kb] = colorFromHex(effectStaticValue(effect, "keyColor"));
  const similarity = clampUnit(numericEffectValue(effect, "similarity", frame, 35) / 100);
  const smoothness = clampUnit(numericEffectValue(effect, "smoothness", frame, 12) / 100);
  const spillAmount = clampUnit(numericEffectValue(effect, "spillSuppression", frame, 50) / 100);
  const showMatte = booleanEffectValue(effect, "showMatte", false);

  // Comparing normalized (unit-length) color vectors instead of raw RGB makes the key
  // tolerant of the brightness/shadow variation real green-screen footage always has -
  // a pixel that's a darker or lighter shade of the same key hue still reads as "close".
  const keyLength = Math.sqrt(kr * kr + kg * kg + kb * kb) || 1;
  const nkr = kr / keyLength;
  const nkg = kg / keyLength;
  const nkb = kb / keyLength;
  const dominantIndex: 0 | 1 | 2 = kr >= kg && kr >= kb ? 0 : kg >= kb ? 1 : 2;

  const maxDistance = 1.35;
  const cutoff = maxDistance * similarity;
  const halfRange = Math.max(0.01, maxDistance * smoothness * 0.6 + 0.02);
  const edge0 = Math.max(0, cutoff - halfRange);
  const edge1 = cutoff + halfRange;
  const edgeSpan = Math.max(0.0001, edge1 - edge0);

  const processed = imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const alpha = data[index + 3];

      const length = Math.sqrt(r * r + g * g + b * b) || 1;
      const distance = Math.sqrt((r / length - nkr) ** 2 + (g / length - nkg) ** 2 + (b / length - nkb) ** 2);

      const t = clampUnit((distance - edge0) / edgeSpan);
      const keyAlpha = t * t * (3 - 2 * t); // smoothstep: soft, not-jagged cutout edge

      if (showMatte) {
        const gray = clampByte(keyAlpha * 255);
        data[index] = gray;
        data[index + 1] = gray;
        data[index + 2] = gray;
        data[index + 3] = 255;
        continue;
      }

      const [nextR, nextG, nextB] = keyAlpha > 0 ? suppressChromaSpill(r, g, b, dominantIndex, spillAmount) : [r, g, b];
      data[index] = clampByte(nextR);
      data[index + 1] = clampByte(nextG);
      data[index + 2] = clampByte(nextB);
      data[index + 3] = clampByte(alpha * keyAlpha);
    }
  });

  return blendWithOriginal(source, processed, mix);
}

function applyEffectCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  if (effect.enabled === false) return source;
  if (effect.type === "colorGrading") return applyColorGradingShader(source, effect, frame);
  if (effect.type === "hueSaturation") return hueSaturationCanvas(source, effect, frame);

  if (effect.type === "brightnessContrast") {
    const brightness = Math.max(0, 100 + effectNumberValue(effect, "brightness", frame));
    const contrast = Math.max(0, 100 + effectNumberValue(effect, "contrast", frame));
    return cssFilterEffect(source, effect, frame, `brightness(${brightness}%) contrast(${contrast}%)`);
  }

  if (effect.type === "gaussianBlur") return cssFilterEffect(source, effect, frame, `blur(${Math.max(0, effectNumberValue(effect, "blur", frame))}px)`);
  if (effect.type === "invert") return cssFilterEffect(source, effect, frame, `invert(${Math.max(0, effectNumberValue(effect, "amount", frame))}%)`);
  if (effect.type === "directionalBlur") return directionalBlurCanvas(source, effect, frame);
  if (effect.type === "fill") return fillCanvas(source, effect, frame);
  if (effect.type === "tint") return tintCanvas(source, effect, frame);
  if (effect.type === "levels") return levelsCanvas(source, effect, frame);
  if (effect.type === "curves") return curvesCanvas(source, effect, frame);
  if (effect.type === "exposure") return exposureCanvas(source, effect, frame);
  if (effect.type === "dropShadow") return dropShadowCanvas(source, effect, frame);
  if (effect.type === "glow") return glowCanvas(source, effect, frame);
  if (effect.type === "noiseGrain") return noiseCanvas(source, effect, frame);
  if (effect.type === "sharpen") return sharpenCanvas(source, effect, frame);
  if (effect.type === "chromaKey") return chromaKeyCanvas(source, effect, frame);
  return source;
}

function applyLayerEffects(source: HTMLCanvasElement, layer: Layer, frame: number) {
  return layer.effects.reduce((canvas, effect) => applyEffectCanvas(canvas, effect, frame), source);
}

function applyAdjustmentLayerToCanvas(canvas: HTMLCanvasElement, composition: Composition, layer: Layer, frame: number) {
  if (layer.effects.length === 0) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const processed = applyLayerEffects(canvas, layer, frame);
  const opacity = clampUnit(evaluateProperty(layer.transform.opacity, frame) / 100);
  const adjusted = opacity < 0.999 ? blendCanvas(canvas, processed, opacity) : processed;
  const output = applyAdjustmentLayerMask(canvas, adjusted, composition, layer, frame);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(output, 0, 0, canvas.width, canvas.height);
}

function maskCenter(points: MaskPath): Vector2 {
  if (points.length === 0) return [0, 0];
  const total = points.reduce<Vector2>((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
  return [total[0] / points.length, total[1] / points.length];
}

function evaluatedMaskPoints(mask: Mask, frame: number): MaskPath {
  const path = evaluatePathProperty(mask.path, frame);
  const position = evaluateProperty(mask.position, frame);
  const scale = evaluateProperty(mask.scale, frame);
  const center = maskCenter(path);

  return path.map((point) => [
    center[0] + (point[0] - center[0]) * (scale[0] / 100) + position[0],
    center[1] + (point[1] - center[1]) * (scale[1] / 100) + position[1],
  ]);
}

function drawPolygonPath(context: CanvasRenderingContext2D, points: MaskPath, closePath = true) {
  if (points.length === 0) return;
  context.beginPath();
  context.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach((point) => context.lineTo(point[0], point[1]));
  if (closePath && points.length > 2) context.closePath();
}

function applyAdjustmentLayerMask(
  original: HTMLCanvasElement,
  adjusted: HTMLCanvasElement,
  composition: Composition,
  layer: Layer,
  frame: number,
) {
  if (layer.masks.length === 0) return adjusted;

  const width = original.width;
  const height = original.height;
  const maskCanvas = borrowScratchCanvas(width, height);
  const maskContext = maskCanvas.getContext("2d");
  if (!maskContext) return adjusted;

  layer.masks.forEach((mask) => {
    const points = evaluatedMaskPoints(mask, frame).map((point) => layerPointToComposition(composition, layer, frame, point));
    if (points.length < 3) return;

    const feather = Math.max(0, evaluateProperty(mask.feather, frame));
    maskContext.save();
    if (feather > 0) maskContext.filter = `blur(${feather}px)`;

    if (mask.inverted) {
      maskContext.fillStyle = "#fff";
      maskContext.fillRect(0, 0, width, height);
      maskContext.globalCompositeOperation = "destination-out";
    }

    maskContext.fillStyle = "#fff";
    drawPolygonPath(maskContext, points);
    maskContext.fill();
    maskContext.restore();
  });

  const maskedAdjusted = borrowScratchCanvas(width, height);
  const maskedContext = maskedAdjusted.getContext("2d");
  if (!maskedContext) return adjusted;
  maskedContext.drawImage(adjusted, 0, 0, width, height);
  maskedContext.globalCompositeOperation = "destination-in";
  maskedContext.drawImage(maskCanvas, 0, 0);
  maskedContext.globalCompositeOperation = "source-over";

  const output = borrowScratchCanvas(width, height);
  const outputContext = output.getContext("2d");
  if (!outputContext) return adjusted;
  outputContext.drawImage(original, 0, 0, width, height);
  outputContext.drawImage(maskedAdjusted, 0, 0, width, height);
  return output;
}

// The single point where a layer's fully rendered (masked + effected) content actually
// lands on the shared composition canvas, on top of whatever layers beneath it already
// drew. Blend mode only ever needs to apply right here - every canvas 2D compositeOperation
// value maps 1:1 to a Photoshop/AE blend mode name (see lib/blendModes.ts), so this is a
// plain drawImage with the operation swapped in and restored afterward.
function drawLayerCompositeResult(context: CanvasRenderingContext2D, layer: Layer, canvas: HTMLCanvasElement, dx: number, dy: number) {
  const operation = compositeOperationForBlendMode(layer.blendMode);
  if (operation === "source-over") {
    context.drawImage(canvas, dx, dy);
    return;
  }
  context.save();
  context.globalCompositeOperation = operation;
  context.drawImage(canvas, dx, dy);
  context.restore();
}

function drawMaskedLayerContent(
  context: CanvasRenderingContext2D,
  composition: Composition,
  layer: Layer,
  frame: number,
  images: Map<string, HTMLImageElement>,
  videos: Map<string, HTMLVideoElement>,
  fps: number,
  liveVideoPlayback: boolean,
  activeCamera?: Layer,
  exportFrameLocked = false,
  exportVideoFrames?: ExportVideoFrames,
  liveTimeRemapFrames?: Map<string, WrappedCanvas | null>,
) {
  const [width, height] = getLayerSize(layer);
  const effectPadding = glowSpreadPadding(layer, frame);
  const contentCanvas = borrowScratchCanvas(Math.ceil(width + effectPadding * 2), Math.ceil(height + effectPadding * 2));
  const contentContext = contentCanvas.getContext("2d");

  if (!contentContext) {
    drawLayerContent(context, composition, layer, images, videos, frame, fps, liveVideoPlayback, activeCamera, exportFrameLocked, exportVideoFrames, liveTimeRemapFrames);
    return;
  }

  contentContext.save();
  contentContext.translate(effectPadding, effectPadding);
  drawLayerContent(contentContext, composition, layer, images, videos, frame, fps, liveVideoPlayback, activeCamera, exportFrameLocked, exportVideoFrames, liveTimeRemapFrames);
  contentContext.restore();

  if (layer.masks.length > 0) {
    const maskCanvas = borrowScratchCanvas(contentCanvas.width, contentCanvas.height);
    const maskContext = maskCanvas.getContext("2d");

    if (!maskContext) {
      drawLayerCompositeResult(context, layer, applyLayerEffects(contentCanvas, layer, frame), -effectPadding, -effectPadding);
      return;
    }

    layer.masks.forEach((mask) => {
      const points = evaluatedMaskPoints(mask, frame);
      if (points.length < 3) return;

      const feather = Math.max(0, evaluateProperty(mask.feather, frame));
      maskContext.save();
      if (feather > 0) maskContext.filter = `blur(${feather}px)`;

      if (mask.inverted) {
        maskContext.fillStyle = "#fff";
        maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskContext.globalCompositeOperation = "destination-out";
      }

      maskContext.translate(effectPadding, effectPadding);
      maskContext.fillStyle = "#fff";
      drawPolygonPath(maskContext, points);
      maskContext.fill();
      maskContext.restore();
    });

    contentContext.globalCompositeOperation = "destination-in";
    contentContext.drawImage(maskCanvas, 0, 0);
    contentContext.globalCompositeOperation = "source-over";
  }

  drawLayerCompositeResult(context, layer, applyLayerEffects(contentCanvas, layer, frame), -effectPadding, -effectPadding);
}
function drawMaskOutlines(context: CanvasRenderingContext2D, layer: Layer, frame: number, selectedMaskId?: string) {
  layer.masks.forEach((mask) => {
    const points = evaluatedMaskPoints(mask, frame);
    if (points.length < 2) return;
    const selected = mask.id === selectedMaskId;
    context.save();
    context.strokeStyle = selected ? "#f2b84b" : "rgba(57, 208, 200, 0.75)";
    context.fillStyle = selected ? "#f2b84b" : "#39d0c8";
    context.lineWidth = selected ? 2.5 : 1.5;
    context.setLineDash(selected ? [] : [8, 5]);
    drawPolygonPath(context, points);
    context.stroke();
    context.setLineDash([]);
    points.forEach((point) => context.fillRect(point[0] - 3, point[1] - 3, 6, 6));
    context.restore();
  });
}

function drawLayerOverlay(
  context: CanvasRenderingContext2D,
  composition: Composition,
  layer: Layer,
  frame: number,
  selectedMaskId?: string,
  activeCamera?: Layer,
) {
  const [width, height] = getLayerSize(layer);
  context.save();
  applyLayerTransform(context, composition, layer, frame, activeCamera);
  context.globalAlpha = 1;
  context.lineWidth = 3;
  context.strokeStyle = "#f2b84b";
  context.setLineDash([14, 8]);
  context.strokeRect(0, 0, width, height);
  context.setLineDash([]);
  context.fillStyle = "#f2b84b";
  const handle = 16;
  [[0, 0], [width, 0], [width, height], [0, height]].forEach(([x, y]) => {
    context.fillRect(x - handle / 2, y - handle / 2, handle, handle);
  });
  drawMaskOutlines(context, layer, frame, selectedMaskId);
  context.restore();
}

function drawCameraLayerOverlay(
  context: CanvasRenderingContext2D,
  composition: Composition,
  layer: Layer,
  frame: number,
) {
  const [width, height] = getLayerSize(layer);
  context.save();
  applyLayerTransform(context, composition, layer, frame);
  context.globalAlpha = 1;
  context.lineWidth = 3;
  context.strokeStyle = "#f2b84b";
  context.fillStyle = "#f2b84b";
  context.setLineDash([14, 8]);
  context.strokeRect(0, 0, width, height);
  context.setLineDash([]);

  const bodyWidth = Math.max(54, width * 0.42);
  const bodyHeight = Math.max(36, height * 0.32);
  const bodyX = width * 0.22;
  const bodyY = height * 0.32;
  context.strokeRect(bodyX, bodyY, bodyWidth, bodyHeight);
  context.beginPath();
  context.moveTo(bodyX + bodyWidth, bodyY + bodyHeight * 0.28);
  context.lineTo(width * 0.86, height * 0.22);
  context.lineTo(width * 0.86, height * 0.78);
  context.lineTo(bodyX + bodyWidth, bodyY + bodyHeight * 0.72);
  context.closePath();
  context.stroke();
  context.beginPath();
  context.arc(bodyX + bodyWidth * 0.34, bodyY + bodyHeight * 0.5, Math.max(7, Math.min(bodyWidth, bodyHeight) * 0.2), 0, Math.PI * 2);
  context.stroke();

  const handle = 16;
  [[0, 0], [width, 0], [width, height], [0, height]].forEach(([x, y]) => {
    context.fillRect(x - handle / 2, y - handle / 2, handle, handle);
  });
  context.restore();
}
function drawAdjustmentLayerOverlay(
  context: CanvasRenderingContext2D,
  composition: Composition,
  layer: Layer,
  frame: number,
  selectedMaskId?: string,
) {
  const [width, height] = getLayerSize(layer);
  context.save();
  applyLayerTransform(context, composition, layer, frame);
  context.globalAlpha = 1;
  context.lineWidth = 3;
  context.strokeStyle = "#f2b84b";
  context.setLineDash([14, 8]);
  context.strokeRect(0, 0, width, height);
  context.setLineDash([]);
  context.fillStyle = "#f2b84b";
  const handle = 16;
  [[0, 0], [width, 0], [width, height], [0, height]].forEach(([x, y]) => {
    context.fillRect(x - handle / 2, y - handle / 2, handle, handle);
  });
  drawMaskOutlines(context, layer, frame, selectedMaskId);
  context.restore();
}

function transformMotionAmount(composition: Composition, layer: Layer, frame: number) {
  const previousFrame = Math.max(layer.startFrame, frame - 1);
  if (previousFrame === frame) return 0;

  const currentPosition = getWorldPosition(composition, layer, frame);
  const previousPosition = getWorldPosition(composition, layer, previousFrame);
  const currentScale = evaluateProperty(layer.transform.scale, frame);
  const previousScale = evaluateProperty(layer.transform.scale, previousFrame);
  const currentRotation = evaluateProperty(layer.transform.rotation, frame);
  const previousRotation = evaluateProperty(layer.transform.rotation, previousFrame);

  const positionAmount = Math.hypot(currentPosition[0] - previousPosition[0], currentPosition[1] - previousPosition[1]);
  const scaleAmount = Math.hypot(currentScale[0] - previousScale[0], currentScale[1] - previousScale[1]) * 2.2;
  const rotationAmount = Math.abs(currentRotation - previousRotation) * 3.5;

  return positionAmount + scaleAmount + rotationAmount;
}
function drawLayer(
  context: CanvasRenderingContext2D,
  composition: Composition,
  layer: Layer,
  frame: number,
  images: Map<string, HTMLImageElement>,
  videos: Map<string, HTMLVideoElement>,
  selected: boolean,
  selectedMaskId?: string,
  liveVideoPlayback = false,
  activeCamera?: Layer,
  exportFrameLocked = false,
  exportVideoFrames?: ExportVideoFrames,
  liveTimeRemapFrames?: Map<string, WrappedCanvas | null>,
) {
  const fps = finiteNumber(composition.fps, 30);
  const motionAmount = composition.motionBlur && layer.motionBlur ? transformMotionAmount(composition, layer, frame) : 0;
  const sampleCount = motionAmount > 0.25 ? Math.min(8, Math.max(2, Math.ceil(motionAmount / 28))) : 1;
  const shutterFrames = sampleCount > 1 ? Math.min(0.85, Math.max(0.22, motionAmount / 90)) : 0;

  const drawContentSample = (sampleFrame: number, alphaScale: number) => {
    const opacity = evaluateProperty(layer.transform.opacity, sampleFrame);
    const contentFrame = layer.type === "video" ? frame : sampleFrame;

    context.save();
    context.globalAlpha = (opacity / 100) * alphaScale;
    applyLayerTransform(context, composition, layer, sampleFrame);
    drawMaskedLayerContent(context, composition, layer, contentFrame, images, videos, fps, liveVideoPlayback, activeCamera, exportFrameLocked, exportVideoFrames, liveTimeRemapFrames);
    context.restore();
  };

  if (sampleCount > 1) {
    for (let index = sampleCount - 1; index >= 0; index -= 1) {
      const amount = index / Math.max(1, sampleCount - 1);
      const sampleFrame = Math.max(layer.startFrame, frame - shutterFrames * amount);
      const alphaScale = index === 0 ? 0.55 : 0.45 / Math.max(1, sampleCount - 1);
      drawContentSample(sampleFrame, alphaScale);
    }
  } else {
    drawContentSample(frame, 1);
  }

  if (selected) drawLayerOverlay(context, composition, layer, frame, selectedMaskId, activeCamera);
}
function drawDraftMask(
  context: CanvasRenderingContext2D,
  composition: Composition,
  layer: Layer,
  frame: number,
  draft: MaskDraft,
  activeCamera?: Layer,
) {
  const points = draft.hover ? [...draft.points, draft.hover] : draft.points;
  if (points.length === 0) return;

  context.save();
  applyLayerTransform(context, composition, layer, frame, activeCamera);
  context.strokeStyle = "#39d0c8";
  context.fillStyle = "#39d0c8";
  context.lineWidth = 2;
  context.setLineDash([9, 6]);
  drawPolygonPath(context, points, false);
  context.stroke();
  context.setLineDash([]);
  draft.points.forEach((point, index) => {
    context.beginPath();
    context.arc(point[0], point[1], index === 0 && draft.points.length > 2 ? 6 : 4, 0, Math.PI * 2);
    context.fill();
  });
  context.restore();
}


// Keyed by layer.id. Populated once per output frame during export (see
// buildExportVideoDecoders / exportCompositionVideo) by pulling the next decoded picture out
// of each video layer's own deterministic mediabunny/WebCodecs decoder - see the
// exportFrameLocked branch in drawLayerContent for why this replaced seeking a live <video>
// element as the source of exported pixels. A missing entry (or an explicit `null`, meaning
// the decoder ran but had no frame yet for this timestamp) falls back to the older
// cache/live-element path.
type ExportVideoFrames = Map<string, WrappedCanvas | null>;

type RenderCompositionFrameOptions = {
  images: Map<string, HTMLImageElement>;
  videos: Map<string, HTMLVideoElement>;
  selectedLayerIds?: string[];
  selectedMaskId?: string;
  maskDraft?: MaskDraft | null;
  showGrid?: boolean;
  showGuides?: boolean;
  showBounds?: boolean;
  showTransparencyGrid?: boolean;
  includeOverlays?: boolean;
  liveVideoPlayback?: boolean;
  // Set only by export (see exportCompositionVideo): tells the video-drawing path to trust
  // the frame-accurate snapshot prepareVideosForExportFrame just captured into
  // videoFrameCache for this exact frame, instead of the live <video> element - which is
  // deliberately left playing between export frames (for continuous audio capture) and so
  // can no longer be trusted to still be showing that exact instant by the time drawing
  // actually happens. See the exportFrameLocked branch in drawLayerContent for the full story.
  exportFrameLocked?: boolean;
  // Set only by export: this frame's already-decoded picture for every video layer that has
  // a working deterministic decoder, see ExportVideoFrames above.
  exportVideoFrames?: ExportVideoFrames;
  // Set only by live preview (see CompositionCanvas()): this exact frame's already-decoded
  // picture, keyed by layer id, for every Time Remapped video layer that has a working
  // LiveTimeRemapDecoder - see that type's comment for why Time Remap playback needs this
  // instead of just trusting a live <video> element's seek to have resolved in time.
  liveTimeRemapFrames?: Map<string, WrappedCanvas | null>;
};

function renderCompositionFrame(
  context: CanvasRenderingContext2D,
  composition: Composition,
  frame: number,
  options: RenderCompositionFrameOptions,
) {
  const selectedLayerIds = options.selectedLayerIds ?? [];
  const showBounds = options.showBounds ?? false;

  // Every masked/effected layer below borrows scratch canvases from the shared pool.
  // Resetting here (once per full frame render, whether live preview or export) lets
  // those canvases be reused frame-to-frame instead of reallocated, which is what was
  // causing playback and export to stutter under load.
  resetScratchCanvasPool();
  resetReadbackCanvasPool();
  configureHighQualityContext(context);

  context.clearRect(0, 0, composition.width, composition.height);
  if (composition.backgroundTransparent) {
    if (options.showTransparencyGrid) drawTransparencyGrid(context, composition);
  } else {
    context.fillStyle = composition.backgroundColor;
    context.fillRect(0, 0, composition.width, composition.height);
  }

  if (options.showGrid) drawGrid(context, composition);

  const soloActive = composition.layers.some((layer) => layer.solo);
  const activeCamera = activeCameraLayer(composition, frame);
  const drawableLayers = composition.layers
    .slice()
    .reverse()
    .filter((layer) => shouldDrawLayer(layer, frame, soloActive));
  const contentCanvas = borrowScratchCanvas(composition.width, composition.height);
  const contentContext = contentCanvas.getContext("2d");

  if (contentContext) {
    drawableLayers.forEach((layer) => {
      if (layer.type === "adjustment") {
        applyAdjustmentLayerToCanvas(contentCanvas, composition, layer, frame);
        return;
      }
      drawLayer(contentContext, composition, layer, frame, options.images, options.videos, false, options.selectedMaskId, options.liveVideoPlayback, activeCamera, options.exportFrameLocked, options.exportVideoFrames, options.liveTimeRemapFrames);
    });
    context.drawImage(contentCanvas, 0, 0, composition.width, composition.height);
  } else {
    drawableLayers
      .filter((layer) => layer.type !== "adjustment")
      .forEach((layer) => drawLayer(context, composition, layer, frame, options.images, options.videos, false, options.selectedMaskId, options.liveVideoPlayback, activeCamera, options.exportFrameLocked, options.exportVideoFrames, options.liveTimeRemapFrames));
  }

  if (options.includeOverlays) {
    drawableLayers
      .filter((layer) => selectedLayerIds.includes(layer.id))
      .forEach((layer) => {
        if (layer.type === "camera") drawCameraLayerOverlay(context, composition, layer, frame);
        else if (layer.type === "adjustment") drawAdjustmentLayerOverlay(context, composition, layer, frame, options.selectedMaskId);
        else drawLayerOverlay(context, composition, layer, frame, options.selectedMaskId, activeCamera);
      });

    if (options.maskDraft) {
      const layer = composition.layers.find((candidate) => candidate.id === options.maskDraft?.layerId);
      if (layer) drawDraftMask(context, composition, layer, frame, options.maskDraft, activeCamera);
    }
  }

  if (options.showGuides) drawGuides(context, composition);

  if (showBounds) {
    context.strokeStyle = "#596579";
    context.lineWidth = 3;
    context.strokeRect(0, 0, composition.width, composition.height);
  }
}
function hitTestLayer(composition: Composition, layer: Layer, frame: number, point: Vector2, activeCamera?: Layer) {
  const [width, height] = getLayerSize(layer);
  const local = compositionToLayerPoint(composition, layer, frame, point, activeCamera);
  return local[0] >= 0 && local[0] <= width && local[1] >= 0 && local[1] <= height;
}

function distance(a: Vector2, b: Vector2) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

type MaskVertexHit = {
  layer: Layer;
  mask: Mask;
  pointIndex: number;
};

function maskVertexHitForLayer(
  composition: Composition,
  layer: Layer,
  frame: number,
  point: Vector2,
  threshold: number,
  selectedMaskId?: string,
  activeCamera?: Layer,
): MaskVertexHit | undefined {
  const orderedMasks = [
    ...layer.masks.filter((mask) => mask.id === selectedMaskId),
    ...layer.masks.filter((mask) => mask.id !== selectedMaskId),
  ];
  let closest: MaskVertexHit | undefined;
  let closestDistance = threshold;

  orderedMasks.forEach((mask) => {
    evaluatedMaskPoints(mask, frame).forEach((maskPoint, pointIndex) => {
      const compositionPoint = layerPointToComposition(composition, layer, frame, maskPoint, activeCamera);
      const currentDistance = distance(point, compositionPoint);
      if (currentDistance <= closestDistance) {
        closest = { layer, mask, pointIndex };
        closestDistance = currentDistance;
      }
    });
  });

  return closest;
}

function maskScaleDragFactor(scale: Vector2, pointCount: number): Vector2 {
  const count = Math.max(1, pointCount);
  const scaleX = scale[0] / 100;
  const scaleY = scale[1] / 100;
  const factorX = scaleX + (1 - scaleX) / count;
  const factorY = scaleY + (1 - scaleY) / count;
  return [Math.abs(factorX) < 0.001 ? 1 : factorX, Math.abs(factorY) < 0.001 ? 1 : factorY];
}


type ExportVideoDetail = {
  compositionId?: string;
  filename?: string;
  settings?: VideoExportSettings;
  jobId?: string;
};

type VideoExportStatusDetail = {
  message: string;
  jobId?: string;
  percent?: number;
  phase?: "rendering" | "done" | "error";
};

function emitVideoExportStatus(message: string, detail?: Omit<VideoExportStatusDetail, "message">) {
  window.dispatchEvent(new CustomEvent<VideoExportStatusDetail>(EXPORT_VIDEO_STATUS_EVENT, { detail: { message, ...detail } }));
}

function videoExportFileBaseName(name: string) {
  return name.trim().replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "composition";
}

function downloadVideoBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type ResolvedVideoExportFormat = {
  outputFormat: Mp4OutputFormat | WebMOutputFormat;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec | undefined;
  extension: "mp4" | "webm";
  mimeType: string;
};

// Picks real, WebCodecs-encodable codecs up front (rather than assuming avc/aac always
// work, the way the old MediaRecorder.isTypeSupported() string-matching did) so the
// export never silently fails partway through with an unsupported-codec encoder error.
// MP4/H.264+AAC is preferred for broad compatibility (matches "Export as MP4"); WebM/VP9
// (or VP8)+Opus is the fallback for browsers that can't encode H.264.
async function resolveVideoExportFormat(
  width: number,
  height: number,
  settings: VideoExportSettings,
): Promise<ResolvedVideoExportFormat> {
  const allowMp4 = settings.container !== "webm";
  const allowWebm = settings.container !== "mp4";

  if (allowMp4 && (await canEncodeVideo("avc", { width, height }))) {
    const audioCodec: AudioCodec | undefined = (await canEncodeAudio("aac"))
      ? "aac"
      : (await canEncodeAudio("opus"))
        ? "opus"
        : undefined;
    return { outputFormat: new Mp4OutputFormat(), videoCodec: "avc", audioCodec, extension: "mp4", mimeType: "video/mp4" };
  }

  if (allowWebm) {
    const videoCodec: VideoCodec = (await canEncodeVideo("vp9", { width, height })) ? "vp9" : "vp8";
    const audioCodec: AudioCodec | undefined = (await canEncodeAudio("opus")) ? "opus" : undefined;
    return { outputFormat: new WebMOutputFormat(), videoCodec, audioCodec, extension: "webm", mimeType: "video/webm" };
  }

  throw new Error("This browser cannot encode video in the requested format.");
}

const VIDEO_QUALITY_BITRATE_FACTOR: Record<VideoExportSettings["quality"], number> = {
  "very-low": 0.03,
  low: 0.05,
  medium: 0.09,
  high: 0.14,
  "very-high": 0.22,
};

function videoQualityForExport(settings: VideoExportSettings, width: number, height: number, outputFps: number): Quality {
  if (settings.customBitrateMbps && settings.customBitrateMbps > 0) {
    return new Quality({ bitrate: Math.round(settings.customBitrateMbps * 1_000_000) });
  }
  const pixels = Math.max(1, width * height);
  const factor = VIDEO_QUALITY_BITRATE_FACTOR[settings.quality] ?? VIDEO_QUALITY_BITRATE_FACTOR.high;
  const bitrate = Math.round(Math.min(50_000_000, Math.max(1_000_000, pixels * outputFps * factor)));
  return new Quality({ bitrate });
}

function waitForExportDelay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, milliseconds)));
}

function waitForImageForExport(image: HTMLImageElement) {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      image.removeEventListener("load", finish);
      image.removeEventListener("error", finish);
      resolve();
    };
    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", finish, { once: true });
    window.setTimeout(finish, 2500);
  });
}

function waitForMediaMetadataForExport(media: HTMLMediaElement) {
  if (media.readyState >= 1) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      media.removeEventListener("loadedmetadata", finish);
      media.removeEventListener("error", finish);
      resolve();
    };
    media.addEventListener("loadedmetadata", finish, { once: true });
    media.addEventListener("error", finish, { once: true });
    media.load();
    window.setTimeout(finish, 2500);
  });
}

async function seekVideoForExport(media: HTMLMediaElement, time: number, tolerance = 0.045) {
  await waitForMediaMetadataForExport(media);
  if (Math.abs(media.currentTime - time) <= tolerance && media.readyState >= 2) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      media.removeEventListener("seeked", finish);
      media.removeEventListener("loadeddata", finish);
      media.removeEventListener("error", finish);
      resolve();
    };
    media.addEventListener("seeked", finish, { once: true });
    media.addEventListener("loadeddata", finish, { once: true });
    media.addEventListener("error", finish, { once: true });
    safeSeekMedia(media, time);
    window.setTimeout(finish, 1200);
  });
}

// NOTE ON A DEAD END, kept as a record so it doesn't get reintroduced: 'seeked' firing does not
// guarantee the compositor has actually painted the decoded picture for the new position yet,
// which briefly looked like the cause of an export that stayed frozen on its first frame despite
// seekVideoForExport correctly moving video.currentTime forward every frame. The fix tried here
// was awaiting one requestVideoFrameCallback after each seek before drawing - the standard
// technique for frame-accurate video capture. It looked right in isolation, but under this app's
// real per-frame load (several video layers plus an Adjustment Layer's Levels/Blur) it made
// things worse: direct diagnostic logging showed the seek itself consistently landing on the
// correct currentTime, and then that EXTRA wait consistently reading currentTime back as 0
// afterward. The actual fix ended up being simpler and is in prepareVideosForExportFrame below:
// pause before seeking (removes the "seeking a moving target" race a playing video creates) and
// verify-with-retry after, without any extra frame-presented wait.
function waitForModelForExport(modelUrl: string) {
  const cachedModel = modelCache.get(modelUrl);
  return cachedModel?.promise ?? Promise.resolve();
}
async function waitForExportAssets(
  composition: Composition,
  images: Map<string, HTMLImageElement>,
  videos: Map<string, HTMLVideoElement>,
  audios: Map<string, HTMLAudioElement>,
) {
  const imageTasks = composition.layers
    .map((layer) => layer.source?.imageUrl ? images.get(layer.source.imageUrl) : undefined)
    .filter((image): image is HTMLImageElement => Boolean(image))
    .map(waitForImageForExport);
  const videoTasks = composition.layers
    .map((layer) => layer.source?.videoUrl ? videos.get(layer.source.videoUrl) : undefined)
    .filter((video): video is HTMLVideoElement => Boolean(video))
    .map(waitForMediaMetadataForExport);
  const audioTasks = composition.layers
    .map((layer) => layer.source?.audioUrl ? audios.get(layer.source.audioUrl) : undefined)
    .filter((audio): audio is HTMLAudioElement => Boolean(audio))
    .map(waitForMediaMetadataForExport);
  const modelTasks = composition.layers
    .map((layer) => layer.source?.modelUrl)
    .filter((modelUrl): modelUrl is string => Boolean(modelUrl))
    .map(waitForModelForExport);
  await Promise.all([...imageTasks, ...videoTasks, ...audioTasks, ...modelTasks]);
}

function audioLayerActiveAtFrame(layer: Layer, frame: number, soloActive: boolean) {
  return layer.visible !== false && (!soloActive || layer.solo) && frame >= layer.startFrame && frame < layer.endFrame;
}

// Dedicated audio layers aren't drawn (shouldDrawLayer excludes them), but the export
// recording needs them played and paused in lockstep with the composition frame just like
// video layers, so their sound lands at the right point in the exported timeline.
//
// Unlike video (see prepareVideosForExportFrame below - that one now reseeks every frame for
// correctness, since a video layer showing the wrong instant is immediately, visibly wrong)
// audio has no per-frame "captured content" to get wrong - it's a continuous stream, so the
// only failure mode here is drifting far enough to be audibly out of place, which is a much
// bigger and rarer miss than a single video frame being a fraction of a second off. Kept on
// the coarser drift tolerance rather than reseeking every frame, since reseeking a *playing*
// audio element periodically clicks/glitches, and doing that every single frame for no audible
// benefit would be a straight regression.
const AUDIO_CONTINUOUS_DRIFT_TOLERANCE = 1;

async function prepareAudioLayersForExportFrame(
  composition: Composition,
  frame: number,
  audios: Map<string, HTMLAudioElement>,
  startedLayers: Set<string>,
) {
  const soloActive = composition.layers.some((layer) => layer.solo);
  const fps = finiteNumber(composition.fps, 30);

  await Promise.all(composition.layers.map(async (layer) => {
    const audioUrl = layer.source?.audioUrl;
    if (!audioUrl) return;
    const audio = audios.get(audioUrl);
    if (!audio) return;

    if (!audioLayerActiveAtFrame(layer, frame, soloActive)) {
      if (!audio.paused) audio.pause();
      // Pausing here means a later reactivation is a fresh start, not a continuation - drop
      // it so that frame gets an actual resync seek instead of being trusted like ongoing
      // continuous playback (see AUDIO_CONTINUOUS_DRIFT_TOLERANCE above).
      startedLayers.delete(layer.id);
      return;
    }

    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const targetTime = mediaTimeForFrame(layer, frame, fps, duration);
    const alreadyStarted = startedLayers.has(layer.id);
    const needsSeek = !alreadyStarted || Math.abs(audio.currentTime - targetTime) > AUDIO_CONTINUOUS_DRIFT_TOLERANCE;
    if (needsSeek) {
      await seekVideoForExport(audio, targetTime, 0.06);
      startedLayers.add(layer.id);
    }

    audio.playbackRate = 1;
    if (audio.paused) await audio.play().catch(() => undefined);
  }));
}

// MediaRecorder can only capture audio from a MediaStream, and canvas.captureStream()
// only ever carries video. The video/audio elements that play live during export need to
// be routed through the Web Audio API into a MediaStreamAudioDestinationNode so their
// sound reaches the recorder at all - previously nothing did this, so every exported
// video was silent regardless of how much audio was in the timeline.
//
// A given HTMLMediaElement can only ever be tapped by createMediaElementSource() once in
// its lifetime, and doing so reroutes its audio output through the Web Audio graph from
// then on. These elements are cached and reused across exports (and for live preview), so
// each node is created at most once and always reconnected back to the real audio
// destination - that keeps normal playback sounding exactly as it did before it was ever
// tapped, on this export and any future one.
const exportAudioSourceNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
let exportAudioContext: AudioContext | null = null;

function getExportAudioContext(): AudioContext | null {
  const Ctor = typeof window !== "undefined" ? window.AudioContext : undefined;
  if (!Ctor) return null;
  if (!exportAudioContext || exportAudioContext.state === "closed") {
    exportAudioContext = new Ctor();
  }
  return exportAudioContext;
}

function tapMediaElementForExportAudio(
  audioContext: AudioContext,
  destination: MediaStreamAudioDestinationNode,
  element: HTMLMediaElement,
) {
  let node = exportAudioSourceNodes.get(element);
  if (!node) {
    try {
      node = audioContext.createMediaElementSource(element);
    } catch {
      // Cross-origin media without CORS clearance can't be tapped by Web Audio; the
      // export continues picture-only for that layer rather than failing outright.
      return undefined;
    }
    exportAudioSourceNodes.set(element, node);
    node.connect(audioContext.destination);
  }
  node.connect(destination);
  return node;
}

function buildExportAudioGraph(composition: Composition, videos: Map<string, HTMLVideoElement>, audios: Map<string, HTMLAudioElement>) {
  const audioContext = getExportAudioContext();
  if (!audioContext) return undefined;

  const destination = audioContext.createMediaStreamDestination();
  const tappedNodes: MediaElementAudioSourceNode[] = [];

  composition.layers.forEach((layer) => {
    if (layer.type === "audio" && layer.source?.audioUrl) {
      const audio = audios.get(layer.source.audioUrl);
      if (audio) {
        const node = tapMediaElementForExportAudio(audioContext, destination, audio);
        if (node) tappedNodes.push(node);
      }
    }

    // Time-remapped video is paused and seeked frame-by-frame for picture accuracy, so
    // it never plays in real time and has no meaningful audio to capture here.
    if (layer.type === "video" && layer.source?.videoUrl && !layer.source.timeRemap) {
      const video = videos.get(layer.source.videoUrl);
      if (video) {
        const node = tapMediaElementForExportAudio(audioContext, destination, video);
        if (node) tappedNodes.push(node);
      }
    }
  });

  return { audioContext, destination, tappedNodes };
}

// PREVIOUS APPROACH (kept here as a record of why it's wrong - do not reintroduce): once a
// video layer's element was up and playing, this trusted it to "stay naturally in sync" with
// each frame's target time on its own, only correcting if it drifted by more than a full
// second. That assumed renderCompositionFrame takes roughly the same, small amount of real
// wall-clock time every frame - but it doesn't: a frame with heavy effects (an Adjustment
// Layer's Levels/Blur running over the full composite, several video layers at once, ...) can
// take many times longer to composite than a light one. The video element keeps decoding and
// advancing in REAL time the whole time renderCompositionFrame is running (export renders with
// liveVideoPlayback: true, so drawLayerContent draws whatever the video is showing *right now*
// rather than seeking it - see the playbackDriven branch there), so after a slow frame the
// video has raced ahead of where that frame's timestamp says it should be. The captured frame
// then shows content from further into the clip than its assigned output timestamp implies.
// That by itself is just "frames a little later than they should be" - survivable. What made
// it look actively broken was the occasional correction once drift finally exceeded the
// 1-second tolerance: that reseek snaps the video BACK to the correct target, so the very next
// captured frame shows earlier content than the frame before it. Export timestamps only ever
// increase, but the content behind them was zig-zagging forward and backward in time -
// exactly the "jumping forward and backward during playback" symptom.
//
// Frame-accurate export has to seek every video layer to its exact target time for every
// frame, not just occasionally. The seek helper below (seekVideoForExport) is safe to call
// every frame - unlike the OLDER bug this file also used to have (see the export reseek-loop
// history elsewhere in this file), it awaits the real 'seeked'/'loadeddata' event rather than
// polling readyState, and within a single frame each seek only starts after the previous one
// on that same element actually finished - see the dedupe step below, which is what makes
// that true.
async function prepareVideosForExportFrame(
  composition: Composition,
  frame: number,
  videos: Map<string, HTMLVideoElement>,
  startedLayers: Set<string>,
) {
  const soloActive = composition.layers.some((layer) => layer.solo);
  const fps = finiteNumber(composition.fps, 30);

  // Layers only reference a video URL, not a private decode instance - two layers using the
  // same source file (the same clip imported twice, or duplicated) share one HTMLVideoElement
  // via the `videos` cache. Once every active layer seeks every frame (rather than rarely, as
  // before), that stopped being harmless: composition.layers.map(...) below fires once per
  // LAYER, so two layers on the same element issued two concurrent seeks to it in the same
  // frame via Promise.all - both racing to set .currentTime, both listening for the next
  // 'seeked' event to resolve. Whichever assignment physically lands last "wins" the position,
  // but either listener can be the one whose event fires and resolves - so a layer could
  // finish believing it seeked to its own target while the element actually sat at the OTHER
  // layer's target the whole time. With this triggering on every single frame instead of
  // rarely, the result wasn't occasional confusion, it was a video that never reliably reached
  // any layer's real target - which looked exactly like a frozen frame throughout the export.
  // Deduping by the resolved video element first means each one gets exactly one seek request
  // per frame, from whichever layer using it is topmost (composition.layers is already
  // front-to-back - see renderCompositionFrame's `.slice().reverse()` - so the first match is
  // the one that actually ends up visible when layers using the same source overlap).
  const seeksByVideo = new Map<HTMLVideoElement, { layer: Layer; targetTime: number }>();
  composition.layers.forEach((layer) => {
    const videoUrl = layer.source?.videoUrl;
    if (!videoUrl || !shouldDrawLayer(layer, frame, soloActive)) return;
    const video = videos.get(videoUrl);
    if (!video || seeksByVideo.has(video)) return;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    seeksByVideo.set(video, { layer, targetTime: mediaTimeForFrame(layer, frame, fps, duration) });
  });

  // Seeking every layer's video CONCURRENTLY (the original approach here) turned out to
  // overload Chromium's decode pipeline once more than one video is being paused/seeked/read
  // back every single frame: isolated, a single video's pause-seek-confirm loop tracked its
  // targets perfectly, but running that same logic for 3 layers at once via Promise.all
  // produced readbacks that were sporadically just wrong - a seek that had just been confirmed
  // correct would read back as currentTime 0 moments later, for no reason attributable to our
  // own logic (confirmed via direct diagnostic logging of every stage: beforeTime/afterSeekTime
  // correct, afterRvfcTime suddenly 0). That is decoder resource contention, not a race in this
  // code - so the fix is to stop creating the contention: seek layers one at a time instead of
  // concurrently. This makes export prep time scale with layer count instead of being roughly
  // flat, but a correct, slower export beats a fast, visibly broken one.
  for (const [video, { layer, targetTime }] of seeksByVideo.entries()) {
    if (layer.source?.timeRemap) {
      video.pause();
      // See the retry-loop comment on the non-time-remapped path below for why this no longer
      // awaits an extra requestVideoFrameCallback round after the seek: that extra wait was
      // itself the source of corrupted readbacks under this app's real per-frame load, not a
      // fix for one. A short retry loop is what actually keeps this converged now.
      let remapVerifiedTime = video.currentTime;
      for (let attempt = 0; attempt < 5 && (Math.abs(remapVerifiedTime - targetTime) > 0.02 || video.readyState < 2); attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 30));
        await seekVideoForExport(video, targetTime);
        remapVerifiedTime = video.currentTime;
      }
      // Pin this exact, now-confirmed-correct picture into videoFrameCache immediately - see
      // the exportFrameLocked branch in drawLayerContent for why the draw step reads this
      // snapshot instead of the live element. See the non-time-remapped path below for why a
      // failed verification skips the cache write rather than pinning unverified content.
      if (Math.abs(remapVerifiedTime - targetTime) <= 0.02 && video.readyState >= 2 && video.videoWidth > 0) {
        const [layerWidth, layerHeight] = getLayerSize(layer);
        rememberVideoFrame(layer.source.videoUrl!, video, layerWidth, layerHeight);
      }
      continue;
    }

    // Pausing before seeking (this used to only happen for time-remapped layers) matters a lot
    // more now that every frame gets a real seek instead of rare ones: a video left playing
    // during the seek is still decoding forward in real time while the seek is in flight, so
    // the seek is chasing a moving target. Under load - several layers seeking concurrently via
    // Promise.all, plus effects/audio prep, easily pushes a single output frame's prep well
    // past its 1/fps real-time budget - that moving-target race got bad enough to make the
    // *decoded content itself* land on the wrong instant unpredictably (confirmed empirically:
    // an isolated single-video seek-and-confirm loop tracked its targets smoothly and
    // monotonically, but this same seek logic produced visibly erratic, non-monotonic content
    // once three layers were seeking concurrently against continuously-playing video - pausing
    // first removes the race that isolated case didn't have). A paused video's position is
    // fully under our control, so the seek converges to exactly the requested frame instead.
    video.pause();
    // Tight tolerance (well under one output frame's duration) so every captured frame shows
    // content from its own correct point in time - seekVideoForExport already no-ops cheaply
    // when the video happens to already be this close, so this isn't "reseek every frame" in
    // the expensive sense, it's "verify every frame and correct whenever needed."
    //
    // This used to also await an extra requestVideoFrameCallback round after the seek settled,
    // on the theory that 'seeked' can fire slightly before the decoded picture is actually ready
    // to paint. That theory was right for a *playing* video, but empirically wrong once the
    // video is paused first (as it now always is here): direct diagnostic logging under this
    // app's real load (three video layers plus an Adjustment Layer's Levels/Blur, all running
    // every frame) showed the seek itself consistently converging to the correct currentTime,
    // and then that EXTRA wait consistently reading currentTime back as 0 afterward - the wait
    // itself was corrupting the readback, not fixing anything. The same real load can also
    // starve the decoder badly enough that a seek "succeeds" (currentTime reads back correct)
    // but the picture never actually finishes decoding (readyState stuck at HAVE_METADATA). The
    // retry loop below - with a short yield between attempts, giving the decoder an actual turn
    // on the event loop instead of hammering it with another seek immediately - is what actually
    // resolves both of those now that the extra wait is gone.
    const tolerance = 1 / (fps * 2);
    let verifiedTime = video.currentTime;
    for (let attempt = 0; attempt < 5 && (Math.abs(verifiedTime - targetTime) > tolerance || video.readyState < 2); attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 30));
      await seekVideoForExport(video, targetTime, tolerance);
      verifiedTime = video.currentTime;
    }
    const seekSucceeded = Math.abs(verifiedTime - targetTime) <= tolerance && video.readyState >= 2;
    // Pin the confirmed-correct picture right away, before resuming playback below can carry
    // the live element's decode forward past this instant - see the exportFrameLocked branch in
    // drawLayerContent for the full rationale. When every retry above still couldn't get this
    // layer to a verified, decoded position, DON'T overwrite its cache with whatever half-decoded
    // (or plain wrong) picture is currently resident - drawCachedVideoFrame will keep reusing
    // that layer's last genuinely-verified frame for this one output frame instead. A layer
    // occasionally holding its previous frame for an extra 1/30s under heavy resource
    // contention is a minor, forgivable stutter; overwriting the cache with unverified content
    // is exactly what was producing the frozen/jumping/wrong-content exports this was all meant
    // to fix.
    if (seekSucceeded && video.videoWidth > 0) {
      const [layerWidth, layerHeight] = getLayerSize(layer);
      rememberVideoFrame(layer.source!.videoUrl!, video, layerWidth, layerHeight);
    }
    startedLayers.add(layer.id);

    // Resume immediately so this layer's audio (tapped live from this same element - see
    // buildExportAudioGraph) keeps advancing in real time for the rest of this output frame's
    // duration, right up until the pause() at the top of this function on the next frame.
    video.muted = true;
    video.playbackRate = 1;
    await video.play().catch(() => undefined);
  }
}

type ExportVideoDecoder = {
  input: Input;
  // Fed the exact, in-order list of composition timestamps this layer will need across the
  // whole export up front, so mediabunny can decode each source packet at most once even
  // though frames are only actually pulled (via .next()) one at a time as the main export
  // loop reaches each output frame - see the call site in exportCompositionVideo.
  generator: AsyncGenerator<WrappedCanvas | null, void, unknown>;
};

// Builds one deterministic, seek-free decoder per video layer for use during export. This
// exists because extracting frames by seeking a live <video> element - the approach used
// everywhere else in this file, including live preview and scrubbing, where it works fine -
// turned out to be fundamentally unreliable specifically under this app's real per-frame
// export load (multiple video layers plus an Adjustment Layer's effects, all reseeking every
// output frame): video.currentTime reading back as the correct, verified target time does not
// guarantee the picture a subsequent drawImage(video, ...) grabs actually corresponds to that
// instant, and under heavy main-thread contention it measurably didn't, no matter how much
// pause/retry/yield/verification logic got layered on top (see the long comment trail in
// prepareVideosForExportFrame). mediabunny already ships a WebCodecs-based decode path
// (CanvasSink) built for exactly this: given a source file and a list of timestamps, it hands
// back the exact decoded picture for each one, with no live playback/seek race involved at
// all, because there is no live <video> element in this path to race - it reads and decodes
// the encoded bytes directly. The <video>/<audio> elements in `videos`/`audios` are still kept
// playing during export (see prepareVideosForExportFrame and buildExportAudioGraph) purely so
// their audio tracks can still be captured live in real time; this function's output is only
// ever used for pixels, never audio.
async function buildExportVideoDecoders(
  composition: Composition,
  compositionFps: number,
  outputFps: number,
  outputFrameCount: number,
  durationFrames: number,
  videos: Map<string, HTMLVideoElement>,
): Promise<Map<string, ExportVideoDecoder>> {
  const decoders = new Map<string, ExportVideoDecoder>();

  for (const layer of composition.layers) {
    const videoUrl = layer.source?.videoUrl;
    if (layer.type !== "video" || !videoUrl) continue;

    // mediaTimeForFrame needs the SOURCE clip's own duration to clamp against (so a layer
    // trimmed past the end of its source doesn't request an out-of-range timestamp) - the
    // already-loaded live <video> element is a cheap, reliable place to read that from rather
    // than probing the file a second time via the new Input.
    const liveVideo = videos.get(videoUrl);
    const sourceDuration = liveVideo && Number.isFinite(liveVideo.duration) && liveVideo.duration > 0 ? liveVideo.duration : 0;

    // Precompute the exact timestamp this layer needs for every output frame, up front, using
    // the identical nearest-frame resampling the main export loop uses for `frame` itself (see
    // exportCompositionVideo) - this list is what keeps this layer's decoder perfectly in sync
    // with the main loop's per-output-frame iteration below, one canvasesAtTimestamps() result
    // pulled per .next() call.
    const timestamps: number[] = [];
    for (let outFrame = 0; outFrame < outputFrameCount; outFrame += 1) {
      const frame = Math.min(durationFrames - 1, Math.round((outFrame / outputFps) * compositionFps));
      timestamps.push(mediaTimeForFrame(layer, frame, compositionFps, sourceDuration));
    }

    try {
      const input = new Input({ source: new UrlSource(videoUrl), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) {
        input.dispose();
        continue;
      }
      // Some codec/profile combinations a browser can play in a <video> element still aren't
      // accepted by WebCodecs (canDecode is stricter than <video> playback) - confirm this
      // track is actually decodable before committing to it, so an unusual source file falls
      // back to the old live-element path for just that one layer instead of only discovering
      // the problem (and throwing) partway through the export loop below.
      const decodable = await track.canDecode();
      if (!decodable) {
        input.dispose();
        continue;
      }
      const sink = new CanvasSink(track);
      decoders.set(layer.id, { input, generator: sink.canvasesAtTimestamps(timestamps) });
    } catch (error) {
      // Leave this layer without an entry in the map - the exportFrameLocked branch in
      // drawLayerContent falls back to the old live-element/cache path whenever a layer has no
      // decoder, so one layer's unusual/unsupported source file can't fail the whole export.
      console.error(`Deterministic export decoder failed to initialize for video layer "${layer.id}":`, error);
    }
  }

  return decoders;
}

async function exportCompositionVideo(
  composition: Composition,
  images: Map<string, HTMLImageElement>,
  videos: Map<string, HTMLVideoElement>,
  audios: Map<string, HTMLAudioElement>,
  filename?: string,
  rawSettings?: VideoExportSettings,
  jobId?: string,
) {
  const settings = normalizeVideoExportSettings(rawSettings ?? DEFAULT_VIDEO_EXPORT_SETTINGS);

  await waitForExportAssets(composition, images, videos, audios);

  // "Composition fps" drives everything about EVALUATING the timeline: keyframe/property
  // interpolation, video/audio seeking, and shouldDrawLayer's frame-range checks are all
  // keyed to composition-space frame numbers, so `frame` below always stays composition-fps
  // (renamed compositionFps to make that explicit). "Output fps" only controls how many
  // frames actually get *encoded* and at what timestamp/duration each one lands in the file -
  // when it differs from compositionFps, the export loop below resamples to the nearest
  // composition frame for each output frame, the same way changing the frame rate on an
  // After Effects render does.
  const compositionFps = Math.max(1, Math.min(60, finiteNumber(composition.fps, 30)));
  const outputFps = Math.max(1, Math.min(120, settings.fpsOverride ?? compositionFps));
  const durationFrames = Math.max(1, Math.round(finiteNumber(composition.durationFrames, compositionFps * 10)));
  const durationSeconds = durationFrames / compositionFps;
  const outputFrameCount = Math.max(1, Math.round(durationSeconds * outputFps));
  const compositionWidth = Math.max(1, Math.round(composition.width));
  const compositionHeight = Math.max(1, Math.round(composition.height));
  const { width: exportWidth, height: exportHeight } = scaledExportDimensions(
    compositionWidth,
    compositionHeight,
    settings.resolutionScale,
  );

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = exportWidth;
  exportCanvas.height = exportHeight;
  const exportContext = exportCanvas.getContext("2d");
  if (!exportContext) throw new Error("Could not create video export canvas.");
  // renderCompositionFrame always draws in composition-space coordinates (it clears/fills
  // using composition.width/height directly); scaling the context once up front lets the
  // export canvas be a different physical size (for resolution-scale presets) without
  // touching the renderer itself.
  if (exportWidth !== compositionWidth || exportHeight !== compositionHeight) {
    exportContext.scale(exportWidth / compositionWidth, exportHeight / compositionHeight);
  }

  const { outputFormat, videoCodec, audioCodec, extension, mimeType } = await resolveVideoExportFormat(
    exportWidth,
    exportHeight,
    settings,
  );

  const audioGraph = buildExportAudioGraph(composition, videos, audios);
  if (audioGraph?.audioContext.state === "suspended") {
    await audioGraph.audioContext.resume().catch(() => undefined);
  }

  const output = new Output({ format: outputFormat, target: new BufferTarget() });

  // CanvasSource.add(timestamp, duration) captures the canvas's current bitmap the moment
  // it's called and hands it directly to the encoder with an EXACT, caller-supplied
  // timestamp/duration - unlike the previous captureStream()-based pipeline, there is no
  // browser-internal capture timer or MediaStream track in between that can race the draw
  // call, drop frames, or (as happened before) leave the container's per-frame duration
  // undeclared and have the muxer guess wrong. This is what actually fixes both the
  // "2s composition exported as a ~1 minute video" bug and the frozen/duplicated-frame
  // stretches found while re-testing that fix.
  const videoSource = new CanvasSource(exportCanvas, {
    codec: videoCodec,
    quality: videoQualityForExport(settings, exportWidth, exportHeight, outputFps),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: outputFps });

  // Audio still has to be captured in real time: it comes from actual <video>/<audio>
  // element playback (so pitch/timing stay correct), routed through the Web Audio API
  // into a MediaStreamAudioDestinationNode, same as before. MediaStreamAudioTrackSource
  // pulls from that live track and timestamps it against the same zero point as the
  // video track, so the two stay in sync even though video frames are added deterministically.
  const audioTrack = audioGraph?.destination.stream.getAudioTracks()[0];
  const audioSource = audioTrack && audioCodec
    ? new MediaStreamAudioTrackSource(audioTrack, { codec: audioCodec, quality: new Quality("high") })
    : undefined;
  if (audioSource) {
    output.addAudioTrack(audioSource);
    // Never resolves, only rejects - swallow it here (rather than leave it as an unhandled
    // rejection) since an audio-capture hiccup shouldn't be allowed to crash the whole
    // export; the resulting file just ends up silent or short on audio in that case.
    audioSource.errorPromise.catch((error) => {
      console.error("Audio export capture error:", error);
    });
  }

  await output.start();

  const startedAt = performance.now();
  const progressStep = Math.max(1, Math.round(outputFps / 4));
  let cancelled = false;

  // Audio is captured live from real-time media playback, so its recorded length tracks
  // however long this loop actually takes to run - not the composition's configured
  // duration. Normally those match because the delay below paces the loop to real time,
  // but if a single frame ever takes longer to prepare than its time budget (a slow video
  // seek being the main offender - see prepareVideosForExportFrame/seekVideoForExport,
  // which can block for up to 1.2s per frame on some source footage), the loop simply runs
  // behind and audio keeps recording for every extra second that takes. Previously that
  // meant a stalled seek could silently balloon the exported file to many times the
  // composition's length, with the video frozen on its last frame for the overrun (the
  // video track itself always stays exactly outputFrameCount/outputFps long, since
  // CanvasSource.add() below is given exact timestamps regardless of loop pacing). This
  // timer hard-caps captured audio to the intended output duration independent of how
  // long the frame loop takes, so a slow seek can only make the export take longer in
  // wall-clock time - it can no longer make the exported file itself longer.
  const targetOutputSeconds = outputFrameCount / outputFps;
  const audioCutoffTimer = audioSource
    ? window.setTimeout(() => audioSource.pause(), Math.round(targetOutputSeconds * 1000))
    : undefined;

  // Tracks which layers' media elements have already been started (seeked once + playing)
  // this export, so later frames trust their continuous real-time playback instead of
  // re-seeking every frame - see the comment on CONTINUOUS_DRIFT_TOLERANCE above.
  const startedMediaLayers = new Set<string>();

  // See buildExportVideoDecoders for the full rationale: this is what actually supplies the
  // pixels for every exported video layer now, independent of and in parallel with the
  // <video> elements below (which still run every frame, but now purely to keep audio capture
  // live and in sync - see prepareVideosForExportFrame).
  const videoDecoders = await buildExportVideoDecoders(composition, compositionFps, outputFps, outputFrameCount, durationFrames, videos);

  try {
    for (let outFrame = 0; outFrame < outputFrameCount; outFrame += 1) {
      // Nearest-frame resampling from output-timeline seconds back to a composition frame
      // number. When outputFps === compositionFps this reduces to `frame = outFrame` exactly.
      const frame = Math.min(durationFrames - 1, Math.round((outFrame / outputFps) * compositionFps));
      const exportVideoFrames: ExportVideoFrames = new Map();
      await Promise.all([
        prepareVideosForExportFrame(composition, frame, videos, startedMediaLayers),
        prepareAudioLayersForExportFrame(composition, frame, audios, startedMediaLayers),
        ...[...videoDecoders.entries()].map(async ([layerId, decoder]) => {
          const { value, done } = await decoder.generator.next();
          exportVideoFrames.set(layerId, done ? null : (value ?? null));
        }),
      ]);
      renderCompositionFrame(exportContext, composition, frame, {
        images,
        videos,
        includeOverlays: false,
        showGrid: false,
        showGuides: false,
        showBounds: false,
        showTransparencyGrid: false,
        liveVideoPlayback: true,
        exportFrameLocked: true,
        exportVideoFrames,
      });
      await videoSource.add(outFrame / outputFps, 1 / outputFps);

      if (outFrame === 0 || outFrame % progressStep === 0 || outFrame === outputFrameCount - 1) {
        const percent = Math.min(100, Math.round(((outFrame + 1) / outputFrameCount) * 100));
        emitVideoExportStatus(`Rendering video ${percent}%`, { jobId, percent, phase: "rendering" });
      }

      // Audio is being captured live from realtime media playback, so the export still
      // has to run no faster than real time or the captured audio would run short/skip.
      // Video frame timestamps above are exact regardless of this loop's actual pacing,
      // so any jitter here no longer affects the output file's correctness, only how
      // closely wall-clock export time tracks composition duration.
      const nextFrameDueAt = startedAt + ((outFrame + 1) / outputFps) * 1000;
      await waitForExportDelay(nextFrameDueAt - performance.now());
    }
  } catch (error) {
    cancelled = true;
    await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (audioCutoffTimer !== undefined) window.clearTimeout(audioCutoffTimer);
    audioSource?.pause();
    videos.forEach((video) => video.pause());
    audios.forEach((audio) => audio.pause());
    videoDecoders.forEach((decoder) => {
      try {
        decoder.input.dispose();
      } catch {
        // Already disposed or never fully initialized - safe to ignore during cleanup.
      }
    });
    audioGraph?.tappedNodes.forEach((node) => {
      try {
        node.disconnect(audioGraph.destination);
      } catch {
        // Already disconnected (e.g. export threw before the graph fully wired up).
      }
    });
  }

  if (cancelled) return;
  await output.finalize();

  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error("Video export failed to produce output data.");
  const blob = new Blob([buffer], { type: mimeType });

  downloadVideoBlob(blob, `${videoExportFileBaseName(filename ?? composition.name)}.${extension}`);
  emitVideoExportStatus(
    extension === "mp4" ? "MP4 export downloaded" : "MP4 unavailable in this browser, downloaded WebM video",
    { jobId, percent: 100, phase: "done" },
  );
}
export function CompositionCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  // Video/audio elements are never shown directly - they only ever get read from via
  // drawImage()/Web Audio taps - so they used to just live in memory, never attached to the
  // document. Chrome (and Chromium/Electron) is free to throttle or outright stop decoding
  // video frames for a <video> that was never inserted into the DOM, especially once it's
  // been playing a little while; the element's `currentTime` can keep ticking upward the
  // whole time even after decode has actually stalled, so the drift-based resync checks
  // elsewhere never notice anything is wrong (the reported time is "correct") while the
  // actual pixels drawImage() reads stay frozen on whatever frame decoding stopped on. That
  // silent stall - not a seeking bug - is what was producing playback (and, since export
  // reuses these same cached elements, exported video) that looked fine for the first
  // second or so and then froze/went choppy indefinitely. Keeping every video/audio element
  // attached here (invisible, zero footprint, but genuinely part of the document) keeps
  // Chrome treating them as live, continuously-decoding media instead of background/detached
  // ones eligible for that throttling.
  const mediaHostRef = useRef<HTMLDivElement | null>(null);
  const imageCache = useRef(new Map<string, HTMLImageElement>());
  const videoCache = useRef(new Map<string, HTMLVideoElement>());
  const audioCache = useRef(new Map<string, HTMLAudioElement>());
  // See LiveTimeRemapDecoder above: one persistent mediabunny/WebCodecs decoder per
  // time-remapped video layer, keyed by layer id, reconciled by the effect below and consumed
  // by the canvas-drawing effect further down.
  const liveTimeRemapDecoders = useRef(new Map<string, LiveTimeRemapDecoder>());
  const liveTimeRemapGeneration = useRef(0);
  const [liveTimeRemapVersion, setLiveTimeRemapVersion] = useState(0);
  const exportInProgressRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const [maskDraft, setMaskDraft] = useState<MaskDraft | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [mediaVersion, setMediaVersion] = useState(0);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const project = useEditorStore((state) => state.project);
  const activeCompositionId = useEditorStore((state) => state.activeCompositionId);
  const selectedLayerIds = useEditorStore((state) => state.selectedLayerIds);
  const selectedMaskId = useEditorStore((state) => state.selectedMaskId);
  const activeTool = useEditorStore((state) => state.activeTool);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const playheadFrame = useEditorStore((state) => state.playheadFrame);
  const canvasZoom = useEditorStore((state) => state.canvasZoom);
  const canvasPan = useEditorStore((state) => state.canvasPan);
  const showGrid = useEditorStore((state) => state.showGrid);
  const showGuides = useEditorStore((state) => state.showGuides);
  const selectLayer = useEditorStore((state) => state.selectLayer);
  const setCanvasPan = useEditorStore((state) => state.setCanvasPan);
  const updateTransformValue = useEditorStore((state) => state.updateTransformValue);
  const updateTextLayer = useEditorStore((state) => state.updateTextLayer);
  const updateMediaLayerSize = useEditorStore((state) => state.updateMediaLayerSize);
  const addPolygonMask = useEditorStore((state) => state.addPolygonMask);
  const updateMaskValue = useEditorStore((state) => state.updateMaskValue);
  const selectMask = useEditorStore((state) => state.selectMask);
  const setActiveTool = useEditorStore((state) => state.setActiveTool);

  const composition = useMemo(
    () => project.compositions.find((item) => item.id === activeCompositionId),
    [activeCompositionId, project.compositions],
  );

  // Opens/closes LiveTimeRemapDecoders to match exactly the set of video layers that currently
  // have Time Remapping on, mirroring buildExportVideoDecoders's own open logic. Runs whenever
  // the composition object changes (a new layer, a layer's timeRemap/videoUrl toggling, a
  // different active composition) - cheap to over-run since it no-ops for any layer whose
  // decoder is already open with a matching videoUrl.
  useEffect(() => {
    const decoders = liveTimeRemapDecoders.current;
    if (!composition) {
      decoders.forEach((decoder) => {
        decoder.disposed = true;
        decoder.input.dispose();
      });
      decoders.clear();
      return;
    }

    liveTimeRemapGeneration.current += 1;
    const generation = liveTimeRemapGeneration.current;

    const neededLayers = new Map<string, string>();
    composition.layers.forEach((layer) => {
      if (layer.type === "video" && layer.source?.videoUrl && layer.source.timeRemap) {
        neededLayers.set(layer.id, layer.source.videoUrl);
      }
    });

    decoders.forEach((decoder, layerId) => {
      const neededUrl = neededLayers.get(layerId);
      if (neededUrl === undefined || neededUrl !== decoder.videoUrl) {
        decoder.disposed = true;
        decoder.input.dispose();
        decoders.delete(layerId);
      }
    });

    neededLayers.forEach((videoUrl, layerId) => {
      if (decoders.has(layerId)) return;
      (async () => {
        try {
          const input = new Input({ source: new UrlSource(videoUrl), formats: ALL_FORMATS });
          const track = await input.getPrimaryVideoTrack();
          if (!track) {
            input.dispose();
            return;
          }
          // Same stricter-than-<video>-playback decodability check export already relies on
          // (see buildExportVideoDecoders) - an unusual/unsupported codec just means this one
          // layer keeps using the old live-element seek path instead of failing anything.
          const decodable = await track.canDecode();
          if (!decodable || liveTimeRemapGeneration.current !== generation || decoders.has(layerId)) {
            input.dispose();
            return;
          }
          const sink = new CanvasSink(track);
          decoders.set(layerId, {
            input,
            sink,
            videoUrl,
            cache: new Map(),
            cacheOrder: [],
            pendingFrame: null,
            desiredFrame: null,
            desiredTargetTime: null,
            disposed: false,
          });
          setLiveTimeRemapVersion((version) => version + 1);
        } catch (error) {
          console.error(`Live time-remap decoder failed to initialize for video layer "${layerId}":`, error);
        }
      })();
    });
  }, [composition]);

  // Final cleanup only - disposes every open decoder when the canvas itself unmounts (the
  // effect above already handles disposing individual decoders as layers/compositions change).
  useEffect(() => {
    return () => {
      liveTimeRemapDecoders.current.forEach((decoder) => {
        decoder.disposed = true;
        decoder.input.dispose();
      });
      liveTimeRemapDecoders.current.clear();
    };
  }, []);

  useEffect(() => {
    const onExportVideo = (event: Event) => {
      const detail = (event as CustomEvent<ExportVideoDetail>).detail ?? {};
      if (!composition) return;
      if (detail.compositionId && detail.compositionId !== composition.id) {
        // A queued render job targeting a composition that isn't the active one right now
        // (the Render Queue switches the active composition before dispatching each job,
        // but the switch may not have propagated to this listener's closure yet). Reporting
        // this explicitly - instead of silently ignoring the event - keeps the queue from
        // hanging forever waiting for a status update that would otherwise never arrive.
        emitVideoExportStatus("Waiting for composition to become active…", { jobId: detail.jobId, phase: "rendering", percent: 0 });
        return;
      }
      if (exportInProgressRef.current) {
        emitVideoExportStatus("Video export already running", { jobId: detail.jobId, phase: "error" });
        return;
      }

      exportInProgressRef.current = true;
      emitVideoExportStatus("Rendering video 0%", { jobId: detail.jobId, phase: "rendering", percent: 0 });
      void exportCompositionVideo(
        composition,
        imageCache.current,
        videoCache.current,
        audioCache.current,
        detail.filename,
        detail.settings,
        detail.jobId,
      )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Video export failed.";
          emitVideoExportStatus(message, { jobId: detail.jobId, phase: "error" });
        })
        .finally(() => {
          exportInProgressRef.current = false;
          if (!useEditorStore.getState().isPlaying) {
            videoCache.current.forEach((video) => video.pause());
            audioCache.current.forEach((audio) => audio.pause());
          }
        });
    };

    window.addEventListener(EXPORT_VIDEO_EVENT, onExportVideo);
    return () => window.removeEventListener(EXPORT_VIDEO_EVENT, onExportVideo);
  }, [composition]);

  const finishMaskDraft = (draft: MaskDraft | null) => {
    if (!draft || draft.points.length < 3) return;
    addPolygonMask(draft.layerId, draft.points);
    setMaskDraft(null);
  };

  const startTextEdit = (layer: Layer) => {
    selectLayer(layer.id);
    dragRef.current = null;
    setTextEdit({ layerId: layer.id, value: layer.source?.text ?? layer.name });
  };

  const commitTextEdit = () => {
    if (!textEdit) return;
    updateTextLayer(textEdit.layerId, textEdit.value);
    setTextEdit(null);
  };

  const hitLayerAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !composition) return undefined;
    const point = screenToComposition(canvas, composition, canvasZoom, canvasPan, clientX, clientY);
    const soloActive = composition.layers.some((layer) => layer.solo);
    const activeCamera = activeCameraLayer(composition, playheadFrame);
    return composition.layers.find((layer) => layer.type !== "adjustment" && shouldDrawLayer(layer, playheadFrame, soloActive) && !layer.locked && hitTestLayer(composition, layer, playheadFrame, point, activeCamera));
  };

  const hitMaskVertexAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !composition) return undefined;
    const point = screenToComposition(canvas, composition, canvasZoom, canvasPan, clientX, clientY);
    const currentPlacement = placement(canvas, composition, canvasZoom, canvasPan);
    const rect = canvas.getBoundingClientRect();
    const canvasPixelRatio = canvas.width / Math.max(1, rect.width);
    const threshold = (12 * canvasPixelRatio) / currentPlacement.scale;
    const soloActive = composition.layers.some((layer) => layer.solo);
    const activeCamera = activeCameraLayer(composition, playheadFrame);
    const drawableLayers = composition.layers.filter((layer) => shouldDrawLayer(layer, playheadFrame, soloActive) && !layer.locked && layer.masks.length > 0);
    const selectedLayers = selectedLayerIds
      .map((layerId) => drawableLayers.find((layer) => layer.id === layerId))
      .filter((layer): layer is Layer => Boolean(layer));
    const orderedLayers = [
      ...selectedLayers,
      ...drawableLayers.filter((layer) => !selectedLayerIds.includes(layer.id)),
    ];

    for (const layer of orderedLayers) {
      const hit = maskVertexHitForLayer(composition, layer, playheadFrame, point, threshold, selectedMaskId, activeCamera);
      if (hit) return hit;
    }

    return undefined;
  };

  useEffect(() => {
    if (!textEdit) return;
    requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.select();
    });
  }, [textEdit?.layerId]);

  useEffect(() => {
    if (!composition) return;
    composition.layers.forEach((layer) => {
      const imageUrl = layer.source?.imageUrl;
      if (imageUrl && !imageCache.current.has(imageUrl)) {
        const image = new Image();
        image.onload = () => {
          if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            updateMediaLayerSize(layer.id, image.naturalWidth, image.naturalHeight, layer.source?.width, layer.source?.height);
          }
          setMediaVersion((version) => version + 1);
        };
        image.src = imageUrl;
        imageCache.current.set(imageUrl, image);
      }

      const videoUrl = layer.source?.videoUrl;
      if (videoUrl && !videoCache.current.has(videoUrl)) {
        const video = document.createElement("video");
        video.src = videoUrl;
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.crossOrigin = "anonymous";
        ["loadedmetadata", "loadeddata", "seeked", "canplay", "canplaythrough", "progress", "waiting", "stalled"].forEach((eventName) => {
          video.addEventListener(eventName, () => {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              updateMediaLayerSize(layer.id, video.videoWidth, video.videoHeight, layer.source?.width, layer.source?.height);
            }
            setMediaVersion((version) => version + 1);
          });
        });
        video.load();
        mediaHostRef.current?.appendChild(video);
        videoCache.current.set(videoUrl, video);
      }

      const audioUrl = layer.source?.audioUrl;
      if (audioUrl && !audioCache.current.has(audioUrl)) {
        const audio = document.createElement("audio");
        audio.src = audioUrl;
        audio.preload = "auto";
        audio.crossOrigin = "anonymous";
        ["loadedmetadata", "loadeddata", "seeked", "canplay"].forEach((eventName) => {
          audio.addEventListener(eventName, () => setMediaVersion((version) => version + 1));
        });
        audio.load();
        mediaHostRef.current?.appendChild(audio);
        audioCache.current.set(audioUrl, audio);
      }

      const modelUrl = layer.source?.modelUrl;
      if (modelUrl && !modelCache.has(modelUrl)) {
        const cachedModel: CachedModel = { status: "loading" };
        const loader = new GLTFLoader();
        loader.setCrossOrigin("anonymous");
        cachedModel.promise = new Promise((resolve) => {
          loader.load(
            modelUrl,
            (gltf) => {
              cachedModel.status = "ready";
              cachedModel.scene = gltf.scene;
              setMediaVersion((version) => version + 1);
              resolve();
            },
            undefined,
            (error) => {
              cachedModel.status = "error";
              cachedModel.error = error;
              setMediaVersion((version) => version + 1);
              resolve();
            },
          );
        });
        modelCache.set(modelUrl, cachedModel);
      }
    });
  }, [composition, updateMediaLayerSize]);
  useEffect(() => {
    if (!composition) return;
    // Export drives these same cached <video> elements itself, frame by frame, entirely
    // independently of this component's isPlaying/playheadFrame state (the editor's playhead
    // just sits still while an export runs). Every seek the export issues fires a native
    // 'seeked' event, which the media-cache setup above turns into a setMediaVersion() bump -
    // that's a dependency of this very effect, so each of the export's per-frame seeks was
    // re-running this effect in the middle of the export. With isPlaying still false and
    // playheadFrame still wherever the editor's playhead was left (frame 0, if export was
    // kicked off without ever pressing play), canUseLivePlayback came out false every time,
    // so this effect immediately paused the video and reseeked it back toward the PLAYHEAD's
    // target time - fighting the export's own seek to the CURRENT EXPORT FRAME's target time
    // on literally every frame. That tug-of-war is what made the exported video look frozen
    // near time zero for its entire duration instead of advancing. Bailing out here while an
    // export is in flight leaves the export's own per-frame seeking (prepareVideosForExportFrame)
    // as the only thing touching these elements, and this effect naturally resumes driving live
    // preview again once the export's finally-block clears exportInProgressRef.
    if (exportInProgressRef.current) return;
    const soloActive = composition.layers.some((layer) => layer.solo);
    const fps = finiteNumber(composition.fps, 30);

    composition.layers.forEach((layer) => {
      const videoUrl = layer.source?.videoUrl;
      if (!videoUrl) return;
      const video = videoCache.current.get(videoUrl);
      if (!video) return;

      const active = layer.visible !== false && (!soloActive || layer.solo) && playheadFrame >= layer.startFrame && playheadFrame < layer.endFrame;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const targetTime = mediaTimeForFrame(layer, playheadFrame, fps, duration);
      const canUseLivePlayback = isPlaying && active && !layer.source?.timeRemap;

      if (!canUseLivePlayback) {
        video.pause();
        video.playbackRate = 1;
        if (active && Math.abs(video.currentTime - targetTime) > 0.05 && !video.seeking) {
          safeSeekMedia(video, targetTime);
        }
        return;
      }

      video.muted = true;

      // During live playback each <video> element decodes and advances on its OWN real-time
      // clock (drawLayerContent draws whatever it's currently showing rather than seeking it
      // to the composition's exact frame every draw - see the `playbackDriven` branch there,
      // which deliberately skips syncVideoToFrame so scrubbing doesn't flash intermediate
      // seeked frames). targetTime, derived from the composition's own playheadFrame, is now
      // ALWAYS a real-time reference too - see the rAF loop in App.tsx, which derives the
      // playhead directly from elapsed wall-clock time every tick (the same technique DaVinci
      // Resolve, Apple Color and other pro NLEs use for interactive playback) rather than
      // advancing it frame-by-frame at whatever pace rendering manages. That single change is
      // what actually fixes drift between layers: previously the playhead was deliberately
      // throttled to never advance faster than rendering could keep up with (to avoid dropping
      // frames), which meant it could end up running well under native speed for a sustained
      // stretch - and every <video> element, left playing at its own native ~1x regardless,
      // just kept drifting further ahead of that artificially slow target with nothing here
      // able to close a gap that opens faster than a small correction can chase. With the
      // playhead never falling behind real time in the first place, there's no such gap for
      // video layers to race ahead of - what's left below is just ordinary decoder jitter
      // between one layer and another, which a bounded proportional nudge handles the same way
      // real multi-track players handle A/V sync drift, without fighting the reference clock.
      const drift = video.currentTime - targetTime; // positive: this layer is running ahead
      const absDrift = Math.abs(drift);
      const hardReseekThreshold = 0.3;

      if (absDrift > hardReseekThreshold && !video.seeking) {
        // Equivalent to a professional player's "drop frame" - jump straight to the correct
        // position instead of trying to catch up in real time - reserved for drift too large
        // for a smooth rate correction to close quickly (a fresh scrub, a loop restart, or a
        // one-off stall like a GC pause).
        safeSeekMedia(video, targetTime);
        video.playbackRate = 1;
      } else if (!video.seeking) {
        const convergeSeconds = 0.5;
        const desiredRate = 1 - drift / convergeSeconds;
        video.playbackRate = Math.max(0.6, Math.min(1.6, desiredRate));
      }
      if (video.paused) void video.play().catch(() => undefined);
    });
  }, [composition, isPlaying, mediaVersion, playheadFrame]);

  useEffect(() => {
    if (!composition) return;
    // Same reason as the video live-sync effect above: export drives these cached <audio>
    // elements itself every frame, and every seek it issues fires 'seeked' -> setMediaVersion,
    // which is a dependency here too. Without this bail, this effect would fight the export's
    // own audio pacing (prepareAudioLayersForExportFrame) using the editor's stale, unmoving
    // playhead position instead of the export's current frame.
    if (exportInProgressRef.current) return;
    const soloActive = composition.layers.some((layer) => layer.solo);

    composition.layers.forEach((layer) => {
      const audioUrl = layer.source?.audioUrl;
      if (!audioUrl) return;
      const audio = audioCache.current.get(audioUrl);
      if (!audio) return;
      const active = layer.visible !== false && (!soloActive || layer.solo) && playheadFrame >= layer.startFrame && playheadFrame < layer.endFrame;
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const targetTime = mediaTimeForFrame(layer, playheadFrame, finiteNumber(composition.fps, 30), duration);

      if (!active || !isPlaying) {
        audio.pause();
        if (Math.abs(audio.currentTime - targetTime) > 0.08 && !audio.seeking) audio.currentTime = targetTime;
        return;
      }

      if (Math.abs(audio.currentTime - targetTime) > 0.18 && !audio.seeking) audio.currentTime = targetTime;
      void audio.play().catch(() => undefined);
    });
  }, [composition, isPlaying, mediaVersion, playheadFrame]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeTool !== "mask") return;
      if (event.key === "Escape") {
        setMaskDraft(null);
        setActiveTool("select");
      }
      if (event.key === "Enter") {
        finishMaskDraft(maskDraft);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTool, maskDraft, setActiveTool]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const nextWidth = Math.max(1, Math.floor(rect.width * ratio));
      const nextHeight = Math.max(1, Math.floor(rect.height * ratio));
      if (canvas.width === nextWidth && canvas.height === nextHeight) return;
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      setCanvasVersion((version) => version + 1);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !composition) return;
    if ((canvasPan[0] !== 0 || canvasPan[1] !== 0) && compositionIsOffscreen(canvas, composition, canvasZoom, canvasPan)) {
      setCanvasPan([0, 0]);
    }
  }, [canvasPan, canvasVersion, canvasZoom, composition, setCanvasPan]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !composition) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#090c10";
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Every Time Remapped layer with an open decoder gets its exact-frame lookup done here,
    // once per render pass, so drawLayerContent only ever needs a synchronous map read (see
    // liveTimeRemapFrames on RenderCompositionFrameOptions). A cache miss kicks off the async
    // decode in the background (requestLiveTimeRemapFrame) without blocking this draw - this
    // tick falls back to the live <video> element via the existing path, and the resolved
    // frame bumps liveTimeRemapVersion, which is in this effect's own dependency list below,
    // so the very next render pass (whether or not playheadFrame has also changed) picks it up.
    const liveTimeRemapFrames = new Map<string, WrappedCanvas | null>();
    const compositionFps = finiteNumber(composition.fps, 30);
    liveTimeRemapDecoders.current.forEach((decoder, layerId) => {
      const layer = composition.layers.find((candidate) => candidate.id === layerId);
      if (!layer) return;
      const liveVideo = videoCache.current.get(decoder.videoUrl);
      const sourceDuration = liveVideo && Number.isFinite(liveVideo.duration) && liveVideo.duration > 0 ? liveVideo.duration : 0;
      const targetTime = mediaTimeForFrame(layer, playheadFrame, compositionFps, sourceDuration);
      const cached = decoder.cache.get(playheadFrame);
      if (cached !== undefined) liveTimeRemapFrames.set(layerId, cached);
      if (decoder.desiredFrame !== playheadFrame) {
        requestLiveTimeRemapFrame(decoder, playheadFrame, targetTime, () => setLiveTimeRemapVersion((version) => version + 1));
      }
    });

    const current = placement(canvas, composition, canvasZoom, canvasPan);
    context.save();
    context.translate(current.x, current.y);
    context.scale(current.scale, current.scale);
    renderCompositionFrame(context, composition, playheadFrame, {
      images: imageCache.current,
      videos: videoCache.current,
      selectedLayerIds,
      selectedMaskId,
      maskDraft,
      showGrid,
      showGuides,
      showBounds: true,
      showTransparencyGrid: true,
      includeOverlays: true,
      liveVideoPlayback: isPlaying,
      liveTimeRemapFrames,
    });
    context.restore();
  }, [canvasPan, canvasVersion, canvasZoom, composition, isPlaying, liveTimeRemapVersion, maskDraft, mediaVersion, playheadFrame, selectedLayerIds, selectedMaskId, showGrid, showGuides]);

  if (!composition) return null;

  const editingLayer = textEdit ? composition.layers.find((layer) => layer.id === textEdit.layerId && layer.type === "text") : undefined;
  const editBox = editingLayer && canvasRef.current && wrapperRef.current
    ? textEditBox(canvasRef.current, wrapperRef.current, composition, editingLayer, playheadFrame, canvasZoom, canvasPan)
    : null;

  return (
    <div ref={wrapperRef} className="relative h-full min-h-0 min-w-0 overflow-hidden bg-[#090c10]">
      {/* Real (but invisible) home for every video/audio element the composition uses - see
          the comment on mediaHostRef above for why these can't just live off-DOM in memory. */}
      <div ref={mediaHostRef} aria-hidden="true" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0.01, pointerEvents: "none" }} />
      <canvas
        ref={canvasRef}
        className={`h-full w-full ${activeTool === "mask" ? "cursor-crosshair" : "cursor-default"}`}
        onWheel={(event) => {
          event.preventDefault();
          useEditorStore.getState().setCanvasZoom(canvasZoom + (event.deltaY > 0 ? -0.05 : 0.05));
        }}
        onPointerDown={(event) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const point = screenToComposition(canvas, composition, canvasZoom, canvasPan, event.clientX, event.clientY);
          const soloActive = composition.layers.some((layer) => layer.solo);
          const activeCamera = activeCameraLayer(composition, playheadFrame);
          const hit = composition.layers.find((layer) => layer.type !== "adjustment" && shouldDrawLayer(layer, playheadFrame, soloActive) && !layer.locked && hitTestLayer(composition, layer, playheadFrame, point, activeCamera));

          if (activeTool === "select" && event.detail > 1 && hit?.type === "text") {
            event.preventDefault();
            startTextEdit(hit);
            return;
          }

          if (textEdit && event.detail <= 1) commitTextEdit();

          if (activeTool === "select") {
            const maskVertexHit = hitMaskVertexAt(event.clientX, event.clientY);
            if (maskVertexHit) {
              event.preventDefault();
              setMaskDraft(null);
              if (!selectedLayerIds.includes(maskVertexHit.layer.id)) selectLayer(maskVertexHit.layer.id);
              selectMask(maskVertexHit.mask.id, "path");
              dragRef.current = {
                type: "maskVertex",
                layerId: maskVertexHit.layer.id,
                maskId: maskVertexHit.mask.id,
                pointIndex: maskVertexHit.pointIndex,
                startPath: evaluatePathProperty(maskVertexHit.mask.path, playheadFrame).map((pathPoint) => [...pathPoint] as Vector2),
                startPointer: compositionToLayerPoint(composition, maskVertexHit.layer, playheadFrame, point, activeCamera),
                startScale: evaluateProperty(maskVertexHit.mask.scale, playheadFrame),
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              return;
            }
          }

          if (activeTool === "mask") {
            event.preventDefault();
            const selectedLayer = composition.layers.find((layer) => layer.id === selectedLayerIds[0] && !layer.locked && layer.type !== "null" && layer.type !== "audio" && layer.type !== "model" && layer.type !== "camera");
            const targetLayer = selectedLayer ?? hit;
            if (!targetLayer) return;
            if (!selectedLayerIds.includes(targetLayer.id)) selectLayer(targetLayer.id);

            const localPoint = compositionToLayerPoint(composition, targetLayer, playheadFrame, point, activeCamera);
            const currentDraft = maskDraft?.layerId === targetLayer.id ? maskDraft : { layerId: targetLayer.id, points: [] };
            const firstPoint = currentDraft.points[0];
            const rect = canvas.getBoundingClientRect();
            const canvasPixelRatio = canvas.width / Math.max(1, rect.width);
            const closeThreshold = (14 * canvasPixelRatio) / placement(canvas, composition, canvasZoom, canvasPan).scale;

            if (event.detail > 1 && currentDraft.points.length >= 3) {
              finishMaskDraft(currentDraft);
              return;
            }

            if (firstPoint && currentDraft.points.length >= 3 && distance(firstPoint, localPoint) <= closeThreshold) {
              finishMaskDraft(currentDraft);
              return;
            }

            setMaskDraft({ layerId: targetLayer.id, points: [...currentDraft.points, localPoint], hover: localPoint });
            return;
          }

          if (hit) {
            selectLayer(hit.id, event.shiftKey);
            dragRef.current = { type: "layer", layerId: hit.id, startPoint: point, startPosition: evaluateProperty(hit.transform.position, playheadFrame) };
          } else {
            dragRef.current = { type: "pan", startScreen: [event.clientX, event.clientY], startPan: canvasPan };
          }
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const canvas = canvasRef.current;
          if (!canvas) return;

          if (activeTool === "mask") {
            if (!maskDraft) return;
            const layer = composition.layers.find((candidate) => candidate.id === maskDraft.layerId);
            if (!layer) return;
            const point = screenToComposition(canvas, composition, canvasZoom, canvasPan, event.clientX, event.clientY);
            const activeCamera = activeCameraLayer(composition, playheadFrame);
            setMaskDraft({ ...maskDraft, hover: compositionToLayerPoint(composition, layer, playheadFrame, point, activeCamera) });
            return;
          }

          const drag = dragRef.current;
          if (!drag) return;
          if (drag.type === "pan") {
            const rect = canvas.getBoundingClientRect();
            const ratioX = canvas.width / Math.max(1, rect.width);
            const ratioY = canvas.height / Math.max(1, rect.height);
            setCanvasPan([
              drag.startPan[0] + (event.clientX - drag.startScreen[0]) * ratioX,
              drag.startPan[1] + (event.clientY - drag.startScreen[1]) * ratioY,
            ]);
            return;
          }
          const point = screenToComposition(canvas, composition, canvasZoom, canvasPan, event.clientX, event.clientY);
          if (drag.type === "maskVertex") {
            const layer = composition.layers.find((candidate) => candidate.id === drag.layerId);
            const mask = layer?.masks.find((candidate) => candidate.id === drag.maskId);
            const startPoint = drag.startPath[drag.pointIndex];
            if (!layer || !mask || !startPoint) return;
            const activeCamera = activeCameraLayer(composition, playheadFrame);
            const localPoint = compositionToLayerPoint(composition, layer, playheadFrame, point, activeCamera);
            const [factorX, factorY] = maskScaleDragFactor(drag.startScale, drag.startPath.length);
            const nextPath = drag.startPath.map((pathPoint) => [...pathPoint] as Vector2);
            nextPath[drag.pointIndex] = [
              startPoint[0] + (localPoint[0] - drag.startPointer[0]) / factorX,
              startPoint[1] + (localPoint[1] - drag.startPointer[1]) / factorY,
            ];
            updateMaskValue(drag.layerId, drag.maskId, "path", nextPath);
            return;
          }
          updateTransformValue(drag.layerId, "position", [
            drag.startPosition[0] + point[0] - drag.startPoint[0],
            drag.startPosition[1] + point[1] - drag.startPoint[1],
            ...(drag.startPosition.length >= 3 ? [drag.startPosition[2] ?? 0] : []),
          ] as never);
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onDoubleClick={(event) => {
          if (activeTool !== "select") return;
          const hit = hitLayerAt(event.clientX, event.clientY);
          if (hit?.type !== "text") return;
          event.preventDefault();
          event.stopPropagation();
          startTextEdit(hit);
        }}
      />
      {textEdit && editingLayer && editBox ? (
        <input
          ref={textInputRef}
          data-editor-text-input="true"
          autoFocus
          className="absolute z-20 border border-editor-cyan bg-editor-shell/95 px-2 text-center font-bold text-editor-ink outline-none shadow-lg shadow-black/40"
          style={{
            left: editBox.left,
            top: editBox.top,
            width: editBox.width,
            height: editBox.height,
            color: editBox.color,
            fontSize: editBox.fontSize,
            lineHeight: `${editBox.height}px`,
            transform: `rotate(${editBox.rotation}deg)`,
            transformOrigin: "center",
            borderRadius: 4,
          }}
          value={textEdit.value}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={commitTextEdit}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setTextEdit((current) => current ? { ...current, value } : current);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setTextEdit(null);
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : null}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-editor-line bg-editor-shell/85 px-2 py-1 font-mono text-[11px] text-editor-muted">
        {Math.round(canvasZoom * 100)}%
      </div>
    </div>
  );
}