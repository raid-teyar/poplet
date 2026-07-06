import { useState, useCallback, type MutableRefObject } from "react";
import Database from "@tauri-apps/plugin-sql";

export interface ProjectListItem {
  id: number;
  name: string;
  updated_at: string;
  /** 1 when the project has an arena document attached. */
  has_doc: number;
}

export function useProjects(dbRef: MutableRefObject<Database | null>) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);

  const loadProjects = useCallback(async (db = dbRef.current) => {
    if (!db) return;
    const rows = await db.select<ProjectListItem[]>(
      `SELECT p.id, p.name, p.updated_at,
              (EXISTS (SELECT 1 FROM documents d WHERE d.project_id = p.id)) AS has_doc
         FROM projects p
        ORDER BY p.updated_at DESC, p.id DESC`,
    );
    setProjects(rows);
  }, []);

  const saveProjectToLibrary = useCallback(
    async (name: string, data: string) => {
      const db = dbRef.current;
      if (!db) return;
      const res = await db.execute(
        "INSERT INTO projects (name, updated_at) VALUES (?, CURRENT_TIMESTAMP)",
        [name],
      );
      if (typeof res.lastInsertId === "number") {
        await db.execute(
          "INSERT INTO documents (project_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
          [res.lastInsertId, data],
        );
      }
      await loadProjects();
    },
    [loadProjects],
  );

  // A blank (container-only) project — no arena document attached. Returns the
  // new project id.
  const createProject = useCallback(
    async (name: string): Promise<number | null> => {
      const db = dbRef.current;
      if (!db) return null;
      const res = await db.execute(
        "INSERT INTO projects (name, updated_at) VALUES (?, CURRENT_TIMESTAMP)",
        [name.trim() || "Untitled project"],
      );
      await loadProjects();
      return typeof res.lastInsertId === "number" ? res.lastInsertId : null;
    },
    [loadProjects],
  );

  // Replace a project's arena document (used when saving an opened project).
  // Upserts into `documents` and touches the project so it sorts as recent.
  const updateProjectData = useCallback(
    async (id: number, data: string) => {
      const db = dbRef.current;
      if (!db) return;
      const res = await db.execute(
        "UPDATE documents SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
        [data, id],
      );
      if (!res.rowsAffected) {
        await db.execute(
          "INSERT INTO documents (project_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
          [id, data],
        );
      }
      await db.execute(
        "UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [id],
      );
      await loadProjects();
    },
    [loadProjects],
  );

  const renameProject = useCallback(
    async (id: number, name: string) => {
      const db = dbRef.current;
      if (!db) return;
      await db.execute("UPDATE projects SET name = ? WHERE id = ?", [
        name.trim() || "Untitled project",
        id,
      ]);
      await loadProjects();
    },
    [loadProjects],
  );

  const getProjectData = useCallback(async (id: number): Promise<string | null> => {
    const db = dbRef.current;
    if (!db) return null;
    const rows = await db.select<{ data: string }[]>(
      "SELECT data FROM documents WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
      [id],
    );
    return rows[0]?.data ?? null;
  }, []);

  const deleteProject = useCallback(
    async (id: number) => {
      const db = dbRef.current;
      if (!db) return;
      await db.execute("DELETE FROM documents WHERE project_id = ?", [id]);
      await db.execute("DELETE FROM projects WHERE id = ?", [id]);
      await loadProjects();
    },
    [loadProjects],
  );

  return {
    projects,
    loadProjects,
    saveProjectToLibrary,
    createProject,
    updateProjectData,
    renameProject,
    getProjectData,
    deleteProject,
  };
}
