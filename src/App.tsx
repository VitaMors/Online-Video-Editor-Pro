import { useEffect, useRef, useState } from "react";
import { CompositionCanvas } from "./components/CompositionCanvas";
import { GraphEditor } from "./components/GraphEditor";
import { LayerPanel } from "./components/LayerPanel";
import { MenuBar } from "./components/MenuBar";
import { PropertyInspector } from "./components/PropertyInspector";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { useEditorStore } from "./store/editorStore";
import type { Project } from "./types/editor";

const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path}`;

const propertyShortcuts = {
  p: "position",
  s: "scale",
  r: "rotation",
  t: "opacity",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProject(value: unknown): value is Project {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.compositions)
  );
}

function projectFromPayload(payload: unknown) {
  const wrappedProject = isRecord(payload) ? payload.project : undefined;
  const candidate = isProject(wrappedProject) ? wrappedProject : payload;
  return isProject(candidate) ? candidate : null;
}

export default function App() {
  const frameRemainder = useRef(0);
  const playheadFrameRef = useRef(0);
  const splashProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [showSplash, setShowSplash] = useState(true);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [graphCollapsed, setGraphCollapsed] = useState(false);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const composition = useEditorStore((state) => state.project.compositions.find((item) => item.id === state.activeCompositionId));
  const playheadFrame = useEditorStore((state) => state.playheadFrame);
  const setPlayheadFrame = useEditorStore((state) => state.setPlayheadFrame);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const setPlayback = useEditorStore((state) => state.setPlayback);
  const newProject = useEditorStore((state) => state.newProject);
  const replaceProject = useEditorStore((state) => state.replaceProject);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const copySelection = useEditorStore((state) => state.copySelection);
  const pasteKeyframes = useEditorStore((state) => state.pasteKeyframes);
  const splitSelectedLayers = useEditorStore((state) => state.splitSelectedLayers);
  const previousKeyframe = useEditorStore((state) => state.previousKeyframe);
  const nextKeyframe = useEditorStore((state) => state.nextKeyframe);
  const selectProperty = useEditorStore((state) => state.selectProperty);

  useEffect(() => {
    playheadFrameRef.current = playheadFrame;
  }, [playheadFrame]);

  useEffect(() => {
    if (!isPlaying || !composition || showSplash) return;
    let animationFrame = 0;
    let lastTime = performance.now();
    frameRemainder.current = 0;
    const fps = Math.max(1, Math.round(typeof composition.fps === "number" && Number.isFinite(composition.fps) ? composition.fps : 30));
    const durationFrames = Math.max(1, Math.round(typeof composition.durationFrames === "number" && Number.isFinite(composition.durationFrames) ? composition.durationFrames : 300));
    const tick = (time: number) => {
      const elapsed = (time - lastTime) / 1000;
      lastTime = time;
      frameRemainder.current += elapsed * fps;
      const wholeFrames = Math.floor(frameRemainder.current);
      if (wholeFrames > 0) {
        frameRemainder.current -= wholeFrames;
        const nextFrame = playheadFrameRef.current + wholeFrames;
        const wrappedFrame = nextFrame >= durationFrames ? nextFrame % durationFrames : nextFrame;
        playheadFrameRef.current = wrappedFrame;
        setPlayheadFrame(wrappedFrame);
      }
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [composition, isPlaying, setPlayheadFrame, showSplash]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (showSplash) return;
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable || Boolean(target?.closest?.("[data-editor-text-input]"));
      if (typing) return;
      if (event.code === "Space") { event.preventDefault(); togglePlayback(); return; }
      if ((event.ctrlKey || event.metaKey || event.shiftKey) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const stepFrameAmount = event.shiftKey ? 5 : 1;
        setPlayheadFrame(playheadFrame + direction * stepFrameAmount);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") deleteSelection();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "d") { event.preventDefault(); splitSelectedLayers(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") copySelection();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") pasteKeyframes();
      if (event.key.toLowerCase() === "j") previousKeyframe();
      if (event.key.toLowerCase() === "k") nextKeyframe();
      const property = propertyShortcuts[event.key.toLowerCase() as keyof typeof propertyShortcuts];
      if (property) selectProperty(property);
      if (event.key === "Escape") setPlayback(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelection, deleteSelection, nextKeyframe, pasteKeyframes, playheadFrame, previousKeyframe, redo, selectProperty, setPlayback, setPlayheadFrame, showSplash, splitSelectedLayers, togglePlayback, undo]);

  const openSplashProject = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const project = projectFromPayload(payload);
      if (!project) throw new Error("Invalid project file");
      replaceProject(project);
      setShowSplash(false);
    } catch {
      window.alert("That file does not look like a valid project file.");
    }
  };

  const startNewProject = () => {
    newProject();
    setShowSplash(false);
  };

  return (
    <div className="relative h-full min-h-0 bg-editor-shell text-editor-ink">
      <input
        ref={splashProjectInputRef}
        className="hidden"
        type="file"
        accept=".oveproj,.json,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openSplashProject(file);
          event.currentTarget.value = "";
        }}
      />
      <div className={`grid h-full min-h-0 min-w-0 overflow-hidden grid-rows-[32px_48px_minmax(0,1fr)] bg-editor-shell transition duration-500 ${showSplash ? "pointer-events-none select-none scale-[1.01] blur-sm" : "blur-0"}`}>
        <MenuBar />
        <Toolbar />
        <main className="grid min-h-0 min-w-0 overflow-hidden" style={{ gridTemplateColumns: inspectorCollapsed ? "288px minmax(0, 1fr) 44px" : "288px minmax(0, 1fr) 360px" }}>
          <LayerPanel />
          <div className="grid min-h-0 min-w-0 overflow-hidden grid-rows-[minmax(0,1fr)_auto_auto]">
            <CompositionCanvas />
            <GraphEditor collapsed={graphCollapsed} onToggleCollapsed={() => setGraphCollapsed((current) => !current)} />
            <Timeline />
          </div>
          <PropertyInspector collapsed={inspectorCollapsed} onToggleCollapsed={() => setInspectorCollapsed((current) => !current)} />
        </main>
      </div>
      {showSplash ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#06080d]/70 backdrop-blur-md">
          <div className="flex w-full max-w-xl flex-col items-center px-8 text-center">
            <img className="h-56 w-56 object-contain drop-shadow-2xl md:h-72 md:w-72" src={assetUrl("assets/bbvep-logo.png")} alt="BBVEP" />
            <div className="mt-8 grid w-full max-w-xs grid-cols-2 gap-3">
              <button className="h-10 border border-editor-cyan bg-cyan-950/45 text-[13px] font-semibold text-editor-cyan shadow-xl shadow-cyan-950/20 hover:bg-cyan-900/50" style={{ borderRadius: 6 }} onClick={startNewProject}>
                New
              </button>
              <button className="h-10 border border-editor-line bg-editor-panel/95 text-[13px] font-semibold text-editor-ink shadow-xl shadow-black/20 hover:border-editor-cyan hover:text-editor-cyan" style={{ borderRadius: 6 }} onClick={() => splashProjectInputRef.current?.click()}>
                Open
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}