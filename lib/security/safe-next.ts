const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Returns `value` only when it is a same-origin relative path (single leading `/`, no `//`,
 * no `\`, no control characters); anything else yields `/` so login cannot be an open redirect.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || CONTROL_CHARS.test(value)) return "/";
  return value;
}
