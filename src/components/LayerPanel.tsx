import { ChevronRight, Eye, EyeOff, Image, Lock, Menu, Music, SlidersHorizontal, Square, Type, Unlock, Video, Wind } from "lucide-react";
import { useState } from "react";
import type { DragEvent } from "react";
import { useEditorStore } from "../store/editorStore";
import type { LayerType } from "../types/editor";

const layerIcons: Record<LayerType, typeof Square> = {
  text: Type,
  shape: Square,
  image: Image,
  video: Video,
  audio: Music,
  solid: Square,
  adjustment: SlidersHorizontal,
  null: ChevronRight,
};

type DropTarget = {
  layerId: string;
  placement: "above" | "below";
};

function placementFromDrag(event: DragEvent<HTMLDivElement>): DropTarget["placement"] {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "above" : "below";
}

type LayerPanelProps = {
  mobile?: boolean;
};

export function LayerPanel({ mobile = false }: LayerPanelProps) {
  const [dragLayerId, setDragLayerId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const composition = useEditorStore((state) =>
    state.project.compositions.find((item) => item.id === state.activeCompositionId),
  );
  const selectedLayerIds = useEditorStore((state) => state.selectedLayerIds);
  const selectLayer = useEditorStore((state) => state.selectLayer);
  const toggleLayerFlag = useEditorStore((state) => state.toggleLayerFlag);
  const setParentLayer = useEditorStore((state) => state.setParentLayer);
  const renameLayer = useEditorStore((state) => state.renameLayer);
  const reorderLayer = useEditorStore((state) => state.reorderLayer);

  if (!composition) return null;

  return (
    <aside className={`flex min-h-0 ${mobile ? "h-full w-full border-t" : "w-72 border-r"} flex-col panel-divider bg-editor-panel`}>
      <div className="flex h-10 items-center justify-between border-b panel-divider px-3">
        <span className="text-[12px] font-semibold uppercase text-editor-muted">Layers</span>
        <span className="font-mono text-[11px] text-editor-muted">{composition.layers.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {composition.layers.map((layer, index) => {
          const Icon = layerIcons[layer.type];
          const selected = selectedLayerIds.includes(layer.id);
          const droppingAbove = dropTarget?.layerId === layer.id && dropTarget.placement === "above";
          const droppingBelow = dropTarget?.layerId === layer.id && dropTarget.placement === "below";
          const activeDrag = dragLayerId === layer.id;
          return (
            <div
              key={layer.id}
              className={`grid grid-cols-[20px_28px_28px_28px_28px_minmax(0,1fr)] items-center gap-1 px-2 py-2 transition ${droppingAbove ? "border-t-2 border-t-editor-cyan" : ""} ${droppingBelow ? "border-b-2 border-b-editor-cyan" : "border-b border-editor-line/70"} ${activeDrag ? "opacity-55" : selected ? "bg-cyan-950/35" : "hover:bg-editor-panel2"}`}
              onClick={() => selectLayer(layer.id)}
              onDragOver={(event) => {
                if (!dragLayerId || dragLayerId === layer.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget({ layerId: layer.id, placement: placementFromDrag(event) });
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const sourceLayerId = dragLayerId ?? event.dataTransfer.getData("text/plain");
                const placement = dropTarget?.layerId === layer.id ? dropTarget.placement : placementFromDrag(event);

                if (sourceLayerId && sourceLayerId !== layer.id) {
                  reorderLayer(sourceLayerId, layer.id, placement);
                  selectLayer(sourceLayerId);
                }

                setDragLayerId(null);
                setDropTarget(null);
              }}
            >
              <button
                className={`flex h-6 w-5 cursor-grab items-center justify-center text-editor-muted transition hover:text-editor-cyan active:cursor-grabbing ${activeDrag ? "text-editor-cyan" : ""}`}
                title="Drag to reorder layer"
                draggable
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onDragStart={(event) => {
                  event.stopPropagation();
                  setDragLayerId(layer.id);
                  setDropTarget(null);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", layer.id);
                }}
                onDragEnd={() => {
                  setDragLayerId(null);
                  setDropTarget(null);
                }}
              >
                <Menu size={14} strokeWidth={2.2} />
              </button>
              <button className="icon-button h-6 w-6" title={layer.visible !== false ? "Hide layer" : "Show layer"} onClick={(event) => { event.stopPropagation(); toggleLayerFlag(layer.id, "visible"); }}>
                {layer.visible !== false ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button className="icon-button h-6 w-6" title={layer.locked ? "Unlock layer" : "Lock layer"} onClick={(event) => { event.stopPropagation(); toggleLayerFlag(layer.id, "locked"); }}>
                {layer.locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
              <button className={`icon-button h-6 w-6 ${layer.solo ? "icon-button-active" : ""}`} title="Solo layer" onClick={(event) => { event.stopPropagation(); toggleLayerFlag(layer.id, "solo"); }}>
                <span className="text-[10px] font-bold">S</span>
              </button>
              <button className={`icon-button h-6 w-6 ${layer.motionBlur ? "icon-button-active" : ""}`} title="Motion blur" onClick={(event) => { event.stopPropagation(); toggleLayerFlag(layer.id, "motionBlur"); }}>
                <Wind size={13} />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Icon className="shrink-0 text-editor-muted" size={14} />
                  <input className="min-w-0 flex-1 bg-transparent text-[13px] text-editor-ink outline-none" value={layer.name} onChange={(event) => renameLayer(layer.id, event.target.value)} onClick={(event) => event.stopPropagation()} />
                  <span className="font-mono text-[10px] text-editor-muted">{index + 1}</span>
                </div>
                <select className="mt-2 h-7 w-full border border-editor-line bg-editor-shell px-2 text-[11px] text-editor-muted outline-none focus:border-editor-cyan" value={layer.parentId ?? ""} onClick={(event) => event.stopPropagation()} onChange={(event) => setParentLayer(layer.id, event.currentTarget.value || undefined)}>
                  <option value="">No parent</option>
                  {composition.layers.filter((candidate) => candidate.id !== layer.id).map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}