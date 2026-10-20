"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, cx, type Size, type Variant } from "./button-class";

/**
 * The admin's button. A submit button disables itself while its form's action runs (`useFormStatus`), so a double
 * click or a repeated decision key never submits twice (gesamt review UI-9); outside a form it is a plain button.
 */
export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "submit",
  disabled,
  ...rest
}: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  const { pending } = useFormStatus();
  const busy = type === "submit" && pending;
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(buttonClass(variant, size), className)}
      {...rest}
    />
  );
}
