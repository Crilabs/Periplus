import type { FetchConfig } from "@/lib/config";
import type { CrawlRules } from "@/lib/domain/sources/crawl-rules";
import type { Transport } from "../http";
import { createFirecrawlConverter } from "./firecrawl";
import { createJinaConverter } from "./jina";
import { createLocalConverter } from "./local";
import type { Converter, ConverterName, RenderPage } from "./types";

export type { Converted, Converter, ConverterName, ConvertInput, RenderPage } from "./types";
export { ConverterServiceError, TargetHttpError } from "./types";
export { htmlToMarkdown } from "./local";
export { BlockedUrlError, isPublicHttpUrl, isPublicUrlLiteral } from "./ssrf";

/** The source's crawl rule unless `auto`, else the per-source decision in `config/fetch.json`, else its default. */
export function resolveConverter(rules: CrawlRules, sourceDomain: string, cfg: FetchConfig): ConverterName {
  if (rules.converter !== "auto") return rules.converter;
  return cfg.converterBySource[sourceDomain] ?? cfg.defaultConverter;
}

/** All three converters; `renderPage` only where a browser runs (the worker), see `createLocalConverter`. */
export function createConverters(deps: { transport: Transport; renderPage?: RenderPage; cfg: FetchConfig }): Record<ConverterName, Converter> {
  return {
    local: createLocalConverter({ renderPage: deps.renderPage, cfg: deps.cfg }),
    jina: createJinaConverter(deps.transport, deps.cfg.jina),
    firecrawl: createFirecrawlConverter(deps.transport, deps.cfg.firecrawl),
  };
}
