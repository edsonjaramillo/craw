import robotsParser from "robots-parser";

import { validateAuditConfig } from "./audit-config";
import { persistRun, renderReport, type AuditRun, type DestinationResult } from "./audit-results";
import { createGuardedFetch, RunLimitReached } from "./guarded-fetch";
import { followRedirects, RedirectFailure } from "./guarded-redirects";
import {
  DestinationRefused,
  productionTransport,
  publicDns,
  validateDestinationUrl,
  type AuditDns,
  type AuditTransport,
} from "./guarded-transport";
import { readRobots } from "./robots-body";

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

/** A single-destination audit. Every dispatch, including robots, goes through the public guard. */
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
  const destination: DestinationResult = {
    url: url.href,
    outcome: "inconclusive",
    evidence: "No response established.",
    redirects: [],
  };
  const limitations = [
    "Only the starting destination was checked; no link discovery or SEO inspection was performed.",
  ];
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
  try {
    const { value: response, attempts } = await followRedirects(
      url,
      fetchGuarded,
      configuration.requests.maxRedirectHops,
      (incoming, _signal, finalUrl) => {
        destination.finalUrl = finalUrl.href;
        destination.responseHeaders = Object.fromEntries(incoming.headers);
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
    destination.evidence = `GET response health evidence: HTTP ${response.status} after ${attempts} attempts at the final destination. Response body was not downloaded; download integrity was not checked.`;
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
    limitations.push(`${destination.outcome}: ${destination.evidence}`);
  const run: AuditRun = {
    id: crypto.randomUUID(),
    configuration,
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date(clock.now()).toISOString(),
    executionStatus,
    destination,
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
