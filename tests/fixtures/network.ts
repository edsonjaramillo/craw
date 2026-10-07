import type { AuditClock } from "../../src/audit-run";
import type { AuditTransport } from "../../src/guarded-transport";
import { scenarioSchema, type FixtureScenarioInput } from "./scenarios";

/** Synthetic public HTTP responses with the same strict, resettable sequences as the server. */
export function createNetwork(input: FixtureScenarioInput, clock: AuditClock) {
  const scenario = scenarioSchema.parse(input);
  const cursors = new Map<number, number>();
  const requests: {
    url: string;
    hostname: string;
    method: "GET";
    identity: string;
    address: string;
    time: number;
    signal: AbortSignal;
    bodyState: "pending" | "completed" | "cancelled";
  }[] = [];
  let active = 0;
  let peak = 0;
  const transport: AuditTransport = async ({ url, signal, identity, address }) => {
    const request: (typeof requests)[number] = {
      url: url.href,
      hostname: url.hostname,
      method: "GET",
      identity,
      address,
      time: clock.now(),
      signal,
      bodyState: "pending",
    };
    requests.push(request);
    active++;
    peak = Math.max(peak, active);
    try {
      const index = scenario.routes.findIndex(
        (route) =>
          route.path === url.pathname + url.search &&
          (route.method === undefined || route.method === "GET") &&
          (route.scheme === undefined || `${route.scheme}:` === url.protocol) &&
          (route.hostname === undefined || route.hostname === url.hostname),
      );
      const route = scenario.routes[index];
      if (!route) throw new Error(`Unexpected fixture destination: ${url.href}`);
      const cursor = cursors.get(index) ?? 0;
      cursors.set(index, cursor + 1);
      const response = route.responses[Math.min(cursor, route.responses.length - 1)]!;
      if (response.delayMs) await clock.sleep(response.delayMs, signal);
      if (response.stream) throw new Error("Use the real fixture server for body-stream scenarios");
      request.bodyState = "completed";
      return new Response(response.body || null, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      request.bodyState = "cancelled";
      throw error;
    } finally {
      active--;
    }
  };
  return {
    transport,
    requests,
    get active() {
      return active;
    },
    get peak() {
      return peak;
    },
    reset() {
      if (active) throw new Error("Cannot reset an active network fixture");
      cursors.clear();
      requests.length = 0;
      peak = 0;
    },
  };
}
