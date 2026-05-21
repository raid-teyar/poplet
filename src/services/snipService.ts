import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { AppSettings, CapturedImage, SnipEditorState } from "../types";

export async function startSnipCapture(
  settings: AppSettings,
): Promise<SnipEditorState> {
  const captured = await invoke<CapturedImage>("capture_screenshot_area");
  await invoke("set_hide_on_blur_delay", { delayMs: 60000 });
  await invoke("set_snip_editor_window", {
    active: true,
    width: settings.windowWidth,
    height: settings.windowHeight,
    hideAfter: false,
  });
  return { ...captured, src: convertFileSrc(captured.path) };
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
