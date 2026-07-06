import { useMemo, useState } from "react";
import {
  Copy,
  FileClock,
  Folder,
  Image as ImageIcon,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
} from "lucide-react";
import type { NoteItem, NoteType } from "../../types";
import type { ProjectListItem } from "../../hooks/useProjects";
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  IconButton,
  Input,
  Modal,
  ModalActions,
  ModalHeader,
  Select,
  Textarea,
} from "../../ui";

interface NoteMeta {
  type?: NoteType;
  projectId?: number | null;
  draft?: boolean;
}

interface NotesTabProps {
  notes: NoteItem[];
  filteredNotes: NoteItem[];
  projects: ProjectListItem[];
  onSaveNote: (
    title: string,
    body: string,
    id: number | null,
    meta?: NoteMeta,
  ) => void;
  onDeleteNote: (id: number) => void;
  onCopy: (text: string) => void;
}

type Filter = "all" | "draft" | NoteType;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "note", label: "Notes" },
  { key: "image", label: "Image" },
  { key: "project", label: "Project" },
];

const TYPE_META: Record<
  NoteType,
  { label: string; icon: typeof StickyNote; tone: "default" | "accent" | "success" }
> = {
  note: { label: "Note", icon: StickyNote, tone: "default" },
  image: { label: "Image", icon: ImageIcon, tone: "accent" },
  project: { label: "Project", icon: StickyNote, tone: "success" },
};

export default function NotesTab({
  notes,
  filteredNotes,
  projects,
  onSaveNote,
  onDeleteNote,
  onCopy,
}: NotesTabProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"add" | "edit">("add");
  const [modalId, setModalId] = useState<number | null>(null);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [noteType, setNoteType] = useState<NoteType>("note");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const projectName = (id: number | null) =>
    id == null ? null : projects.find((p) => p.id === id)?.name ?? null;

  const shown = useMemo(
    () =>
      filteredNotes.filter((n) => {
        if (filter === "all") return true;
        if (filter === "draft") return n.draft === 1;
        return (n.type ?? "note") === filter;
      }),
    [filteredNotes, filter],
  );

  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      all: notes.length,
      draft: 0,
      note: 0,
      image: 0,
      project: 0,
    };
    for (const n of notes) {
      if (n.draft === 1) c.draft++;
      c[(n.type ?? "note") as NoteType]++;
    }
    return c;
  }, [notes]);

  const openAdd = () => {
    setModalMode("add");
    setModalId(null);
    setNoteTitle("");
    setNoteBody("");
    setNoteType(filter === "note" || filter === "project" ? filter : "note");
    setProjectId(null);
    setModalOpen(true);
  };

  const openEdit = (note: NoteItem) => {
    setModalMode("edit");
    setModalId(note.id);
    setNoteTitle(note.title);
    setNoteBody(note.body);
    setNoteType(note.type ?? "note");
    setProjectId(note.project_id ?? null);
    setModalOpen(true);
  };

  const hardClose = () => {
    setModalOpen(false);
    setModalId(null);
    setNoteTitle("");
    setNoteBody("");
  };

  const handleSave = () => {
    const title = noteTitle.trim();
    const body = noteBody.trim();
    if (!title && !body) return hardClose();
    onSaveNote(title || "Untitled", body, modalMode === "edit" ? modalId : null, {
      type: noteType,
      projectId,
      draft: false,
    });
    hardClose();
  };

  // Closing a new note that has content keeps it as a draft so nothing is lost.
  const handleDismiss = () => {
    const title = noteTitle.trim();
    const body = noteBody.trim();
    if (modalMode === "add" && (title || body)) {
      onSaveNote(title || "Untitled", body, null, {
        type: noteType,
        projectId,
        draft: true,
      });
    }
    hardClose();
  };

  const handleDelete = (id: number) => {
    onDeleteNote(id);
    if (modalId === id) hardClose();
  };

  return (
    <>
      <div className="notes-panel">
        <div className="notes-toolbar">
          <div className="note-filters">
            {FILTERS.map((f) => (
              <Chip
                key={f.key}
                active={filter === f.key}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="note-filter-count">{counts[f.key]}</span>
              </Chip>
            ))}
          </div>
          <Button variant="primary" icon={<Plus size={14} />} onClick={openAdd}>
            Add note
          </Button>
        </div>

        {shown.length === 0 && (
          <EmptyState>{notes.length === 0 ? "No notes yet" : "No matches"}</EmptyState>
        )}

        <div className="notes-list">
          {shown.map((note) => {
            const t = TYPE_META[(note.type ?? "note") as NoteType];
            const TypeIcon = t.icon;
            const proj = projectName(note.project_id);
            return (
              <div
                className={`note-item ${note.draft ? "is-draft" : ""}`}
                key={note.id}
              >
                <div className="note-header">
                  <div
                    className="note-title note-click"
                    onClick={() => openEdit(note)}
                    title="Click to open"
                  >
                    {note.draft === 1 && (
                      <Badge tone="warning">
                        <FileClock size={11} />
                        Draft
                      </Badge>
                    )}
                    <Badge tone={t.tone}>
                      <TypeIcon size={11} />
                      {t.label}
                    </Badge>
                    {proj && (
                      <Badge tone="success">
                        <Folder size={11} />
                        {proj}
                      </Badge>
                    )}
                    {note.title}
                  </div>
                  <div className="note-actions">
                    {note.body && (
                      <IconButton title="Copy note" onClick={() => onCopy(note.body)}>
                        <Copy size={13} />
                      </IconButton>
                    )}
                    <IconButton title="Edit note" onClick={() => openEdit(note)}>
                      <Pencil size={13} />
                    </IconButton>
                    <IconButton title="Delete note" onClick={() => handleDelete(note.id)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </div>
                {note.body && (
                  <div className="note-body note-click" onClick={() => openEdit(note)}>
                    {note.body}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {modalOpen && (
        <Modal onClose={handleDismiss}>
          <ModalHeader
            title={modalMode === "edit" ? "Edit note" : "Add note"}
            onClose={handleDismiss}
          />
          <Input
            value={noteTitle}
            onChange={(e) => setNoteTitle(e.target.value)}
            placeholder="Title"
            autoFocus
          />
          <div className="note-type-picker">
            {(["note", "project"] as NoteType[]).map((tp) => (
              <Chip
                key={tp}
                active={noteType === tp}
                onClick={() => setNoteType(tp)}
              >
                {TYPE_META[tp].label}
              </Chip>
            ))}
            <Select
              value={projectId ?? ""}
              onChange={(e) =>
                setProjectId(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <Textarea
            className="note-modal-body"
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            placeholder="Note"
          />
          <ModalActions>
            {modalMode === "edit" && modalId !== null && (
              <Button
                icon={<Trash2 size={13} />}
                onClick={() => handleDelete(modalId)}
              >
                Delete
              </Button>
            )}
            <Button onClick={hardClose}>Discard</Button>
            <Button variant="primary" onClick={handleSave}>
              Save
            </Button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}
