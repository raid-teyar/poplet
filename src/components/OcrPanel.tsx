import { Copy, ScanText, X } from "lucide-react";

interface OcrPanelProps {
  text: string;
  loading: boolean;
  error: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
  onChangeText: (text: string) => void;
}

/// The extracted-text side panel for the snip editor's OCR action. Purely
/// presentational — recognition and clipboard side effects live in SnipEditor.
export default function OcrPanel({
  text,
  loading,
  error,
  copied,
  onCopy,
  onClose,
  onChangeText,
}: OcrPanelProps) {
  return (
    <div className="ocr-panel">
      <div className="ocr-panel-header">
        <span>
          <ScanText size={13} /> Extracted text
        </span>
        <div className="ocr-panel-actions">
          <button
            className="snip-tool-btn"
            onClick={onCopy}
            disabled={!text || loading}
            title="Copy all"
          >
            <Copy size={13} />
          </button>
          <button
            className="snip-tool-btn"
            onClick={onClose}
            title="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {loading ? (
        <p className="ocr-status">Recognizing…</p>
      ) : error ? (
        <p className="ocr-status error-state">{error}</p>
      ) : (
        <textarea
          className="ocr-text"
          value={text}
          onChange={(e) => onChangeText(e.target.value)}
          placeholder="No text found."
          spellCheck={false}
        />
      )}
      {copied && <span className="ocr-copied">Copied!</span>}
    </div>
  );
}
