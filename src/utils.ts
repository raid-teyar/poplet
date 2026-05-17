import {
  DEFAULT_SNIP_PENCIL_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MAX_HOVER_PREVIEW_DELAY_MS,
  MAX_SNIP_PENCIL_WIDTH,
  MAX_WINDOW_HEIGHT,
  MAX_WINDOW_WIDTH,
  MIN_SNIP_PENCIL_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from "./constants";
import type { DetectedFile } from "./types";

export function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function clampHoverPreviewDelayMs(value: number) {
  return clampNumber(value, 0, MAX_HOVER_PREVIEW_DELAY_MS, 1500);
}

export function clampWindowWidth(value: number) {
  return clampNumber(
    value,
    MIN_WINDOW_WIDTH,
    MAX_WINDOW_WIDTH,
    DEFAULT_WINDOW_WIDTH,
  );
}

export function clampWindowHeight(value: number) {
  return clampNumber(
    value,
    MIN_WINDOW_HEIGHT,
    MAX_WINDOW_HEIGHT,
    DEFAULT_WINDOW_HEIGHT,
  );
}

export function clampSnipPencilWidth(value: number) {
  return clampNumber(
    value,
    MIN_SNIP_PENCIL_WIDTH,
    MAX_SNIP_PENCIL_WIDTH,
    DEFAULT_SNIP_PENCIL_WIDTH,
  );
}

const IMG_SRC_RE = /<img\b[^>]*\bsrc=(["']?)([^"'\s>]+)\1[^>]*>/i;

export function imageReferenceFromText(content: string): string | null {
  const trimmed = content.trim();
  const htmlSrc = trimmed.match(IMG_SRC_RE)?.[2];
  const candidate = htmlSrc ?? trimmed.split(/\r?\n/).find(Boolean)?.trim();
  return candidate ?? null;
}

// ─── File Path Detection ─────────────────────────────────────────────

const TEXT_FILE_EXTENSIONS = new Set([
  "md",
  "txt",
  "rs",
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "toml",
  "yaml",
  "yml",
  "py",
  "go",
  "c",
  "cpp",
  "h",
  "hpp",
  "java",
  "sh",
  "bash",
  "zsh",
  "css",
  "html",
  "xml",
  "svg",
  "sql",
  "lua",
  "rb",
  "php",
  "conf",
  "ini",
  "env",
  "gitignore",
  "dockerfile",
  "makefile",
  "lock",
  "log",
  "csv",
]);

export function detectFilePath(content: string): DetectedFile | null {
  const trimmed = content.trim();
  // Only consider single-line content
  if (trimmed.includes("\n")) return null;

  let candidate: string;
  if (/^file:\/\//i.test(trimmed)) {
    candidate = decodeURI(trimmed.replace(/^file:\/\//i, ""));
  } else if (/^\/[^\s]+$/.test(trimmed)) {
    candidate = trimmed;
  } else {
    return null;
  }

  const parts = candidate.split("/");
  const filename = parts[parts.length - 1];
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return null;

  const extension = filename.slice(dotIndex + 1).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(extension)) return null;

  return { path: candidate, filename, extension };
}
