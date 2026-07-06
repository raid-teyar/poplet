import { useCallback, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { saveBackupFile, openBackupFile } from "../services/editorService";
import type { NoteItem } from "../types";
import type { useVault } from "./useVault";
import type { useProjects } from "./useProjects";

interface UseBackupArgs {
  dbRef: MutableRefObject<Database | null>;
  vault: ReturnType<typeof useVault>;
  projects: ReturnType<typeof useProjects>;
  loadNotes: () => Promise<unknown>;
}

/// Encrypted whole-app backup: seals notes (+embedded images), library
/// projects, and vault secrets under a standalone backup passphrase, and
/// restores them. Extracted from App so the shell doesn't carry the schema.
export function useBackup({ dbRef, vault, projects, loadNotes }: UseBackupArgs) {
  const exportBackup = useCallback(
    async (passphrase: string) => {
      const db = dbRef.current;
      if (!db) throw new Error("Database not ready");
      if (!vault.status.unlocked)
        throw new Error("Unlock the vault first so secrets can be included.");
      const noteRows = await db.select<NoteItem[]>("SELECT * FROM notes");
      const notesOut = [];
      for (const n of noteRows) {
        let imageData: string | null = null;
        if (n.type === "image" && n.image_path) {
          try {
            imageData = await invoke<string>("read_image_as_data_url", {
              path: n.image_path,
            });
          } catch {
            // image missing — keep the note without it
          }
        }
        notesOut.push({
          title: n.title,
          body: n.body,
          type: n.type,
          pin_x: n.pin_x,
          pin_y: n.pin_y,
          imageData,
        });
      }
      // LEFT JOIN so container-only projects (no arena document) are still
      // exported, with an empty data blob.
      const projectRows = await db.select<{ name: string; data: string }[]>(
        `SELECT p.name AS name, COALESCE(d.data, '') AS data
           FROM projects p
           LEFT JOIN documents d ON d.project_id = p.id
          ORDER BY p.id`,
      );
      const vaultEntries = vault.entries.map((e) => ({
        label: e.label,
        username: e.username,
        secret: e.secret,
        url: e.url,
        notes: e.notes,
        category: e.category,
      }));
      const bundle = {
        version: 1,
        notes: notesOut,
        projects: projectRows,
        vaultEntries,
      };
      const blob = await invoke<string>("backup_seal", {
        passphrase,
        plaintext: JSON.stringify(bundle),
      });
      return saveBackupFile(blob);
    },
    [dbRef, vault.status.unlocked, vault.entries],
  );

  const importBackup = useCallback(
    async (passphrase: string) => {
      const db = dbRef.current;
      if (!db) throw new Error("Database not ready");
      const blob = await openBackupFile();
      if (!blob) return;
      const json = await invoke<string>("backup_open", { passphrase, blob });
      const bundle = JSON.parse(json);

      for (const n of bundle.notes ?? []) {
        let imagePath: string | null = null;
        if (n.imageData) {
          try {
            const created = await invoke<{ path: string }>("save_data_url_image", {
              dataUrl: n.imageData,
            });
            imagePath = created.path;
          } catch {
            // skip broken image
          }
        }
        await db.execute(
          "INSERT INTO notes (title, body, type, image_path, pin_x, pin_y, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
          [n.title ?? "", n.body ?? "", n.type ?? "note", imagePath, n.pin_x ?? null, n.pin_y ?? null],
        );
      }
      for (const p of bundle.projects ?? []) {
        const res = await db.execute(
          "INSERT INTO projects (name, updated_at) VALUES (?, CURRENT_TIMESTAMP)",
          [p.name ?? "Project"],
        );
        if (
          typeof res.lastInsertId === "number" &&
          typeof p.data === "string" &&
          p.data.length > 0
        ) {
          await db.execute(
            "INSERT INTO documents (project_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
            [res.lastInsertId, p.data],
          );
        }
      }
      const secrets = bundle.vaultEntries ?? [];
      if (secrets.length > 0) {
        if (!vault.status.unlocked)
          throw new Error("Unlock the vault to import its secrets.");
        for (const e of secrets) {
          const data = await invoke<string>("vault_encrypt", {
            plaintext: JSON.stringify(e),
          });
          await db.execute(
            "INSERT INTO vault_entries (data, updated_at) VALUES (?, CURRENT_TIMESTAMP)",
            [data],
          );
        }
      }
      await loadNotes();
      await projects.loadProjects();
      await vault.loadEntries();
    },
    [dbRef, vault.status.unlocked, loadNotes],
  );

  return { exportBackup, importBackup };
}
