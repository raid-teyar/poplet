import { useCallback, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import {
  startSnipCapture,
  restoreSnipWindow,
  enterEditorWindow,
} from "../services/snipService";
import {
  startImageImport,
  startBlankCanvas,
  type PopletProject,
} from "../services/editorService";
import { DEFAULT_BLANK_CANVAS } from "../constants";
import type {
  AppSettings,
  BlankCanvasOptions,
  CapturedImage,
  EditorPage,
  SnipEditorState,
} from "../types";
import type { useProjects } from "./useProjects";

interface EditorInit {
  pages: EditorPage[];
  groupNames: Record<number, string>;
  projectId: number | null;
  projectName: string;
}

interface UseEditorSessionArgs {
  settings: AppSettings;
  blankOpts: BlankCanvasOptions;
  projects: ReturnType<typeof useProjects>;
  /** Called at the start of every launch so the caller can dismiss UI
   *  (clear the image preview, close the edit launcher, etc.). */
  onLaunchStart: () => void;
}

/// Owns the snip/editor session: the captured/opened document, the pending
/// launch state, and the actions that produce a document (snip, import,
/// blank canvas, open/new project). Extracted from App to keep the shell lean.
export function useEditorSession({
  settings,
  blankOpts,
  projects,
  onLaunchStart,
}: UseEditorSessionArgs) {
  const [snipEditor, setSnipEditor] = useState<SnipEditorState | null>(null);
  const [editorInit, setEditorInit] = useState<EditorInit | null>(null);
  const [snipStarting, setSnipStarting] = useState(false);
  const [snipError, setSnipError] = useState("");
  const snipStartingRef = useRef(false);

  const launchEditor = useCallback(
    async (produce: () => Promise<SnipEditorState | null>) => {
      setSnipError("");
      onLaunchStart();
      setEditorInit(null); // fresh single-page session unless a project sets it
      setSnipStarting(true);
      snipStartingRef.current = true;
      try {
        const editor = await produce();
        if (editor) setSnipEditor(editor);
      } catch (err) {
        setSnipError(String(err));
      } finally {
        snipStartingRef.current = false;
        setSnipStarting(false);
      }
    },
    [onLaunchStart],
  );

  const startSnip = useCallback(
    () => launchEditor(() => startSnipCapture(settings)),
    [launchEditor, settings],
  );

  const importImage = useCallback(
    () => launchEditor(() => startImageImport(settings)),
    [launchEditor, settings],
  );

  const createBlankCanvas = useCallback(
    () => launchEditor(() => startBlankCanvas(settings, blankOpts)),
    [launchEditor, settings, blankOpts],
  );

  // Open an existing project's document in the editor (materialize its pages,
  // then launch with them so saving updates that project).
  const blankPage = useCallback(async (): Promise<EditorPage> => {
    const created = await invoke<CapturedImage>("create_blank_canvas", {
      width: DEFAULT_BLANK_CANVAS.width,
      height: DEFAULT_BLANK_CANVAS.height,
      color: DEFAULT_BLANK_CANVAS.color,
    });
    return {
      id: 0,
      path: created.path,
      src: convertFileSrc(created.path),
      width: created.width,
      height: created.height,
      source: "blank",
      strokes: [],
    };
  }, []);

  const openProjectInEditor = useCallback(
    (id: number) =>
      launchEditor(async () => {
        const name =
          projects.projects.find((p) => p.id === id)?.name ?? "Project";
        const data = await projects.getProjectData(id);
        let pages: EditorPage[] = [];
        let groupNames: Record<number, string> = {};
        if (data) {
          try {
            const project = JSON.parse(data) as PopletProject;
            groupNames = project.groupNames ?? {};
            for (let i = 0; i < project.pages.length; i++) {
              const pg = project.pages[i];
              const created = await invoke<CapturedImage>("save_data_url_image", {
                dataUrl: pg.base,
              });
              pages.push({
                id: i,
                path: created.path,
                src: convertFileSrc(created.path),
                width: created.width,
                height: created.height,
                source: "import",
                strokes: pg.strokes ?? [],
              });
            }
          } catch {
            pages = [];
          }
        }
        // A blank/empty project opens a fresh arena bound to it.
        if (!pages.length) pages = [await blankPage()];
        setEditorInit({ pages, groupNames, projectId: id, projectName: name });
        await enterEditorWindow(settings);
        return pages[0];
      }),
    [launchEditor, settings, blankPage],
  );

  // Create a new (blank) project and start drawing in it — saves go to it.
  const startNewProject = useCallback(
    (name: string) =>
      launchEditor(async () => {
        const id = await projects.createProject(name);
        const page = await blankPage();
        setEditorInit({
          pages: [page],
          groupNames: {},
          projectId: id,
          projectName: name,
        });
        await enterEditorWindow(settings);
        return page;
      }),
    [launchEditor, settings, blankPage],
  );

  const cancelSnip = useCallback(async () => {
    setSnipEditor(null);
    await restoreSnipWindow(settings);
  }, [settings]);

  return {
    snipEditor,
    setSnipEditor,
    editorInit,
    snipStarting,
    snipError,
    snipStartingRef,
    startSnip,
    importImage,
    createBlankCanvas,
    openProjectInEditor,
    startNewProject,
    cancelSnip,
  };
}
