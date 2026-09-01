// Shared between MenuBar/RenderQueue (which build export jobs) and CompositionCanvas
// (which performs the actual render). Kept in its own module since the two components
// only talk to each other through window CustomEvents, never direct imports.

export type VideoExportContainer = "auto" | "mp4" | "webm";
export type VideoExportQuality = "very-low" | "low" | "medium" | "high" | "very-high";

export type VideoExportSettings = {
  /** "auto" prefers MP4 (H.264/AAC) and falls back to WebM (VP9/Opus) if the browser can't encode it. */
  container: VideoExportContainer;
  quality: VideoExportQuality;
  /** 1 = composition's native resolution, 0.5 = half, etc. */
  resolutionScale: number;
  /** Bits per second. When set and > 0, overrides the quality-derived bitrate entirely. */
  customBitrateMbps?: number;
};

export const DEFAULT_VIDEO_EXPORT_SETTINGS: VideoExportSettings = {
  container: "auto",
  quality: "high",
  resolutionScale: 1,
};

export const VIDEO_EXPORT_QUALITY_ORDER: VideoExportQuality[] = [
  "very-low",
  "low",
  "medium",
  "high",
  "very-high",
];

export const VIDEO_EXPORT_QUALITY_LABELS: Record<VideoExportQuality, string> = {
  "very-low": "Draft (Very Low)",
  low: "Low",
  medium: "Medium",
  high: "High",
  "very-high": "Maximum (Very High)",
};

export const VIDEO_EXPORT_CONTAINER_LABELS: Record<VideoExportContainer, string> = {
  auto: "Auto (MP4 preferred)",
  mp4: "MP4 (H.264)",
  webm: "WebM (VP9)",
};

export type ResolutionScalePreset = { label: string; value: number };

export const RESOLUTION_SCALE_PRESETS: ResolutionScalePreset[] = [
  { label: "Full", value: 1 },
  { label: "1/2", value: 0.5 },
  { label: "1/4", value: 0.25 },
];

export function scaledExportDimensions(width: number, height: number, scale: number) {
  const clampedScale = Number.isFinite(scale) && scale > 0 ? Math.min(2, scale) : 1;
  return {
    width: Math.max(2, Math.round(width * clampedScale) - (Math.round(width * clampedScale) % 2)),
    height: Math.max(2, Math.round(height * clampedScale) - (Math.round(height * clampedScale) % 2)),
  };
}

export function normalizeVideoExportSettings(settings?: Partial<VideoExportSettings> | null): VideoExportSettings {
  return {
    container: settings?.container ?? DEFAULT_VIDEO_EXPORT_SETTINGS.container,
    quality: settings?.quality ?? DEFAULT_VIDEO_EXPORT_SETTINGS.quality,
    resolutionScale: settings?.resolutionScale && settings.resolutionScale > 0
      ? settings.resolutionScale
      : DEFAULT_VIDEO_EXPORT_SETTINGS.resolutionScale,
    customBitrateMbps: settings?.customBitrateMbps && settings.customBitrateMbps > 0
      ? settings.customBitrateMbps
      : undefined,
  };
}
