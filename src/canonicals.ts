import type { CheerioAPI } from "cheerio";

import { htmlBase } from "./navigation";

export interface CanonicalDeclaration {
  sourceUrl: string;
  href: string | null;
  destinationUrl?: string;
  evidence: string;
}

/** Keep every declaration, including unsupported or unresolved references. */
export function canonicalDeclarations(html: CheerioAPI, sourceUrl: string): CanonicalDeclaration[] {
  const base = htmlBase(html, sourceUrl);
  return html("link[rel]")
    .toArray()
    .filter((element) =>
      (html(element).attr("rel") ?? "").toLowerCase().split(/\s+/u).includes("canonical"),
    )
    .map((element) => {
      const href = html(element).attr("href") ?? null;
      if (href === null)
        return {
          sourceUrl,
          href,
          evidence: "Canonical declaration has no href; target health not established.",
        };
      try {
        const target = new URL(href, base);
        target.hash = "";
        return {
          sourceUrl,
          href,
          destinationUrl: target.href,
          evidence:
            target.protocol === "http:" || target.protocol === "https:"
              ? "Resolved canonical declaration; see destination check evidence."
              : "Unsupported canonical scheme; target health not established.",
        };
      } catch {
        return {
          sourceUrl,
          href,
          evidence: "Canonical URL could not be resolved; target health not established.",
        };
      }
    });
}
