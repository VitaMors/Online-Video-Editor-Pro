import { Check, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

// A generic, reusable right-click menu used everywhere the app needs one instead of letting
// the browser's own context menu show (which is the default for any onContextMenu-less
// element, and looks completely out of place in an app that's meant to feel like a desktop
// video editor). Modeled after how After Effects actually builds its own timeline/layer
// context menus: a flat list of actions, occasional separators/section labels, and a handful
// of items that expand into a submenu (Effect, Blending Mode, Arrange, etc.) rather than ever
// nesting a dialog. See src/lib/layerContextMenu.ts for the actual After-Effects-style item
// list this renders for a layer.
export type ContextMenuItem =
  | { kind: "separator" }
  | { kind: "label"; label: string }
  | {
      kind?: "action";
      label: string;
      action?: () => void;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      shortcut?: string;
      items?: ContextMenuItem[];
    };

export type ContextMenuState = { x: number; y: number; items: ContextMenuItem[] } | null;

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState>(null);
  const open = (event: ReactMouseEvent, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setState({ x: event.clientX, y: event.clientY, items });
  };
  const close = () => setState(null);
  return { state, open, close };
}

function ContextMenuRow({ item, onClose, openLeft }: { item: ContextMenuItem; onClose: () => void; openLeft: boolean }) {
  if (item.kind === "separator") return <div className="my-1 h-px bg-editor-line" />;
  if (item.kind === "label") {
    return <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-editor-muted">{item.label}</div>;
  }

  const hasChildren = Boolean(item.items && item.items.length > 0);

  return (
    <div className="group relative">
      <button
        type="button"
        className={`flex h-7 w-full items-center gap-3 px-3 text-left text-[12px] hover:bg-cyan-950/45 hover:text-editor-cyan disabled:text-editor-muted/50 disabled:hover:bg-transparent disabled:hover:text-editor-muted/50 ${item.danger ? "text-red-400 hover:!bg-red-950/40 hover:!text-red-300" : "text-editor-ink"}`}
        disabled={item.disabled}
        onClick={hasChildren ? undefined : () => { item.action?.(); onClose(); }}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex w-3 shrink-0 items-center justify-center">
            {item.checked ? <Check size={12} className="text-editor-cyan" /> : null}
          </span>
          <span className="truncate">{item.label}</span>
        </span>
        {item.shortcut ? <span className="shrink-0 font-mono text-[10px] text-editor-muted">{item.shortcut}</span> : null}
        {hasChildren ? <ChevronRight size={12} className="shrink-0 text-editor-muted" /> : null}
      </button>
      {hasChildren && !item.disabled ? (
        <div className={`absolute top-[-5px] z-10 hidden group-hover:block ${openLeft ? "right-full" : "left-full"}`}>
          <ContextMenuList items={item.items ?? []} onClose={onClose} openLeft={openLeft} />
        </div>
      ) : null}
    </div>
  );
}

function ContextMenuList({ items, onClose, openLeft }: { items: ContextMenuItem[]; onClose: () => void; openLeft: boolean }) {
  return (
    <div className="min-w-52 border border-editor-line bg-editor-panel py-1 shadow-2xl" style={{ borderRadius: 6 }}>
      {items.map((item, index) => (
        <ContextMenuRow key={item.kind === "separator" ? `sep-${index}` : `${item.kind ?? "action"}-${"label" in item ? item.label : index}`} item={item} onClose={onClose} openLeft={openLeft} />
      ))}
    </div>
  );
}

export function ContextMenu({ state, onClose }: { state: ContextMenuState; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    if (!state) return;
    const closeOnOutside = () => onClose();
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    // pointerdown (not click) so this behaves exactly like every other dropdown in the app
    // (see MenuBar's own outside-click handling) - closes the instant you click anywhere else,
    // including on another element that opens its own menu/context menu.
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("contextmenu", closeOnOutside);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("scroll", closeOnOutside, true);
    window.addEventListener("resize", closeOnOutside);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("contextmenu", closeOnOutside);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("scroll", closeOnOutside, true);
      window.removeEventListener("resize", closeOnOutside);
    };
  }, [state, onClose]);

  useEffect(() => {
    if (!state) return;
    const menu = rootRef.current;
    const rect = menu?.getBoundingClientRect();
    const width = rect?.width ?? 208;
    const height = rect?.height ?? 200;
    setPosition({
      x: Math.max(4, Math.min(state.x, window.innerWidth - width - 8)),
      y: Math.max(4, Math.min(state.y, window.innerHeight - height - 8)),
    });
  }, [state]);

  if (!state) return null;

  const openLeft = state.x > window.innerWidth / 2;

  return (
    <div
      ref={rootRef}
      className="fixed z-[100]"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ContextMenuList items={state.items} onClose={onClose} openLeft={openLeft} />
    </div>
  );
}
