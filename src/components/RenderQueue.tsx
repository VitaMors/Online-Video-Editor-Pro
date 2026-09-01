import { ListVideo, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  RESOLUTION_SCALE_PRESETS,
  VIDEO_EXPORT_CONTAINER_LABELS,
  VIDEO_EXPORT_QUALITY_LABELS,
  VIDEO_EXPORT_QUALITY_ORDER,
  type VideoExportContainer,
  type VideoExportQuality,
  type VideoExportSettings,
} from "../lib/videoExportSettings";
import { useEditorStore } from "../store/editorStore";

const EXPORT_VIDEO_EVENT = "bbvep:export-composition-video";
const EXPORT_VIDEO_STATUS_EVENT = "bbvep:export-composition-video-status";

type JobStatus = "queued" | "rendering" | "done" | "error";

type RenderQueueJob = {
  id: string;
  compositionId: string;
  compositionName: string;
  filename: string;
  settings: VideoExportSettings;
  status: JobStatus;
  percent: number;
  message?: string;
};

type VideoExportStatusDetail = {
  message: string;
  jobId?: string;
  percent?: number;
  phase?: "rendering" | "done" | "error";
};

function fileBaseName(name: string) {
  return name.trim().replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "composition";
}

function createJobId() {
  return `render-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function settingsSummary(settings: VideoExportSettings) {
  const resolutionLabel = RESOLUTION_SCALE_PRESETS.find((preset) => preset.value === settings.resolutionScale)?.label
    ?? `${Math.round(settings.resolutionScale * 100)}%`;
  const bitrate = settings.customBitrateMbps ? `${settings.customBitrateMbps} Mbps` : VIDEO_EXPORT_QUALITY_LABELS[settings.quality];
  return `${VIDEO_EXPORT_CONTAINER_LABELS[settings.container]} · ${bitrate} · ${resolutionLabel} res`;
}

function statusLabel(job: RenderQueueJob) {
  switch (job.status) {
    case "queued": return "Queued";
    case "rendering": return `Rendering ${job.percent}%`;
    case "done": return "Done";
    case "error": return job.message ?? "Failed";
  }
}

async function waitForActiveComposition(compositionId: string, timeoutMs = 3000) {
  const start = performance.now();
  while (useEditorStore.getState().activeCompositionId !== compositionId) {
    if (performance.now() - start > timeoutMs) return false;
    await new Promise((resolve) => window.setTimeout(resolve, 30));
  }
  // One extra frame so CompositionCanvas's export listener (bound to the composition
  // resolved via useMemo off activeCompositionId) has actually re-rendered and rebound
  // before we dispatch the export event at it.
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  return true;
}

function renderQueuedJob(job: RenderQueueJob) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onStatus = (event: Event) => {
      const detail = (event as CustomEvent<VideoExportStatusDetail>).detail;
      if (!detail || detail.jobId !== job.id) return;
      if (detail.phase === "done") {
        settled = true;
        cleanup();
        resolve();
      } else if (detail.phase === "error") {
        settled = true;
        cleanup();
        reject(new Error(detail.message || "Render failed."));
      }
    };
    const cleanup = () => window.removeEventListener(EXPORT_VIDEO_STATUS_EVENT, onStatus);
    window.addEventListener(EXPORT_VIDEO_STATUS_EVENT, onStatus);

    void waitForActiveComposition(job.compositionId).then((becameActive) => {
      if (settled) return;
      if (!becameActive) {
        settled = true;
        cleanup();
        reject(new Error("Timed out switching to this composition."));
        return;
      }
      window.dispatchEvent(new CustomEvent(EXPORT_VIDEO_EVENT, {
        detail: { compositionId: job.compositionId, filename: job.filename, settings: job.settings, jobId: job.id },
      }));
    });
  });
}

export function RenderQueue({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditorStore((state) => state.project);
  const activeCompositionId = useEditorStore((state) => state.activeCompositionId);
  const setActiveComposition = useEditorStore((state) => state.setActiveComposition);

  const [jobs, setJobs] = useState<RenderQueueJob[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [settingsJobId, setSettingsJobId] = useState<string | null>(null);
  const isProcessingRef = useRef(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const restoreCompositionIdRef = useRef<string | null>(null);

  // Live progress: CompositionCanvas emits status events carrying a job's id while it
  // renders. Subscribed unconditionally (not after the `open` early-return below) so hook
  // order stays stable across renders regardless of whether the panel is open.
  useEffect(() => {
    const onStatus = (event: Event) => {
      const detail = (event as CustomEvent<VideoExportStatusDetail>).detail;
      if (!detail?.jobId) return;
      setJobs((current) => current.map((job) => (
        job.id === detail.jobId && job.status === "rendering"
          ? { ...job, percent: detail.percent ?? job.percent, message: detail.message }
          : job
      )));
    };
    window.addEventListener(EXPORT_VIDEO_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(EXPORT_VIDEO_STATUS_EVENT, onStatus);
  }, []);

  if (!open) return null;

  const updateJob = (id: string, updates: Partial<RenderQueueJob>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...updates } : job)));
  };

  const addCompositionToQueue = (compositionId: string) => {
    const composition = project.compositions.find((item) => item.id === compositionId);
    if (!composition) return;
    setJobs((current) => [
      ...current,
      {
        id: createJobId(),
        compositionId: composition.id,
        compositionName: composition.name,
        filename: fileBaseName(composition.name),
        settings: { container: "auto", quality: "high", resolutionScale: 1 },
        status: "queued",
        percent: 0,
      },
    ]);
    setAddMenuOpen(false);
  };

  const removeJob = (id: string) => {
    if (isProcessingRef.current) return;
    setJobs((current) => current.filter((job) => job.id !== id));
  };

  const clearFinished = () => {
    setJobs((current) => current.filter((job) => job.status === "queued" || job.status === "rendering"));
  };

  const updateJobSettings = (id: string, updates: Partial<VideoExportSettings>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, settings: { ...job.settings, ...updates } } : job)));
  };

  const updateJobFilename = (id: string, filename: string) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, filename } : job)));
  };

  const startQueue = async () => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setIsProcessing(true);
    restoreCompositionIdRef.current = activeCompositionId;

    const pending = jobs.filter((job) => job.status === "queued" || job.status === "error");
    for (const job of pending) {
      updateJob(job.id, { status: "rendering", percent: 0, message: undefined });
      setActiveComposition(job.compositionId);
      try {
        await renderQueuedJob(job);
        updateJob(job.id, { status: "done", percent: 100 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Render failed.";
        updateJob(job.id, { status: "error", message });
      }
    }

    if (restoreCompositionIdRef.current) setActiveComposition(restoreCompositionIdRef.current);
    isProcessingRef.current = false;
    setIsProcessing(false);
  };

  const settingsJob = jobs.find((job) => job.id === settingsJobId);
  const hasPendingJobs = jobs.some((job) => job.status === "queued" || job.status === "error");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55" onPointerDown={onClose}>
      <div
        className="flex max-h-[80vh] w-[720px] flex-col border border-editor-line bg-editor-panel shadow-2xl"
        style={{ borderRadius: 6 }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b panel-divider px-4 py-3">
          <div className="flex items-center gap-2">
            <ListVideo size={16} className="text-editor-cyan" />
            <div className="text-[14px] font-semibold text-editor-ink">Render Queue</div>
          </div>
          <button className="icon-button h-7 w-7" title="Close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="flex items-center gap-2 border-b panel-divider px-4 py-2">
          <div className="relative">
            <button
              className="flex h-8 items-center gap-1.5 border border-editor-line bg-editor-shell px-3 text-[12px] text-editor-ink"
              style={{ borderRadius: 5 }}
              onClick={() => setAddMenuOpen((value) => !value)}
              disabled={isProcessing}
            >
              <Plus size={13} /> Add Composition
            </button>
            {addMenuOpen ? (
              <div className="absolute left-0 top-9 z-10 min-w-52 border border-editor-line bg-editor-panel py-1 shadow-2xl" style={{ borderRadius: 5 }}>
                {project.compositions.map((composition) => (
                  <button
                    key={composition.id}
                    className="block w-full px-3 py-1.5 text-left text-[12px] text-editor-ink hover:bg-editor-shell"
                    onClick={() => addCompositionToQueue(composition.id)}
                  >
                    {composition.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            className="ml-auto h-8 border border-editor-line bg-editor-shell px-3 text-[12px] text-editor-muted disabled:opacity-40"
            style={{ borderRadius: 5 }}
            onClick={clearFinished}
            disabled={isProcessing || jobs.every((job) => job.status === "queued" || job.status === "rendering")}
          >
            Clear Finished
          </button>
          <button
            className="h-8 border border-editor-cyan bg-cyan-950/40 px-4 text-[12px] font-semibold text-editor-cyan disabled:opacity-40"
            style={{ borderRadius: 5 }}
            onClick={() => void startQueue()}
            disabled={isProcessing || !hasPendingJobs}
          >
            {isProcessing ? "Rendering…" : "Render Queue"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {jobs.length === 0 ? (
            <div className="py-10 text-center text-[12px] text-editor-muted">
              No render jobs queued yet. Add a composition above, then set its output settings and hit Render Queue.
            </div>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <div key={job.id} className="border border-editor-line bg-editor-shell px-3 py-2" style={{ borderRadius: 5 }}>
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-semibold text-editor-ink">{job.compositionName}</div>
                      <button
                        className="mt-0.5 truncate text-left text-[11px] text-editor-cyan hover:underline"
                        onClick={() => setSettingsJobId(job.id)}
                        disabled={job.status === "rendering"}
                      >
                        {settingsSummary(job.settings)}
                      </button>
                    </div>
                    <div className="w-40 text-right text-[11px] text-editor-muted">{statusLabel(job)}</div>
                    <button
                      className="icon-button h-6 w-6 disabled:opacity-30"
                      title="Remove"
                      onClick={() => removeJob(job.id)}
                      disabled={isProcessing && job.status === "rendering"}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {job.status === "rendering" || job.status === "done" ? (
                    <div className="mt-2 h-1 w-full overflow-hidden bg-editor-panel" style={{ borderRadius: 2 }}>
                      <div
                        className={job.status === "done" ? "h-full bg-emerald-500" : "h-full bg-editor-cyan"}
                        style={{ width: `${job.percent}%`, transition: "width 120ms linear" }}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {settingsJob ? (
        <OutputModuleSettingsDialog
          job={settingsJob}
          onChange={(updates) => updateJobSettings(settingsJob.id, updates)}
          onFilenameChange={(filename) => updateJobFilename(settingsJob.id, filename)}
          onClose={() => setSettingsJobId(null)}
        />
      ) : null}
    </div>
  );
}

function OutputModuleSettingsDialog({
  job,
  onChange,
  onFilenameChange,
  onClose,
}: {
  job: RenderQueueJob;
  onChange: (updates: Partial<VideoExportSettings>) => void;
  onFilenameChange: (filename: string) => void;
  onClose: () => void;
}) {
  const containers: VideoExportContainer[] = ["auto", "mp4", "webm"];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55" onPointerDown={onClose}>
      <div
        className="w-[380px] border border-editor-line bg-editor-panel p-4 shadow-2xl"
        style={{ borderRadius: 6 }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b panel-divider pb-3">
          <div>
            <div className="text-[14px] font-semibold text-editor-ink">Output Module Settings</div>
            <div className="mt-1 text-[11px] text-editor-muted">{job.compositionName}</div>
          </div>
          <button className="icon-button h-7 w-7" title="Close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="mt-4 space-y-3 text-[12px] text-editor-muted">
          <label className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">Filename
            <input
              className="number-field text-left font-sans"
              value={job.filename}
              onChange={(event) => onFilenameChange(event.currentTarget.value)}
            />
          </label>

          <label className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">Format
            <select
              className="number-field text-left"
              value={job.settings.container}
              onChange={(event) => onChange({ container: event.currentTarget.value as VideoExportContainer })}
            >
              {containers.map((container) => (
                <option key={container} value={container}>{VIDEO_EXPORT_CONTAINER_LABELS[container]}</option>
              ))}
            </select>
          </label>

          <label className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">Quality
            <select
              className="number-field text-left"
              value={job.settings.quality}
              onChange={(event) => onChange({ quality: event.currentTarget.value as VideoExportQuality, customBitrateMbps: undefined })}
            >
              {VIDEO_EXPORT_QUALITY_ORDER.map((quality) => (
                <option key={quality} value={quality}>{VIDEO_EXPORT_QUALITY_LABELS[quality]}</option>
              ))}
            </select>
          </label>

          <label className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">Resolution
            <select
              className="number-field text-left"
              value={job.settings.resolutionScale}
              onChange={(event) => onChange({ resolutionScale: Number(event.currentTarget.value) })}
            >
              {RESOLUTION_SCALE_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>{preset.label}</option>
              ))}
            </select>
          </label>

          <label className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">Custom Bitrate
            <div className="flex items-center gap-2">
              <input
                className="number-field"
                type="number"
                min={0}
                placeholder="Mbps"
                value={job.settings.customBitrateMbps ?? ""}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  onChange({ customBitrateMbps: value === "" ? undefined : Math.max(0, Number(value)) });
                }}
              />
              <span className="text-[11px] text-editor-muted">Mbps (overrides quality)</span>
            </div>
          </label>
        </div>

        <div className="mt-5 flex justify-end">
          <button className="h-8 border border-editor-cyan bg-cyan-950/40 px-4 text-[12px] text-editor-cyan" style={{ borderRadius: 5 }} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
