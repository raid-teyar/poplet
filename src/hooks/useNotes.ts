import { useState, useCallback, type MutableRefObject } from "react";
import Database from "@tauri-apps/plugin-sql";
import type { NoteItem, NoteType } from "../types";

interface NoteMeta {
  type?: NoteType;
  imagePath?: string | null;
  pinX?: number | null;
  pinY?: number | null;
  draft?: boolean;
  projectId?: number | null;
}

export function useNotes(dbRef: MutableRefObject<Database | null>) {
  const [notes, setNotes] = useState<NoteItem[]>([]);

  const loadNotes = useCallback(async (db = dbRef.current) => {
    if (!db) return;
    try {
      const result = await db.select<NoteItem[]>(
        "SELECT * FROM notes ORDER BY updated_at DESC, id DESC",
      );
      setNotes(result);
    } catch (err) {
      console.error("Load Notes Error:", err);
    }
  }, []);

  const saveNote = useCallback(
    async (title: string, body: string, id: number | null, meta?: NoteMeta) => {
      const db = dbRef.current;
      if (!db) return;
      if (id !== null) {
        // Update text always; only touch type/draft/project when provided so
        // callers without that context (e.g. pin popover) preserve them.
        const sets = ["title = ?", "body = ?", "updated_at = CURRENT_TIMESTAMP"];
        const params: (string | number | null)[] = [title, body];
        if (meta?.type !== undefined) {
          sets.push("type = ?");
          params.push(meta.type);
        }
        if (meta?.draft !== undefined) {
          sets.push("draft = ?");
          params.push(meta.draft ? 1 : 0);
        }
        if (meta?.projectId !== undefined) {
          sets.push("project_id = ?");
          params.push(meta.projectId);
        }
        params.push(id);
        await db.execute(
          `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`,
          params,
        );
      } else {
        await db.execute(
          "INSERT INTO notes (title, body, type, image_path, pin_x, pin_y, draft, project_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
          [
            title,
            body,
            meta?.type ?? "note",
            meta?.imagePath ?? null,
            meta?.pinX ?? null,
            meta?.pinY ?? null,
            meta?.draft ? 1 : 0,
            meta?.projectId ?? null,
          ],
        );
      }
      loadNotes(db);
    },
    [loadNotes],
  );

  // Convenience for the editor's pin tool.
  const createImageNote = useCallback(
    async (
      title: string,
      body: string,
      imagePath: string,
      pinX: number,
      pinY: number,
    ) => {
      await saveNote(title, body, null, {
        type: "image",
        imagePath,
        pinX,
        pinY,
      });
    },
    [saveNote],
  );

  const setNoteProject = useCallback(
    async (id: number, projectId: number | null) => {
      const db = dbRef.current;
      if (!db) return;
      await db.execute("UPDATE notes SET project_id = ? WHERE id = ?", [
        projectId,
        id,
      ]);
      loadNotes(db);
    },
    [loadNotes],
  );

  const deleteNote = useCallback(
    async (id: number) => {
      const db = dbRef.current;
      if (!db) return;
      await db.execute("DELETE FROM notes WHERE id = ?", [id]);
      loadNotes(db);
    },
    [loadNotes],
  );

  return {
    notes,
    loadNotes,
    saveNote,
    createImageNote,
    setNoteProject,
    deleteNote,
  };
}
