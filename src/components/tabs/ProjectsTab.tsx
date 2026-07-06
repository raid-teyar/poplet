import { useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Image as ImageIcon,
  Pencil,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import type { HistoryItem, NoteItem } from "../../types";
import type { ProjectListItem } from "../../hooks/useProjects";
import { Button, EmptyState, IconButton, Input } from "../../ui";

interface ProjectsTabProps {
  projects: ProjectListItem[];
  notes: NoteItem[];
  captures: HistoryItem[];
  onCreate: (name: string) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  onUnassignNote: (noteId: number) => void;
  onUnassignCapture: (id: number) => void;
  onOpen: (id: number) => void;
}

export default function ProjectsTab({
  projects,
  notes,
  captures,
  onCreate,
  onRename,
  onDelete,
  onUnassignNote,
  onUnassignCapture,
  onOpen,
}: ProjectsTabProps) {
  const [newName, setNewName] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");

  const byProject = useMemo(() => {
    const notesFor = new Map<number, NoteItem[]>();
    const capsFor = new Map<number, HistoryItem[]>();
    for (const n of notes) {
      if (n.project_id != null) {
        (notesFor.get(n.project_id) ?? notesFor.set(n.project_id, []).get(n.project_id)!).push(n);
      }
    }
    for (const c of captures) {
      if (c.project_id != null) {
        (capsFor.get(c.project_id) ?? capsFor.set(c.project_id, []).get(c.project_id)!).push(c);
      }
    }
    return { notesFor, capsFor };
  }, [notes, captures]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const create = () => {
    if (!newName.trim()) return;
    onCreate(newName.trim());
    setNewName("");
  };

  return (
    <div className="projects-panel">
      <div className="project-create">
        <Input
          placeholder="New project name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <Button variant="primary" onClick={create}>
          Create
        </Button>
      </div>

      {projects.length === 0 && <EmptyState>No projects yet</EmptyState>}

      <div className="notes-list">
        {projects.map((p) => {
          const pNotes = byProject.notesFor.get(p.id) ?? [];
          const pCaps = byProject.capsFor.get(p.id) ?? [];
          const isOpen = expanded.has(p.id);
          return (
            <div className="project-item" key={p.id}>
              <div className="project-head">
                <IconButton size="sm" onClick={() => toggle(p.id)}>
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </IconButton>
                {editing === p.id ? (
                  <Input
                    className="layer-rename"
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={() => {
                      onRename(p.id, draftName);
                      setEditing(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onRename(p.id, draftName);
                        setEditing(null);
                      }
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <span className="project-name" onClick={() => onOpen(p.id)} title="Open in editor">
                    {p.name}
                  </span>
                )}
                <span className="project-counts">
                  <span title="Notes">
                    <StickyNote size={11} /> {pNotes.length}
                  </span>
                  <span title="Captures">
                    <ImageIcon size={11} /> {pCaps.length}
                  </span>
                </span>
                <IconButton title="Open in editor" onClick={() => onOpen(p.id)}>
                  <FolderOpen size={13} />
                </IconButton>
                <IconButton
                  title="Rename"
                  onClick={() => {
                    setEditing(p.id);
                    setDraftName(p.name);
                  }}
                >
                  <Pencil size={13} />
                </IconButton>
                <IconButton title="Delete project" onClick={() => onDelete(p.id)}>
                  <Trash2 size={13} />
                </IconButton>
              </div>

              {isOpen && (
                <div className="project-contents">
                  {pNotes.length === 0 && pCaps.length === 0 && (
                    <p className="project-empty">
                      Nothing assigned yet — assign notes from the Notes tab and
                      captures from History.
                    </p>
                  )}
                  {pNotes.map((n) => (
                    <div className="project-ref" key={`n${n.id}`}>
                      <StickyNote size={12} />
                      <span className="layer-name">{n.title || "Untitled"}</span>
                      <IconButton
                        size="sm"
                        title="Remove from project"
                        onClick={() => onUnassignNote(n.id)}
                      >
                        <X size={12} />
                      </IconButton>
                    </div>
                  ))}
                  {pCaps.length > 0 && (
                    <div className="project-captures">
                      {pCaps.map((c) => (
                        <div className="project-capture" key={`c${c.id}`}>
                          {c.image_path && (
                            <img src={convertFileSrc(c.image_path)} alt="capture" />
                          )}
                          <IconButton
                            size="sm"
                            className="project-capture-x"
                            title="Remove from project"
                            onClick={() => onUnassignCapture(c.id)}
                          >
                            <X size={12} />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
