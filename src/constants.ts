import type { AppSettings, Tab } from "./types";

export const PICKER_TABS: Tab[] = ["history", "emoji", "gif", "notes"];

export const DEFAULT_WINDOW_WIDTH = 450;
export const DEFAULT_WINDOW_HEIGHT = 600;
export const MIN_WINDOW_WIDTH = 320;
export const MAX_WINDOW_WIDTH = 1000;
export const MIN_WINDOW_HEIGHT = 360;
export const MAX_WINDOW_HEIGHT = 1200;
export const MAX_HOVER_PREVIEW_DELAY_MS = 5000;
export const MIN_SNIP_PENCIL_WIDTH = 0.1;
export const MAX_SNIP_PENCIL_WIDTH = 3;
export const DEFAULT_SNIP_PENCIL_WIDTH = 0.25;

export const DEFAULT_SETTINGS: AppSettings = {
  enableImagePreview: true,
  hoverPreviewDelayMs: 1500,
  preferredTab: "emoji",
  giphyApiKey: "",
  historyLimit: 50,
  hideOnBlurDelayMs: 250,
  windowWidth: DEFAULT_WINDOW_WIDTH,
  windowHeight: DEFAULT_WINDOW_HEIGHT,
  popletShortcut: "Super+V",
  snipShortcut: "Super+Shift+S",
  fullscreenShortcut: "Ctrl+Shift+F",
  restoreWindowOnShow: true,
  snipPencilWidth: DEFAULT_SNIP_PENCIL_WIDTH,
};
