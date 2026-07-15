import { useEffect, useMemo, useRef, useState } from "react";
import { evaluatePathProperty, evaluateProperty, getLayerSize, getWorldPosition } from "../lib/animation";
import { applyColorGradingShader } from "../lib/colorGradingShader";
import { effectNumberValue, effectStaticValue } from "../lib/effects";
import { useEditorStore } from "../store/editorStore";
import type { Composition, Effect, Layer, Mask, MaskPath, Vector2 } from "../types/editor";

type DragState =
  | { type: "layer"; layerId: string; startPoint: Vector2; startPosition: Vector2 }
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

const EXPORT_VIDEO_EVENT = "bbvep:export-composition-video";
const EXPORT_VIDEO_STATUS_EVENT = "bbvep:export-composition-video-status";
const videoFrameCache = new Map<string, CachedVideoFrame>();

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

function compositionToLayerPoint(composition: Composition, layer: Layer, frame: number, point: Vector2): Vector2 {
  const position = getWorldPosition(composition, layer, frame);
  const scale = evaluateProperty(layer.transform.scale, frame);
  const rotation = evaluateProperty(layer.transform.rotation, frame);
  const anchor = evaluateProperty(layer.transform.anchorPoint, frame);
  const radians = (-rotation * Math.PI) / 180;
  const translatedX = point[0] - position[0];
  const translatedY = point[1] - position[1];
  const rotatedX = translatedX * Math.cos(radians) - translatedY * Math.sin(radians);
  const rotatedY = translatedX * Math.sin(radians) + translatedY * Math.cos(radians);

  return [
    rotatedX / Math.max(0.001, scale[0] / 100) + anchor[0],
    rotatedY / Math.max(0.001, scale[1] / 100) + anchor[1],
  ];
}

function layerPointToComposition(composition: Composition, layer: Layer, frame: number, point: Vector2): Vector2 {
  const position = getWorldPosition(composition, layer, frame);
  const scale = evaluateProperty(layer.transform.scale, frame);
  const rotation = evaluateProperty(layer.transform.rotation, frame);
  const anchor = evaluateProperty(layer.transform.anchorPoint, frame);
  const radians = (rotation * Math.PI) / 180;
  const scaledX = (point[0] - anchor[0]) * (scale[0] / 100);
  const scaledY = (point[1] - anchor[1]) * (scale[1] / 100);

  return [
    position[0] + scaledX * Math.cos(radians) - scaledY * Math.sin(radians),
    position[1] + scaledX * Math.sin(radians) + scaledY * Math.cos(radians),
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

function applyLayerTransform(context: CanvasRenderingContext2D, composition: Composition, layer: Layer, frame: number) {
  const position = getWorldPosition(composition, layer, frame);
  const scale = evaluateProperty(layer.transform.scale, frame);
  const rotation = evaluateProperty(layer.transform.rotation, frame);
  const anchorPoint = evaluateProperty(layer.transform.anchorPoint, frame);

  context.translate(position[0], position[1]);
  context.rotate((rotation * Math.PI) / 180);
  context.scale(scale[0] / 100, scale[1] / 100);
  context.translate(-anchorPoint[0], -anchorPoint[1]);
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
function drawLayerContent(
  context: CanvasRenderingContext2D,
  layer: Layer,
  images: Map<string, HTMLImageElement>,
  videos: Map<string, HTMLVideoElement>,
  frame: number,
  fps: number,
  liveVideoPlayback = false,
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

  if (layer.type === "video" && source?.videoUrl) {
    const video = videos.get(source.videoUrl);
    const enoughPreviewBuffer = video ? hasEnoughPreviewBuffer(video, layer, frame, fps) : false;
    const playbackDriven = liveVideoPlayback && !source.timeRemap;
    if (video && !playbackDriven) syncVideoToFrame(video, layer, frame, fps);
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
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

function canvasLike(source: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  return canvas;
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

function imageDataCanvas(source: HTMLCanvasElement, mutator: (data: Uint8ClampedArray) => void) {
  const canvas = canvasLike(source);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return source;
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  mutator(image.data);
  context.putImageData(image, 0, 0);
  return canvas;
}

function cssFilterEffect(source: HTMLCanvasElement, effect: Effect, frame: number, filter: string) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  if (mix <= 0) return source;
  return blendCanvas(source, filteredCanvas(source, filter), mix);
}

function directionalBlurCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  const distance = Math.max(0, effectNumberValue(effect, "distance", frame));
  if (mix <= 0 || distance <= 0) return source;
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
  return blendCanvas(source, canvas, mix);
}

function fillCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  const opacity = effectNumberValue(effect, "opacity", frame) / 100;
  if (mix <= 0 || opacity <= 0) return source;
  const [r, g, b] = colorFromHex(effectStaticValue(effect, "color"));
  return blendCanvas(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = clampByte(data[index + 3] * opacity);
    }
  }), mix);
}

function tintCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  const amount = effectNumberValue(effect, "amount", frame) / 100;
  if (mix <= 0 || amount <= 0) return source;
  const black = colorFromHex(effectStaticValue(effect, "blackColor"));
  const white = colorFromHex(effectStaticValue(effect, "whiteColor"));
  return blendCanvas(source, imageDataCanvas(source, (data) => {
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

function levelsCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  if (mix <= 0) return source;
  const blackInput = effectNumberValue(effect, "blackInput", frame);
  const whiteInput = Math.max(blackInput + 1, effectNumberValue(effect, "whiteInput", frame));
  const gamma = Math.max(0.1, effectNumberValue(effect, "gamma", frame));
  const outputBlack = effectNumberValue(effect, "outputBlack", frame);
  const outputWhite = effectNumberValue(effect, "outputWhite", frame);
  return blendCanvas(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const normalized = clampUnit((data[index + channel] - blackInput) / (whiteInput - blackInput));
        data[index + channel] = clampByte(outputBlack + normalized ** (1 / gamma) * (outputWhite - outputBlack));
      }
    }
  }), mix);
}

function curvesCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  if (mix <= 0) return source;
  const shadows = effectNumberValue(effect, "shadows", frame);
  const midtones = effectNumberValue(effect, "midtones", frame);
  const highlights = effectNumberValue(effect, "highlights", frame);
  return blendCanvas(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      const lum = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
      const delta = shadows * (1 - lum) ** 2 + midtones * Math.max(0, 1 - Math.abs(lum - 0.5) * 2) + highlights * lum ** 2;
      data[index] = clampByte(data[index] + delta);
      data[index + 1] = clampByte(data[index + 1] + delta);
      data[index + 2] = clampByte(data[index + 2] + delta);
    }
  }), mix);
}

function exposureCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  if (mix <= 0) return source;
  const exposure = 2 ** effectNumberValue(effect, "exposure", frame);
  const offset = effectNumberValue(effect, "offset", frame);
  const gamma = Math.max(0.1, effectNumberValue(effect, "gamma", frame));
  return blendCanvas(source, imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const normalized = clampUnit(data[index + channel] / 255 * exposure + offset);
        data[index + channel] = clampByte(normalized ** (1 / gamma) * 255);
      }
    }
  }), mix);
}

function glowCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  const radius = effectNumberValue(effect, "radius", frame);
  const intensity = effectNumberValue(effect, "intensity", frame) / 100;
  if (mix <= 0 || radius <= 0 || intensity <= 0) return source;
  const threshold = effectNumberValue(effect, "threshold", frame) / 100;
  const [r, g, b] = colorFromHex(effectStaticValue(effect, "color"));
  const glowSource = imageDataCanvas(source, (data) => {
    for (let index = 0; index < data.length; index += 4) {
      const luminance = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
      if (luminance < threshold) data[index + 3] = 0;
    }
  });
  const glow = filteredCanvas(glowSource, `blur(${radius}px)`);
  const tint = canvasLike(source);
  const tintContext = tint.getContext("2d");
  if (!tintContext) return source;
  tintContext.drawImage(glow, 0, 0);
  tintContext.globalCompositeOperation = "source-in";
  tintContext.fillStyle = `rgb(${r}, ${g}, ${b})`;
  tintContext.fillRect(0, 0, tint.width, tint.height);
  tintContext.globalCompositeOperation = "source-over";
  const canvas = canvasLike(source);
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.drawImage(source, 0, 0);
  context.globalCompositeOperation = "lighter";
  context.globalAlpha = intensity;
  context.drawImage(tint, 0, 0);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  return blendCanvas(source, canvas, mix);
}

function dropShadowCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  if (mix <= 0) return source;
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
  return blendCanvas(source, canvas, mix);
}

function noiseCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  const amount = effectNumberValue(effect, "amount", frame) * 1.28;
  if (mix <= 0 || amount <= 0) return source;
  const monochrome = Boolean(effectStaticValue(effect, "monochrome"));
  const seedFrame = Math.round(frame);
  return blendCanvas(source, imageDataCanvas(source, (data) => {
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
  const mix = effectNumberValue(effect, "mix", frame) / 100;
  const amount = effectNumberValue(effect, "amount", frame) / 100;
  if (mix <= 0 || amount <= 0) return source;
  const blurred = filteredCanvas(source, "blur(1px)");
  const canvas = canvasLike(source);
  const context = canvas.getContext("2d");
  const blurredContext = blurred.getContext("2d", { willReadFrequently: true });
  if (!context || !blurredContext) return source;
  context.drawImage(source, 0, 0);
  const sharp = context.getImageData(0, 0, canvas.width, canvas.height);
  const soft = blurredContext.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < sharp.data.length; index += 4) {
    sharp.data[index] = clampByte(sharp.data[index] + (sharp.data[index] - soft.data[index]) * amount);
    sharp.data[index + 1] = clampByte(sharp.data[index + 1] + (sharp.data[index + 1] - soft.data[index + 1]) * amount);
    sharp.data[index + 2] = clampByte(sharp.data[index + 2] + (sharp.data[index + 2] - soft.data[index + 2]) * amount);
  }
  context.putImageData(sharp, 0, 0);
  return blendCanvas(source, canvas, mix);
}

function applyEffectCanvas(source: HTMLCanvasElement, effect: Effect, frame: number) {
  if (effect.enabled === false) return source;
  if (effect.type === "colorGrading") return applyColorGradingShader(source, effect, frame);
  if (effect.type === "hueSaturation") {
    const hue = effectNumberValue(effect, "hue", frame);
    const saturation = Math.max(0, 100 + effectNumberValue(effect, "saturation", frame));
    const lightness = Math.max(0, 100 + effectNumberValue(effect, "lightness", frame));
    return cssFilterEffect(source, effect, frame, `hue-rotate(${hue}deg) saturate(${saturation}%) brightness(${lightness}%)`);
  }

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
  return source;
}

function applyLayerEffects(source: HTMLCanvasElement, layer: Layer, frame: number) {
  return layer.effects.reduce((canvas, effect) => applyEffectCanvas(canvas, effect, frame), source);
}

function applyAdjustmentLayerToCanvas(canvas: HTMLCanvasElement, layer: Layer, frame: number) {
  if (layer.effects.length === 0) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const processed = applyLayerEffects(canvas, layer, frame);
  const opacity = clampUnit(evaluateProperty(layer.transform.opacity, frame) / 100);
  const output = opacity < 0.999 ? blendCanvas(canvas, processed, opacity) : processed;
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

function drawMaskedLayerContent(
  context: CanvasRenderingContext2D,
  layer: Layer,
  frame: number,
  images: Map<string, HTMLImageElement>,
  videos: Map<string, HTMLVideoElement>,
  fps: number,
  liveVideoPlayback: boolean,
) {
  const [width, height] = getLayerSize(layer);
  const contentCanvas = document.createElement("canvas");
  contentCanvas.width = Math.max(1, Math.ceil(width));
  contentCanvas.height = Math.max(1, Math.ceil(height));
  const contentContext = contentCanvas.getContext("2d");

  if (!contentContext) {
    drawLayerContent(context, layer, images, videos, frame, fps, liveVideoPlayback);
    return;
  }

  drawLayerContent(contentContext, layer, images, videos, frame, fps, liveVideoPlayback);

  if (layer.masks.length > 0) {
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = contentCanvas.width;
    maskCanvas.height = contentCanvas.height;
    const maskContext = maskCanvas.getContext("2d");

    if (!maskContext) {
      context.drawImage(applyLayerEffects(contentCanvas, layer, frame), 0, 0, width, height);
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

      maskContext.fillStyle = "#fff";
      drawPolygonPath(maskContext, points);
      maskContext.fill();
      maskContext.restore();
    });

    contentContext.globalCompositeOperation = "destination-in";
    contentContext.drawImage(maskCanvas, 0, 0);
    contentContext.globalCompositeOperation = "source-over";
  }

  context.drawImage(applyLayerEffects(contentCanvas, layer, frame), 0, 0, width, height);
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

function drawAdjustmentLayerOverlay(context: CanvasRenderingContext2D, composition: Composition) {
  context.save();
  context.globalAlpha = 1;
  context.lineWidth = 3;
  context.strokeStyle = "#f2b84b";
  context.setLineDash([14, 8]);
  context.strokeRect(0, 0, composition.width, composition.height);
  context.setLineDash([]);
  context.fillStyle = "#f2b84b";
  const handle = 16;
  [[0, 0], [composition.width, 0], [composition.width, composition.height], [0, composition.height]].forEach(([x, y]) => {
    context.fillRect(x - handle / 2, y - handle / 2, handle, handle);
  });
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
    drawMaskedLayerContent(context, layer, contentFrame, images, videos, fps, liveVideoPlayback);
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

  if (selected) drawLayerOverlay(context, composition, layer, frame, selectedMaskId);
}
function drawDraftMask(
  context: CanvasRenderingContext2D,
  composition: Composition,
  layer: Layer,
  frame: number,
  draft: MaskDraft,
) {
  const points = draft.hover ? [...draft.points, draft.hover] : draft.points;
  if (points.length === 0) return;

  context.save();
  applyLayerTransform(context, composition, layer, frame);
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
};

function renderCompositionFrame(
  context: CanvasRenderingContext2D,
  composition: Composition,
  frame: number,
  options: RenderCompositionFrameOptions,
) {
  const selectedLayerIds = options.selectedLayerIds ?? [];
  const showBounds = options.showBounds ?? false;

  context.clearRect(0, 0, composition.width, composition.height);
  if (composition.backgroundTransparent) {
    if (options.showTransparencyGrid) drawTransparencyGrid(context, composition);
  } else {
    context.fillStyle = composition.backgroundColor;
    context.fillRect(0, 0, composition.width, composition.height);
  }

  if (options.showGrid) drawGrid(context, composition);

  const soloActive = composition.layers.some((layer) => layer.solo);
  const drawableLayers = composition.layers
    .slice()
    .reverse()
    .filter((layer) => shouldDrawLayer(layer, frame, soloActive));
  const contentCanvas = document.createElement("canvas");
  contentCanvas.width = Math.max(1, Math.round(composition.width));
  contentCanvas.height = Math.max(1, Math.round(composition.height));
  const contentContext = contentCanvas.getContext("2d");

  if (contentContext) {
    drawableLayers.forEach((layer) => {
      if (layer.type === "adjustment") {
        applyAdjustmentLayerToCanvas(contentCanvas, layer, frame);
        return;
      }
      drawLayer(contentContext, composition, layer, frame, options.images, options.videos, false, options.selectedMaskId, options.liveVideoPlayback);
    });
    context.drawImage(contentCanvas, 0, 0, composition.width, composition.height);
  } else {
    drawableLayers
      .filter((layer) => layer.type !== "adjustment")
      .forEach((layer) => drawLayer(context, composition, layer, frame, options.images, options.videos, false, options.selectedMaskId, options.liveVideoPlayback));
  }

  if (options.includeOverlays) {
    drawableLayers
      .filter((layer) => selectedLayerIds.includes(layer.id))
      .forEach((layer) => {
        if (layer.type === "adjustment") drawAdjustmentLayerOverlay(context, composition);
        else drawLayerOverlay(context, composition, layer, frame, options.selectedMaskId);
      });

    if (options.maskDraft) {
      const layer = composition.layers.find((candidate) => candidate.id === options.maskDraft?.layerId);
      if (layer) drawDraftMask(context, composition, layer, frame, options.maskDraft);
    }
  }

  if (options.showGuides) drawGuides(context, composition);

  if (showBounds) {
    context.strokeStyle = "#596579";
    context.lineWidth = 3;
    context.strokeRect(0, 0, composition.width, composition.height);
  }
}
function hitTestLayer(composition: Composition, layer: Layer, frame: number, point: Vector2) {
  const [width, height] = getLayerSize(layer);
  const local = compositionToLayerPoint(composition, layer, frame, point);
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
): MaskVertexHit | undefined {
  const orderedMasks = [
    ...layer.masks.filter((mask) => mask.id === selectedMaskId),
    ...layer.masks.filter((mask) => mask.id !== selectedMaskId),
  ];
  let closest: MaskVertexHit | undefined;
  let closestDistance = threshold;

  orderedMasks.forEach((mask) => {
    evaluatedMaskPoints(mask, frame).forEach((maskPoint, pointIndex) => {
      const compositionPoint = layerPointToComposition(composition, layer, frame, maskPoint);
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
};

type VideoExportStatusDetail = {
  message: string;
};

function emitVideoExportStatus(message: string) {
  window.dispatchEvent(new CustomEvent<VideoExportStatusDetail>(EXPORT_VIDEO_STATUS_EVENT, { detail: { message } }));
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

function bestVideoRecorderMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function extensionForRecorderMimeType(mimeType: string) {
  return mimeType.includes("mp4") ? "mp4" : "webm";
}

function videoBitrateForComposition(composition: Composition) {
  const fps = Math.max(1, Math.min(60, finiteNumber(composition.fps, 30)));
  const pixels = Math.max(1, composition.width * composition.height);
  return Math.round(Math.min(20_000_000, Math.max(2_500_000, pixels * fps * 0.09)));
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

async function seekVideoForExport(video: HTMLVideoElement, time: number, tolerance = 0.045) {
  await waitForMediaMetadataForExport(video);
  if (Math.abs(video.currentTime - time) <= tolerance && video.readyState >= 2) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", finish);
      video.removeEventListener("loadeddata", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    video.addEventListener("seeked", finish, { once: true });
    video.addEventListener("loadeddata", finish, { once: true });
    video.addEventListener("error", finish, { once: true });
    safeSeekMedia(video, time);
    window.setTimeout(finish, 1200);
  });
}

async function waitForExportAssets(
  composition: Composition,
  images: Map<string, HTMLImageElement>,
  videos: Map<string, HTMLVideoElement>,
) {
  const imageTasks = composition.layers
    .map((layer) => layer.source?.imageUrl ? images.get(layer.source.imageUrl) : undefined)
    .filter((image): image is HTMLImageElement => Boolean(image))
    .map(waitForImageForExport);
  const videoTasks = composition.layers
    .map((layer) => layer.source?.videoUrl ? videos.get(layer.source.videoUrl) : undefined)
    .filter((video): video is HTMLVideoElement => Boolean(video))
    .map(waitForMediaMetadataForExport);
  await Promise.all([...imageTasks, ...videoTasks]);
}

async function prepareVideosForExportFrame(
  composition: Composition,
  frame: number,
  videos: Map<string, HTMLVideoElement>,
) {
  const soloActive = composition.layers.some((layer) => layer.solo);
  const fps = finiteNumber(composition.fps, 30);

  await Promise.all(composition.layers.map(async (layer) => {
    const videoUrl = layer.source?.videoUrl;
    if (!videoUrl || !shouldDrawLayer(layer, frame, soloActive)) return;
    const video = videos.get(videoUrl);
    if (!video) return;

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const targetTime = mediaTimeForFrame(layer, frame, fps, duration);

    if (layer.source?.timeRemap) {
      video.pause();
      await seekVideoForExport(video, targetTime);
      return;
    }

    if (video.readyState < 2 || Math.abs(video.currentTime - targetTime) > 0.28) {
      await seekVideoForExport(video, targetTime, 0.08);
    }

    video.muted = true;
    video.playbackRate = 1;
    if (video.paused) await video.play().catch(() => undefined);
  }));
}

async function exportCompositionVideo(
  composition: Composition,
  images: Map<string, HTMLImageElement>,
  videos: Map<string, HTMLVideoElement>,
  filename?: string,
) {
  if (!("captureStream" in HTMLCanvasElement.prototype)) {
    throw new Error("This browser cannot record canvas video exports.");
  }

  const mimeType = bestVideoRecorderMimeType();
  if (!mimeType) throw new Error("This browser does not expose a supported video recorder.");

  await waitForExportAssets(composition, images, videos);

  const fps = Math.max(1, Math.min(60, finiteNumber(composition.fps, 30)));
  const durationFrames = Math.max(1, Math.round(finiteNumber(composition.durationFrames, fps * 10)));
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = Math.max(1, Math.round(composition.width));
  exportCanvas.height = Math.max(1, Math.round(composition.height));
  const exportContext = exportCanvas.getContext("2d");
  if (!exportContext) throw new Error("Could not create video export canvas.");

  const stream = exportCanvas.captureStream(fps);
  const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: videoBitrateForComposition(composition),
  });
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error("Video export failed."));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  recorder.start(250);
  const startedAt = performance.now();
  const progressStep = Math.max(1, Math.round(fps));

  for (let frame = 0; frame < durationFrames; frame += 1) {
    await prepareVideosForExportFrame(composition, frame, videos);
    renderCompositionFrame(exportContext, composition, frame, {
      images,
      videos,
      includeOverlays: false,
      showGrid: false,
      showGuides: false,
      showBounds: false,
      showTransparencyGrid: false,
      liveVideoPlayback: true,
    });
    videoTrack?.requestFrame();

    if (frame === 0 || frame % progressStep === 0) {
      const percent = Math.min(100, Math.round(((frame + 1) / durationFrames) * 100));
      emitVideoExportStatus(`Rendering video ${percent}%`);
    }

    const nextFrameDueAt = startedAt + ((frame + 1) / fps) * 1000;
    await waitForExportDelay(nextFrameDueAt - performance.now());
  }

  if (recorder.state !== "inactive") recorder.stop();
  const blob = await stopped;
  stream.getTracks().forEach((track) => track.stop());
  videos.forEach((video) => video.pause());

  const extension = extensionForRecorderMimeType(mimeType);
  downloadVideoBlob(blob, `${videoExportFileBaseName(filename ?? composition.name)}.${extension}`);
  emitVideoExportStatus(extension === "mp4" ? "MP4 export downloaded" : "MP4 unavailable in this browser, downloaded WebM video");
}
export function CompositionCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const imageCache = useRef(new Map<string, HTMLImageElement>());
  const videoCache = useRef(new Map<string, HTMLVideoElement>());
  const audioCache = useRef(new Map<string, HTMLAudioElement>());
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

  useEffect(() => {
    const onExportVideo = (event: Event) => {
      const detail = (event as CustomEvent<ExportVideoDetail>).detail ?? {};
      if (!composition || (detail.compositionId && detail.compositionId !== composition.id)) return;
      if (exportInProgressRef.current) {
        emitVideoExportStatus("Video export already running");
        return;
      }

      exportInProgressRef.current = true;
      emitVideoExportStatus("Rendering video 0%");
      void exportCompositionVideo(composition, imageCache.current, videoCache.current, detail.filename)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Video export failed.";
          emitVideoExportStatus(message);
        })
        .finally(() => {
          exportInProgressRef.current = false;
          if (!useEditorStore.getState().isPlaying) videoCache.current.forEach((video) => video.pause());
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
    return composition.layers.find((layer) => layer.type !== "adjustment" && shouldDrawLayer(layer, playheadFrame, soloActive) && !layer.locked && hitTestLayer(composition, layer, playheadFrame, point));
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
    const drawableLayers = composition.layers.filter((layer) => shouldDrawLayer(layer, playheadFrame, soloActive) && !layer.locked && layer.masks.length > 0);
    const selectedLayers = selectedLayerIds
      .map((layerId) => drawableLayers.find((layer) => layer.id === layerId))
      .filter((layer): layer is Layer => Boolean(layer));
    const orderedLayers = [
      ...selectedLayers,
      ...drawableLayers.filter((layer) => !selectedLayerIds.includes(layer.id)),
    ];

    for (const layer of orderedLayers) {
      const hit = maskVertexHitForLayer(composition, layer, playheadFrame, point, threshold, selectedMaskId);
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
        audioCache.current.set(audioUrl, audio);
      }
    });
  }, [composition, updateMediaLayerSize]);
  useEffect(() => {
    if (!composition) return;
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
        if (active && Math.abs(video.currentTime - targetTime) > 0.05 && !video.seeking) {
          safeSeekMedia(video, targetTime);
        }
        return;
      }

      video.muted = true;
      video.playbackRate = 1;
      if (Math.abs(video.currentTime - targetTime) > 0.25 && !video.seeking) {
        safeSeekMedia(video, targetTime);
      }
      if (video.paused) void video.play().catch(() => undefined);
    });
  }, [composition, isPlaying, mediaVersion, playheadFrame]);

  useEffect(() => {
    if (!composition) return;
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
    });
    context.restore();
  }, [canvasPan, canvasVersion, canvasZoom, composition, isPlaying, maskDraft, mediaVersion, playheadFrame, selectedLayerIds, selectedMaskId, showGrid, showGuides]);

  if (!composition) return null;

  const editingLayer = textEdit ? composition.layers.find((layer) => layer.id === textEdit.layerId && layer.type === "text") : undefined;
  const editBox = editingLayer && canvasRef.current && wrapperRef.current
    ? textEditBox(canvasRef.current, wrapperRef.current, composition, editingLayer, playheadFrame, canvasZoom, canvasPan)
    : null;

  return (
    <div ref={wrapperRef} className="relative h-full min-h-0 min-w-0 overflow-hidden bg-[#090c10]">
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
          const hit = composition.layers.find((layer) => layer.type !== "adjustment" && shouldDrawLayer(layer, playheadFrame, soloActive) && !layer.locked && hitTestLayer(composition, layer, playheadFrame, point));

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
                startPointer: compositionToLayerPoint(composition, maskVertexHit.layer, playheadFrame, point),
                startScale: evaluateProperty(maskVertexHit.mask.scale, playheadFrame),
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              return;
            }
          }

          if (activeTool === "mask") {
            event.preventDefault();
            const selectedLayer = composition.layers.find((layer) => layer.id === selectedLayerIds[0] && !layer.locked && layer.type !== "null" && layer.type !== "audio" && layer.type !== "adjustment");
            const targetLayer = selectedLayer ?? hit;
            if (!targetLayer) return;
            if (!selectedLayerIds.includes(targetLayer.id)) selectLayer(targetLayer.id);

            const localPoint = compositionToLayerPoint(composition, targetLayer, playheadFrame, point);
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
            setMaskDraft({ ...maskDraft, hover: compositionToLayerPoint(composition, layer, playheadFrame, point) });
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
            const localPoint = compositionToLayerPoint(composition, layer, playheadFrame, point);
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
          ]);
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