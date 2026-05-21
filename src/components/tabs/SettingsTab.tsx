import { Keyboard } from "lucide-react";
import type { AppSettings } from "../../types";
import {
  MAX_HOVER_PREVIEW_DELAY_MS,
  MAX_SNIP_PENCIL_WIDTH,
  MAX_WINDOW_HEIGHT,
  MAX_WINDOW_WIDTH,
  MIN_SNIP_PENCIL_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from "../../constants";
import {
  clampHoverPreviewDelayMs,
  clampSnipPencilWidth,
  clampWindowHeight,
  clampWindowWidth,
} from "../../utils";

interface SettingsTabProps {
  settings: AppSettings;
  onSaveSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => void;
  shortcutStatus: string;
  onApplyShortcuts: () => void;
  onLoadHistory: (limit: number) => void;
}

export default function SettingsTab({
  settings,
  onSaveSetting,
  shortcutStatus,
  onApplyShortcuts,
  onLoadHistory,
}: SettingsTabProps) {
  return (
    <div className="settings-panel">
      <label className="setting-row">
        <span>
          <strong>Image preview</strong>
          <small>Show a floating preview when hovering images.</small>
        </span>
        <input
          type="checkbox"
          checked={settings.enableImagePreview}
          onChange={(e) =>
            onSaveSetting("enableImagePreview", e.target.checked)
          }
        />
      </label>

      <label className="setting-row">
        <span>
          <strong>Preferred tab</strong>
          <small>Tab opened when Poplet is shown.</small>
        </span>
        <select
          value={settings.preferredTab}
          onChange={(e) =>
            onSaveSetting(
              "preferredTab",
              e.target.value as AppSettings["preferredTab"],
            )
          }
        >
          <option value="history">History</option>
          <option value="emoji">Emoji</option>
          <option value="gif">GIF</option>
          <option value="notes">Notes</option>
        </select>
      </label>

      <label className="setting-field">
        <span>
          <strong>Giphy API key</strong>
          <small>Used by the GIF tab without rebuilding Poplet.</small>
        </span>
        <input
          type="password"
          value={settings.giphyApiKey}
          onChange={(e) => onSaveSetting("giphyApiKey", e.target.value)}
          placeholder="giphy api key"
        />
      </label>

      <div className="setting-group">
        <div className="setting-group-header">
          <span>
            <strong>Shortcuts</strong>
            <small>
              Saved in Poplet and applied to the current desktop when supported.
            </small>
          </span>
          <button className="note-primary-button" onClick={onApplyShortcuts}>
            <Keyboard size={14} />
            Apply
          </button>
        </div>

        <label className="setting-field">
          <span>
            <strong>Open Poplet</strong>
            <small>Example: Super+V</small>
          </span>
          <input
            type="text"
            value={settings.popletShortcut}
            onChange={(e) => onSaveSetting("popletShortcut", e.target.value)}
            placeholder="Super+V"
          />
        </label>

        <label className="setting-field">
          <span>
            <strong>Snip tool</strong>
            <small>Example: Super+Shift+S</small>
          </span>
          <input
            type="text"
            value={settings.snipShortcut}
            onChange={(e) => onSaveSetting("snipShortcut", e.target.value)}
            placeholder="Super+Shift+S"
          />
        </label>

        <label className="setting-field">
          <span>
            <strong>Fullscreen toggle</strong>
            <small>Example: Ctrl+Shift+F</small>
          </span>
          <input
            type="text"
            value={settings.fullscreenShortcut}
            onChange={(e) =>
              onSaveSetting("fullscreenShortcut", e.target.value)
            }
            placeholder="Ctrl+Shift+F"
          />
        </label>

        {shortcutStatus && <p className="setting-status">{shortcutStatus}</p>}
      </div>

      <label className="setting-row">
        <span>
          <strong>Restore window on show</strong>
          <small>Return Poplet to saved width and height when opened.</small>
        </span>
        <input
          type="checkbox"
          checked={settings.restoreWindowOnShow}
          onChange={(e) =>
            onSaveSetting("restoreWindowOnShow", e.target.checked)
          }
        />
      </label>

      <label className="setting-field">
        <span>
          <strong>Preview delay</strong>
          <small>Milliseconds to wait before showing hover previews.</small>
        </span>
        <input
          type="number"
          min={0}
          max={MAX_HOVER_PREVIEW_DELAY_MS}
          step={100}
          value={settings.hoverPreviewDelayMs}
          onChange={(e) =>
            onSaveSetting(
              "hoverPreviewDelayMs",
              clampHoverPreviewDelayMs(Number(e.target.value)),
            )
          }
        />
      </label>

      <label className="setting-field">
        <span>
          <strong>Pencil width</strong>
          <small>Snip annotation stroke width multiplier.</small>
        </span>
        <input
          type="number"
          min={MIN_SNIP_PENCIL_WIDTH}
          max={MAX_SNIP_PENCIL_WIDTH}
          step={0.25}
          value={settings.snipPencilWidth}
          onChange={(e) =>
            onSaveSetting(
              "snipPencilWidth",
              clampSnipPencilWidth(Number(e.target.value)),
            )
          }
        />
      </label>

      <label className="setting-field">
        <span>
          <strong>History limit</strong>
          <small>Number of clipboard rows to load.</small>
        </span>
        <input
          type="number"
          min={10}
          max={200}
          value={settings.historyLimit}
          onChange={(e) => {
            const value = Math.min(
              Math.max(Number(e.target.value) || 50, 10),
              200,
            );
            onSaveSetting("historyLimit", value);
            onLoadHistory(value);
          }}
        />
      </label>

      <label className="setting-field">
        <span>
          <strong>Window width</strong>
          <small>Poplet window width in pixels.</small>
        </span>
        <input
          type="number"
          min={MIN_WINDOW_WIDTH}
          max={MAX_WINDOW_WIDTH}
          step={10}
          value={settings.windowWidth}
          onChange={(e) =>
            onSaveSetting(
              "windowWidth",
              clampWindowWidth(Number(e.target.value)),
            )
          }
        />
      </label>

      <label className="setting-field">
        <span>
          <strong>Window height</strong>
          <small>Poplet window height in pixels.</small>
        </span>
        <input
          type="number"
          min={MIN_WINDOW_HEIGHT}
          max={MAX_WINDOW_HEIGHT}
          step={10}
          value={settings.windowHeight}
          onChange={(e) =>
            onSaveSetting(
              "windowHeight",
              clampWindowHeight(Number(e.target.value)),
            )
          }
        />
      </label>

      <label className="setting-field">
        <span>
          <strong>Hide delay</strong>
          <small>Grace period after focus loss, in milliseconds.</small>
        </span>
        <input
          type="number"
          min={0}
          max={2000}
          step={50}
          value={settings.hideOnBlurDelayMs}
          onChange={(e) =>
            onSaveSetting(
              "hideOnBlurDelayMs",
              Math.min(Math.max(Number(e.target.value) || 0, 0), 2000),
            )
          }
        />
      </label>
    </div>
  );
}
