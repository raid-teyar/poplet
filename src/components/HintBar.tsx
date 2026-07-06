import { NAV_SECTIONS } from "../nav";
import type { Tab } from "../types";

/// Context-sensitive footer showing the key bindings for the current section,
/// plus the always-available Tab cycle. Keyboard discoverability for a
/// keyboard-first launcher.
export default function HintBar({ tab }: { tab: Tab }) {
  const hints = NAV_SECTIONS.find((s) => s.id === tab)?.hints ?? [];
  return (
    <div className="hint-bar">
      {hints.map((h, i) => (
        <span className="hint" key={i}>
          <kbd>{h.keys}</kbd>
          <span className="hint-label">{h.label}</span>
        </span>
      ))}
      <span className="hint hint-global">
        <kbd>Tab</kbd>
        <span className="hint-label">switch section</span>
      </span>
    </div>
  );
}
