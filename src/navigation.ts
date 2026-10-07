import { CheerioCrawler, Configuration, type CheerioCrawlingContext } from "@crawlee/cheerio";
import type { CheerioAPI } from "cheerio";

import type { AuditConfig } from "./audit-config";

/**
 * Use the required CheerioCrawler queue/lifecycle without its HTTP client or automatic redirects.
 * Its protected handler is the adapter boundary: navigation hooks cannot safely replace the
 * underlying pinned connection and bounded redirect/robots pipeline. Keep this override narrow;
 * full-run transport/scheduling tests guard against changes to Crawlee's lifecycle on upgrades.
 */
class GuardedCheerioCrawler extends CheerioCrawler {
  constructor(private readonly visit: (context: CheerioCrawlingContext) => Promise<void>) {
    super(
      {
        maxConcurrency: 1,
        maxRequestRetries: 0,
        useSessionPool: false,
        // Guarded fetching owns timeouts (including injected clocks); Crawlee must not race it.
        requestHandlerTimeoutSecs: 2_147_400,
        requestHandler: () => Promise.resolve(),
        failedRequestHandler: (_context, error) => Promise.reject(error),
      },
      new Configuration({
        persistStorage: false,
        storageClientOptions: { persistStorage: false },
        defaultRequestQueueId: crypto.randomUUID(),
        logLevel: 0,
      }),
    );
  }
  protected override async _runRequestHandler(context: CheerioCrawlingContext) {
    await this.visit(context);
  }
}

export async function traverse(
  startUrl: string,
  visit: (
    url: string,
    depth: number,
    enqueue: (url: string, depth: number) => Promise<void>,
  ) => Promise<void>,
) {
  const depths = new Map([[startUrl, 0]]);
  const seeds: { url: string; uniqueKey: string }[] = [];
  // Bootstrap promptly at the audit-run seam, before Crawlee's asynchronous storage lifecycle.
  // This keeps injected-clock request deadlines independent of queue initialization latency.
  await visit(startUrl, 0, (url, depth) => {
    if (!depths.has(url)) {
      depths.set(url, depth);
      seeds.push({ url, uniqueKey: url });
    }
    return Promise.resolve();
  });
  if (seeds.length === 0) return;
  const crawler = new GuardedCheerioCrawler(async ({ request }) => {
    await visit(request.url, depths.get(request.url)!, async (url, depth) => {
      if (depths.has(url)) return;
      depths.set(url, depth);
      await crawler.addRequests([{ url, uniqueKey: url }]);
    });
  });
  await crawler.run(seeds);
}

export function inBoundary(url: URL, configuration: AuditConfig): boolean {
  const path = configuration.pathRestriction?.replace(/\/+$/u, "") ?? "";
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.port === "" &&
    url.hostname === new URL(configuration.startUrl).hostname &&
    (path === "" || url.pathname === path || url.pathname.startsWith(`${path}/`))
  );
}

export function crawlIdentity(url: string, configuration: AuditConfig): string {
  const identity = new URL(url);
  // Do not reserialize untouched queries: URLSearchParams also changes encoding and whitespace.
  if (configuration.trackingParameterExclusions.length > 0) {
    const parameters = identity.search.slice(1).split("&");
    const retained = parameters.filter((parameter) => {
      const key = new URLSearchParams(parameter).keys().next().value;
      return key === undefined || !configuration.trackingParameterExclusions.includes(key);
    });
    if (retained.length !== parameters.length) identity.search = retained.join("&");
  }
  identity.hash = "";
  return identity.href;
}

export function htmlBase($: CheerioAPI, pageUrl: string): string {
  let base = pageUrl;
  for (const element of $("base[href]").toArray()) {
    try {
      const candidate = new URL($(element).attr("href")!, pageUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") {
        base = candidate.href;
        break;
      }
    } catch {
      /* Ignore malformed base declarations. */
    }
  }
  return base;
}

export function navigationLinks(
  $: CheerioAPI,
  pageUrl: string,
): { href: string; destinationUrl: string }[] {
  const base = htmlBase($, pageUrl);
  return $("a[href], area[href]")
    .toArray()
    .flatMap((element) => {
      const href = $(element).attr("href")!;
      try {
        const destination = new URL(href, base);
        if (destination.protocol !== "http:" && destination.protocol !== "https:") return [];
        destination.hash = "";
        return [{ href, destinationUrl: destination.href }];
      } catch {
        return [];
      }
    });
}
