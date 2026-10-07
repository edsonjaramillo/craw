import robotsParser from "robots-parser";

import { validateAuditConfig } from "./audit-config";
import { persistRun, renderReport, type AuditRun, type DestinationResult } from "./audit-results";
import { createGuardedFetch, RunLimitReached } from "./guarded-fetch";
import { followRedirects, RedirectFailure } from "./guarded-redirects";
import {
  DestinationRefused,
  productionTransport,
  publicDns,
  responseHeaderValues,
  validateDestinationUrl,
  type AuditDns,
  type AuditTransport,
} from "./guarded-transport";
import { HtmlInspectionUnavailable, readHtml } from "./html";
import { crawlIdentity, inBoundary, navigationLinks, traverse } from "./navigation";
import { readRobots } from "./robots-body";
import { duplicateMetadata, inspectSeo, readMetadata, type PageMetadata } from "./seo";

class RobotsAccessDenied extends Error {
  constructor(
    public readonly outcome: "robots-excluded" | "robots-unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface AuditClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}
export const systemClock: AuditClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Sleep aborted", { cause: signal.reason }));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("Sleep aborted", { cause: signal.reason }));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", abort, { once: true });
    }),
};
export interface AuditDependencies {
  dns?: AuditDns;
  transport?: AuditTransport;
  clock?: AuditClock;
  databasePath?: string;
  reportPath?: string;
}
export interface AuditResult {
  run: AuditRun;
  report: string;
  reportPath: string;
}

