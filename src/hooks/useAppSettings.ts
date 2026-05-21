import { useState, useCallback, type MutableRefObject } from "react";
import Database from "@tauri-apps/plugin-sql";
import type { AppSettings, Tab } from "../types";
import { DEFAULT_SETTINGS, PICKER_TABS } from "../constants";
import {
  clampHoverPreviewDelayMs,
  clampSnipPencilWidth,
  clampWindowHeight,
  clampWindowWidth,
} from "../utils";

export function useAppSettings(dbRef: MutableRefObject<Database | null>) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const loadSettings = useCallback(async (db = dbRef.current) => {
    if (!db) return DEFAULT_SETTINGS;
    try {
      const rows = await db.select<Array<{ key: string; value: string }>>(
        "SELECT key, value FROM settings",
      );
      const next = { ...DEFAULT_SETTINGS };
      for (const row of rows) {
        if (row.key === "enableImagePreview") {
          next.enableImagePreview = row.value !== "false";
        } else if (row.key === "hoverPreviewDelayMs") {
          next.hoverPreviewDelayMs = clampHoverPreviewDelayMs(
            Number(row.value),
          );
        } else if (
          row.key === "preferredTab" &&
          PICKER_TABS.includes(row.value as Tab)
        ) {
          next.preferredTab = row.value as AppSettings["preferredTab"];
        } else if (row.key === "giphyApiKey") {
          next.giphyApiKey = row.value;
        } else if (row.key === "historyLimit") {
          const limit = Number(row.value);
          if (Number.isFinite(limit)) {
            next.historyLimit = Math.min(Math.max(limit, 10), 200);
          }
        } else if (row.key === "hideOnBlurDelayMs") {
          const delay = Number(row.value);
          if (Number.isFinite(delay)) {
            next.hideOnBlurDelayMs = Math.min(Math.max(delay, 0), 2000);
          }
        } else if (row.key === "windowWidth") {
          next.windowWidth = clampWindowWidth(Number(row.value));
        } else if (row.key === "windowHeight") {
          next.windowHeight = clampWindowHeight(Number(row.value));
        } else if (row.key === "popletShortcut") {
          next.popletShortcut =
            row.value.trim() || DEFAULT_SETTINGS.popletShortcut;
        } else if (row.key === "snipShortcut") {
          next.snipShortcut = row.value.trim() || DEFAULT_SETTINGS.snipShortcut;
        } else if (row.key === "fullscreenShortcut") {
          next.fullscreenShortcut =
            row.value.trim() || DEFAULT_SETTINGS.fullscreenShortcut;
        } else if (row.key === "restoreWindowOnShow") {
          next.restoreWindowOnShow = row.value !== "false";
        } else if (row.key === "snipPencilWidth") {
          next.snipPencilWidth = clampSnipPencilWidth(Number(row.value));
        }
      }
      setSettings(next);
      return next;
    } catch (err) {
      console.error("Load Settings Error:", err);
      return DEFAULT_SETTINGS;
    }
  }, []);

  const saveSetting = useCallback(async <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    const db = dbRef.current;
    setSettings((prev) => ({ ...prev, [key]: value }));
    if (!db) return;
    await db.execute(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, String(value)],
    );
  }, []);

  return { settings, loadSettings, saveSetting };
}
