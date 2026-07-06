import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type Tone = "default" | "accent" | "success" | "warning" | "danger";

export function Badge({
  tone = "default",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return <span className={cx("ui-badge", `ui-badge--${tone}`, className)}>{children}</span>;
}

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function Chip({ active, className, children, ...rest }: ChipProps) {
  return (
    <button className={cx("ui-chip", active && "is-active", className)} {...rest}>
      {children}
    </button>
  );
}

export function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("ui-panel", className)}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="ui-empty">{children}</p>;
}