/** Every dispatch, including discovery, robots and redirects, goes through the public guard. */
export async function runAudit(
  input: unknown,
  dependencies: AuditDependencies = {},
): Promise<AuditResult> {
  const configuration = validateAuditConfig(input);
  const clock = dependencies.clock ?? systemClock;
  const dns = dependencies.dns ?? publicDns;
  const transport = dependencies.transport ?? productionTransport;
  const start = clock.now();
  const url = new URL(configuration.startUrl);
  url.hash = "";
  const startingDestination: DestinationResult = {
    url: url.href,
    crawlIdentity: crawlIdentity(url.href, configuration),
    outcome: "inconclusive",
    evidence: "No response established.",
    redirects: [],
  };
  const destinations: DestinationResult[] = [];
  const pages: AuditRun["pages"] = [];
  const links: AuditRun["links"] = [];
  const observations: AuditRun["observations"] = [];
  const metadata: PageMetadata[] = [];
  const limitations: string[] = [];
  const expanded = new Set<string>();
  let checked = 0;
  let executionStatus: AuditRun["executionStatus"] = "completed";
  const fetchGuarded = createGuardedFetch(configuration, clock, dns, transport, start);
  const policies = new Map<
    string,
    { status: number; attempts: number; parser?: ReturnType<typeof robotsParser> }
  >();
  async function authorize(target: URL) {
    validateDestinationUrl(target);
    const robotsUrl = new URL("/robots.txt", target);
    let policy = policies.get(target.origin);
    if (!policy) {
      try {
        const { value: robots, attempts } = await followRedirects(
          robotsUrl,
          fetchGuarded,
          configuration.requests.maxRedirectHops,
          async (response, signal) => ({
            status: response.status,
            ok: response.ok,
            text: response.ok ? await readRobots(response, signal) : "",
          }),
          [],
        );
        policy = {
          status: robots.status,
          attempts,
          ...(robots.ok ? { parser: robotsParser(robotsUrl.href, robots.text) } : {}),
        };
        policies.set(target.origin, policy);
      } catch (error) {
        if (error instanceof DestinationRefused || error instanceof RunLimitReached) throw error;
        throw new RobotsAccessDenied(
          "robots-unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (policy.status === 404 || policy.status === 410) return;
    if (
      policy.parser &&
      policy.parser.isAllowed(target.href, configuration.crawlerIdentity) !== false
    )
      return;
    throw new RobotsAccessDenied(
      policy.parser || policy.status === 401 || policy.status === 403
        ? "robots-excluded"
        : "robots-unavailable",
      `Robots rules prevented access to ${target.href} (HTTP ${policy.status} after ${policy.attempts} attempts).`,
    );
  }
  async function visit(
    destination: DestinationResult,
    depth: number,
    enqueue: (url: string, depth: number) => Promise<void>,
  ) {
    destinations.push(destination);
    if (checked >= configuration.limits.maxDestinations) {
      executionStatus = "limit-stopped";
      destination.outcome = "limit-stopped";
      destination.evidence = "Checked-destination budget excluded this destination.";
      limitations.push(`${destination.url}: ${destination.evidence}`);
      return;
    }
    checked++;
    let html: Awaited<ReturnType<typeof readHtml>> | undefined;
    let indexingHeaders: string[] = [];
    try {
      const { value: response, attempts } = await followRedirects(
        new URL(destination.url),
        fetchGuarded,
        configuration.requests.maxRedirectHops,
        async (incoming, signal, finalUrl) => {
          destination.finalUrl = finalUrl.href;
          destination.responseHeaders = Object.fromEntries(incoming.headers);
          indexingHeaders = responseHeaderValues(incoming, "x-robots-tag");
          const identity = crawlIdentity(finalUrl.href, configuration);
          const eligible =
            incoming.ok &&
            inBoundary(new URL(destination.url), configuration) &&
            inBoundary(finalUrl, configuration) &&
            /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/iu.test(
              incoming.headers.get("content-type") ?? "",
            ) &&
            !expanded.has(identity);
          if (eligible) {
            if (
              depth > configuration.limits.maxDepth ||
              pages.length >= configuration.limits.maxPages
            ) {
              executionStatus = "limit-stopped";
              limitations.push(
                `${finalUrl.href}: ${depth > configuration.limits.maxDepth ? "HTML-link depth" : "Page"} budget excluded expansion and SEO eligibility.`,
              );
            } else {
              try {
                html = await readHtml(incoming, signal);
              } catch (error) {
                if (!(error instanceof HtmlInspectionUnavailable)) throw error;
                limitations.push(
                  `${finalUrl.href}: HTML discovery and SEO eligibility unavailable: ${error.message}`,
                );
              }
            }
          }
          return {
            status: incoming.status,
            ok: incoming.ok,
            location: incoming.headers.get("location"),
          };
        },
        destination.redirects!,
        authorize,
      );
      destination.status = response.status;
      destination.outcome =
        response.status === 404 || response.status === 410
          ? "confirmed-broken"
          : response.ok
            ? "successful"
            : response.status >= 500
              ? "server-error"
              : response.status === 401 || response.status === 403
                ? "inaccessible"
                : response.status === 408 || response.status === 429
                  ? "inconclusive"
                  : response.status >= 300 && response.status < 400
                    ? "redirect-not-followed"
                    : "client-error";
      destination.evidence = `GET response health evidence: HTTP ${response.status} after ${attempts} attempts at the final destination. ${html === undefined ? "HTML body inspection was not completed; download integrity was not checked." : "Successful in-boundary HTML inspected for navigation links."}`;
      if (destination.outcome === "redirect-not-followed")
        destination.evidence += ` Redirect was not followed${response.location === null ? "." : `: ${response.location}`}`;
    } catch (error) {
      if (error instanceof RunLimitReached) executionStatus = "limit-stopped";
      destination.outcome =
        error instanceof RunLimitReached
          ? "limit-stopped"
          : error instanceof DestinationRefused
            ? "refused"
            : error instanceof RobotsAccessDenied || error instanceof RedirectFailure
              ? error.outcome
              : "inconclusive";
      destination.evidence = error instanceof Error ? error.message : String(error);
    }
    if (
      destination.outcome !== "successful" &&
      destination.outcome !== "confirmed-broken" &&
      destination.outcome !== "server-error" &&
      destination.outcome !== "client-error"
    )
      limitations.push(`${destination.url}: ${destination.outcome}: ${destination.evidence}`);
    if (html !== undefined && destination.outcome === "successful") {
      const pageUrl = destination.finalUrl!;
      const identity = crawlIdentity(pageUrl, configuration);
      expanded.add(identity);
      pages.push({ url: pageUrl, crawlIdentity: identity, depth, seoEligible: true });
      observations.push(...inspectSeo(html, pageUrl, indexingHeaders));
      metadata.push(readMetadata(html, pageUrl));
      for (const link of navigationLinks(html, pageUrl)) {
        links.push({ sourceUrl: pageUrl, ...link });
        await enqueue(link.destinationUrl, depth + 1);
      }
    }
  }
  try {
    await traverse(url.href, async (target, depth, enqueue) => {
      await visit(
        target === startingDestination.url
          ? startingDestination
          : {
              url: target,
              crawlIdentity: crawlIdentity(target, configuration),
              outcome: "inconclusive",
              evidence: "No response established.",
              redirects: [],
            },
        depth,
        enqueue,
      );
    });
  } catch (error) {
    executionStatus = "failed";
    limitations.push(
      `Fatal traversal failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const run: AuditRun = {
    id: crypto.randomUUID(),
    configuration,
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date(clock.now()).toISOString(),
    executionStatus,
    destination: startingDestination,
    destinations,
    pages,
    links,
    observations,
    duplicateMetadata: duplicateMetadata(metadata),
    limitations,
  };
  const databasePath = dependencies.databasePath ?? "audit.sqlite";
  const reportPath = dependencies.reportPath ?? "audit-report.html";
  try {
    persistRun(databasePath, run);
    const report = renderReport(run);
    await Bun.write(reportPath, report);
    return { run, report, reportPath };
  } catch (error) {
    run.executionStatus = "failed";
    run.finishedAt = new Date(clock.now()).toISOString();
    run.limitations.push(
      `Fatal artifact failure: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Keep the original fatal error, while preserving each artifact independently when possible.
    try {
      persistRun(databasePath, run);
    } catch {
      /* Storage itself may be unavailable. */
    }
    try {
      await Bun.write(reportPath, renderReport(run));
    } catch {
      /* The report path may also be unavailable. */
    }
    throw error;
  }
}
