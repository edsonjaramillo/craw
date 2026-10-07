import type { AuditConfig } from "./audit-config";
import type { AuditClock } from "./audit-run";
import {
  DestinationRefused,
  validateDestination,
  type AuditDns,
  type AuditTransport,
} from "./guarded-transport";
import { InvalidRobotsRules } from "./robots-body";

export class RunLimitReached extends Error {}

/** A cancellation-aware permit pool. Waiting never counts as a network request. */
function permits(capacity: number) {
  let active = 0;
  const waiting = new Set<() => void>();
  return (signal: AbortSignal): Promise<() => void> =>
    new Promise((resolve, reject) => {
      const cancel = () => {
        waiting.delete(enter);
        signal.removeEventListener("abort", cancel);
        reject(new Error("Scheduling aborted", { cause: signal.reason }));
      };
      const enter = () => {
        if (signal.aborted) {
          cancel();
          return;
        }
        if (active >= capacity) {
          waiting.add(enter);
          return;
        }
        waiting.delete(enter);
        signal.removeEventListener("abort", cancel);
        active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active--;
          for (const next of waiting) {
            next();
            if (active >= capacity) break;
          }
        });
      };
      signal.addEventListener("abort", cancel, { once: true });
      enter();
    });
}

function retryAfterDelay(response: Response, now: number): number {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined) return 0;
  // Date.parse also accepts non-HTTP dates (e.g. "-9999"); those must not become cooldowns.
  const httpDate =
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/u;
  const milliseconds = /^\d+$/u.test(value)
    ? Number(value) * 1000
    : httpDate.test(value)
      ? Date.parse(value) - now
      : 0;
  return Number.isNaN(milliseconds) ? 0 : Math.max(0, milliseconds);
}

/** Shared by robots, retries and future redirect hops; no dispatch can bypass pressure controls. */
export function createGuardedFetch(
  configuration: AuditConfig,
  clock: AuditClock,
  dns: AuditDns,
  transport: AuditTransport,
  startedAt: number,
) {
  const globalPermit = permits(configuration.requests.concurrency);
  const hosts = new Map<
    string,
    {
      acquire: ReturnType<typeof permits>;
      previousStart?: number;
      notBefore: number;
    }
  >();
  const deadline = startedAt + configuration.limits.maxDurationMs;
  function remaining(): number {
    const milliseconds = deadline - clock.now();
    if (milliseconds <= 0) throw new RunLimitReached("Run-duration limit reached.");
    return milliseconds;
  }
  async function bounded<T>(
    budget: number,
    durationLimited: boolean,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timerController = new AbortController();
    const timeout = clock.sleep(budget, timerController.signal).then(() => {
      throw durationLimited
        ? new RunLimitReached("Run-duration limit reached.")
        : new Error("Request timeout; response health is inconclusive.");
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      timerController.abort();
      controller.abort();
    }
  }
  async function wait(milliseconds: number) {
    if (milliseconds > 0) {
      const budget = remaining();
      await bounded(budget, true, (signal) => clock.sleep(Math.min(milliseconds, budget), signal));
    }
    remaining();
  }
  async function attempt<T>(
    url: URL,
    consume: (response: Response, signal: AbortSignal) => T | Promise<T>,
  ) {
    let host = hosts.get(url.hostname);
    if (!host) {
      host = { acquire: permits(1), notBefore: 0 };
      hosts.set(url.hostname, host);
    }
    // Serialize each hostname through consumption; other hostnames can use the global slots.
    const releaseHost = await bounded(remaining(), true, host.acquire);
    let dispatched = false;
    try {
      await wait(
        Math.max(
          host.notBefore,
          (host.previousStart ?? -Infinity) + configuration.requests.hostnameIntervalMs,
        ) - clock.now(),
      );
      const releaseGlobal = await bounded(remaining(), true, globalPermit);
      try {
        const available = remaining();
        return await bounded(
          Math.min(available, configuration.requests.timeoutMs),
          available <= configuration.requests.timeoutMs,
          async (signal) => {
            try {
              const address = await validateDestination(url, dns);
              signal.throwIfAborted();
              host.previousStart = clock.now();
              dispatched = true;
              const response = await transport({
                url,
                address,
                identity: configuration.crawlerIdentity,
                signal,
              });
              try {
                signal.throwIfAborted();
                // Cool down the hostname, not just this caller, including after exhausted retries.
                host.notBefore = Math.max(
                  host.notBefore,
                  clock.now() + retryAfterDelay(response, clock.now()),
                );
                return await consume(response, signal);
              } finally {
                await response.body?.cancel().catch(() => {});
              }
            } finally {
              // Timeout aborts promptly, but capacity belongs to the actual work until cleanup settles.
              releaseGlobal();
              releaseHost();
            }
          },
        );
      } finally {
        // A stalled DNS lookup cannot dispatch after abort, so it need not retain capacity.
        if (!dispatched) releaseGlobal();
      }
    } finally {
      if (!dispatched) releaseHost();
    }
  }
  return async function fetchGuarded<T>(
    url: URL,
    consume: (response: Response, signal: AbortSignal) => T | Promise<T>,
  ): Promise<{ value: T; attempts: number }> {
    for (let retries = 0; ; retries++) {
      let delay = Math.min(30_000, 1_000 * 2 ** Math.min(retries, 5));
      try {
        const result = await attempt(url, async (response, signal) => {
          const transient =
            response.status === 408 || response.status === 429 || response.status >= 500;
          if (transient && retries < configuration.requests.retries) {
            delay = Math.max(delay, retryAfterDelay(response, clock.now()));
            return { retry: true as const };
          }
          return { retry: false as const, value: await consume(response, signal) };
        });
        if (!result.retry) return { value: result.value, attempts: retries + 1 };
      } catch (error) {
        if (
          error instanceof RunLimitReached ||
          error instanceof DestinationRefused ||
          error instanceof InvalidRobotsRules
        )
          throw error;
        if (retries >= configuration.requests.retries) {
          const evidence = error instanceof Error ? error.message : String(error);
          throw new Error(`${evidence} after ${retries + 1} attempts.`, { cause: error });
        }
      }
      await wait(delay);
    }
  };
}
