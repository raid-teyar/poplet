import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
  BlankCanvasOptions,
  CapturedImage,
  SnipEditorState,
  Stroke,
} from "../types";
import { enterEditorWindow } from "./snipService";

export interface ProjectPage {
  width: number;
  height: number;
  /** Base image embedded as a PNG data URL so the project file is portable. */
  base: string;
  strokes: Stroke[];
}

export interface PopletProject {
  version: number;
  groupNames: Record<number, string>;
  pages: ProjectPage[];
}

const PROJECT_FILTER = [
  { name: "Poplet project", extensions: ["poplet", "json"] },
];

export async function saveProjectFile(
  project: PopletProject,
): Promise<boolean> {
  const path = await save({
    defaultPath: "poplet-project.poplet",
    filters: PROJECT_FILTER,
  });
  if (!path) return false;
  await invoke("write_text_file", {
    path,
    contents: JSON.stringify(project),
  });
  return true;
}

export async function openProjectFile(): Promise<PopletProject | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: PROJECT_FILTER,
  });
  if (typeof picked !== "string") return null;
  const text = await invoke<string>("read_text_file", { path: picked });
  return JSON.parse(text) as PopletProject;
}

const BACKUP_FILTER = [{ name: "Poplet backup", extensions: ["pbak", "json"] }];

/// Write an already-encrypted backup blob to a user-chosen file.
export async function saveBackupFile(blob: string): Promise<boolean> {
  const path = await save({
    defaultPath: "poplet-backup.pbak",
    filters: BACKUP_FILTER,
  });
  if (!path) return false;
  await invoke("write_text_file", { path, contents: blob });
  return true;
}

/// Read an encrypted backup blob from a user-chosen file.
export async function openBackupFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: BACKUP_FILTER,
  });
  if (typeof picked !== "string") return null;
  return invoke<string>("read_text_file", { path: picked });
}

/// Open a native file picker, import the chosen image into the app images dir,
/// then enter the editor. Returns null if the user cancels the dialog.
export async function startImageImport(
  settings: AppSettings,
): Promise<SnipEditorState | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"],
      },
    ],
  });
  if (typeof selected !== "string") return null;

  const imported = await invoke<CapturedImage>("import_image", {
    path: selected,
  });
  await enterEditorWindow(settings);
  return { ...imported, src: convertFileSrc(imported.path), source: "import" };
}

/// Create a solid-color blank canvas and enter the editor.
export async function startBlankCanvas(
  settings: AppSettings,
  options: BlankCanvasOptions,
): Promise<SnipEditorState> {
  const created = await invoke<CapturedImage>("create_blank_canvas", {
    width: Math.round(options.width),
    height: Math.round(options.height),
    color: options.color,
  });
  await enterEditorWindow(settings);
  return { ...created, src: convertFileSrc(created.path), source: "blank" };
}

/// Run Tesseract OCR over an image file and return the recognized text.
export async function extractTextFromImage(path: string): Promise<string> {
  return invoke<string>("extract_text_from_image", { path });
}
