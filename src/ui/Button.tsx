import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cx("ui-btn", `ui-btn--${variant}`, `ui-btn--${size}`, className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  active?: boolean;
}

export function IconButton({
  size = "md",
  active,
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      className={cx(
        "ui-iconbtn",
        `ui-iconbtn--${size}`,
        active && "is-active",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
