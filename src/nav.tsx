import {
  History,
  Smile,
  Image as ImageIcon,
  StickyNote,
  FolderKanban,
  KeyRound,
  Settings,
} from "lucide-react";
import type { Tab } from "./types";

export interface KeyHint {
  keys: string;
  label: string;
}

export interface NavSection {
  id: Tab;
  label: string;
  icon: typeof History;
  /** Context key hints shown in the footer for this section. Keep truthful. */
  hints: KeyHint[];
}

/// Single source of truth for the left rail, the footer hint bar, and the
/// Tab-key section cycle. Order here IS the rail order and the cycle order.
export const NAV_SECTIONS: NavSection[] = [
  {
    id: "history",
    label: "History",
    icon: History,
    hints: [
      { keys: "↑↓", label: "navigate" },
      { keys: "↵", label: "paste" },
    ],
  },
  {
    id: "emoji",
    label: "Emoji",
    icon: Smile,
    hints: [{ keys: "Type", label: "search" }],
  },
  {
    id: "gif",
    label: "GIFs",
    icon: ImageIcon,
    hints: [{ keys: "Type", label: "search" }],
  },
  {
    id: "notes",
    label: "Notes",
    icon: StickyNote,
    hints: [{ keys: "Type", label: "filter notes" }],
  },
  {
    id: "projects",
    label: "Projects",
    icon: FolderKanban,
    hints: [{ keys: "Click", label: "open in editor" }],
  },
  {
    id: "vault",
    label: "Vault",
    icon: KeyRound,
    hints: [{ keys: "Click", label: "copy secret" }],
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    hints: [],
  },
];

/// The Tab-key cycle order (all sections, matching the rail).
export const SECTION_ORDER: Tab[] = NAV_SECTIONS.map((s) => s.id);
