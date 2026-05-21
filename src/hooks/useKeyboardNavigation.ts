import { useEffect } from "react";
import type { HistoryItem, Tab } from "../types";

interface KeyboardNavOptions {
  filteredHistory: HistoryItem[];
  selectedIndex: number;
  setSelectedIndex: (fn: (prev: number) => number) => void;
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  snipActive: boolean;
  onEscape: () => void;
  onEnter: () => void;
}

export function useKeyboardNavigation({
  filteredHistory,
  selectedIndex,
  setSelectedIndex,
  activeTab,
  setActiveTab,
  snipActive,
  onEscape,
  onEnter,
}: KeyboardNavOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (snipActive && e.key === "Escape") {
        e.preventDefault();
        onEscape();
      } else if (snipActive) {
        return;
      } else if (e.key === "ArrowDown") {
        setSelectedIndex((prev) =>
          Math.min(prev + 1, filteredHistory.length - 1),
        );
      } else if (e.key === "ArrowUp") {
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        onEnter();
      } else if (e.key === "Tab") {
        e.preventDefault();
        const tabs: Tab[] = ["history", "emoji", "gif", "notes", "settings"];
        const nextIndex = (tabs.indexOf(activeTab) + 1) % tabs.length;
        setActiveTab(tabs[nextIndex]);
        setSelectedIndex(() => 0);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredHistory, selectedIndex, activeTab, snipActive, onEscape, onEnter]);
}
