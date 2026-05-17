import { useEffect, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import type { HistoryItem, ImagePreview } from "../../types";
import { imageReferenceFromText, detectFilePath } from "../../utils";

function imageSrcFromText(content: string): string | null {
  const candidate = imageReferenceFromText(content);
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate) || /^data:image\//i.test(candidate)) {
    return candidate;
  }
  if (/^file:\/\//i.test(candidate)) {
    return convertFileSrc(decodeURI(candidate.replace(/^file:\/\//i, "")));
  }
  if (/^\/.*\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(candidate)) {
    return convertFileSrc(candidate);
  }
  return null;
}

function isImageItem(item: HistoryItem): boolean {
  if (item.image_path) return true;
  return imageSrcFromText(item.content) !== null;
}

type HistoryGroup =
  | { type: "images"; items: { item: HistoryItem; index: number }[] }
  | { type: "other"; items: { item: HistoryItem; index: number }[] };

function groupHistoryItems(items: HistoryItem[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isImage = isImageItem(item);
    const groupType = isImage ? "images" : "other";
    const last = groups[groups.length - 1];

    if (!last || last.type !== groupType) {
      groups.push({ type: groupType, items: [{ item, index: i }] });
    } else {
      last.items.push({ item, index: i });
    }
  }

  return groups;
}

interface HistoryTabProps {
  history: HistoryItem[];
  filteredHistory: HistoryItem[];
  selectedIndex: number;
  onSelect: (item: HistoryItem) => void;
  onClear: () => void;
  onPreview: (preview: ImagePreview | null) => void;
  previewDelayMs: number;
}

export default function HistoryTab({
  history,
  filteredHistory,
  selectedIndex,
  onSelect,
  onClear,
  onPreview,
  previewDelayMs,
}: HistoryTabProps) {
  const groups = useMemo(
    () => groupHistoryItems(filteredHistory),
    [filteredHistory],
  );

  return (
    <div className="history-list">
      {history.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "4px 8px",
          }}
        >
          <button
            onClick={onClear}
            title="Clear all history"
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.5)",
              cursor: "pointer",
              padding: "4px 8px",
              borderRadius: "4px",
              display: "flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "12px",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = "rgba(255,200,200,1)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "rgba(255,255,255,0.5)")
            }
          >
            <Trash2 size={12} />
            Clear
          </button>
        </div>
      )}
      {filteredHistory.length === 0 && (
        <p
          style={{
            padding: "20px",
            color: "rgba(255,255,255,0.4)",
            textAlign: "center",
            fontSize: "13px",
          }}
        >
          {history.length === 0 ? "No history yet" : "No matches"}
        </p>
      )}
      {groups.map((group, gi) => {
        if (group.type === "images") {
          return (
            <div key={gi} className="history-image-grid">
              {group.items.map(({ item, index }) => (
                <HistoryRow
                  key={item.id}
                  item={item}
                  selected={index === selectedIndex}
                  onSelect={() => onSelect(item)}
                  onPreview={onPreview}
                  previewDelayMs={previewDelayMs}
                />
              ))}
            </div>
          );
        }
        return group.items.map(({ item, index }) => (
          <HistoryRow
            key={item.id}
            item={item}
            selected={index === selectedIndex}
            onSelect={() => onSelect(item)}
            onPreview={onPreview}
            previewDelayMs={previewDelayMs}
          />
        ));
      })}
    </div>
  );
}

function HistoryRow({
  item,
  selected,
  onSelect,
  onPreview,
  previewDelayMs,
}: {
  item: HistoryItem;
  selected: boolean;
  onSelect: () => void;
  onPreview: (preview: ImagePreview | null) => void;
  previewDelayMs: number;
}) {
  const previewTimerRef = useRef<number | null>(null);
  const textImageSrc = item.image_path ? null : imageSrcFromText(item.content);
  const imageSrc = item.image_path
    ? convertFileSrc(item.image_path)
    : textImageSrc;
  const isImageLike = Boolean(imageSrc);
  const detectedFile = !isImageLike ? detectFilePath(item.content) : null;

  const clearPreviewTimer = () => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  };

  useEffect(() => clearPreviewTimer, []);

  return (
    <div
      className={`history-item ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onMouseLeave={() => {
        clearPreviewTimer();
        onPreview(null);
      }}
    >
      {isImageLike && imageSrc ? (
        <>
          <img
            src={imageSrc}
            alt="clipboard image"
            className="history-image"
            onMouseEnter={(e) => {
              const img = e.currentTarget;
              clearPreviewTimer();
              previewTimerRef.current = window.setTimeout(() => {
                onPreview({
                  src: imageSrc,
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                });
              }, previewDelayMs);
            }}
          />
          <div className="history-meta">
            {item.image_path ? "Image" : "Image link"}
          </div>
        </>
      ) : detectedFile ? (
        <>
          <div className="history-file">
            <span className="file-ext-badge">{detectedFile.extension}</span>
            <span className="file-name">{detectedFile.filename}</span>
          </div>
          <div className="history-meta">{detectedFile.path}</div>
        </>
      ) : (
        <>
          <div className="history-text">{item.content}</div>
          <div className="history-meta">Text</div>
        </>
      )}
    </div>
  );
}
