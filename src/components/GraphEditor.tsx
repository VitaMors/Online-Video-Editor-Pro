import { PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { clamp, cloneValue, evaluateProperty, keyframeVelocity, propertyLabel, valueComponents } from "../lib/animation";
import { effectControlDefinition, effectDefinition, isEffectNumberControl } from "../lib/effects";
import { useEditorStore } from "../store/editorStore";
import type { AnimatableProperty, AnimatableValue, Keyframe, MaskPropertyKey } from "../types/editor";

const width = 620;
const height = 150;
const padding = 28;
const handleInset = 7;
const fallbackHandlePixels = 110;

type GraphPoint = {
  x: number;
  y: number;
  value: number;
  keyframe: Keyframe<AnimatableValue>;
  component: 0 | 1;
};

type DragTarget =
  | { type: "point"; keyframeId: string; component: 0 | 1 }
  | {
      type: "handle";
      keyframeId: string;
      component: 0 | 1;
      side: "in" | "out";
      lockedFrame: number;
      lockedValue: AnimatableValue;
    };

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function componentValue(value: AnimatableValue, component: 0 | 1) {
  const components = valueComponents(value);
  return components[component] ?? components[0];
}

function setComponentValue(value: AnimatableValue, component: 0 | 1, nextValue: number): AnimatableValue {
  if (!Array.isArray(value)) return nextValue;
  const next: [number, number] = [value[0], value[1]];
  next[component] = nextValue;
  return next;
}

function valueRange(values: number[]) {
  if (values.length === 0) return [0, 1] as [number, number];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [min - 1, max + 1] as [number, number];
  const margin = (max - min) * 0.08;
  return [min - margin, max + margin] as [number, number];
}

function speedRange(values: number[]) {
  const max = Math.max(1, ...values.map((value) => Math.abs(value))) * 1.2;
  return [0, max] as [number, number];
}

function speedValue(keyframe: Keyframe<AnimatableValue>, component: 0 | 1) {
  return (Math.abs(keyframeVelocity(keyframe, "in", component)) + Math.abs(keyframeVelocity(keyframe, "out", component))) / 2;
}

function normalizedInfluences(left: Keyframe<AnimatableValue>, right: Keyframe<AnimatableValue>) {
  const outInfluence = clamp(left.easeOut, 0, 100) / 100;
  const inInfluence = clamp(right.easeIn, 0, 100) / 100;
  const scale = outInfluence + inInfluence > 1 ? 1 / (outInfluence + inInfluence) : 1;

  return {
    out: outInfluence * scale,
    in: inInfluence * scale,
  };
}

function velocityUpdateFor(
  keyframe: Keyframe<AnimatableValue>,
  side: "in" | "out",
  component: 0 | 1,
  velocity: number,
): Partial<Keyframe<AnimatableValue>> {
  const nextVelocity = round2(velocity);

  if (!Array.isArray(keyframe.value)) {
    return side === "in" ? { velocityIn: nextVelocity } : { velocityOut: nextVelocity };
  }

  const current = side === "in" ? keyframe.velocityInComponents : keyframe.velocityOutComponents;
  const fallback = side === "in" ? keyframe.velocityIn : keyframe.velocityOut;
  const components: [number, number] = [current?.[0] ?? fallback, current?.[1] ?? fallback];
  components[component] = nextVelocity;

  return side === "in"
    ? { velocityIn: nextVelocity, velocityInComponents: components }
    : { velocityOut: nextVelocity, velocityOutComponents: components };
}

function directionFor(
  keyframes: Keyframe<AnimatableValue>[],
  index: number,
  side: "in" | "out",
  component: 0 | 1,
) {
  const keyframe = keyframes[index];
  const neighbor = side === "out" ? keyframes[index + 1] : keyframes[index - 1];

  if (keyframe && neighbor) {
    const from = side === "out" ? componentValue(keyframe.value, component) : componentValue(neighbor.value, component);
    const to = side === "out" ? componentValue(neighbor.value, component) : componentValue(keyframe.value, component);
    const delta = to - from;
    if (delta > 0) return 1;
    if (delta < 0) return -1;
  }

  return keyframeVelocity(keyframe, side, component) < 0 ? -1 : 1;
}

function neighborSpeed(
  keyframes: Keyframe<AnimatableValue>[],
  index: number,
  side: "in" | "out",
  component: 0 | 1,
) {
  const keyframe = keyframes[index];
  const neighbor = side === "out" ? keyframes[index + 1] : keyframes[index - 1];
  if (!keyframe || !neighbor) return 0;

  const frameDelta = Math.max(1, Math.abs(neighbor.frame - keyframe.frame));
  return Math.abs(componentValue(neighbor.value, component) - componentValue(keyframe.value, component)) / frameDelta;
}

function hasNeighborForSide(keyframes: Keyframe<AnimatableValue>[], index: number, side: "in" | "out") {
  return side === "in" ? index > 0 : index < keyframes.length - 1;
}

function maskPropertyLabel(property: Exclude<MaskPropertyKey, "path">) {
  const labels: Record<Exclude<MaskPropertyKey, "path">, string> = {
    feather: "Feather",
    position: "Position",
    scale: "Scale",
  };
  return labels[property];
}

type GraphEditorProps = {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

export function GraphEditor({ collapsed = false, onToggleCollapsed }: GraphEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const composition = useEditorStore((state) => state.project.compositions.find((item) => item.id === state.activeCompositionId));
  const selectedLayerIds = useEditorStore((state) => state.selectedLayerIds);
  const selectedProperty = useEditorStore((state) => state.selectedProperty);
  const selectedMaskId = useEditorStore((state) => state.selectedMaskId);
  const selectedMaskProperty = useEditorStore((state) => state.selectedMaskProperty);
  const selectedSourceProperty = useEditorStore((state) => state.selectedSourceProperty);
  const selectedEffectId = useEditorStore((state) => state.selectedEffectId);
  const selectedEffectProperty = useEditorStore((state) => state.selectedEffectProperty);
  const selectedKeyframeIds = useEditorStore((state) => state.selectedKeyframeIds);
  const graphMode = useEditorStore((state) => state.graphMode);
  const setGraphMode = useEditorStore((state) => state.setGraphMode);
  const selectKeyframe = useEditorStore((state) => state.selectKeyframe);
  const updateKeyframe = useEditorStore((state) => state.updateKeyframe);
  const layer = composition?.layers.find((item) => item.id === selectedLayerIds[0]);
  const transformProperty = layer?.transform[selectedProperty];
  const selectedMask = selectedMaskId ? layer?.masks.find((mask) => mask.id === selectedMaskId) : undefined;
  const selectedEffect = selectedEffectId ? layer?.effects.find((effect) => effect.id === selectedEffectId) : undefined;
  const selectedEffectControl = selectedEffect && selectedEffectProperty ? selectedEffect.controls[selectedEffectProperty] : undefined;
  const effectGraphProperty = isEffectNumberControl(selectedEffectControl)
    ? (selectedEffectControl as AnimatableProperty<AnimatableValue>)
    : undefined;
  const maskGraphProperty = selectedMask && selectedMaskProperty && selectedMaskProperty !== "path"
    ? (selectedMask[selectedMaskProperty] as AnimatableProperty<AnimatableValue>)
    : undefined;
  const timeRemapProperty = selectedSourceProperty === "timeRemap"
    ? (layer?.source?.timeRemap as AnimatableProperty<AnimatableValue> | undefined)
    : undefined;
  const graphProperty = effectGraphProperty ?? (selectedSourceProperty === "timeRemap" ? timeRemapProperty : selectedMaskId ? maskGraphProperty : transformProperty);
  const graphLabel = selectedEffect && selectedEffectProperty
    ? `${selectedEffect.name || effectDefinition(selectedEffect).label} / ${effectControlDefinition(selectedEffect, selectedEffectProperty)?.label ?? selectedEffectProperty}`
    : selectedSourceProperty === "timeRemap"
      ? "Time Remap / Source Time (s)"
      : selectedMask && selectedMaskProperty && selectedMaskProperty !== "path"
        ? `${selectedMask.name} / ${maskPropertyLabel(selectedMaskProperty)}`
        : propertyLabel(selectedProperty);
  const keyframes = useMemo(() => ([...(graphProperty?.keyframes ?? [])] as Keyframe<AnimatableValue>[]).sort((a, b) => a.frame - b.frame), [graphProperty?.keyframes]);

  if (!composition || !layer || !graphProperty) return null;

  const propertyForEvaluation = graphProperty as AnimatableProperty<AnimatableValue>;
  const compositionDurationFrames = Math.max(1, Math.round(typeof composition.durationFrames === "number" && Number.isFinite(composition.durationFrames) ? composition.durationFrames : 300));
  const hasSecondComponent = keyframes.some((keyframe) => valueComponents(keyframe.value)[1] !== undefined);
  const componentCount = hasSecondComponent ? 2 : 1;
  const speedAtFrame = (frame: number, component: 0 | 1) => {
    const exactKeyframe = keyframes.find((keyframe) => Math.abs(keyframe.frame - frame) < 0.001);
    if (exactKeyframe) return speedValue(exactKeyframe, component);

    const firstFrame = keyframes[0]?.frame ?? 0;
    const lastFrame = keyframes[keyframes.length - 1]?.frame ?? compositionDurationFrames - 1;
    const beforeFrame = clamp(frame - 0.25, firstFrame, lastFrame);
    const afterFrame = clamp(frame + 0.25, firstFrame, lastFrame);

    if (afterFrame === beforeFrame) return 0;

    const beforeValue = evaluateProperty(propertyForEvaluation, beforeFrame);
    const afterValue = evaluateProperty(propertyForEvaluation, afterFrame);
    return Math.abs(componentValue(afterValue, component) - componentValue(beforeValue, component)) / (afterFrame - beforeFrame);
  };
  const sampledSpeedValues = graphMode === "speed"
    ? [0, 1].slice(0, componentCount).flatMap((component) => {
        const typedComponent = component as 0 | 1;
        return keyframes.flatMap((keyframe, index) => {
          const next = keyframes[index + 1];
          const baseValues = [
            speedValue(keyframe, typedComponent),
            Math.abs(keyframeVelocity(keyframe, "in", typedComponent)),
            Math.abs(keyframeVelocity(keyframe, "out", typedComponent)),
            neighborSpeed(keyframes, index, "in", typedComponent) * 4,
            neighborSpeed(keyframes, index, "out", typedComponent) * 4,
          ];

          if (!next || next.frame <= keyframe.frame) return baseValues;

          const frameSpan = next.frame - keyframe.frame;
          const steps = Math.max(8, Math.ceil(frameSpan / 4));
          return [
            ...baseValues,
            ...Array.from({ length: steps - 1 }, (_, sampleIndex) => {
              const frame = keyframe.frame + (frameSpan * (sampleIndex + 1)) / steps;
              return speedAtFrame(frame, typedComponent);
            }),
          ];
        });
      })
    : [];
  const rawGraphValues = graphMode === "speed"
    ? sampledSpeedValues
    : keyframes.flatMap((keyframe) => [0, 1].slice(0, componentCount).map((component) => componentValue(keyframe.value, component as 0 | 1)));
  const [minValue, maxValue] = graphMode === "speed" ? speedRange(rawGraphValues) : valueRange(rawGraphValues);
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const durationFrames = Math.max(1, compositionDurationFrames - 1);
  const xForFrame = (frame: number) => padding + (frame / durationFrames) * usableWidth;
  const frameForX = (x: number) => Math.round(clamp(((x - padding) / usableWidth) * durationFrames, 0, durationFrames));
  const yForValue = (value: number) => padding + usableHeight - ((value - minValue) / (maxValue - minValue)) * usableHeight;
  const valueForY = (y: number) => minValue + ((padding + usableHeight - clamp(y, padding, padding + usableHeight)) / usableHeight) * (maxValue - minValue);
  const graphLeft = padding;
  const graphRight = padding + usableWidth;
  const graphTop = padding;
  const graphBottom = padding + usableHeight;
  const clampHandleX = (x: number) => clamp(x, graphLeft + handleInset, graphRight - handleInset);
  const clampHandleY = (y: number) => clamp(y, graphTop + handleInset, graphBottom - handleInset);
  const frameSpanForSide = (index: number, side: "in" | "out") => {
    const keyframe = keyframes[index];
    const neighbor = side === "out" ? keyframes[index + 1] : keyframes[index - 1];
    if (!keyframe || !neighbor) return Math.max(1, (fallbackHandlePixels / usableWidth) * durationFrames);
    return Math.max(1, Math.abs(neighbor.frame - keyframe.frame));
  };
  const influenceForSide = (index: number, side: "in" | "out") => {
    const keyframe = keyframes[index];
    if (!keyframe) return 0;

    if (side === "out") {
      const next = keyframes[index + 1];
      return next ? normalizedInfluences(keyframe, next).out : clamp(keyframe.easeOut, 0, 100) / 100;
    }

    const previous = keyframes[index - 1];
    return previous ? normalizedInfluences(previous, keyframe).in : clamp(keyframe.easeIn, 0, 100) / 100;
  };
  const graphValue = (keyframe: Keyframe<AnimatableValue>, component: 0 | 1) => graphMode === "speed" ? speedValue(keyframe, component) : componentValue(keyframe.value, component);
  const makePoints = (component: 0 | 1) => keyframes.map((keyframe) => {
    const value = graphValue(keyframe, component);
    return { x: xForFrame(keyframe.frame), y: yForValue(value), value, keyframe, component };
  });
  const pointsA = makePoints(0);
  const pointsB = hasSecondComponent ? makePoints(1) : [];
  const allPoints = [...pointsA, ...pointsB];
  const handleFor = (point: GraphPoint, side: "in" | "out") => {
    const keyframeIndex = keyframes.findIndex((keyframe) => keyframe.id === point.keyframe.id);
    const frameOffset = frameSpanForSide(keyframeIndex, side) * influenceForSide(keyframeIndex, side);
    const handleFrame = side === "in" ? point.keyframe.frame - frameOffset : point.keyframe.frame + frameOffset;
    const x = clampHandleX(xForFrame(handleFrame));

    if (graphMode === "speed") {
      const velocity = Math.abs(keyframeVelocity(point.keyframe, side, point.component));
      return { x, y: clampHandleY(yForValue(velocity)), value: velocity };
    }

    const velocity = keyframeVelocity(point.keyframe, side, point.component);
    const handleValue = side === "in"
      ? componentValue(point.keyframe.value, point.component) - velocity * frameOffset
      : componentValue(point.keyframe.value, point.component) + velocity * frameOffset;

    return { x, y: clampHandleY(yForValue(handleValue)), value: handleValue };
  };
  const valuePathFor = (points: readonly GraphPoint[]) => {
    if (points.length === 0) return "";

    return points.slice(1).reduce((path, point, index) => {
      const previous = points[index];

      if (previous.keyframe.interpolation === "hold") {
        return `${path} L ${point.x} ${previous.y} L ${point.x} ${point.y}`;
      }

      if (previous.keyframe.interpolation === "linear") {
        return `${path} L ${point.x} ${point.y}`;
      }

      const outHandle = handleFor(previous, "out");
      const inHandle = handleFor(point, "in");
      return `${path} C ${outHandle.x} ${outHandle.y} ${inHandle.x} ${inHandle.y} ${point.x} ${point.y}`;
    }, `M ${points[0].x} ${points[0].y}`);
  };
  const speedPathFor = (component: 0 | 1) => {
    const samples: { x: number; y: number }[] = [];

    keyframes.slice(1).forEach((right, index) => {
      const left = keyframes[index];
      if (right.frame <= left.frame) return;

      const frameSpan = right.frame - left.frame;
      const pixelSpan = Math.abs(xForFrame(right.frame) - xForFrame(left.frame));
      const steps = Math.max(10, Math.ceil(pixelSpan / 5));

      for (let step = 0; step <= steps; step += 1) {
        if (samples.length > 0 && step === 0) continue;
        const frame = left.frame + (frameSpan * step) / steps;
        const speed = step === 0 ? speedValue(left, component) : step === steps ? speedValue(right, component) : speedAtFrame(frame, component);
        samples.push({ x: xForFrame(frame), y: yForValue(speed) });
      }
    });

    if (samples.length === 0 && keyframes[0]) {
      samples.push({ x: xForFrame(keyframes[0].frame), y: yForValue(speedValue(keyframes[0], component)) });
    }

    return samples.map((sample, index) => `${index === 0 ? "M" : "L"} ${sample.x} ${sample.y}`).join(" ");
  };
  const pathFor = (points: readonly GraphPoint[], component: 0 | 1) => graphMode === "speed" ? speedPathFor(component) : valuePathFor(points);
  const pointerPoint = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const rectWidth = Math.max(1, rect.width);
    const rectHeight = Math.max(1, rect.height);
    return {
      x: ((event.clientX - rect.left) / rectWidth) * width,
      y: ((event.clientY - rect.top) / rectHeight) * height,
    };
  };
  const selectedPoints = allPoints.filter((point) => selectedKeyframeIds.includes(point.keyframe.id));
  const valueSuffix = selectedSourceProperty === "timeRemap" && graphMode === "value" ? "s" : "";

  return (
    <section className="block min-h-0 min-w-0 overflow-hidden border-t panel-divider bg-editor-panel2">
      <div className="flex h-10 items-center justify-between border-b panel-divider px-4">
        <div className="min-w-0 truncate text-[12px] font-semibold uppercase text-editor-muted">Graph Editor / {graphLabel}</div>
        <div className="flex gap-1">
          <button className={`h-7 border border-editor-line px-3 text-[12px] ${graphMode === "value" ? "bg-cyan-950/40 text-editor-cyan" : "text-editor-muted"}`} style={{ borderRadius: 5 }} onClick={() => setGraphMode("value")}>Value</button>
          <button className={`h-7 border border-editor-line px-3 text-[12px] ${graphMode === "speed" ? "bg-cyan-950/40 text-editor-cyan" : "text-editor-muted"}`} style={{ borderRadius: 5 }} onClick={() => setGraphMode("speed")}>Speed</button>
        </div>
      </div>
      <div className="flex h-[170px] min-w-0 items-center justify-center overflow-hidden">
        <svg
          ref={svgRef}
          width={width}
          height={height}
          role="img"
          aria-label="Graph editor"
          className="touch-none"
          onPointerMove={(event) => {
            if (!dragTarget) return;
            const point = pointerPoint(event);
            const keyframeIndex = keyframes.findIndex((keyframe) => keyframe.id === dragTarget.keyframeId);
            const keyframe = keyframes[keyframeIndex];
            if (!keyframe) return;

            if (dragTarget.type === "point") {
              const nextFrame = frameForX(point.x);
              const graphValueAtPointer = round2(valueForY(point.y));
              if (graphMode === "speed") {
                const speed = Math.max(0, graphValueAtPointer);
                updateKeyframe(keyframe.id, {
                  frame: nextFrame,
                  value: keyframe.value,
                  ...velocityUpdateFor(keyframe, "in", dragTarget.component, speed * directionFor(keyframes, keyframeIndex, "in", dragTarget.component)),
                  ...velocityUpdateFor(keyframe, "out", dragTarget.component, speed * directionFor(keyframes, keyframeIndex, "out", dragTarget.component)),
                });
              } else {
                updateKeyframe(keyframe.id, { frame: nextFrame, value: setComponentValue(keyframe.value, dragTarget.component, graphValueAtPointer) });
              }
              return;
            }

            const originX = xForFrame(dragTarget.lockedFrame);
            const originValue = componentValue(dragTarget.lockedValue, dragTarget.component);
            const rawDx = point.x - originX;
            const sideDx = dragTarget.side === "in" ? Math.min(0, rawDx) : Math.max(0, rawDx);
            const frameSpan = frameSpanForSide(keyframeIndex, dragTarget.side);
            const pixelSpan = Math.max(1, (frameSpan / durationFrames) * usableWidth);
            const ease = Math.round(clamp((Math.abs(sideDx) / pixelSpan) * 100, 0, 100));

            if (graphMode === "speed") {
              const handleSpeed = Math.max(0, round2(valueForY(point.y)));
              const velocityUpdate = velocityUpdateFor(
                keyframe,
                dragTarget.side,
                dragTarget.component,
                handleSpeed * directionFor(keyframes, keyframeIndex, dragTarget.side, dragTarget.component),
              );
              updateKeyframe(keyframe.id, dragTarget.side === "in"
                ? { interpolation: "bezier", frame: dragTarget.lockedFrame, value: dragTarget.lockedValue, easeIn: ease, ...velocityUpdate }
                : { interpolation: "bezier", frame: dragTarget.lockedFrame, value: dragTarget.lockedValue, easeOut: ease, ...velocityUpdate });
              return;
            }

            const frameDelta = Math.max(0.001, frameSpan * ease / 100);
            const pointerValue = round2(valueForY(point.y));
            const velocity = round2(((dragTarget.side === "in" ? originValue - pointerValue : pointerValue - originValue) / frameDelta));
            const velocityUpdate = velocityUpdateFor(keyframe, dragTarget.side, dragTarget.component, velocity);

            updateKeyframe(keyframe.id, dragTarget.side === "in"
              ? { interpolation: "bezier", frame: dragTarget.lockedFrame, value: dragTarget.lockedValue, easeIn: ease, ...velocityUpdate }
              : { interpolation: "bezier", frame: dragTarget.lockedFrame, value: dragTarget.lockedValue, easeOut: ease, ...velocityUpdate });
          }}
          onPointerUp={(event) => {
            setDragTarget(null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={(event) => {
            setDragTarget(null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        >
          <rect width={width} height={height} fill="#151b23" />
          {Array.from({ length: 6 }).map((_, index) => {
            const y = padding + (usableHeight / 5) * index;
            return <line key={index} x1={padding} y1={y} x2={width - padding} y2={y} stroke="rgba(89, 101, 121, 0.5)" />;
          })}
          {Array.from({ length: 6 }).map((_, index) => {
            const x = padding + (usableWidth / 5) * index;
            return <line key={index} x1={x} y1={padding} x2={x} y2={height - padding} stroke="rgba(89, 101, 121, 0.32)" />;
          })}
          <path d={pathFor(pointsA, 0)} fill="none" stroke="#39d0c8" strokeWidth={3} />
          {pointsB.length > 0 ? <path d={pathFor(pointsB, 1)} fill="none" stroke="#f2b84b" strokeWidth={3} /> : null}
          {pointsA.map((point) => (
            <circle
              key={point.keyframe.id}
              cx={point.x}
              cy={point.y}
              r={selectedKeyframeIds.includes(point.keyframe.id) ? 7 : 5}
              fill={selectedKeyframeIds.includes(point.keyframe.id) ? "#f2b84b" : "#39d0c8"}
              stroke="#0d1117"
              strokeWidth={2}
              className="cursor-grab"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                selectKeyframe(point.keyframe.id);
                setDragTarget({ type: "point", keyframeId: point.keyframe.id, component: 0 });
                svgRef.current?.setPointerCapture(event.pointerId);
              }}
            />
          ))}
          {pointsB.map((point) => (
            <rect
              key={`${point.keyframe.id}-b`}
              x={point.x - 5}
              y={point.y - 5}
              width={10}
              height={10}
              fill="#f2b84b"
              stroke="#0d1117"
              strokeWidth={2}
              className="cursor-grab"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                selectKeyframe(point.keyframe.id);
                setDragTarget({ type: "point", keyframeId: point.keyframe.id, component: 1 });
                svgRef.current?.setPointerCapture(event.pointerId);
              }}
            />
          ))}
          {selectedPoints.map((point) => (["in", "out"] as const).map((side) => {
            const keyframeIndex = keyframes.findIndex((keyframe) => keyframe.id === point.keyframe.id);
            if (!hasNeighborForSide(keyframes, keyframeIndex, side)) return null;
            const handle = handleFor(point, side);
            return (
              <g key={`${point.keyframe.id}-${point.component}-${side}`}>
                <line x1={point.x} y1={point.y} x2={handle.x} y2={handle.y} stroke="#9b8cff" strokeWidth={1.5} />
                <circle
                  cx={handle.x}
                  cy={handle.y}
                  r={10}
                  fill="transparent"
                  pointerEvents="all"
                  className="cursor-grab"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectKeyframe(point.keyframe.id);
                    setDragTarget({
                      type: "handle",
                      keyframeId: point.keyframe.id,
                      component: point.component,
                      side,
                      lockedFrame: point.keyframe.frame,
                      lockedValue: cloneValue(point.keyframe.value),
                    });
                    svgRef.current?.setPointerCapture(event.pointerId);
                  }}
                />
                <circle
                  cx={handle.x}
                  cy={handle.y}
                  r={5}
                  fill="#9b8cff"
                  stroke="#0d1117"
                  strokeWidth={2}
                  className="cursor-grab"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectKeyframe(point.keyframe.id);
                    setDragTarget({
                      type: "handle",
                      keyframeId: point.keyframe.id,
                      component: point.component,
                      side,
                      lockedFrame: point.keyframe.frame,
                      lockedValue: cloneValue(point.keyframe.value),
                    });
                    svgRef.current?.setPointerCapture(event.pointerId);
                  }}
                />
              </g>
            );
          }))}
          {selectedPoints.map((point) => graphMode === "value" ? (
            <text key={`${point.keyframe.id}-${point.component}-value-label`} x={Math.min(width - padding - 58, point.x + 8)} y={Math.max(18, point.y - 8)} fill="#dce7f3" fontSize={10}>{round2(point.value)}{valueSuffix}</text>
          ) : null)}
          <text x={padding} y={18} fill="#8b949e" fontSize={11}>{graphMode === "value" ? "Value graph" : "Speed graph"}</text>
        </svg>
      </div>
    </section>
  );
}