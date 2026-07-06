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
  snipSmoothing: false,
  snipSketch: false,
  showPageNumbers: false,
};

export const BLANK_CANVAS_PRESETS: { label: string; width: number; height: number }[] = [
  { label: "1920 × 1080", width: 1920, height: 1080 },
  { label: "1280 × 720", width: 1280, height: 720 },
  { label: "800 × 600", width: 800, height: 600 },
  { label: "1080 × 1080", width: 1080, height: 1080 },
  { label: "Vertical 1080 × 1920", width: 1080, height: 1920 },
];

export const DEFAULT_BLANK_CANVAS = {
  width: 1280,
  height: 720,
  color: "#ffffff",
};
