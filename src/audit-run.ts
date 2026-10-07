import robotsParser from "robots-parser";

import { validateAuditConfig } from "./audit-config";
import { persistRun, renderReport, type AuditRun, type DestinationResult } from "./audit-results";
import { createGuardedFetch, RunLimitReached } from "./guarded-fetch";
import {
  DestinationRefused,
  productionTransport,
  publicDns,
  type AuditDns,
  type AuditTransport,
} from "./guarded-transport";
import { readRobots } from "./robots-body";

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
  };
  const limitations = [
    "Only the starting destination was checked; no link discovery or SEO inspection was performed.",
  ];
  let executionStatus: AuditRun["executionStatus"] = "completed";
  const robotsUrl = new URL("/robots.txt", url);
  const fetchGuarded = createGuardedFetch(configuration, clock, dns, transport, start);
  let fetchingRobots = true;
  try {
    const { value: robots, attempts: robotsAttempts } = await fetchGuarded(
      robotsUrl,
      async (response, signal) => ({
        status: response.status,
        ok: response.ok,
        text: response.ok ? await readRobots(response, signal) : "",
      }),
    );
    let allowed = robots.status === 404 || robots.status === 410;
    if (robots.ok)
      allowed =
        robotsParser(robotsUrl.href, robots.text).isAllowed(
          url.href,
          configuration.crawlerIdentity,
        ) !== false;
    if (allowed) {
      fetchingRobots = false;
      const { value: response, attempts } = await fetchGuarded(url, (incoming) => ({
        status: incoming.status,
        ok: incoming.ok,
        location: incoming.headers.get("location"),
      }));
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
      destination.evidence = `GET returned HTTP ${response.status} after ${attempts} attempts. Response body was not downloaded; download integrity was not checked.`;
      if (destination.outcome === "redirect-not-followed")
        destination.evidence += ` Redirect was not followed${response.location === null ? "." : `: ${response.location}`}`;
    } else {
      destination.outcome =
        robots.status === 401 || robots.status === 403 || robots.ok
          ? "robots-excluded"
          : "robots-unavailable";
      destination.evidence = `Robots rules prevented access (HTTP ${robots.status} after ${robotsAttempts} attempts).`;
    }
  } catch (error) {
    if (error instanceof RunLimitReached) executionStatus = "limit-stopped";
    destination.outcome =
      error instanceof RunLimitReached
        ? "limit-stopped"
        : error instanceof DestinationRefused
          ? "refused"
          : fetchingRobots
            ? "robots-unavailable"
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
