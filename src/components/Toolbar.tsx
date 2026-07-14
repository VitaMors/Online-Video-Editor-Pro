import {
  Box,
  CircleDot,
  Grid3X3,
  ImagePlus,
  Maximize2,
  MousePointer2,
  Pause,
  PenTool,
  Play,
  Square,
  Type,
  Wind,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useRef } from "react";
import { useEditorStore } from "../store/editorStore";

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composition = useEditorStore((state) =>
    state.project.compositions.find((item) => item.id === state.activeCompositionId),
  );
  const playheadFrame = useEditorStore((state) => state.playheadFrame);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const canvasZoom = useEditorStore((state) => state.canvasZoom);
  const showGrid = useEditorStore((state) => state.showGrid);
  const showGuides = useEditorStore((state) => state.showGuides);
  const activeTool = useEditorStore((state) => state.activeTool);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const setCanvasZoom = useEditorStore((state) => state.setCanvasZoom);
  const setCanvasPan = useEditorStore((state) => state.setCanvasPan);
  const toggleGrid = useEditorStore((state) => state.toggleGrid);
  const toggleGuides = useEditorStore((state) => state.toggleGuides);
  const setActiveTool = useEditorStore((state) => state.setActiveTool);
  const updateActiveCompositionSettings = useEditorStore((state) => state.updateActiveCompositionSettings);
  const addLayer = useEditorStore((state) => state.addLayer);
  const importImage = useEditorStore((state) => state.importImage);
  const fps = composition && typeof composition.fps === "number" && Number.isFinite(composition.fps) ? composition.fps : 30;
  const seconds = composition ? playheadFrame / Math.max(1, fps) : 0;

  return (
    <header className="flex h-12 items-center justify-between border-b panel-divider bg-editor-shell px-3">
      <div className="flex min-w-0 items-center gap-2">
        <button className="icon-button" title="Play or pause" onClick={togglePlayback}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <div className="min-w-[150px] font-mono text-[12px] text-editor-muted">
          {String(playheadFrame).padStart(4, "0")}f / {seconds.toFixed(2)}s
        </div>
        <div className="hidden h-6 w-px bg-editor-line md:block" />
        <div className="hidden truncate text-[13px] font-medium text-editor-ink md:block">
          {composition?.name ?? "Composition"}
        </div>
        <div className="hidden text-[12px] text-editor-muted lg:block">
          {composition?.width} x {composition?.height} at {composition?.fps} fps
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          accept="image/*,video/mp4,video/*,audio/mpeg,audio/wav,audio/*,.mp3,.wav"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importImage(file);
            event.currentTarget.value = "";
          }}
        />
        <button className="icon-button" title="Import media" onClick={() => fileInputRef.current?.click()}>
          <ImagePlus size={16} />
        </button>
        <button className="icon-button" title="Add text layer" onClick={() => addLayer("text")}>
          <Type size={16} />
        </button>
        <button className="icon-button" title="Add shape layer" onClick={() => addLayer("shape")}>
          <Square size={16} />
        </button>
        <button className="icon-button" title="Add solid layer" onClick={() => addLayer("solid")}>
          <Box size={16} />
        </button>
        <button className="icon-button" title="Add null layer" onClick={() => addLayer("null")}>
          <CircleDot size={16} />
        </button>
        <div className="h-6 w-px bg-editor-line" />
        <button className={`icon-button ${activeTool === "select" ? "icon-button-active" : ""}`} title="Select tool" onClick={() => setActiveTool("select")}>
          <MousePointer2 size={16} />
        </button>
        <button className={`icon-button ${activeTool === "mask" ? "icon-button-active" : ""}`} title="Polygon mask tool" onClick={() => setActiveTool("mask")}>
          <PenTool size={16} />
        </button>
        <div className="h-6 w-px bg-editor-line" />
        <button className={`icon-button ${showGrid ? "icon-button-active" : ""}`} title="Toggle grid" onClick={toggleGrid}>
          <Grid3X3 size={16} />
        </button>
        <button className={`icon-button ${showGuides ? "icon-button-active" : ""}`} title="Toggle guides" onClick={toggleGuides}>
          <MousePointer2 size={16} />
        </button>
        <button className={`icon-button ${composition?.motionBlur ? "icon-button-active" : ""}`} title="Global motion blur" onClick={() => composition && updateActiveCompositionSettings({ motionBlur: !composition.motionBlur })}>
          <Wind size={16} />
        </button>
        <button className="icon-button" title="Fit comp view" onClick={() => { setCanvasPan([0, 0]); setCanvasZoom(0.95); }}>
          <Maximize2 size={16} />
        </button>
        <button className="icon-button" title="Zoom out" onClick={() => setCanvasZoom(canvasZoom - 0.08)}>
          <ZoomOut size={16} />
        </button>
        <button className="icon-button" title="Zoom in" onClick={() => setCanvasZoom(canvasZoom + 0.08)}>
          <ZoomIn size={16} />
        </button>
      </div>
    </header>
  );
}