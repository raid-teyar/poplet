import { useState, useCallback, type MutableRefObject } from "react";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import type { VaultEntry, VaultMeta } from "../types";

interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
}

type EntryFields = Omit<VaultEntry, "id" | "updated_at">;

export function useVault(dbRef: MutableRefObject<Database | null>) {
  const [status, setStatus] = useState<VaultStatus>({
    initialized: false,
    unlocked: false,
  });
  const [entries, setEntries] = useState<VaultEntry[]>([]);

  const refreshStatus = useCallback(async (): Promise<VaultStatus> => {
    const db = dbRef.current;
    if (!db) return { initialized: false, unlocked: false };
    const rows = await db.select<{ id: number }[]>(
      "SELECT id FROM vault_meta WHERE id = 1",
    );
    const unlocked = await invoke<boolean>("vault_is_unlocked");
    const next = { initialized: rows.length > 0, unlocked };
    setStatus(next);
    return next;
  }, []);

  const loadEntries = useCallback(async () => {
    const db = dbRef.current;
    if (!db) return;
    const rows = await db.select<{ id: number; data: string; updated_at: string }[]>(
      "SELECT id, data, updated_at FROM vault_entries ORDER BY updated_at DESC, id DESC",
    );
    const out: VaultEntry[] = [];
    for (const r of rows) {
      try {
        const json = await invoke<string>("vault_decrypt", { ciphertext: r.data });
        const parsed = JSON.parse(json) as EntryFields;
        out.push({ id: r.id, updated_at: r.updated_at, ...parsed });
      } catch {
        // Locked or corrupt row — skip.
      }
    }
    setEntries(out);
  }, []);

  const setup = useCallback(
    async (passphrase: string) => {
      const db = dbRef.current;
      if (!db) throw new Error("Database not ready");
      const meta = await invoke<VaultMeta>("vault_setup", { passphrase });
      await db.execute(
        "INSERT OR REPLACE INTO vault_meta (id, salt, verifier, mem_kib, iters, parallelism) VALUES (1, ?, ?, ?, ?, ?)",
        [meta.salt, meta.verifier, meta.mem_kib, meta.iters, meta.parallelism],
      );
      await refreshStatus();
      await loadEntries();
    },
    [refreshStatus, loadEntries],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      const db = dbRef.current;
      if (!db) throw new Error("Database not ready");
      const rows = await db.select<VaultMeta[]>(
        "SELECT salt, verifier, mem_kib, iters, parallelism FROM vault_meta WHERE id = 1",
      );
      const meta = rows[0];
      if (!meta) throw new Error("Vault is not set up");
      await invoke("vault_unlock", {
        passphrase,
        salt: meta.salt,
        verifier: meta.verifier,
        memKib: meta.mem_kib,
        iters: meta.iters,
        parallelism: meta.parallelism,
      });
      await refreshStatus();
      await loadEntries();
    },
    [refreshStatus, loadEntries],
  );

  const lock = useCallback(async () => {
    await invoke("vault_lock");
    setEntries([]);
    await refreshStatus();
  }, [refreshStatus]);

  const saveEntry = useCallback(
    async (fields: EntryFields, id: number | null) => {
      const db = dbRef.current;
      if (!db) return;
      const data = await invoke<string>("vault_encrypt", {
        plaintext: JSON.stringify(fields),
      });
      if (id !== null) {
        await db.execute(
          "UPDATE vault_entries SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [data, id],
        );
      } else {
        await db.execute(
          "INSERT INTO vault_entries (data, updated_at) VALUES (?, CURRENT_TIMESTAMP)",
          [data],
        );
      }
      await loadEntries();
    },
    [loadEntries],
  );

  const deleteEntry = useCallback(
    async (id: number) => {
      const db = dbRef.current;
      if (!db) return;
      await db.execute("DELETE FROM vault_entries WHERE id = ?", [id]);
      await loadEntries();
    },
    [loadEntries],
  );

  return {
    status,
    entries,
    refreshStatus,
    loadEntries,
    setup,
    unlock,
    lock,
    saveEntry,
    deleteEntry,
  };
}
