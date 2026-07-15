import { ChevronDown, ChevronUp, Clock3, Copy, Diamond, Link2, Link2Off, PanelRightClose, PanelRightOpen, Power, RotateCcw, SkipBack, SkipForward, Trash2 } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { evaluatePathProperty, evaluateProperty, propertyLabel } from "../lib/animation";
import { effectControlDefinition, effectDefinition, effectNumberValue, effectStaticValue, isEffectNumberControl } from "../lib/effects";
import { useEditorStore } from "../store/editorStore";
import type { AnimatableProperty, AnimatableValue, EasePreset, Effect, EffectPropertyKey, Keyframe, Mask, MaskPropertyKey, SpatialVector, TransformPropertyKey } from "../types/editor";

const rows: TransformPropertyKey[] = ["position", "scale", "rotation", "opacity", "anchorPoint"];
const modelRows: TransformPropertyKey[] = ["position", "scale", "rotationX", "rotationY", "rotation", "opacity", "anchorPoint"];

function isTuple(value: AnimatableValue): value is [number, number] {
  return Array.isArray(value);
}

function scrubStep(property: TransformPropertyKey | MaskPropertyKey) {
  if (property === "rotation" || property === "rotationX" || property === "rotationY") return 0.25;
  if (property === "scale" || property === "opacity" || property === "feather") return 0.5;
  return 1;
}

function formatNumber(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

type DragNumberFieldProps = {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  step?: number;
};

function DragNumberField({ value, onChange, className = "", step = 1 }: DragNumberFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(formatNumber(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{ startX: number; startValue: number } | null>(null);
  const displayValue = formatNumber(value);

  useEffect(() => {
    if (!editing) setDraftValue(displayValue);
  }, [displayValue, editing]);

  const beginEditing = () => {
    setDraftValue(formatNumber(value));
    setEditing(true);
    window.setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitEditing = () => {
    const parsed = Number(draftValue);
    if (Number.isFinite(parsed)) onChange(Math.round(parsed * 100) / 100);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`number-field min-w-0 ${className}`}
        title="Type a value."
        value={draftValue}
        onBlur={commitEditing}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitEditing();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraftValue(formatNumber(value));
            setEditing(false);
          }
        }}
        onChange={(event) => setDraftValue(event.currentTarget.value)}
      />
    );
  }

  return (
    <button
      type="button"
      className={`inline-flex h-7 min-w-0 cursor-ew-resize select-none items-center justify-end overflow-visible whitespace-nowrap bg-transparent px-0.5 text-right font-mono text-[12px] text-editor-ink outline-none transition hover:text-editor-cyan focus:text-editor-cyan ${className}`}
      title={`${displayValue} - drag left or right. Double-click to type.`}
      onDoubleClick={(event) => {
        event.stopPropagation();
        beginEditing();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        dragRef.current = { startX: event.clientX, startValue: value };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const nextValue = drag.startValue + (event.clientX - drag.startX) * step;
        onChange(Math.round(nextValue * 100) / 100);
      }}
      onPointerUp={(event) => {
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
    >
      {displayValue}
    </button>
  );
}

function selectedKeyframeFrom(keyframes: Keyframe[], selectedIds: string[]) {
  return keyframes.find((keyframe) => selectedIds.includes(keyframe.id));
}

function maskPropertyLabel(property: MaskPropertyKey) {
  const labels: Record<MaskPropertyKey, string> = {
    path: "Mask Path",
    feather: "Feather",
    position: "Position",
    scale: "Scale",
  };
  return labels[property];
}

function evaluatedMaskPath(mask: Mask, frame: number) {
  return evaluatePathProperty(mask.path, frame);
}

function maskNumberValue(mask: Mask, property: "feather", frame: number) {
  return evaluateProperty(mask[property], frame);
}

function maskTupleValue(mask: Mask, property: "position" | "scale", frame: number) {
  return evaluateProperty(mask[property], frame);
}

type PropertyInspectorProps = {
  collapsed?: boolean;
  mobile?: boolean;
  onToggleCollapsed?: () => void;
};

function InspectorRail({ onToggleCollapsed }: { onToggleCollapsed?: () => void }) {
  return (
    <aside className="flex min-h-0 w-11 shrink-0 flex-col items-center border-l panel-divider bg-editor-panel py-2">
      <button type="button" className="icon-button h-7 w-7" title="Show inspector" onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); onToggleCollapsed?.(); }} onKeyDown={(event) => { if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); event.stopPropagation(); onToggleCollapsed?.(); }}>
        <PanelRightOpen size={14} />
      </button>
      <div className="mt-4 rotate-180 select-none text-[11px] font-semibold uppercase tracking-wide text-editor-muted" style={{ writingMode: "vertical-rl" }}>
        Inspector
      </div>
    </aside>
  );
}

