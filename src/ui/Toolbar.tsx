import type { ReactNode } from "react";
import { cx } from "./cx";

export function Toolbar({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("ui-toolbar", className)}>{children}</div>;
}

export function ToolbarDivider() {
  return <span className="ui-toolbar-sep" />;
}
