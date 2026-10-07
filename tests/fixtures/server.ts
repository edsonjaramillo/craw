import { Hono } from "hono";

import { healthyScenario, scenarioSchema, type FixtureScenarioInput } from "./scenarios";

const logicalUrlHeader = "x-fixture-logical-url";

export interface FixtureRequest {
  method: string;
  url: string;
  hostname: string;
  arrivedAt: number;
  bodyState: "pending" | "completed" | "cancelled";
  bodyCompletedAt?: number;
  bodyCancelledAt?: number;
  bytesProduced: number;
}

// Structural test seam: intentionally has no production imports. Address is already
// policy-validated by the caller; loopback mapping does NOT test address pinning.
export type FixtureTransport = (request: {
  url: URL;
  address: string;
  identity: string;
  signal: AbortSignal;
}) => Promise<Response>;

export interface Fixture {
  url: URL;
  requests: FixtureRequest[];
  transport: FixtureTransport;
  /** Reset response sequences and the log; call between requests. */
  reset(): void;
  /** Cancel pending delays/streams and close the listener. Safe to call twice. */
  stop(): Promise<void>;
}

/** No listeners are created until this function is called. Port 0 isolates tests. */
export function startFixture(
  input: FixtureScenarioInput = healthyScenario,
  options: { port?: number } = {},
): Fixture {
  const scenario = scenarioSchema.parse(input);
  const requests: FixtureRequest[] = [];
  const cursors = new Map<number, number>();
  const cleanups = new Set<() => void>();
  let stopped = false;
  const app = new Hono();

  app.all("*", async (context) => {
    const request = context.req.raw;
    const logicalUrl = new URL(request.headers.get(logicalUrlHeader) ?? request.url);
    const log: FixtureRequest = {
      method: request.method,
      url: logicalUrl.href,
      hostname: logicalUrl.hostname,
      arrivedAt: Date.now(),
      bodyState: "pending",
      bytesProduced: 0,
    };
    requests.push(log);
    const finish = (state: "completed" | "cancelled") => {
      if (log.bodyState !== "pending") return;
      log.bodyState = state;
      if (state === "completed") log.bodyCompletedAt = Date.now();
      else log.bodyCancelledAt = Date.now();
    };
    const routeIndex = scenario.routes.findIndex(
      (route) =>
        (route.hostname === undefined || route.hostname === logicalUrl.hostname) &&
        (route.method === undefined || route.method === request.method) &&
        route.path === logicalUrl.pathname + logicalUrl.search,
    );
    const route = scenario.routes[routeIndex];
    const cursor = cursors.get(routeIndex) ?? 0;
    const response = route?.responses[Math.min(cursor, route.responses.length - 1)] ?? {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "Fixture route not found",
      delayMs: 0,
    };
    if (route) cursors.set(routeIndex, cursor + 1);

    if (response.delayMs) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          cleanups.delete(cancel);
          request.signal.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = () => {
          finish("cancelled");
          done();
        };
        const timer = setTimeout(done, response.delayMs);
        cleanups.add(cancel);
        request.signal.addEventListener("abort", cancel, { once: true });
        if (request.signal.aborted || stopped) cancel();
      });
    }
    if (request.signal.aborted || stopped || log.bodyState === "cancelled") {
      finish("cancelled");
      return new Response(null, { status: 499 });
    }
    if (request.method === "HEAD" || [204, 205, 304].includes(response.status)) {
      finish("completed");
      return new Response(null, { status: response.status, headers: response.headers });
    }

    const encoder = new TextEncoder();
    const streamSpec = response.stream;
    if (!streamSpec) {
      // Completion records server-side production, not proof of client consumption.
      log.bytesProduced = encoder.encode(response.body).byteLength;
      finish("completed");
      return new Response(response.body, { status: response.status, headers: response.headers });
    }

    let cancelStream: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let produced = 0;
        let ended = false;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          cleanups.delete(cancelStream);
          request.signal.removeEventListener("abort", cancelStream);
        };
        cancelStream = () => {
          if (ended) return;
          ended = true;
          cleanup();
          finish("cancelled");
          try {
            controller.close();
          } catch {
            /* Consumer may have cancelled already. */
          }
        };
        const push = () => {
          if (ended) return;
          const chunk = encoder.encode(streamSpec.chunk);
          controller.enqueue(chunk);
          log.bytesProduced += chunk.byteLength;
          produced++;
          if (produced === streamSpec.chunks) {
            ended = true;
            cleanup();
            finish("completed");
            controller.close();
          } else {
            timer = setTimeout(push, streamSpec.intervalMs);
          }
        };
        cleanups.add(cancelStream);
        request.signal.addEventListener("abort", cancelStream, { once: true });
        if (request.signal.aborted || stopped) cancelStream();
        else push();
      },
      cancel() {
        cancelStream();
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  });

  const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 0, fetch: app.fetch });
  const url = new URL(server.url);
  const transport: FixtureTransport = ({ url: logicalUrl, identity, signal }) => {
    if (stopped) return Promise.reject(new Error("Fixture is stopped"));
    const target = new URL(url);
    target.pathname = logicalUrl.pathname;
    target.search = logicalUrl.search;
    return fetch(target, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        host: logicalUrl.host,
        [logicalUrlHeader]: logicalUrl.href,
        "user-agent": identity,
      },
    });
  };
  return {
    url,
    requests,
    transport,
    reset() {
      cursors.clear();
      requests.length = 0;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const cleanup of cleanups) cleanup();
      await server.stop(true);
    },
  };
}
