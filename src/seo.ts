import type { CheerioAPI } from "cheerio";

export interface SeoObservation {
  url: string;
  kind:
    | "missing-title"
    | "empty-title"
    | "missing-description"
    | "empty-description"
    | "missing-h1"
    | "multiple-h1"
    | "indexing-directives"
    | "missing-canonical"
    | "conflicting-canonicals"
    | "broken-canonical";
  severity: "error" | "warning" | "info";
  evidence: string;
  /** '*' denotes generic directives, not an assertion of indexing intent. */
  scope?: string;
  source?: "meta" | "header";
}

export interface PageMetadata {
  url: string;
  titles: string[];
  descriptions: string[];
}
export interface DuplicateMetadata {
  kind: "duplicate-title" | "duplicate-description";
  severity: "warning";
  scope: "within-this-run";
  value: string;
  pages: { url: string; values: string[] }[];
}

/** The caller establishes successful HTML eligibility and crawl-identity uniqueness. */
export function readMetadata(html: CheerioAPI, url: string): PageMetadata {
  return {
    url,
    titles: html("title")
      .toArray()
      .filter((element) => element.namespace === "http://www.w3.org/1999/xhtml")
      .map((element) => html(element).text()),
    descriptions: html("meta[name]")
      .toArray()
      .filter((element) => html(element).attr("name")?.toLowerCase() === "description")
      .map((element) => html(element).attr("content") ?? ""),
  };
}

export function duplicateMetadata(pages: PageMetadata[]): DuplicateMetadata[] {
  const duplicates: DuplicateMetadata[] = [];
  for (const [field, kind] of [
    ["titles", "duplicate-title"],
    ["descriptions", "duplicate-description"],
  ] as const) {
    const groups = new Map<string, Map<string, string[]>>();
    for (const page of pages) {
      for (const raw of page[field]) {
        const value = raw.trim().replaceAll(/\s+/gu, " ");
        if (!value) continue;
        let group = groups.get(value);
        if (!group) groups.set(value, (group = new Map<string, string[]>()));
        const values = group.get(page.url) ?? [];
        values.push(raw);
        group.set(page.url, values);
      }
    }
    for (const [value, group] of groups) {
      if (group.size < 2) continue;
      duplicates.push({
        kind,
        severity: "warning",
        scope: "within-this-run",
        value,
        pages: [...group].map(([url, values]) => ({ url, values })),
      });
    }
  }
  return duplicates;
}

/** Page-local evidence only; the caller establishes successful HTML eligibility. */
export function inspectSeo(
  html: CheerioAPI,
  url: string,
  indexingHeaders: string[],
): SeoObservation[] {
  const observations: SeoObservation[] = [];
  const { titles, descriptions } = readMetadata(html, url);
  for (const [field, values, severity] of [
    ["title", titles, "warning"],
    ["description", descriptions, "info"],
  ] as const) {
    if (values.length === 0) {
      observations.push({
        url,
        kind: `missing-${field}`,
        severity,
        evidence: `No ${field} declaration found.`,
      });
    } else if (values.some((value) => value.trim() === "")) {
      observations.push({
        url,
        kind: `empty-${field}`,
        severity,
        evidence: `${field} declarations: ${JSON.stringify(values)}`,
      });
    }
  }
  const headings = html("h1")
    .toArray()
    .map((element) => html(element).text());
  if (headings.length === 0 || headings.length > 1) {
    observations.push({
      url,
      kind: headings.length === 0 ? "missing-h1" : "multiple-h1",
      severity: "warning",
      evidence: `Found ${headings.length} H1 headings: ${JSON.stringify(headings)}`,
    });
  }
  for (const element of html("meta[name]").toArray()) {
    const name = html(element).attr("name")!;
    const content = html(element).attr("content");
    const crawlerName =
      /^(?:robots|.*bot.*|.*spider.*|.*crawler.*|slurp|yandex|googleother(?:-.*)?)$/iu.test(name);
    // Unknown scopes need explicit robots syntax, not incidental words in prose.
    // Ambiguous words such as 'all', 'none', 'index' or 'follow' alone are insufficient.
    const descriptiveName =
      /^(?:description|keywords|author|generator|application-name|viewport|theme-color|color-scheme|referrer)$/iu.test(
        name,
      );
    const tokens = (content ?? "").split(",").map((token) => token.trim());
    const indexingContent =
      tokens.every((token) =>
        /^(?:all|none|index|noindex|follow|nofollow|noarchive|nocache|nosnippet|noimageindex|notranslate|indexifembedded|(?:max-snippet|max-image-preview|max-video-preview|unavailable_after)\s*:.+)$/iu.test(
          token,
        ),
      ) &&
      tokens.some((token) =>
        /^(?:noindex|nofollow|noarchive|nocache|nosnippet|noimageindex|notranslate|indexifembedded|max-[\w-]+\s*:|unavailable_after\s*:)/iu.test(
          token,
        ),
      );
    if (!crawlerName && (descriptiveName || !indexingContent)) continue;
    observations.push({
      url,
      kind: "indexing-directives",
      severity: "info",
      source: "meta",
      scope: name.toLowerCase() === "robots" ? "*" : name,
      evidence: `Meta name=${JSON.stringify(name)} content=${html(element).attr("content") ?? "(missing content attribute)"}`,
    });
  }
  for (const header of indexingHeaders) {
    let scope = "*";
    let directives: string[] = [];
    const record = () =>
      observations.push({
        url,
        kind: "indexing-directives",
        severity: "info",
        source: "header",
        scope,
        evidence: `X-Robots-Tag: ${directives.join(", ")} (header: ${header})`,
      });
    for (const token of header.split(",")) {
      // Value-bearing directives are not user-agent scope prefixes.
      const scoped =
        /^(?!(?:unavailable_after|max-snippet|max-image-preview|max-video-preview)\s*:)([a-z][\w.-]*)\s*:\s*(.*)$/iu.exec(
          token.trim(),
        );
      if (scoped) {
        if (directives.length > 0) record();
        scope = scoped[1]!;
        directives = [scoped[2]!];
      } else directives.push(token.trim());
    }
    record();
  }
  return observations;
}
