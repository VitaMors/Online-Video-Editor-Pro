import { AlertTriangle, Check, File as FileIcon, Music, TriangleAlert, Video, X } from "lucide-react";
import { useEffect, useState } from "react";
import { acceptAttributeForKind, findMissingMedia, missingMediaKindLabel, type MissingMediaEntry } from "../lib/missingMedia";
import { useEditorStore } from "../store/editorStore";
import type { Project } from "../types/editor";

export const PROJECT_OPENED_EVENT = "bbvep:project-opened";

type ProjectOpenedDetail = {
  project: Project;
};

function kindIcon(kind: MissingMediaEntry["kind"]) {
  switch (kind) {
    case "video": return <Video size={14} />;
    case "audio": return <Music size={14} />;
    case "model": return <FileIcon size={14} />;
    default: return <FileIcon size={14} />;
  }
}

export function RelinkMediaDialog() {
  const relinkMediaSource = useEditorStore((state) => state.relinkMediaSource);
  const [entries, setEntries] = useState<MissingMediaEntry[] | null>(null);
  const [resolvedUrls, setResolvedUrls] = useState<Set<string>>(new Set());

  useEffect(() => {
    const onProjectOpened = (event: Event) => {
      const detail = (event as CustomEvent<ProjectOpenedDetail>).detail;
      if (!detail?.project) return;
      const missing = findMissingMedia(detail.project.compositions);
      setResolvedUrls(new Set());
      setEntries(missing.length > 0 ? missing : null);
    };
    window.addEventListener(PROJECT_OPENED_EVENT, onProjectOpened);
    return () => window.removeEventListener(PROJECT_OPENED_EVENT, onProjectOpened);
  }, []);

  if (!entries) return null;

  const onFilePicked = (url: string, file: File) => {
    relinkMediaSource(url, file);
    setResolvedUrls((current) => new Set(current).add(url));
  };

  const remaining = entries.filter((entry) => !resolvedUrls.has(entry.url)).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55">
      <div className="flex max-h-[80vh] w-[640px] flex-col border border-editor-line bg-editor-panel shadow-2xl" style={{ borderRadius: 6 }}>
        <div className="flex items-center justify-between border-b panel-divider px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-400" />
            <div>
              <div className="text-[14px] font-semibold text-editor-ink">Missing Media</div>
              <div className="mt-0.5 text-[11px] text-editor-muted">
                {entries.length} media {entries.length === 1 ? "file" : "files"} from this project couldn't be found - the media itself isn't saved inside a project file, only a reference to it. Locate each one below to relink it.
              </div>
            </div>
          </div>
          <button className="icon-button h-7 w-7" title="Close" onClick={() => setEntries(null)}><X size={14} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="space-y-2">
            {entries.map((entry) => {
              const resolved = resolvedUrls.has(entry.url);
              const inputId = `relink-media-input-${entry.url}`;
              return (
                <div key={entry.url} className="border border-editor-line bg-editor-shell px-3 py-2" style={{ borderRadius: 5 }}>
                  <div className="flex items-center gap-3">
                    <div className={resolved ? "text-emerald-400" : "text-amber-400"}>
                      {resolved ? <Check size={16} /> : <TriangleAlert size={16} />}
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {kindIcon(entry.kind)}
                      <div className="min-w-0">
                        <div className="truncate text-[12px] font-semibold text-editor-ink">
                          {entry.fileName || `Unnamed ${missingMediaKindLabel(entry.kind).toLowerCase()}`}
                        </div>
                        <div className="truncate text-[11px] text-editor-muted">
                          {missingMediaKindLabel(entry.kind)} · used by {entry.layers.length} {entry.layers.length === 1 ? "layer" : "layers"}: {" "}
                          {entry.layers.map((ref) => `${ref.layerName} (${ref.compositionName})`).join(", ")}
                        </div>
                      </div>
                    </div>
                    {/* A <label htmlFor> pointing at its own hidden file input - each entry gets a
                        fixed, correctly-typed accept filter from render time, instead of one shared
                        input whose accept attribute would need to react to an imperative click. */}
                    <input
                      id={inputId}
                      className="hidden"
                      type="file"
                      accept={acceptAttributeForKind(entry.kind)}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) onFilePicked(entry.url, file);
                        event.currentTarget.value = "";
                      }}
                    />
                    <label
                      htmlFor={inputId}
                      className={
                        resolved
                          ? "h-7 shrink-0 cursor-pointer border border-editor-line bg-editor-panel px-3 text-[11px] leading-7 text-editor-muted"
                          : "h-7 shrink-0 cursor-pointer border border-editor-cyan bg-cyan-950/40 px-3 text-[11px] font-semibold leading-7 text-editor-cyan"
                      }
                      style={{ borderRadius: 5 }}
                    >
                      {resolved ? "Relinked - Change" : "Locate…"}
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between border-t panel-divider px-4 py-3">
          <div className="text-[11px] text-editor-muted">
            {remaining === 0 ? "All media relinked." : `${remaining} still missing.`}
          </div>
          <button
            className="h-8 border border-editor-cyan bg-cyan-950/40 px-4 text-[12px] font-semibold text-editor-cyan"
            style={{ borderRadius: 5 }}
            onClick={() => setEntries(null)}
          >
            {remaining === 0 ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
