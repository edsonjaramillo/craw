import type { AuditConfig } from "./audit-config";
import type { AuditClock } from "./audit-run";
import { validateDestination, type AuditDns, type AuditTransport } from "./guarded-transport";

export class RunLimitReached extends Error {}

/** Sequential requests satisfy the global concurrency cap; all starts are hostname-paced. */
export function createGuardedFetch(
  configuration: AuditConfig,
  clock: AuditClock,
  dns: AuditDns,
  transport: AuditTransport,
  startedAt: number,
) {
  let previousStart: number | undefined;
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
      const error = durationLimited
        ? new RunLimitReached("Run-duration limit reached.")
        : new Error("Request timeout; response health is inconclusive.");
      throw error;
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      timerController.abort();
      controller.abort();
    }
  }
  return async function fetchGuarded<T>(
    url: URL,
    consume: (response: Response) => T | Promise<T>,
  ): Promise<T> {
    const wait =
      previousStart === undefined
        ? 0
        : previousStart + configuration.requests.hostnameIntervalMs - clock.now();
    if (wait > 0) await bounded(remaining(), true, (signal) => clock.sleep(wait, signal));
    const available = remaining();
    return bounded(
      Math.min(available, configuration.requests.timeoutMs),
      available <= configuration.requests.timeoutMs,
      async (signal) => {
        const address = await validateDestination(url, dns);
        signal.throwIfAborted();
        previousStart = clock.now();
        const response = await transport({
          url,
          address,
          identity: configuration.crawlerIdentity,
          signal,
        });
        try {
          signal.throwIfAborted();
          return await consume(response);
        } finally {
          // Consumers release readers before returning, so cancellation closes even late responses.
          await response.body?.cancel().catch(() => {});
        }
      },
    );
  };
}

/** Robots bodies are capped to keep both memory and coverage decisions bounded. */
export async function readRobots(response: Response): Promise<string> {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "identity") {
    throw new Error(`Robots rules use an unsupported content encoding: ${encoding}.`);
  }
  if (!response.body) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > 512 * 1024) throw new Error("Robots rules exceeded the 512 KiB safety bound.");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
