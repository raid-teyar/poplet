import { useState, type Dispatch, type SetStateAction } from "react";
import { FolderKanban, SquarePlus, Upload } from "lucide-react";
import { Button, Input } from "../ui";
import { BLANK_CANVAS_PRESETS } from "../constants";
import type { BlankCanvasOptions } from "../types";
import type { ProjectListItem } from "../hooks/useProjects";

interface EditLauncherProps {
  blankOpts: BlankCanvasOptions;
  setBlankOpts: Dispatch<SetStateAction<BlankCanvasOptions>>;
  newProjectName: string;
  setNewProjectName: Dispatch<SetStateAction<string>>;
  projects: ProjectListItem[];
  onClose: () => void;
  onImportImage: () => void;
  onCreateBlankCanvas: () => void;
  onStartNewProject: (name: string) => void;
  onOpenProject: (id: number) => void;
}

/// The "Open editor" modal: load an image, create a blank canvas, or start /
/// reopen a library project. Purely presentational — all state and side
/// effects are owned by the caller (App).
export default function EditLauncher({
  blankOpts,
  setBlankOpts,
  newProjectName,
  setNewProjectName,
  projects,
  onClose,
  onImportImage,
  onCreateBlankCanvas,
  onStartNewProject,
  onOpenProject,
}: EditLauncherProps) {
  const [projectSearch, setProjectSearch] = useState("");
  const q = projectSearch.trim().toLowerCase();
  const visibleProjects = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q))
    : projects;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="edit-launcher" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>Open editor</strong>
        </div>
        <button className="edit-launcher-option" onClick={onImportImage}>
          <Upload size={16} />
          <span>Load image…</span>
        </button>
        <div className="edit-launcher-blank">
          <div className="edit-launcher-blank-title">
            <SquarePlus size={16} />
            <span>Blank canvas</span>
          </div>
          <div className="blank-presets">
            {BLANK_CANVAS_PRESETS.map((preset) => (
              <button
                key={preset.label}
                className={`blank-preset ${
                  blankOpts.width === preset.width &&
                  blankOpts.height === preset.height
                    ? "active"
                    : ""
                }`}
                onClick={() =>
                  setBlankOpts((prev) => ({
                    ...prev,
                    width: preset.width,
                    height: preset.height,
                  }))
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="blank-custom">
            <label>
              W
              <input
                type="number"
                min={16}
                max={8000}
                value={blankOpts.width}
                onChange={(e) =>
                  setBlankOpts((prev) => ({
                    ...prev,
                    width: Number(e.target.value),
                  }))
                }
              />
            </label>
            <label>
              H
              <input
                type="number"
                min={16}
                max={8000}
                value={blankOpts.height}
                onChange={(e) =>
                  setBlankOpts((prev) => ({
                    ...prev,
                    height: Number(e.target.value),
                  }))
                }
              />
            </label>
            <label className="blank-color">
              Color
              <input
                type="color"
                value={blankOpts.color}
                onChange={(e) =>
                  setBlankOpts((prev) => ({
                    ...prev,
                    color: e.target.value,
                  }))
                }
              />
            </label>
          </div>
          <Button
            variant="primary"
            icon={<SquarePlus size={14} />}
            onClick={onCreateBlankCanvas}
          >
            Create
          </Button>
        </div>

        <div className="edit-launcher-blank">
          <div className="edit-launcher-blank-title">
            <FolderKanban size={16} />
            <span>Projects</span>
          </div>
          <div className="launcher-newproject">
            <Input
              placeholder="New project name…"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
            />
            <Button
              variant="primary"
              icon={<SquarePlus size={14} />}
              onClick={() => {
                if (!newProjectName.trim()) return;
                onStartNewProject(newProjectName.trim());
                setNewProjectName("");
              }}
            >
              New
            </Button>
          </div>
          {projects.length > 0 && (
            <>
              {projects.length > 4 && (
                <Input
                  placeholder="Search projects…"
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                />
              )}
              <div className="launcher-project-list">
                {visibleProjects.map((p) => (
                  <button
                    key={p.id}
                    className="edit-launcher-option"
                    onClick={() => onOpenProject(p.id)}
                  >
                    <FolderKanban size={15} />
                    <span>{p.name}</span>
                    {p.has_doc === 1 && (
                      <span className="launcher-proj-tag">doc</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
