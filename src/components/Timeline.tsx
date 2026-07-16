import { ChevronDown, ChevronRight, Clock3, Copy, Gauge, LocateFixed, Maximize2, Scissors, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { propertyLabel } from "../lib/animation";
import { effectControlDefinition, effectDefinition, isEffectNumberControl } from "../lib/effects";
import { useEditorStore } from "../store/editorStore";
import type { Effect, EffectPropertyKey, Layer, Mask, MaskPropertyKey, TransformPropertyKey } from "../types/editor";

const labelWidth = 280;
const transformRows: TransformPropertyKey[] = ["position", "scale", "rotation", "opacity"];
const modelTransformRows: TransformPropertyKey[] = ["position", "scale", "rotationX", "rotationY", "rotation", "opacity"];
const maskRows: MaskPropertyKey[] = ["path", "feather", "position", "scale"];
const rowHeight = 28;
const rulerHeight = 30;

type TimelineRow =
  | { kind: "layer"; layer: Layer }
  | { kind: "property"; layer: Layer; property: TransformPropertyKey }
  | { kind: "timeRemap"; layer: Layer }
  | { kind: "effect"; layer: Layer; effect: Effect }
  | { kind: "effectProperty"; layer: Layer; effect: Effect; property: EffectPropertyKey }
  | { kind: "mask"; layer: Layer; mask: Mask }
  | { kind: "maskProperty"; layer: Layer; mask: Mask; property: MaskPropertyKey };

type Dragging =
  | "playhead"
  | { type: "layerTrim"; layerId: string; edge: "in" | "out" }
  | { type: "layerMove"; layerId: string; startPointerFrame: number; startFrame: number; endFrame: number }
  | { type: "timeRemap"; layerId: string; keyframeId: string }
  | { type: "effect"; layerId: string; effectId: string; property: EffectPropertyKey; keyframeId: string }
  | { type: "transform"; layerId: string; property: TransformPropertyKey; keyframeId: string }
  | { type: "mask"; layerId: string; maskId: string; property: MaskPropertyKey; keyframeId: string };

function maskPropertyLabel(property: MaskPropertyKey) {
  const labels: Record<MaskPropertyKey, string> = {
    path: "Mask Path",
    feather: "Feather",
    position: "Position",
    scale: "Scale",
  };
  return labels[property];
}

function frameFromSvgPoint(svg: SVGSVGElement, clientX: number, frameWidth: number, durationFrames: number, allowEnd = false) {
  const rect = svg.getBoundingClientRect();
  const svgWidth = Number(svg.getAttribute("width")) || rect.width;
  const x = (clientX - rect.left) * (svgWidth / Math.max(1, rect.width));
  const maxFrame = allowEnd ? durationFrames : durationFrames - 1;
  return Math.min(maxFrame, Math.max(0, Math.round(x / frameWidth)));
}

function frameFromPointer(event: React.PointerEvent<SVGSVGElement>, frameWidth: number, durationFrames: number, allowEnd = false) {
  return frameFromSvgPoint(event.currentTarget, event.clientX, frameWidth, durationFrames, allowEnd);
}

function rowKey(row: TimelineRow) {
  if (row.kind === "layer") return row.layer.id;
  if (row.kind === "property") return `${row.layer.id}-${row.property}`;
  if (row.kind === "timeRemap") return `${row.layer.id}-time-remap`;
  if (row.kind === "effect") return `${row.layer.id}-${row.effect.id}`;
  if (row.kind === "effectProperty") return `${row.layer.id}-${row.effect.id}-${row.property}`;
  if (row.kind === "mask") return `${row.layer.id}-${row.mask.id}`;
  return `${row.layer.id}-${row.mask.id}-${row.property}`;
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type TimelineProps = {
  mobile?: boolean;
};

export function Timeline({ mobile = false }: TimelineProps) {
  const [expandedLayerIds, setExpandedLayerIds] = useState<string[]>([]);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const composition = useEditorStore((state) => state.project.compositions.find((item) => item.id === state.activeCompositionId));
  const selectedLayerIds = useEditorStore((state) => state.selectedLayerIds);
  const selectedProperty = useEditorStore((state) => state.selectedProperty);
  const selectedKeyframeIds = useEditorStore((state) => state.selectedKeyframeIds);
  const selectedMaskId = useEditorStore((state) => state.selectedMaskId);
  const selectedMaskProperty = useEditorStore((state) => state.selectedMaskProperty);
  const selectedSourceProperty = useEditorStore((state) => state.selectedSourceProperty);
  const selectedEffectId = useEditorStore((state) => state.selectedEffectId);
  const selectedEffectProperty = useEditorStore((state) => state.selectedEffectProperty);
  const playheadFrame = useEditorStore((state) => state.playheadFrame);
  const timelineZoom = useEditorStore((state) => state.timelineZoom);
  const graphMode = useEditorStore((state) => state.graphMode);
  const setTimelineZoom = useEditorStore((state) => state.setTimelineZoom);
  const setPlayheadFrame = useEditorStore((state) => state.setPlayheadFrame);
  const setLayerTiming = useEditorStore((state) => state.setLayerTiming);
  const updateActiveCompositionSettings = useEditorStore((state) => state.updateActiveCompositionSettings);
  const moveLayerTiming = useEditorStore((state) => state.moveLayerTiming);
  const selectLayer = useEditorStore((state) => state.selectLayer);
  const selectProperty = useEditorStore((state) => state.selectProperty);
  const selectMask = useEditorStore((state) => state.selectMask);
  const selectTimeRemap = useEditorStore((state) => state.selectTimeRemap);
  const selectEffect = useEditorStore((state) => state.selectEffect);
  const selectKeyframe = useEditorStore((state) => state.selectKeyframe);
  const moveKeyframe = useEditorStore((state) => state.moveKeyframe);
  const moveTimeRemapKeyframe = useEditorStore((state) => state.moveTimeRemapKeyframe);
  const moveEffectKeyframe = useEditorStore((state) => state.moveEffectKeyframe);
  const moveMaskKeyframe = useEditorStore((state) => state.moveMaskKeyframe);
  const copySelection = useEditorStore((state) => state.copySelection);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);
  const splitSelectedLayers = useEditorStore((state) => state.splitSelectedLayers);
  const setGraphMode = useEditorStore((state) => state.setGraphMode);

  const rows = useMemo<TimelineRow[]>(() => {
    if (!composition) return [];
    return composition.layers.flatMap((layer) => {
      const expanded = expandedLayerIds.includes(layer.id);
      const layerRow: TimelineRow = { kind: "layer", layer };
      if (!expanded) return [layerRow];

      const currentTransformRows = layer.type === "model" ? modelTransformRows : transformRows;
      const transformPropertyRows = currentTransformRows.map<TimelineRow>((property) => ({ kind: "property", layer, property }));
      const timeRemapRows = layer.type === "video" && layer.source?.timeRemap
        ? [{ kind: "timeRemap", layer } satisfies TimelineRow]
        : [];
      const layerEffectRows = layer.effects.flatMap<TimelineRow>((effect) => [
        { kind: "effect", layer, effect },
        ...effectDefinition(effect).controls
          .filter((control) => control.kind === "number" && isEffectNumberControl(effect.controls[control.key]))
          .map<TimelineRow>((control) => ({ kind: "effectProperty", layer, effect, property: control.key })),
      ]);
      const layerMaskRows = layer.masks.flatMap<TimelineRow>((mask) => [
        { kind: "mask", layer, mask },
        ...maskRows.map<TimelineRow>((property) => ({ kind: "maskProperty", layer, mask, property })),
      ]);

      return [layerRow, ...layerMaskRows, ...timeRemapRows, ...layerEffectRows, ...transformPropertyRows];
    });
  }, [composition, expandedLayerIds]);

  if (!composition) return null;

  const frameWidth = Math.max(1, finiteNumber(timelineZoom, 4));
  const durationFrames = Math.max(1, Math.round(finiteNumber(composition.durationFrames, 300)));
  const fps = Math.max(1, Math.round(finiteNumber(composition.fps, 30)));
  const tickEvery = fps;
  const timelineWidth = durationFrames * frameWidth;
  const timelineCanvasWidth = Math.max(timelineWidth, 900);
  const timelineHeight = rows.length * rowHeight + rulerHeight;
  const currentLabelWidth = mobile ? 168 : labelWidth;
  const timelineGridWidth = currentLabelWidth + timelineCanvasWidth;
  const canSplitLayer = selectedLayerIds.some((layerId) => {
    const layer = composition.layers.find((candidate) => candidate.id === layerId);
    return Boolean(layer && !layer.locked && playheadFrame > layer.startFrame && playheadFrame < layer.endFrame);
  });
  const canTrimCompositionToPlayhead = playheadFrame > 0 && playheadFrame < durationFrames - 1;
  const trimCompositionToPlayhead = () => {
    if (!canTrimCompositionToPlayhead) return;
    updateActiveCompositionSettings({ durationFrames: Math.max(1, playheadFrame) });
  };

  const fitTimeline = () => {
    const scroller = timelineScrollRef.current;
    const availableWidth = Math.max(240, (scroller?.clientWidth ?? 900) - currentLabelWidth);
    setTimelineZoom(availableWidth / durationFrames);
    if (scroller) scroller.scrollLeft = 0;
  };

  const centerPlayhead = () => {
    const scroller = timelineScrollRef.current;
    if (!scroller) return;
    const playheadX = currentLabelWidth + playheadFrame * frameWidth;
    scroller.scrollLeft = Math.max(0, playheadX - scroller.clientWidth / 2);
  };

  const rowSelected = (row: TimelineRow) => {
    if (row.kind === "layer") return selectedLayerIds.includes(row.layer.id) && !selectedMaskId && !selectedEffectId;
    if (row.kind === "property") return selectedLayerIds.includes(row.layer.id) && selectedProperty === row.property && !selectedMaskId && !selectedSourceProperty && !selectedEffectId;
    if (row.kind === "timeRemap") return selectedLayerIds.includes(row.layer.id) && selectedSourceProperty === "timeRemap";
    if (row.kind === "effect") return selectedLayerIds.includes(row.layer.id) && selectedEffectId === row.effect.id && !selectedEffectProperty;
    if (row.kind === "effectProperty") return selectedLayerIds.includes(row.layer.id) && selectedEffectId === row.effect.id && selectedEffectProperty === row.property;
    if (row.kind === "mask") return selectedLayerIds.includes(row.layer.id) && selectedMaskId === row.mask.id && !selectedMaskProperty;
    return selectedLayerIds.includes(row.layer.id) && selectedMaskId === row.mask.id && selectedMaskProperty === row.property;
  };

  const selectRow = (row: TimelineRow) => {
    selectLayer(row.layer.id);
    if (row.kind === "property") selectProperty(row.property);
    if (row.kind === "timeRemap") selectTimeRemap(row.layer.id);
    if (row.kind === "mask") selectMask(row.mask.id);
    if (row.kind === "maskProperty") selectMask(row.mask.id, row.property);
  };

  return (
    <section className={`flex ${mobile ? "h-full" : "h-56"} min-h-0 min-w-0 flex-col overflow-hidden border-t panel-divider bg-editor-shell`}>
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 overflow-x-auto border-b panel-divider px-3">
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[12px] font-semibold uppercase text-editor-muted">Timeline</span>
          <button className="icon-button h-7 w-7" title="Copy keyframes" onClick={copySelection}><Copy size={13} /></button>
          <button className="icon-button h-7 w-7" title="Split selected layer at playhead" disabled={!canSplitLayer} onClick={splitSelectedLayers}><Scissors size={13} /></button>
          <button className="icon-button h-7 w-7" title="Trim composition to playhead" disabled={!canTrimCompositionToPlayhead} onClick={trimCompositionToPlayhead}><Clock3 size={13} /></button>
          <button className="icon-button h-7 w-7" title="Delete selection" onClick={deleteSelection}><Trash2 size={13} /></button>
          <button className={`icon-button h-7 w-7 ${graphMode === "speed" ? "icon-button-active" : ""}`} title="Speed graph" onClick={() => setGraphMode(graphMode === "speed" ? "value" : "speed")}><Gauge size={13} /></button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="icon-button h-7 w-7" title="Fit timeline" onClick={fitTimeline}><Maximize2 size={13} /></button>
          <button className="icon-button h-7 w-7" title="Center playhead" onClick={centerPlayhead}><LocateFixed size={13} /></button>
          <label className="flex items-center gap-2 text-[12px] text-editor-muted">Zoom<input className="w-28 accent-editor-cyan" type="range" min={1} max={18} value={frameWidth} onChange={(event) => setTimelineZoom(Number(event.currentTarget.value))} /></label>
        </div>
      </div>
      <div ref={timelineScrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="grid min-h-full" style={{ width: timelineGridWidth, gridTemplateColumns: `${currentLabelWidth}px ${timelineCanvasWidth}px` }}>
          <div className="sticky left-0 z-10 border-r panel-divider bg-editor-shell">
            <div className="sticky top-0 z-10 h-[30px] border-b panel-divider bg-editor-shell px-3 py-2 text-[11px] uppercase text-editor-muted">Layer</div>
            <div>
              {rows.map((row) => {
                const key = rowKey(row);
                const selected = rowSelected(row);
                const expanded = expandedLayerIds.includes(row.layer.id);
                return (
                  <button key={key} className={`flex h-7 w-full items-center gap-2 border-b border-editor-line/70 px-3 text-left text-[12px] ${selected ? "bg-cyan-950/35 text-editor-cyan" : "text-editor-muted"}`} onClick={() => selectRow(row)}>
                    {row.kind === "layer" ? (
                      <span className="flex h-5 w-5 items-center justify-center" onClick={(event) => { event.stopPropagation(); setExpandedLayerIds((current) => current.includes(row.layer.id) ? current.filter((id) => id !== row.layer.id) : [...current, row.layer.id]); }}>
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                    ) : <span className="w-5" />}
                    {row.kind === "layer" ? <span className="truncate">{row.layer.name}</span> : null}
                    {row.kind === "property" ? <span className="truncate pl-4">{propertyLabel(row.property)}</span> : null}
                    {row.kind === "timeRemap" ? <span className="truncate pl-4">Time Remap</span> : null}
                    {row.kind === "mask" ? <span className="truncate pl-4 font-medium text-editor-ink">{row.mask.name}</span> : null}
                    {row.kind === "maskProperty" ? <span className="truncate pl-8">{maskPropertyLabel(row.property)}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
          <svg
            width={timelineCanvasWidth}
            height={timelineHeight}
            className="block select-none"
            onPointerDown={(event) => { event.preventDefault(); setDragging("playhead"); setPlayheadFrame(frameFromPointer(event, frameWidth, durationFrames)); event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={(event) => {
              if (!dragging) return;
              const allowEndFrame = dragging !== "playhead" && (dragging.type === "layerTrim" || dragging.type === "layerMove");
              const frame = frameFromPointer(event, frameWidth, durationFrames, allowEndFrame);
              if (dragging === "playhead") setPlayheadFrame(frame);
              else if (dragging.type === "layerTrim") {
                const layer = composition.layers.find((candidate) => candidate.id === dragging.layerId);
                if (!layer) return;
                if (dragging.edge === "in") setLayerTiming(layer.id, Math.min(frame, layer.endFrame - 1), layer.endFrame);
                else setLayerTiming(layer.id, layer.startFrame, Math.max(frame, layer.startFrame + 1));
              }
              else if (dragging.type === "layerMove") {
                const delta = frame - dragging.startPointerFrame;
                moveLayerTiming(dragging.layerId, dragging.startFrame + delta);
              }
              else if (dragging.type === "timeRemap") moveTimeRemapKeyframe(dragging.layerId, dragging.keyframeId, frame);
              else if (dragging.type === "effect") moveEffectKeyframe(dragging.layerId, dragging.effectId, dragging.property, dragging.keyframeId, frame);
              else if (dragging.type === "transform") moveKeyframe(dragging.layerId, dragging.property, dragging.keyframeId, frame);
              else moveMaskKeyframe(dragging.layerId, dragging.maskId, dragging.property, dragging.keyframeId, frame);
            }}
            onPointerUp={(event) => {
              setDragging(null);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          >
            <rect width="100%" height="100%" fill="#0d1117" />
            <rect x={0} y={0} width={timelineWidth} height={rulerHeight} fill="#151b23" />
            {Array.from({ length: Math.ceil(durationFrames / tickEvery) + 1 }).map((_, index) => {
              const frame = index * tickEvery;
              const x = frame * frameWidth;
              return <g key={frame}><line x1={x} y1={0} x2={x} y2={timelineHeight} stroke="#2b3545" /><text x={x + 4} y={19} fill="#8b949e" fontSize={11} fontFamily="monospace" style={{ userSelect: "none", pointerEvents: "none" }}>{frame / fps}s</text></g>;
            })}
            {rows.map((row, index) => {
              const y = rulerHeight + index * rowHeight;
              const selected = rowSelected(row);
              const key = rowKey(row);
              const propertyKeyframes = row.kind === "property" ? row.layer.transform[row.property]?.keyframes ?? [] : [];
              const timeRemapKeyframes = row.kind === "timeRemap" ? row.layer.source?.timeRemap?.keyframes ?? [] : [];
              const maskKeyframes = row.kind === "maskProperty" ? row.mask[row.property].keyframes : [];
              const effectControl = row.kind === "effectProperty" ? row.effect.controls[row.property] : undefined;
              const effectKeyframes = isEffectNumberControl(effectControl) ? effectControl.keyframes : [];
              return (
                <g key={key}>
                  <rect x={0} y={y} width={timelineCanvasWidth} height={rowHeight} fill={selected ? "rgba(57, 208, 200, 0.08)" : "transparent"} />
                  <line x1={0} y1={y + rowHeight} x2={timelineCanvasWidth} y2={y + rowHeight} stroke="rgba(43, 53, 69, 0.75)" />
                  {row.kind === "layer" ? (() => {
                    const layerStartX = row.layer.startFrame * frameWidth;
                    const layerEndX = row.layer.endFrame * frameWidth;
                    const layerWidth = Math.max(2, layerEndX - layerStartX);
                    const handleWidth = Math.max(6, Math.min(12, layerWidth / 2));
                    const handleFill = selected ? "#f2b84b" : "#596579";

                    return (
                      <g>
                        <rect
                          x={layerStartX}
                          y={y + 7}
                          width={layerWidth}
                          height={14}
                          fill={row.layer.locked ? "#596579" : "#293241"}
                          stroke="#596579"
                          rx={3}
                          cursor={row.layer.locked ? "default" : "grab"}
                          onPointerDown={(event) => {
                            if (row.layer.locked) return;
                            event.preventDefault();
                            event.stopPropagation();
                            selectLayer(row.layer.id);
                            const svg = event.currentTarget.ownerSVGElement;
                            const startPointerFrame = svg ? frameFromSvgPoint(svg, event.clientX, frameWidth, durationFrames, true) : row.layer.startFrame;
                            setDragging({ type: "layerMove", layerId: row.layer.id, startPointerFrame, startFrame: row.layer.startFrame, endFrame: row.layer.endFrame });
                            svg?.setPointerCapture(event.pointerId);
                          }}
                        />
                        <rect
                          x={layerStartX}
                          y={y + 5}
                          width={handleWidth}
                          height={18}
                          fill={handleFill}
                          opacity={row.layer.locked ? 0.35 : 0.95}
                          cursor={row.layer.locked ? "default" : "ew-resize"}
                          onPointerDown={(event) => {
                            if (row.layer.locked) return;
                            event.preventDefault();
                            event.stopPropagation();
                            selectLayer(row.layer.id);
                            setDragging({ type: "layerTrim", layerId: row.layer.id, edge: "in" });
                            event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                          }}
                        />
                        <rect
                          x={layerEndX - handleWidth}
                          y={y + 5}
                          width={handleWidth}
                          height={18}
                          fill={handleFill}
                          opacity={row.layer.locked ? 0.35 : 0.95}
                          cursor={row.layer.locked ? "default" : "ew-resize"}
                          onPointerDown={(event) => {
                            if (row.layer.locked) return;
                            event.preventDefault();
                            event.stopPropagation();
                            selectLayer(row.layer.id);
                            setDragging({ type: "layerTrim", layerId: row.layer.id, edge: "out" });
                            event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                          }}
                        />
                      </g>
                    );
                  })() : null}
                  {timeRemapKeyframes.map((keyframe) => {
                    const x = keyframe.frame * frameWidth;
                    const selectedKeyframe = selectedKeyframeIds.includes(keyframe.id);
                    if (row.kind !== "timeRemap") return null;
                    return (
                      <g key={keyframe.id} transform={`translate(${x} ${y + rowHeight / 2}) rotate(45)`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); selectTimeRemap(row.layer.id); selectKeyframe(keyframe.id, event.shiftKey); setDragging({ type: "timeRemap", layerId: row.layer.id, keyframeId: keyframe.id }); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); }}>
                        <rect x={-5} y={-5} width={10} height={10} fill={selectedKeyframe ? "#f2b84b" : "#9b8cff"} stroke="#0d1117" strokeWidth={1.5} />
                      </g>
                    );
                  })}
                  {effectKeyframes.map((keyframe) => {
                    const x = keyframe.frame * frameWidth;
                    const selectedKeyframe = selectedKeyframeIds.includes(keyframe.id);
                    if (row.kind !== "effectProperty") return null;
                    return (
                      <g key={keyframe.id} transform={`translate(${x} ${y + rowHeight / 2}) rotate(45)`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); selectLayer(row.layer.id); selectEffect(row.layer.id, row.effect.id, row.property); selectKeyframe(keyframe.id, event.shiftKey); setDragging({ type: "effect", layerId: row.layer.id, effectId: row.effect.id, property: row.property, keyframeId: keyframe.id }); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); }}>
                        <rect x={-5} y={-5} width={10} height={10} fill={selectedKeyframe ? "#f2b84b" : "#ff7ab6"} stroke="#0d1117" strokeWidth={1.5} />
                      </g>
                    );
                  })}                  {propertyKeyframes.map((keyframe) => {
                    const x = keyframe.frame * frameWidth;
                    const selectedKeyframe = selectedKeyframeIds.includes(keyframe.id);
                    if (row.kind !== "property") return null;
                    return (
                      <g key={keyframe.id} transform={`translate(${x} ${y + rowHeight / 2}) rotate(45)`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); selectLayer(row.layer.id); selectProperty(row.property); selectKeyframe(keyframe.id, event.shiftKey); setDragging({ type: "transform", layerId: row.layer.id, property: row.property, keyframeId: keyframe.id }); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); }}>
                        <rect x={-5} y={-5} width={10} height={10} fill={selectedKeyframe ? "#f2b84b" : "#39d0c8"} stroke="#0d1117" strokeWidth={1.5} />
                      </g>
                    );
                  })}
                  {maskKeyframes.map((keyframe) => {
                    const x = keyframe.frame * frameWidth;
                    const selectedKeyframe = selectedKeyframeIds.includes(keyframe.id);
                    if (row.kind !== "maskProperty") return null;
                    return (
                      <g key={keyframe.id} transform={`translate(${x} ${y + rowHeight / 2}) rotate(45)`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); selectLayer(row.layer.id); selectMask(row.mask.id, row.property); selectKeyframe(keyframe.id, event.shiftKey); setDragging({ type: "mask", layerId: row.layer.id, maskId: row.mask.id, property: row.property, keyframeId: keyframe.id }); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); }}>
                        <rect x={-5} y={-5} width={10} height={10} fill={selectedKeyframe ? "#f2b84b" : "#9b8cff"} stroke="#0d1117" strokeWidth={1.5} />
                      </g>
                    );
                  })}
                </g>
              );
            })}
            <line x1={playheadFrame * frameWidth} y1={0} x2={playheadFrame * frameWidth} y2={timelineHeight} stroke="#ff6b8a" strokeWidth={2} />
            <g transform={`translate(${playheadFrame * frameWidth} 0)`}><path d="M -7 0 H 7 L 0 12 Z" fill="#ff6b8a" /></g>
          </svg>
        </div>
      </div>
    </section>
  );
}