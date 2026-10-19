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

/**
 * Archived Markdown as HTML: GitHub-flavoured Markdown (tables, strike-through, task lists). Raw HTML in the archive
 * is dropped (`skipHtml`), never rendered, and URLs pass the default transform (no `javascript:` or `data:` links).
 */
export function ArchiveMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="archive-markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={defaultUrlTransform} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
