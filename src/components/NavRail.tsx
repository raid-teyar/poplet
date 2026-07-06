import { Scissors, PencilRuler } from "lucide-react";
import { NAV_SECTIONS } from "../nav";
import type { Tab } from "../types";

interface NavRailProps {
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
  onSnip: () => void;
  onOpenEditor: () => void;
}

/// Left navigation rail: the two capture/create actions (Snip, Editor) sit at
/// the top, then the content sections, then Settings pinned to the bottom.
/// Every item shows an icon + label so nothing needs guessing.
export default function NavRail({
  activeTab,
  onSelect,
  onSnip,
  onOpenEditor,
}: NavRailProps) {
  const sections = NAV_SECTIONS.filter((s) => s.id !== "settings");
  const settings = NAV_SECTIONS.find((s) => s.id === "settings")!;
  const SettingsIcon = settings.icon;

  return (
    <nav className="nav-rail">
      <div className="nav-sections">
        <button
          className="nav-item nav-action"
          onClick={onSnip}
          title="Snip a screen area"
        >
          <Scissors size={18} />
          <span className="nav-item-label">Snip</span>
        </button>
        <button
          className="nav-item nav-action"
          onClick={onOpenEditor}
          title="Open editor — load image or blank canvas"
        >
          <PencilRuler size={18} />
          <span className="nav-item-label">Editor</span>
        </button>

        <div className="nav-divider" />

        {sections.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${activeTab === id ? "active" : ""}`}
            onClick={() => onSelect(id)}
            title={label}
          >
            <Icon size={18} />
            <span className="nav-item-label">{label}</span>
          </button>
        ))}
      </div>

      <button
        className={`nav-item nav-item-settings ${
          activeTab === "settings" ? "active" : ""
        }`}
        onClick={() => onSelect("settings")}
        title="Settings"
      >
        <SettingsIcon size={18} />
        <span className="nav-item-label">Settings</span>
      </button>
    </nav>
  );
}
