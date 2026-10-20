import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Links of archived content open outside the admin, without referrer or opener, and earn no ranking. Images load
 * only when scrolled into view and never tell their host which admin page shows them.
 */
const components: Components = {
  img: ({ src, alt, title }) => (
    // eslint-disable-next-line @next/next/no-img-element -- archived third-party images, not optimised app assets
    <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} title={title} referrerPolicy="no-referrer" loading="lazy" />
  ),
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};

/** Reading typography for archived text (the admin has no typography plugin). */
const PROSE = [
  "archive-markdown max-w-[72ch] text-[0.9375rem] leading-7 text-ink break-words",
  "[&>*+*]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold",
  "[&_h3]:mt-6 [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold",
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li+li]:mt-1 [&_li>ul]:mt-1 [&_li>ol]:mt-1",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-4 [&_blockquote]:text-muted",
  "[&_code]:rounded [&_code]:bg-sunken [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.8125rem]",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-sunken [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_hr]:border-line [&_img]:max-w-full [&_img]:rounded-md",
  "[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-sm",
  "[&_th]:border [&_th]:border-line [&_th]:bg-sunken [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1",
].join(" ");

/**
 * Archived Markdown as HTML: GitHub-flavoured Markdown (tables, strike-through, task lists). Raw HTML in the archive
 * is dropped (`skipHtml`), never rendered, and URLs pass the default transform (no `javascript:` or `data:` links).
 */
export function ArchiveMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className={PROSE}>
      <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={defaultUrlTransform} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
