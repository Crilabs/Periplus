// The package ships no types; only the combined GFM plugin is used.
declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export const gfm: TurndownService.Plugin;
}
