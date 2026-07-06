import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  Diamond,
  Eraser,
  Image as ImageIcon,
  Eye,
  EyeOff,
  Folder,
  Lock,
  LockOpen,
  Minus,
  Pencil,
  Square,
  Trash2,
  Triangle,
  Type,
  Ungroup,
  Group,
} from "lucide-react";
import type { DrawingTool, Stroke } from "../types";

const TOOL_ICON: Record<DrawingTool, typeof Pencil> = {
  select: Pencil,
  pencil: Pencil,
  eraser: Eraser,
  line: Minus,
  arrow: ArrowUpRight,
  rect: Square,
  diamond: Diamond,
  circle: Circle,
  triangle: Triangle,
  text: Type,
  redact: EyeOff,
  image: ImageIcon,
  pin: Pencil,
};

const TOOL_LABEL: Record<DrawingTool, string> = {
  select: "Selection",
  pencil: "Drawing",
  eraser: "Eraser",
  line: "Line",
  arrow: "Arrow",
  rect: "Rectangle",
  diamond: "Diamond",
  circle: "Ellipse",
  triangle: "Triangle",
  text: "Text",
  redact: "Redaction",
  image: "Image",
  pin: "Pin",
};

interface AssetsPanelProps {
  strokes: Stroke[];
  selectedIndices: number[];
  groupNames: Record<number, string>;
  onSelect: (index: number, additive: boolean) => void;
  onSelectMany: (indices: number[]) => void;
  onSetHidden: (indices: number[], value: boolean) => void;
  onSetLocked: (indices: number[], value: boolean) => void;
  onRenameGroup: (groupId: number, name: string) => void;
  onRenameStroke: (index: number, name: string) => void;
  onGroup: () => void;
  onUngroup: () => void;
  onDuplicate: () => void;
  onMove: (dir: "forward" | "backward") => void;
  onDelete: () => void;
  canGroup: boolean;
  canUngroup: boolean;
  selectionCount: number;
  canvasWidth: number;
  canvasHeight: number;
  applying: boolean;
  onApplyCanvas: (width: number, height: number, color: string) => void;
}

