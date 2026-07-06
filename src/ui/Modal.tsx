import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";

export function Modal({
  onClose,
  children,
  style,
}: {
  onClose: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="ui-modal-backdrop" onMouseDown={onClose}>
      <div
        className="ui-modal"
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({
  title,
  onClose,
}: {
  title: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className="ui-modal-header">
      <strong>{title}</strong>
      {onClose && (
        <IconButton onClick={onClose} title="Close">
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}

export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="ui-modal-actions">{children}</div>;
}
