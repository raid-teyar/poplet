import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { NoteItem } from "../../types";

interface NotesTabProps {
  notes: NoteItem[];
  filteredNotes: NoteItem[];
  onSaveNote: (title: string, body: string, id: number | null) => void;
  onDeleteNote: (id: number) => void;
}

export default function NotesTab({
  notes,
  filteredNotes,
  onSaveNote,
  onDeleteNote,
}: NotesTabProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"add" | "edit">("add");
  const [modalId, setModalId] = useState<number | null>(null);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");

  const openAdd = () => {
    setModalMode("add");
    setModalId(null);
    setNoteTitle("");
    setNoteBody("");
    setModalOpen(true);
  };

  const openEdit = (note: NoteItem) => {
    setModalMode("edit");
    setModalId(note.id);
    setNoteTitle(note.title);
    setNoteBody(note.body);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalId(null);
    setNoteTitle("");
    setNoteBody("");
  };

  const handleSave = () => {
    const title = noteTitle.trim();
    const body = noteBody.trim();
    if (!title && !body) return;
    onSaveNote(
      title || "Untitled",
      body,
      modalMode === "edit" ? modalId : null,
    );
    closeModal();
  };

  const handleDelete = (id: number) => {
    onDeleteNote(id);
    if (modalId === id) closeModal();
  };

  return (
    <>
      <div className="notes-panel">
        <div className="notes-toolbar">
          <button className="note-primary-button" onClick={openAdd}>
            <Plus size={14} />
            Add note
          </button>
        </div>

        {filteredNotes.length === 0 && (
          <p className="empty-state">
            {notes.length === 0 ? "No notes yet" : "No matches"}
          </p>
        )}

        <div className="notes-list">
          {filteredNotes.map((note) => (
            <div className="note-item" key={note.id}>
              <div className="note-header">
                <div className="note-title">{note.title}</div>
                <div className="note-actions">
                  <button
                    className="icon-button"
                    title="Edit note"
                    onClick={() => openEdit(note)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button"
                    title="Delete note"
                    onClick={() => handleDelete(note.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {note.body && <div className="note-body">{note.body}</div>}
            </div>
          ))}
        </div>
      </div>

      {modalOpen && (
        <div className="modal-backdrop" onMouseDown={closeModal}>
          <div className="note-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>{modalMode === "edit" ? "Edit note" : "Add note"}</strong>
              <button className="icon-button" onClick={closeModal}>
                <X size={14} />
              </button>
            </div>
            <input
              className="note-title-input"
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
              placeholder="Title"
              autoFocus
            />
            <textarea
              className="note-body-input note-modal-body"
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Note"
            />
            <div className="modal-actions">
              <button className="secondary-button" onClick={closeModal}>
                Cancel
              </button>
              <button className="note-primary-button" onClick={handleSave}>
                <Check size={14} />
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
