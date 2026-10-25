/** The first ATX heading of the Markdown, as the document title. */
export function titleOf(md: string): string | null {
  const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(md);
  return m ? m[1]!.trim() : null;
}
