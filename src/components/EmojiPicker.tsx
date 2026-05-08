import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import emojiGroups from "unicode-emoji-json/data-by-group.json";

interface Emoji {
  emoji: string;
  name: string;
  slug: string;
}

interface Group {
  name: string;
  slug: string;
  emojis: Emoji[];
}

const GROUPS = emojiGroups as Group[];

interface Props {
  searchQuery: string;
}

export default function EmojiPicker({ searchQuery }: Props) {
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({
      ...g,
      emojis: g.emojis.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.slug.toLowerCase().includes(q),
      ),
    })).filter((g) => g.emojis.length > 0);
  }, [searchQuery]);

  const handleSelect = async (emoji: string) => {
    await writeText(emoji);
    await invoke("perform_paste");
  };

  return (
    <div
      className="emoji-picker"
      style={{ padding: "8px", overflowY: "auto", maxHeight: "100%" }}
    >
      {filteredGroups.length === 0 && (
        <div
          style={{
            textAlign: "center",
            color: "rgba(255,255,255,0.4)",
            fontSize: "13px",
            padding: "20px",
          }}
        >
          No emojis match "{searchQuery}"
        </div>
      )}
      {filteredGroups.map((group) => (
        <div key={group.slug} style={{ marginBottom: "12px" }}>
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "rgba(255,255,255,0.5)",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              padding: "4px 6px",
              position: "sticky",
              top: 0,
              background: "rgba(20,20,20,0.85)",
              backdropFilter: "blur(8px)",
              zIndex: 1,
            }}
          >
            {group.name}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(8, 1fr)",
              gap: "4px",
              padding: "4px",
            }}
          >
            {group.emojis.map((e) => (
              <button
                key={e.slug}
                title={e.name}
                onClick={() => handleSelect(e.emoji)}
                style={{
                  fontSize: "22px",
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: "6px",
                  borderRadius: "6px",
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily:
                    '"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif',
                  transition: "background 0.15s",
                }}
                onMouseEnter={(ev) =>
                  (ev.currentTarget.style.background =
                    "rgba(255,255,255,0.1)")
                }
                onMouseLeave={(ev) =>
                  (ev.currentTarget.style.background = "transparent")
                }
              >
                {e.emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
