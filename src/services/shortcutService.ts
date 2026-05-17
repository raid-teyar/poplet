import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, ShortcutApplyResult } from "../types";

export async function applySystemShortcuts(
  settings: AppSettings,
): Promise<string> {
  const result = await invoke<ShortcutApplyResult>("apply_system_shortcuts", {
    popletShortcut: settings.popletShortcut,
    snipShortcut: settings.snipShortcut,
    fullscreenShortcut: settings.fullscreenShortcut,
  });
  return result.message;
}