export default function AssetsPanel({
  strokes,
  selectedIndices,
  groupNames,
  onSelect,
  onSelectMany,
  onSetHidden,
  onSetLocked,
  onRenameGroup,
  onRenameStroke,
  onGroup,
  onUngroup,
  onDuplicate,
  onMove,
  onDelete,
  canGroup,
  canUngroup,
  selectionCount,
  canvasWidth,
  canvasHeight,
  applying,
  onApplyCanvas,
}: AssetsPanelProps) {
  const [w, setW] = useState(canvasWidth);
  const [h, setH] = useState(canvasHeight);
  const [color, setColor] = useState("#ffffff");
  const [editingGroup, setEditingGroup] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [rowDraft, setRowDraft] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const toggleCollapse = (gid: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });

  useEffect(() => {
    setW(canvasWidth);
    setH(canvasHeight);
  }, [canvasWidth, canvasHeight]);

  // Auto-apply so there's no separate "Apply" click: colour applies the moment
  // it's picked; width/height commit on Enter or when the field loses focus.
  const applyNow = (nextW: number, nextH: number, nextColor: string) => {
    if (applying) return;
    if (
      !Number.isFinite(nextW) ||
      !Number.isFinite(nextH) ||
      nextW < 16 ||
      nextH < 16
    ) {
      return;
    }
    onApplyCanvas(nextW, nextH, nextColor);
  };

  const labels: string[] = [];
  const counts: Partial<Record<DrawingTool, number>> = {};
  for (const s of strokes) {
    counts[s.tool] = (counts[s.tool] ?? 0) + 1;
    labels.push(s.name ?? `${TOOL_LABEL[s.tool]} ${counts[s.tool]}`);
  }

  const isSelected = (i: number) => selectedIndices.includes(i);

  const stop = (e: MouseEvent | PointerEvent) => e.stopPropagation();

  // Drag across rows to fast-select multiple layers.
  const dragRef = useRef<{ active: boolean; set: Set<number> }>({
    active: false,
    set: new Set(),
  });
  useEffect(() => {
    const end = () => {
      dragRef.current.active = false;
    };
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  }, []);

  const startDrag = (indices: number[], additive: boolean) => {
    if (additive) {
      onSelect(indices[0], true);
      dragRef.current.active = false;
      return;
    }
    dragRef.current = { active: true, set: new Set(indices) };
    onSelectMany([...dragRef.current.set]);
  };
  const extendDrag = (indices: number[]) => {
    if (!dragRef.current.active) return;
    let changed = false;
    for (const i of indices) {
      if (!dragRef.current.set.has(i)) {
        dragRef.current.set.add(i);
        changed = true;
      }
    }
    if (changed) onSelectMany([...dragRef.current.set]);
  };

  // Visibility/lock controls operating on an explicit set of indices. For an
  // item that's just [index]; for a group header it's all member indices, and
  // the icon reflects whether the whole group is hidden/locked.
  const Controls = ({ indices }: { indices: number[] }) => {
    const hidden = indices.every((i) => strokes[i]?.hidden);
    const locked = indices.every((i) => strokes[i]?.locked);
    return (
      <span className="layer-controls" onPointerDown={stop}>
        <button
          className="layer-icon-btn"
          title={hidden ? "Show" : "Hide"}
          onClick={(e) => {
            stop(e);
            onSetHidden(indices, !hidden);
          }}
        >
          {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
        <button
          className="layer-icon-btn"
          title={locked ? "Unlock" : "Lock"}
          onClick={(e) => {
            stop(e);
            onSetLocked(indices, !locked);
          }}
        >
          {locked ? <Lock size={12} /> : <LockOpen size={12} />}
        </button>
      </span>
    );
  };

  // Rendered as a plain function (not a <Row/> component) so a row reconciles
  // in place instead of remounting on every re-render — remounting between the
  // two clicks of a double-click would break rename-on-double-click.
  const renderRow = (index: number, nested?: boolean) => {
    const stroke = strokes[index];
    const Icon = TOOL_ICON[stroke.tool];
    return (
      <div
        key={index}
        className={`layer-row ${nested ? "nested" : ""} ${isSelected(index) ? "selected" : ""} ${stroke.hidden ? "dimmed" : ""}`}
        onPointerDown={(e: PointerEvent) =>
          startDrag([index], e.shiftKey || e.metaKey || e.ctrlKey)
        }
        onPointerEnter={() => extendDrag([index])}
      >
        <Icon size={13} />
        <span
          className="layer-swatch"
          style={{ backgroundColor: stroke.color }}
        />
        {editingRow === index ? (
          <input
            className="layer-rename"
            autoFocus
            value={rowDraft}
            onClick={stop}
            onPointerDown={stop}
            onChange={(e) => setRowDraft(e.target.value)}
            onBlur={() => {
              onRenameStroke(index, rowDraft);
              setEditingRow(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRenameStroke(index, rowDraft);
                setEditingRow(null);
              }
              if (e.key === "Escape") setEditingRow(null);
            }}
          />
        ) : (
          <span
            className="layer-name"
            onDoubleClick={(e) => {
              stop(e);
              setEditingRow(index);
              setRowDraft(stroke.name ?? labels[index]);
            }}
            title="Double-click to rename"
          >
            {labels[index]}
          </span>
        )}
        <Controls indices={[index]} />
      </div>
    );
  };

  const rows: React.ReactNode[] = [];
  const emittedGroups = new Set<number>();
  for (let i = strokes.length - 1; i >= 0; i--) {
    const gid = strokes[i].groupId;
    if (gid == null) {
      rows.push(renderRow(i));
      continue;
    }
    if (emittedGroups.has(gid)) continue;
    emittedGroups.add(gid);
    const members: number[] = [];
    for (let j = strokes.length - 1; j >= 0; j--) {
      if (strokes[j].groupId === gid) members.push(j);
    }
    const groupIsSelected = members.every((m) => isSelected(m));
    const partiallySelected =
      !groupIsSelected && members.some((m) => isSelected(m));
    const name = groupNames[gid] || "Group";
    const isCollapsed = collapsed.has(gid);
    rows.push(
      <div
        key={`g${gid}`}
        className={`layer-group ${groupIsSelected || partiallySelected ? "active" : ""}`}
      >
        <div
          className={`layer-row group-head ${groupIsSelected ? "selected" : ""} ${partiallySelected ? "partial" : ""}`}
          onPointerDown={(e: PointerEvent) =>
            startDrag(members, e.shiftKey || e.metaKey || e.ctrlKey)
          }
          onPointerEnter={() => extendDrag(members)}
        >
          <button
            className="layer-chevron"
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              toggleCollapse(gid);
            }}
            title={isCollapsed ? "Expand" : "Collapse"}
          >
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
          <Folder size={13} />
          {editingGroup === gid ? (
            <input
              className="layer-rename"
              autoFocus
              value={draftName}
              onClick={stop}
              onPointerDown={stop}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => {
                onRenameGroup(gid, draftName.trim() || "Group");
                setEditingGroup(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onRenameGroup(gid, draftName.trim() || "Group");
                  setEditingGroup(null);
                }
                if (e.key === "Escape") setEditingGroup(null);
              }}
            />
          ) : (
            <span
              className="layer-name"
              onDoubleClick={(e) => {
                stop(e);
                setEditingGroup(gid);
                setDraftName(name);
              }}
              title="Double-click to rename"
            >
              {name}
            </span>
          )}
          <span className="layer-count">{members.length}</span>
          <Controls indices={members} />
        </div>
        {!isCollapsed && (
          <div className="layer-children">
            {members.map((m) => renderRow(m, true))}
          </div>
        )}
      </div>,
    );
  }

  return (
    <div className="assets-panel">
      <div className="assets-section">
        <div className="assets-title">Canvas</div>
        <div className="assets-canvas-grid">
          <label>
            W
            <input
              type="number"
              min={16}
              max={8000}
              value={w}
              onChange={(e) => setW(Number(e.target.value))}
              onBlur={() => applyNow(w, h, color)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyNow(w, h, color);
              }}
            />
          </label>
          <label>
            H
            <input
              type="number"
              min={16}
              max={8000}
              value={h}
              onChange={(e) => setH(Number(e.target.value))}
              onBlur={() => applyNow(w, h, color)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyNow(w, h, color);
              }}
            />
          </label>
          <label className="assets-color">
            BG
            <input
              type="color"
              value={color}
              onChange={(e) => {
                setColor(e.target.value);
                applyNow(w, h, e.target.value);
              }}
            />
          </label>
        </div>
        <p className="assets-hint">
          {applying ? "Applying…" : "Colour applies on pick · size on Enter"}
        </p>
      </div>

      <div className="assets-section assets-layers">
        <div className="assets-title">
          <span>Layers</span>
          <div className="assets-layer-actions">
            <button
              className="snip-tool-btn"
              onClick={() => onMove("forward")}
              disabled={selectionCount === 0}
              title="Bring forward"
            >
              <ArrowUp size={13} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={() => onMove("backward")}
              disabled={selectionCount === 0}
              title="Send backward"
            >
              <ArrowDown size={13} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={onDuplicate}
              disabled={selectionCount === 0}
              title="Duplicate (Ctrl/Cmd+D)"
            >
              <Copy size={13} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={onGroup}
              disabled={!canGroup}
              title="Group (Ctrl/Cmd+G)"
            >
              <Group size={13} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={onUngroup}
              disabled={!canUngroup}
              title="Ungroup / remove from group (Ctrl/Cmd+Shift+G)"
            >
              <Ungroup size={13} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={onDelete}
              disabled={selectionCount === 0}
              title="Delete (Del)"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        <div className="layer-list">
          {rows.length ? rows : <p className="assets-empty">No shapes yet.</p>}
        </div>
      </div>
    </div>
  );
}
