import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { AppSettings, CapturedImage, SnipEditorState } from "../types";

/// Transition the main window into fullscreen editor mode and suspend the
/// hide-on-blur auto-dismiss while editing.
export async function enterEditorWindow(settings: AppSettings) {
  await invoke("set_hide_on_blur_delay", { delayMs: 60000 });
  await invoke("set_snip_editor_window", {
    active: true,
    width: settings.windowWidth,
    height: settings.windowHeight,
    hideAfter: false,
  });
}

export async function startSnipCapture(
  settings: AppSettings,
): Promise<SnipEditorState> {
  const captured = await invoke<CapturedImage>("capture_screenshot_area");
  await enterEditorWindow(settings);
  return { ...captured, src: convertFileSrc(captured.path), source: "snip" };
}

export async function restoreSnipWindow(
  settings: AppSettings,
  hideAfter = false,
) {
  await invoke("set_snip_editor_window", {
    active: false,
    width: settings.windowWidth,
    height: settings.windowHeight,
    hideAfter,
  });
  await invoke("set_hide_on_blur_delay", {
    delayMs: settings.hideOnBlurDelayMs,
  });
}