function InspectorHeader({ title, onToggleCollapsed }: { title: string; onToggleCollapsed?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b panel-divider px-4 py-3">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold uppercase text-editor-muted">Inspector</div>
        <div className="mt-1 truncate text-[14px] font-medium text-editor-ink">{title}</div>
      </div>
      <button type="button" className="icon-button h-7 w-7 shrink-0" title="Hide inspector" onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); onToggleCollapsed?.(); }} onKeyDown={(event) => { if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); event.stopPropagation(); onToggleCollapsed?.(); }}>
        <PanelRightClose size={14} />
      </button>
    </div>
  );
}

export function PropertyInspector({ collapsed = false, mobile = false, onToggleCollapsed }: PropertyInspectorProps) {
  const selectedMaskRowRef = useRef<HTMLDivElement | null>(null);
  const transformSectionRef = useRef<HTMLElement | null>(null);
  const [scaleLinkedByLayer, setScaleLinkedByLayer] = useState<Record<string, boolean>>({});
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
  const selectProperty = useEditorStore((state) => state.selectProperty);
  const selectMask = useEditorStore((state) => state.selectMask);
  const selectTimeRemap = useEditorStore((state) => state.selectTimeRemap);
  const selectEffect = useEditorStore((state) => state.selectEffect);
  const updateTransformValue = useEditorStore((state) => state.updateTransformValue);
  const resetTransformProperty = useEditorStore((state) => state.resetTransformProperty);
  const toggleAnimation = useEditorStore((state) => state.toggleAnimation);
  const addOrUpdateKeyframe = useEditorStore((state) => state.addOrUpdateKeyframe);
  const toggleTimeRemap = useEditorStore((state) => state.toggleTimeRemap);
  const updateTimeRemapValue = useEditorStore((state) => state.updateTimeRemapValue);
  const addOrUpdateTimeRemapKeyframe = useEditorStore((state) => state.addOrUpdateTimeRemapKeyframe);
  const toggleEffectEnabled = useEditorStore((state) => state.toggleEffectEnabled);
  const reorderEffect = useEditorStore((state) => state.reorderEffect);
  const duplicateEffect = useEditorStore((state) => state.duplicateEffect);
  const removeEffect = useEditorStore((state) => state.removeEffect);
  const resetEffect = useEditorStore((state) => state.resetEffect);
  const updateEffectNumberValue = useEditorStore((state) => state.updateEffectNumberValue);
  const updateEffectStaticValue = useEditorStore((state) => state.updateEffectStaticValue);
  const toggleEffectAnimation = useEditorStore((state) => state.toggleEffectAnimation);
  const addOrUpdateEffectKeyframe = useEditorStore((state) => state.addOrUpdateEffectKeyframe);
  const freezeTimeRemap = useEditorStore((state) => state.freezeTimeRemap);
  const reverseTimeRemap = useEditorStore((state) => state.reverseTimeRemap);
  const previousKeyframe = useEditorStore((state) => state.previousKeyframe);
  const nextKeyframe = useEditorStore((state) => state.nextKeyframe);
  const updateKeyframe = useEditorStore((state) => state.updateKeyframe);
  const applyEasePreset = useEditorStore((state) => state.applyEasePreset);
  const updateMaskValue = useEditorStore((state) => state.updateMaskValue);
  const toggleMaskAnimation = useEditorStore((state) => state.toggleMaskAnimation);
  const addOrUpdateMaskKeyframe = useEditorStore((state) => state.addOrUpdateMaskKeyframe);
  const layer = composition?.layers.find((item) => item.id === selectedLayerIds[0]);
  const selectedPropertyState = layer?.transform[selectedProperty];
  const selectedTimeRemapProperty = selectedSourceProperty === "timeRemap" ? layer?.source?.timeRemap : undefined;
  const selectedEffect = layer?.effects.find((effect) => effect.id === selectedEffectId);
  const selectedEffectControl = selectedEffect && selectedEffectProperty ? selectedEffect.controls[selectedEffectProperty] : undefined;
  const selectedEffectPropertyState = isEffectNumberControl(selectedEffectControl) ? selectedEffectControl : undefined;
  const selectedMask = layer?.masks.find((mask) => mask.id === selectedMaskId) ?? layer?.masks[0];
  const selectedMaskPropertyState = selectedMask && selectedMaskProperty ? selectedMask[selectedMaskProperty] : undefined;
  const selectedKeyframe = selectedEffectPropertyState
    ? selectedKeyframeFrom(selectedEffectPropertyState.keyframes as unknown as Keyframe[], selectedKeyframeIds)
    : selectedTimeRemapProperty
      ? selectedKeyframeFrom(selectedTimeRemapProperty.keyframes as unknown as Keyframe[], selectedKeyframeIds)
      : selectedMaskPropertyState
        ? selectedKeyframeFrom(selectedMaskPropertyState.keyframes as unknown as Keyframe[], selectedKeyframeIds)
        : selectedPropertyState
          ? selectedKeyframeFrom(selectedPropertyState.keyframes as Keyframe[], selectedKeyframeIds)
          : undefined;
  const scaleLinked = layer ? scaleLinkedByLayer[layer.id] ?? true : true;

  useEffect(() => {
    if (!selectedMaskId || !selectedMaskProperty) return;
    selectedMaskRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedMaskId, selectedMaskProperty]);

  useEffect(() => {
    if (selectedMaskId) return;
    transformSectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [layer?.id, selectedProperty, selectedMaskId]);

  const inspectorShellClass = mobile
    ? "flex h-full min-h-0 w-full flex-col overflow-hidden border-t panel-divider bg-editor-panel"
    : "flex min-h-0 w-[360px] shrink-0 flex-col overflow-hidden border-l panel-divider bg-editor-panel";
  const headerToggle = mobile ? undefined : onToggleCollapsed;

  if (collapsed && !mobile) {
    return <InspectorRail onToggleCollapsed={onToggleCollapsed} />;
  }

  if (!layer) {
    return (
      <aside className={inspectorShellClass}>
        <InspectorHeader title="No layer selected" onToggleCollapsed={headerToggle} />
        <div className="p-4 text-[13px] text-editor-muted">No layer selected</div>
      </aside>
    );
  }

  const maskPropertyActive = (mask: Mask, property: MaskPropertyKey) => selectedMask?.id === mask.id && selectedMaskProperty === property;

  const renderMaskKeyButtons = (mask: Mask, property: MaskPropertyKey) => {
    const propertyState = mask[property];
    return (
      <div className="flex justify-end gap-1">
        <button className={`icon-button h-7 w-7 ${propertyState.animated ? "icon-button-active" : ""}`} title="Toggle animation" onClick={(event) => { event.stopPropagation(); toggleMaskAnimation(layer.id, mask.id, property); }}><Clock3 size={13} /></button>
        <button className="icon-button h-7 w-7" title="Add keyframe" onClick={(event) => { event.stopPropagation(); addOrUpdateMaskKeyframe(layer.id, mask.id, property); }}><Diamond size={13} /></button>
      </div>
    );
  };

  const renderMaskPathRow = (mask: Mask) => {
    const path = evaluatedMaskPath(mask, playheadFrame);
    return (
      <div ref={maskPropertyActive(mask, "path") ? selectedMaskRowRef : null} className={`grid grid-cols-[92px_minmax(0,1fr)_60px] items-center gap-2 px-4 py-1.5 ${maskPropertyActive(mask, "path") ? "bg-editor-panel2" : "bg-editor-panel2/40"}`} onClick={() => selectMask(mask.id, "path")}>
        <button className="flex min-w-0 items-center text-left text-[12px] text-editor-muted" onClick={() => selectMask(mask.id, "path")}>
          <span className="truncate">{maskPropertyLabel("path")}</span>
        </button>
        <div className="h-7 min-w-0 border border-editor-line bg-editor-shell px-2 py-1.5 font-mono text-[11px] text-editor-muted" style={{ borderRadius: 5 }}>
          {path.length} pts
        </div>
        {renderMaskKeyButtons(mask, "path")}
      </div>
    );
  };

  const renderMaskNumberRow = (mask: Mask, property: "feather") => {
    const value = maskNumberValue(mask, property, playheadFrame);
    return (
      <div ref={maskPropertyActive(mask, property) ? selectedMaskRowRef : null} className={`grid grid-cols-[92px_minmax(0,1fr)_60px] items-center gap-2 px-4 py-1.5 ${maskPropertyActive(mask, property) ? "bg-editor-panel2" : "bg-editor-panel2/40"}`} onClick={() => selectMask(mask.id, property)}>
        <button className="flex min-w-0 items-center text-left text-[12px] text-editor-muted" onClick={() => selectMask(mask.id, property)}>
          <span className="truncate">{maskPropertyLabel(property)}</span>
        </button>
        <DragNumberField value={value} step={scrubStep(property)} onChange={(next) => updateMaskValue(layer.id, mask.id, property, next)} />
        {renderMaskKeyButtons(mask, property)}
      </div>
    );
  };

  const renderMaskTupleRow = (mask: Mask, property: "position" | "scale") => {
    const value = maskTupleValue(mask, property, playheadFrame);
    const step = scrubStep(property);
    return (
      <div ref={maskPropertyActive(mask, property) ? selectedMaskRowRef : null} className={`grid grid-cols-[92px_minmax(0,1fr)_60px] items-center gap-2 px-4 py-1.5 ${maskPropertyActive(mask, property) ? "bg-editor-panel2" : "bg-editor-panel2/40"}`} onClick={() => selectMask(mask.id, property)}>
        <button className="flex min-w-0 items-center text-left text-[12px] text-editor-muted" onClick={() => selectMask(mask.id, property)}>
          <span className="truncate">{maskPropertyLabel(property)}</span>
        </button>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <DragNumberField value={value[0]} step={step} onChange={(next) => updateMaskValue(layer.id, mask.id, property, [next, value[1]])} />
          <DragNumberField value={value[1]} step={step} onChange={(next) => updateMaskValue(layer.id, mask.id, property, [value[0], next])} />
        </div>
        {renderMaskKeyButtons(mask, property)}
      </div>
    );
  };

  const effectPropertyActive = (effect: Effect, property?: EffectPropertyKey) => selectedEffectId === effect.id && (!property || selectedEffectProperty === property);

  const renderEffectKeyButtons = (effect: Effect, property: EffectPropertyKey) => {
    const control = effect.controls[property];
    if (!isEffectNumberControl(control)) return <div />;
    return (
      <div className="flex justify-end gap-1">
        <button className={`icon-button h-7 w-7 ${control.animated ? "icon-button-active" : ""}`} title="Toggle animation" onClick={(event) => { event.stopPropagation(); toggleEffectAnimation(layer.id, effect.id, property); }}><Clock3 size={13} /></button>
        <button className="icon-button h-7 w-7" title="Add keyframe" onClick={(event) => { event.stopPropagation(); addOrUpdateEffectKeyframe(layer.id, effect.id, property); }}><Diamond size={13} /></button>
      </div>
    );
  };

  const renderEffectNumberRow = (effect: Effect, property: EffectPropertyKey) => {
    const definition = effectControlDefinition(effect, property);
    const value = effectNumberValue(effect, property, playheadFrame);
    return (
      <div key={`${effect.id}-${property}`} className={`grid grid-cols-[118px_minmax(0,1fr)_60px] items-center gap-2 px-4 py-1.5 ${effectPropertyActive(effect, property) ? "bg-editor-panel2" : "bg-editor-panel2/35"}`} onClick={() => selectEffect(layer.id, effect.id, property)}>
        <button className="flex min-w-0 items-center text-left text-[12px] text-editor-muted" onClick={() => selectEffect(layer.id, effect.id, property)}>
          <span className="truncate">{definition?.label ?? property}</span>
        </button>
        <DragNumberField value={value} step={definition?.kind === "number" ? definition.step : 1} onChange={(next) => updateEffectNumberValue(layer.id, effect.id, property, next)} />
        {renderEffectKeyButtons(effect, property)}
      </div>
    );
  };

  const renderEffectStaticRow = (effect: Effect, property: EffectPropertyKey) => {
    const definition = effectControlDefinition(effect, property);
    const value = effectStaticValue(effect, property);
    return (
      <div key={`${effect.id}-${property}`} className={`grid grid-cols-[118px_minmax(0,1fr)] items-center gap-2 px-4 py-1.5 ${effectPropertyActive(effect, property) ? "bg-editor-panel2" : "bg-editor-panel2/35"}`} onClick={() => selectEffect(layer.id, effect.id, property)}>
        <button className="flex min-w-0 items-center text-left text-[12px] text-editor-muted" onClick={() => selectEffect(layer.id, effect.id, property)}>
          <span className="truncate">{definition?.label ?? property}</span>
        </button>
        {definition?.kind === "color" ? (
          <div className="flex items-center gap-2">
            <input className="h-7 w-10 border border-editor-line bg-editor-shell" type="color" value={typeof value === "string" ? value : "#ffffff"} onClick={(event) => event.stopPropagation()} onChange={(event) => updateEffectStaticValue(layer.id, effect.id, property, event.currentTarget.value)} />
            <input className="number-field text-left font-mono" value={typeof value === "string" ? value : "#ffffff"} onClick={(event) => event.stopPropagation()} onChange={(event) => updateEffectStaticValue(layer.id, effect.id, property, event.currentTarget.value)} />
          </div>
        ) : (
          <label className="flex items-center justify-end gap-2 text-[12px] text-editor-muted" onClick={(event) => event.stopPropagation()}>
            <span>{value ? "On" : "Off"}</span>
            <input className="h-4 w-4 accent-editor-cyan" type="checkbox" checked={Boolean(value)} onChange={(event) => updateEffectStaticValue(layer.id, effect.id, property, event.currentTarget.checked)} />
          </label>
        )}
      </div>
    );
  };


  const colorGradingPresetText = (effect: Effect) => {
    const controls: Record<string, number | string | boolean> = {};
    effectDefinition(effect).controls.forEach((control) => {
      const value = effect.controls[control.key];
      controls[control.key] = isEffectNumberControl(value) ? effectNumberValue(effect, control.key, playheadFrame) : typeof value === "boolean" ? value : String(value ?? "");
    });
    return JSON.stringify({ kind: "bbvep-color-grading-preset", version: 1, controls }, null, 2);
  };

  const exportColorGradingPreset = async (effect: Effect) => {
    const text = colorGradingPresetText(effect);
    try {
      await navigator.clipboard.writeText(text);
      window.alert("Color grading preset copied as JSON.");
    } catch {
      window.prompt("Copy color grading preset JSON", text);
    }
  };

  const importColorGradingPreset = (effect: Effect) => {
    const text = window.prompt("Paste color grading preset JSON");
    if (!text) return;
    try {
      const payload = JSON.parse(text) as { controls?: Record<string, unknown> } & Record<string, unknown>;
      const controls: Record<string, unknown> = payload.controls ?? payload;
      effectDefinition(effect).controls.forEach((control) => {
        if (!(control.key in controls)) return;
        const value = controls[control.key];
        if (control.kind === "number" && typeof value === "number") updateEffectNumberValue(layer.id, effect.id, control.key, value);
        if (control.kind === "boolean" && typeof value === "boolean") updateEffectStaticValue(layer.id, effect.id, control.key, value);
        if (control.kind === "color" && typeof value === "string") updateEffectStaticValue(layer.id, effect.id, control.key, value);
      });
    } catch {
      window.alert("That does not look like a valid color grading preset.");
    }
  };

  const renderEffect = (effect: Effect, index: number) => {
    const definition = effectDefinition(effect);
    return (
      <div key={effect.id} className="border-t border-editor-line/60 first:border-t-0">
        <div className={`flex min-h-9 items-center gap-2 px-4 py-1.5 ${effectPropertyActive(effect) ? "bg-cyan-950/20" : ""}`} onClick={() => selectEffect(layer.id, effect.id)}>
          <button className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-editor-ink" onClick={() => selectEffect(layer.id, effect.id)}>{effect.name || definition.label}</button>
          <button className={`icon-button h-6 w-6 ${effect.enabled !== false ? "icon-button-active" : ""}`} title={effect.enabled !== false ? "Disable effect" : "Enable effect"} onClick={(event) => { event.stopPropagation(); toggleEffectEnabled(layer.id, effect.id); }}><Power size={12} /></button>
          <button className="icon-button h-6 w-6" title="Move up" disabled={index === 0} onClick={(event) => { event.stopPropagation(); reorderEffect(layer.id, effect.id, -1); }}><ChevronUp size={12} /></button>
          <button className="icon-button h-6 w-6" title="Move down" disabled={index === layer.effects.length - 1} onClick={(event) => { event.stopPropagation(); reorderEffect(layer.id, effect.id, 1); }}><ChevronDown size={12} /></button>
          <button className="icon-button h-6 w-6" title="Duplicate" onClick={(event) => { event.stopPropagation(); duplicateEffect(layer.id, effect.id); }}><Copy size={12} /></button>
          <button className="icon-button h-6 w-6" title="Reset" onClick={(event) => { event.stopPropagation(); resetEffect(layer.id, effect.id); }}><RotateCcw size={12} /></button>
          <button className="icon-button h-6 w-6" title="Remove" onClick={(event) => { event.stopPropagation(); removeEffect(layer.id, effect.id); }}><Trash2 size={12} /></button>
        </div>
        <div className={`${effect.enabled === false ? "opacity-55" : ""}`}>
          {effect.type === "colorGrading" ? (
            <div className="grid grid-cols-2 gap-2 px-4 py-2">
              <button className="h-7 border border-editor-line bg-editor-shell text-[11px] text-editor-muted hover:border-editor-cyan hover:text-editor-cyan" style={{ borderRadius: 5 }} onClick={(event) => { event.stopPropagation(); void exportColorGradingPreset(effect); }}>Export JSON</button>
              <button className="h-7 border border-editor-line bg-editor-shell text-[11px] text-editor-muted hover:border-editor-cyan hover:text-editor-cyan" style={{ borderRadius: 5 }} onClick={(event) => { event.stopPropagation(); importColorGradingPreset(effect); }}>Import JSON</button>
            </div>
          ) : null}
          {definition.controls.map((control) => (
            <Fragment key={`${effect.id}-${control.key}`}>
              {control.kind === "number" ? renderEffectNumberRow(effect, control.key) : renderEffectStaticRow(effect, control.key)}
            </Fragment>
          ))}
        </div>
      </div>
    );
  };
  return (
    <aside className={inspectorShellClass}>
      <InspectorHeader title={layer.name} onToggleCollapsed={headerToggle} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section ref={transformSectionRef} className="border-b panel-divider">
          <div className="flex h-10 items-center gap-2 px-4 text-[13px] font-semibold text-editor-ink">
            <ChevronDown size={15} /> Transform
          </div>
          <div className="pb-3">
            {(layer.type === "model" ? modelRows : rows).map((property) => {
              const propertyState = layer.transform[property];
              if (!propertyState) return null;
              const value = evaluateProperty(propertyState as AnimatableProperty<AnimatableValue>, playheadFrame);
              const active = selectedProperty === property && !selectedMaskId && !selectedSourceProperty && !selectedEffectId;
              const step = scrubStep(property);
              const vectorLength = isTuple(value) ? value.length : 0;
              const vectorGridClass = property === "scale"
                ? vectorLength >= 3
                  ? "grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)_minmax(0,1fr)]"
                  : "grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)]"
                : vectorLength >= 3
                  ? "grid-cols-3"
                  : "grid-cols-2";
              const updateVectorComponent = (component: number, next: number) => {
                if (!isTuple(value)) return;
                const nextValue = [...value] as number[];
                if (property === "scale" && scaleLinked) {
                  nextValue.fill(next);
                } else {
                  nextValue[component] = next;
                }
                updateTransformValue(layer.id, property, nextValue as never);
              };

              return (
                <div key={property} className={`grid grid-cols-[78px_minmax(96px,1fr)_auto] items-center gap-2 px-4 py-1.5 ${active ? "bg-editor-panel2" : ""}`} onClick={() => selectProperty(property)}>
                  <button className="flex min-w-0 items-center gap-2 text-left text-[12px] text-editor-muted" onClick={() => selectProperty(property)}>
                    <span className="truncate">{propertyLabel(property)}</span>
                  </button>
                  <div className={`grid min-w-0 ${vectorGridClass} gap-1`}>
                    {isTuple(value) ? (
                      <>
                        <DragNumberField value={value[0]} step={step} onChange={(next) => updateVectorComponent(0, next)} />
                        {property === "scale" ? (
                          <button
                            type="button"
                            className={`icon-button h-5 w-5 self-center justify-self-center ${scaleLinked ? "icon-button-active" : ""}`}
                            title={scaleLinked ? "Unlink scale values" : "Link scale values"}
                            onClick={(event) => {
                              event.stopPropagation();
                              selectProperty("scale");
                              setScaleLinkedByLayer((current) => ({ ...current, [layer.id]: !(current[layer.id] ?? true) }));
                            }}
                          >
                            {scaleLinked ? <Link2 size={11} /> : <Link2Off size={11} />}
                          </button>
                        ) : null}
                        <DragNumberField value={value[1]} step={step} onChange={(next) => updateVectorComponent(1, next)} />
                        {vectorLength >= 3 ? <DragNumberField value={(value as unknown as [number, number, number])[2] ?? 0} step={step} onChange={(next) => updateVectorComponent(2, next)} /> : null}
                      </>
                    ) : (
                      <DragNumberField className="col-span-2" value={value as number} step={step} onChange={(next) => updateTransformValue(layer.id, property, next as never)} />
                    )}
                  </div>
                  <div className="flex justify-end gap-1">
                    <button className={`icon-button h-6 w-6 ${propertyState.animated ? "icon-button-active" : ""}`} title="Toggle animation" onClick={(event) => { event.stopPropagation(); toggleAnimation(layer.id, property); }}><Clock3 size={12} /></button>
                    <button className="icon-button h-6 w-6" title="Previous keyframe" onClick={(event) => { event.stopPropagation(); selectProperty(property); previousKeyframe(); }}><SkipBack size={12} /></button>
                    <button className="icon-button h-6 w-6" title="Add keyframe" onClick={(event) => { event.stopPropagation(); addOrUpdateKeyframe(layer.id, property); }}><Diamond size={12} /></button>
                    <button className="icon-button h-6 w-6" title="Next keyframe" onClick={(event) => { event.stopPropagation(); selectProperty(property); nextKeyframe(); }}><SkipForward size={12} /></button>
                    <button className="icon-button h-6 w-6" title="Reset" onClick={(event) => { event.stopPropagation(); resetTransformProperty(layer.id, property); }}><RotateCcw size={12} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        {layer.type === "video" ? (
          <section className="border-b panel-divider">
            <div className="flex h-10 items-center gap-2 px-4 text-[13px] font-semibold text-editor-ink">
              <ChevronDown size={15} /> Time Remap
            </div>
            {layer.source?.timeRemap ? (
              <div className="pb-3">
                <div className={`grid grid-cols-[92px_minmax(0,1fr)_120px] items-center gap-2 px-4 py-1.5 ${selectedSourceProperty === "timeRemap" ? "bg-editor-panel2" : ""}`} onClick={() => selectTimeRemap(layer.id)}>
                  <button className="flex min-w-0 items-center text-left text-[12px] text-editor-muted" onClick={() => selectTimeRemap(layer.id)}>
                    <span className="truncate">Source Time</span>
                  </button>
                  <DragNumberField value={evaluateProperty(layer.source.timeRemap, playheadFrame)} step={0.01} onChange={(next) => updateTimeRemapValue(layer.id, next)} />
                  <div className="flex justify-end gap-1">
                    <button className="icon-button icon-button-active h-6 w-6" title="Disable time remapping" onClick={(event) => { event.stopPropagation(); toggleTimeRemap(layer.id); }}><Clock3 size={12} /></button>
                    <button className="icon-button h-6 w-6" title="Previous time-remap keyframe" onClick={(event) => { event.stopPropagation(); selectTimeRemap(layer.id); previousKeyframe(); }}><SkipBack size={12} /></button>
                    <button className="icon-button h-6 w-6" title="Add time-remap keyframe" onClick={(event) => { event.stopPropagation(); addOrUpdateTimeRemapKeyframe(layer.id); }}><Diamond size={12} /></button>
                    <button className="icon-button h-6 w-6" title="Next time-remap keyframe" onClick={(event) => { event.stopPropagation(); selectTimeRemap(layer.id); nextKeyframe(); }}><SkipForward size={12} /></button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 px-4 pt-2">
                  <button className="h-8 border border-editor-line bg-editor-shell px-2 text-[11px] text-editor-muted hover:border-editor-cyan hover:text-editor-cyan" style={{ borderRadius: 5 }} onClick={() => freezeTimeRemap(layer.id)}>Freeze Frame</button>
                  <button className="h-8 border border-editor-line bg-editor-shell px-2 text-[11px] text-editor-muted hover:border-editor-cyan hover:text-editor-cyan" style={{ borderRadius: 5 }} onClick={() => reverseTimeRemap(layer.id)}>Reverse</button>
                </div>
              </div>
            ) : (
              <div className="px-4 pb-4">
                <button className="h-8 w-full border border-editor-cyan bg-cyan-950/35 text-[12px] text-editor-cyan" style={{ borderRadius: 5 }} onClick={() => toggleTimeRemap(layer.id)}>Enable Time Remap</button>
              </div>
            )}
          </section>
        ) : null}
        <section className="border-b panel-divider">
          <div className="flex h-10 items-center gap-2 px-4 text-[13px] font-semibold text-editor-ink">
            <ChevronDown size={15} /> Effects
          </div>
          {layer.effects.length > 0 ? (
            <div className="pb-3">
              {layer.effects.map((effect, index) => renderEffect(effect, index))}
            </div>
          ) : (
            <div className="px-4 pb-4 text-[12px] text-editor-muted">No effects on this layer</div>
          )}
        </section>
        <section className="border-b panel-divider">
          <div className="flex h-10 items-center gap-2 px-4 text-[13px] font-semibold text-editor-ink">
            <ChevronDown size={15} /> Masks
          </div>
          {layer.masks.length > 0 ? (
            <div className="pb-3">
              <div className="max-h-28 space-y-1 overflow-y-auto px-4 pb-2 pr-2">
                {layer.masks.map((mask) => (
                  <button key={mask.id} className={`h-7 w-full border border-editor-line px-2 text-left text-[12px] ${selectedMask?.id === mask.id ? "bg-cyan-950/40 text-editor-cyan" : "bg-editor-shell text-editor-muted"}`} style={{ borderRadius: 5 }} onClick={() => selectMask(mask.id)}>
                    {mask.name}
                  </button>
                ))}
              </div>
              {selectedMask ? (
                <>
                  {renderMaskPathRow(selectedMask)}
                  {renderMaskNumberRow(selectedMask, "feather")}
                  {renderMaskTupleRow(selectedMask, "position")}
                  {renderMaskTupleRow(selectedMask, "scale")}
                </>
              ) : null}
            </div>
          ) : (
            <div className="px-4 pb-4 text-[12px] text-editor-muted">No masks on this layer</div>
          )}
        </section>
        <section className="border-b panel-divider px-4 py-4">
          <div className="mb-3 text-[12px] font-semibold uppercase text-editor-muted">Keyframe</div>
          {selectedKeyframe ? (
            <div className="space-y-3">
              <label className="block text-[12px] text-editor-muted">Interpolation
                <select className="select-field mt-1 w-full" value={selectedKeyframe.interpolation} onChange={(event) => updateKeyframe(selectedKeyframe.id, { interpolation: event.currentTarget.value as Keyframe["interpolation"] })}>
                  <option value="bezier">Bezier</option><option value="linear">Linear</option><option value="hold">Hold</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[12px] text-editor-muted">Ease In<DragNumberField className="mt-1 w-full" value={selectedKeyframe.easeIn} step={0.5} onChange={(next) => updateKeyframe(selectedKeyframe.id, { easeIn: next })} /></label>
                <label className="text-[12px] text-editor-muted">Ease Out<DragNumberField className="mt-1 w-full" value={selectedKeyframe.easeOut} step={0.5} onChange={(next) => updateKeyframe(selectedKeyframe.id, { easeOut: next })} /></label>
                <label className="text-[12px] text-editor-muted">Incoming Velocity<DragNumberField className="mt-1 w-full" value={selectedKeyframe.velocityIn} step={0.25} onChange={(next) => updateKeyframe(selectedKeyframe.id, { velocityIn: next })} /></label>
                <label className="text-[12px] text-editor-muted">Outgoing Velocity<DragNumberField className="mt-1 w-full" value={selectedKeyframe.velocityOut} step={0.25} onChange={(next) => updateKeyframe(selectedKeyframe.id, { velocityOut: next })} /></label>
              </div>
              <div className="grid grid-cols-5 gap-1">
                {(["linear", "easeIn", "easeOut", "easeInOut", "hold"] as EasePreset[]).map((preset) => (
                  <button key={preset} className="h-8 border border-editor-line bg-editor-shell px-1 text-[11px] text-editor-muted hover:border-editor-cyan hover:text-editor-cyan" style={{ borderRadius: 5 }} onClick={() => applyEasePreset(preset)}>
                    {preset === "easeInOut" ? "In Out" : preset === "easeIn" ? "In" : preset === "easeOut" ? "Out" : preset[0].toUpperCase() + preset.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          ) : <div className="text-[12px] text-editor-muted">No keyframe selected</div>}
        </section>
      </div>
    </aside>
  );
}