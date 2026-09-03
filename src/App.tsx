import { useEffect, useRef, useState } from "react";
import { CompositionCanvas } from "./components/CompositionCanvas";
import { GraphEditor } from "./components/GraphEditor";
import { LayerPanel } from "./components/LayerPanel";
import { MenuBar } from "./components/MenuBar";
import { PropertyInspector } from "./components/PropertyInspector";
import { PROJECT_OPENED_EVENT, RelinkMediaDialog } from "./components/RelinkMediaDialog";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { useEditorStore } from "./store/editorStore";
import type { Project } from "./types/editor";

function emitProjectOpened(project: Project) {
  window.dispatchEvent(new CustomEvent(PROJECT_OPENED_EVENT, { detail: { project } }));
}

const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path}`;

const propertyShortcuts = {
  p: "position",
  s: "scale",
  r: "rotation",
  t: "opacity",
} as const;

type EditorLayoutMode = "desktop" | "iphone";
type IPhonePanel = "layers" | "timeline" | "inspector";

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
  const playheadFrameRef = useRef(0);
  const splashProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [showSplash, setShowSplash] = useState(true);
  const [layoutMode, setLayoutMode] = useState<EditorLayoutMode>("desktop");
  const [iphonePanel, setIphonePanel] = useState<IPhonePanel>("timeline");
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
  const duplicateLayer = useEditorStore((state) => state.duplicateLayer);
  const previousKeyframe = useEditorStore((state) => state.previousKeyframe);
  const nextKeyframe = useEditorStore((state) => state.nextKeyframe);
  const selectProperty = useEditorStore((state) => state.selectProperty);
  const iphoneMode = layoutMode === "iphone";

  useEffect(() => {
    playheadFrameRef.current = playheadFrame;
  }, [playheadFrame]);

  useEffect(() => {
    if (!isPlaying || !composition || showSplash) return;
    let animationFrame = 0;
    const fps = Math.max(1, Math.round(typeof composition.fps === "number" && Number.isFinite(composition.fps) ? composition.fps : 30));
    const durationFrames = Math.max(1, Math.round(typeof composition.durationFrames === "number" && Number.isFinite(composition.durationFrames) ? composition.durationFrames : 300));
    // Wall-clock-derived playhead, the same technique real NLEs use for interactive playback
    // (After Effects, DaVinci Resolve, Apple Color): the playhead is always wherever real
    // elapsed time says it should be, computed fresh from performance.now() every tick rather
    // than accumulated frame-by-frame - so a slow frame can never make the clock itself fall
    // behind. See https://creativecow.net/forums/thread/real-timedropped-frames-playback-optionae/
    // for editors independently converging on exactly this tradeoff: Resolve's own "play every
    // frame" mode does the opposite (advance by exactly one frame per tick, however long that
    // takes) and users report it as "butt-numbingly slow" once a frame is expensive to render -
    // which is exactly what this project's previous version of this loop did on purpose, and
    // exactly why. That approach also broke video-layer sync in a way real-time frame dropping
    // doesn't: every <video> element in the composition (see the live-preview sync effect in
    // CompositionCanvas.tsx) plays on its own native real-time clock regardless of how the
    // playhead advances, so throttling the playhead to "however long rendering takes" just
    // means the reference every layer is supposed to be tracking keeps falling further behind
    // real time - which is what was actually behind both the "jumping" and "layers playing at
    // different speeds" reports: the video elements were racing ahead of an artificially
    // slowed-down target, at whatever different rate each layer's own decoder happened to drift.
    // A wall-clock playhead never falls behind, so there's no gap for video layers to race
    // ahead of in the first place - and it means dropped/skipped composition frames during a
    // heavy stretch (frames that were too expensive to fully render in their real-time budget
    // simply aren't drawn, the same "dropped frames" indicator every pro NLE has), rather than
    // played back in slow motion.
    const startTime = performance.now();
    const startFrame = playheadFrameRef.current;
    let lastFrame = startFrame;
    const tick = (time: number) => {
      const elapsedSeconds = (time - startTime) / 1000;
      const framesAdvanced = Math.round(elapsedSeconds * fps);
      const rawFrame = startFrame + framesAdvanced;
      // Proper modulo (not `%`, which can return a value up to `durationFrames - 1` short of
      // wrapping correctly once framesAdvanced spans more than one full loop under a long
      // heavy stretch) so looped playback always lands on the exact right frame regardless of
      // how many loops real time has actually covered.
      const wrappedFrame = ((rawFrame % durationFrames) + durationFrames) % durationFrames;
      if (wrappedFrame !== lastFrame) {
        lastFrame = wrappedFrame;
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
      // After Effects' own Duplicate shortcut - Ctrl/Cmd+D with no Shift, so it never collides
      // with Split Layer (Ctrl/Cmd+Shift+D) right above.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateLayer(); return; }
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
  }, [copySelection, deleteSelection, duplicateLayer, nextKeyframe, pasteKeyframes, playheadFrame, previousKeyframe, redo, selectProperty, setPlayback, setPlayheadFrame, showSplash, splitSelectedLayers, togglePlayback, undo]);


  const chooseLayoutMode = (mode: EditorLayoutMode) => {
    setLayoutMode(mode);
    if (mode === "iphone") {
      setIphonePanel("timeline");
      setInspectorCollapsed(false);
    }
  };
  const openSplashProject = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const project = projectFromPayload(payload);
      if (!project) throw new Error("Invalid project file");
      replaceProject(project);
      setShowSplash(false);
      emitProjectOpened(project);
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
      <div className={`grid h-full min-h-0 min-w-0 overflow-hidden grid-rows-[32px_48px_minmax(0,1fr)] bg-editor-shell transition duration-500 ${showSplash ? "pointer-events-none select-none blur-sm" : "blur-0"}`}>
        <MenuBar />
        <Toolbar />
        {iphoneMode ? (
          <main className="grid min-h-0 min-w-0 overflow-hidden grid-rows-[minmax(220px,1fr)_auto_44px_minmax(220px,42vh)]">
            <CompositionCanvas />
            <GraphEditor collapsed={graphCollapsed} onToggleCollapsed={() => setGraphCollapsed((current) => !current)} />
            <div className="grid grid-cols-3 border-y panel-divider bg-editor-panel2 px-2 py-1">
              {(["layers", "timeline", "inspector"] as IPhonePanel[]).map((panel) => (
                <button
                  key={panel}
                  className={`h-8 border text-[12px] font-semibold capitalize ${iphonePanel === panel ? "border-editor-cyan bg-cyan-950/40 text-editor-cyan" : "border-transparent text-editor-muted"}`}
                  style={{ borderRadius: 6 }}
                  onClick={() => setIphonePanel(panel)}
                >
                  {panel}
                </button>
              ))}
            </div>
            <section className="min-h-0 min-w-0 overflow-hidden bg-editor-shell">
              {iphonePanel === "layers" ? <LayerPanel mobile /> : null}
              {iphonePanel === "timeline" ? <Timeline mobile /> : null}
              {iphonePanel === "inspector" ? <PropertyInspector mobile /> : null}
            </section>
          </main>
        ) : (
          <main className="grid min-h-0 min-w-0 overflow-hidden" style={{ gridTemplateColumns: inspectorCollapsed ? "288px minmax(0, 1fr) 44px" : "288px minmax(0, 1fr) 360px" }}>
            <LayerPanel />
            <div className="grid min-h-0 min-w-0 overflow-hidden grid-rows-[minmax(0,1fr)_auto_auto]">
              <CompositionCanvas />
              <GraphEditor collapsed={graphCollapsed} onToggleCollapsed={() => setGraphCollapsed((current) => !current)} />
              <Timeline />
            </div>
            <PropertyInspector collapsed={inspectorCollapsed} onToggleCollapsed={() => setInspectorCollapsed((current) => !current)} />
          </main>
        )}
      </div>
      {showSplash ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#06080d]/70 backdrop-blur-md">
          <div className="flex w-full max-w-xl flex-col items-center px-8 text-center">
            <img className="h-56 w-56 object-contain drop-shadow-2xl md:h-72 md:w-72" src={assetUrl("assets/bbvep-logo.png")} alt="BBVEP" />
            <div className="mt-7 grid w-full max-w-xs grid-cols-2 gap-2 border border-editor-line bg-editor-panel/80 p-1 shadow-xl shadow-black/20" style={{ borderRadius: 7 }}>
              <button className={`h-9 text-[12px] font-semibold ${!iphoneMode ? "bg-cyan-950/45 text-editor-cyan" : "text-editor-muted hover:text-editor-ink"}`} style={{ borderRadius: 5 }} onClick={() => chooseLayoutMode("desktop")}>
                Desktop
              </button>
              <button className={`h-9 text-[12px] font-semibold ${iphoneMode ? "bg-cyan-950/45 text-editor-cyan" : "text-editor-muted hover:text-editor-ink"}`} style={{ borderRadius: 5 }} onClick={() => chooseLayoutMode("iphone")}>
                iPhone Mode
              </button>
            </div>
            <div className="mt-4 grid w-full max-w-xs grid-cols-2 gap-3">
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
      <RelinkMediaDialog />
    </div>
  );
}