import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit } from "../../src/audit-run";
import { ManualClock, flush } from "../fixtures/clock";
import { createNetwork } from "../fixtures/network";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function storage() {
  const directory = await mkdtemp(join(tmpdir(), "craw-recovery-"));
  directories.push(directory);
  return {
    databasePath: join(directory, "audit.sqlite"),
    reportPath: join(directory, "report.html"),
  };
}

test("recovers transient robots and destination failures with paced, bounded backoff", async () => {
  const clock = new ManualClock();
  const paths = await storage();
  const attempts: { path: string; time: number }[] = [];
  const sequences = new Map([
    ["/robots.txt", [503, 404]],
    ["/", [503, 200]],
  ]);
  const result = runAudit(
    { startUrl: "https://public.example/", requests: { hostnameIntervalMs: 100, concurrency: 1 } },
    {
      ...paths,
      clock,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url }) => {
        attempts.push({ path: url.pathname, time: clock.now() - Date.UTC(2026, 0, 1) });
        return Promise.resolve(
          new Response(null, { status: sequences.get(url.pathname)!.shift()! }),
        );
      },
    },
  );
  await flush();
  clock.advance(999);
  await flush();
  expect(attempts).toHaveLength(1);
  clock.advance(1);
  await flush();
  expect(attempts).toHaveLength(2);
  clock.advance(100);
  await flush();
  clock.advance(1000);
  await flush();
  const audit = await result;
  expect(audit.run.destination.outcome).toBe("successful");
  expect(attempts).toEqual([
    { path: "/robots.txt", time: 0 },
    { path: "/robots.txt", time: 1000 },
    { path: "/", time: 1100 },
    { path: "/", time: 2100 },
  ]);
  expect(audit.report).toContain("2 attempts");
  const db = new Database(paths.databasePath, { readonly: true });
  try {
    expect(db.query("SELECT outcome, status FROM destinations").get()).toEqual({
      outcome: "successful",
      status: 200,
    });
  } finally {
    db.close();
  }
  expect(clock.timers.size).toBe(0);
});

test("exhausted network attempts remain inconclusive with retry evidence, never confirmed broken", async () => {
  const clock = new ManualClock();
  const paths = await storage();
  const attempts: number[] = [];
  const result = runAudit(
    { startUrl: "https://public.example/", requests: { hostnameIntervalMs: 1 } },
    {
      ...paths,
      clock,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url }) => {
        if (url.pathname === "/robots.txt")
          return Promise.resolve(new Response(null, { status: 404 }));
        attempts.push(clock.now() - Date.UTC(2026, 0, 1));
        return Promise.reject(new Error("Connection reset"));
      },
    },
  );
  await flush();
  clock.advance(1);
  await flush();
  clock.advance(1000);
  await flush();
  clock.advance(2000);
  const audit = await result;
  expect(attempts).toEqual([1, 1001, 3001]);
  expect(audit.run.destination.outcome).toBe("inconclusive");
  expect(audit.report).toContain("3 attempts");
  expect(audit.report).toContain("Confirmed broken links: 0");
  expect(audit.run.limitations.join(" ")).toContain("inconclusive");
  const db = new Database(paths.databasePath, { readonly: true });
  try {
    expect(db.query("SELECT outcome, status FROM destinations").get()).toEqual({
      outcome: "inconclusive",
      status: null,
    });
  } finally {
    db.close();
  }
  expect(clock.timers.size).toBe(0);
});

test("request timeout aborts a stalled robots body, retries it, and releases all readers", async () => {
  const clock = new ManualClock();
  let cancellations = 0;
  let robotsAttempts = 0;
  const result = runAudit(
    {
      startUrl: "https://public.example/",
      requests: { timeoutMs: 50, hostnameIntervalMs: 1, retries: 1 },
    },
    {
      ...(await storage()),
      clock,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url }) => {
        if (url.pathname === "/robots.txt" && ++robotsAttempts === 1) {
          return Promise.resolve(
            new Response(
              new ReadableStream({
                cancel() {
                  cancellations++;
                },
              }),
            ),
          );
        }
        return Promise.resolve(
          new Response(null, { status: url.pathname === "/robots.txt" ? 404 : 200 }),
        );
      },
    },
  );
  await flush();
  clock.advance(50);
  await flush();
  expect(cancellations).toBe(1);
  clock.advance(1000);
  await flush();
  clock.advance(1);
  expect((await result).run.destination.outcome).toBe("successful");
  expect(clock.timers.size).toBe(0);
});

test("timeout aborts the current attempt before retrying and can recover", async () => {
  const clock = new ManualClock();
  const network = createNetwork(
    {
      name: "timeout-recovery",
      routes: [
        { path: "/robots.txt", responses: [{ status: 404 }] },
        { path: "/", responses: [{ status: 200, delayMs: 200 }, { status: 200 }] },
      ],
    },
    clock,
  );
  const result = runAudit(
    {
      startUrl: "https://public.example/",
      requests: { concurrency: 1, hostnameIntervalMs: 1, timeoutMs: 50 },
    },
    {
      ...(await storage()),
      clock,
      transport: network.transport,
      dns: () => Promise.resolve(["93.184.216.34"]),
    },
  );
  await flush();
  clock.advance(1);
  await flush();
  expect(network.active).toBe(1);
  clock.advance(50);
  await flush();
  expect(network.active).toBe(0);
  expect(network.requests[1]!.signal.aborted).toBe(true);
  clock.advance(999);
  await flush();
  expect(network.requests).toHaveLength(2);
  clock.advance(1);
  expect((await result).run.destination.outcome).toBe("successful");
  expect(network.requests.map((request) => request.time - Date.UTC(2026, 0, 1))).toEqual([
    0, 1, 1051,
  ]);
  expect(network.peak).toBe(1);
  expect(clock.timers.size).toBe(0);
});

test("run deadline aborts destination work in flight without spending remaining retry attempts", async () => {
  const clock = new ManualClock();
  const network = createNetwork(
    {
      name: "in-flight-deadline",
      routes: [
        { path: "/robots.txt", responses: [{ status: 404 }] },
        { path: "/", responses: [{ delayMs: 200 }] },
      ],
    },
    clock,
  );
  const result = runAudit(
    {
      startUrl: "https://public.example/",
      requests: { hostnameIntervalMs: 1 },
      limits: { maxDurationMs: 100 },
    },
    {
      ...(await storage()),
      clock,
      transport: network.transport,
      dns: () => Promise.resolve(["93.184.216.34"]),
    },
  );
  await flush();
  clock.advance(1);
  await flush();
  expect(network.active).toBe(1);
  clock.advance(99);
  const audit = await result;
  expect(audit.run.executionStatus).toBe("limit-stopped");
  expect(network.requests).toHaveLength(2);
  expect(network.requests[1]!.signal.aborted).toBe(true);
  expect(network.active).toBe(0);
  expect(clock.timers.size).toBe(0);
});

test("timed-out response retains its request slot until asynchronous body cancellation finishes", async () => {
  const clock = new ManualClock();
  let active = 0;
  let peak = 0;
  let attempts = 0;
  const result = runAudit(
    {
      startUrl: "https://public.example/",
      requests: { concurrency: 1, timeoutMs: 50, hostnameIntervalMs: 1, retries: 1 },
    },
    {
      ...(await storage()),
      clock,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url }) => {
        if (url.pathname === "/robots.txt")
          return Promise.resolve(new Response(null, { status: 404 }));
        attempts++;
        active++;
        peak = Math.max(peak, active);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: async () => {
                await clock.sleep(attempts === 1 ? 2000 : 0, new AbortController().signal);
                active--;
              },
            }),
            { status: 200 },
          ),
        );
      },
    },
  );
  await flush();
  clock.advance(1);
  await flush();
  clock.advance(50);
  await flush();
  clock.advance(1000);
  await flush();
  expect(attempts).toBe(1);
  expect(active).toBe(1);
  clock.advance(950);
  await flush();
  expect(attempts).toBe(2);
  clock.advance(0);
  await flush();
  expect((await result).run.destination.outcome).toBe("successful");
  expect(peak).toBe(1);
  expect(active).toBe(0);
  expect(clock.timers.size).toBe(0);
});

test("run deadline cancels a retry queued behind unfinished response cleanup", async () => {
  const clock = new ManualClock();
  let attempts = 0;
  let cancelFinished = false;
  const result = runAudit(
    {
      startUrl: "https://public.example/",
      requests: { timeoutMs: 50, hostnameIntervalMs: 1 },
      limits: { maxDurationMs: 1500 },
    },
    {
      ...(await storage()),
      clock,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url }) => {
        if (url.pathname === "/robots.txt")
          return Promise.resolve(new Response(null, { status: 404 }));
        attempts++;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: async () => {
                await clock.sleep(2000, new AbortController().signal);
                cancelFinished = true;
              },
            }),
          ),
        );
      },
    },
  );
  await flush();
  clock.advance(1);
  await flush();
  clock.advance(50);
  await flush();
  clock.advance(1000);
  await flush();
  expect(attempts).toBe(1);
  clock.advance(449);
  expect((await result).run.executionStatus).toBe("limit-stopped");
  expect(cancelFinished).toBe(false);
  clock.advance(501);
  await flush();
  expect(cancelFinished).toBe(true);
  expect(attempts).toBe(1);
  expect(clock.timers.size).toBe(0);
});

test("backoff caps at thirty seconds and malformed Retry-After does not disable retry spacing", async () => {
  const clock = new ManualClock();
  const network = createNetwork(
    {
      name: "bounded-backoff",
      routes: [
        {
          path: "/robots.txt",
          responses: [{ status: 503, headers: { "retry-after": "-9999" } }],
        },
      ],
    },
    clock,
  );
  const result = runAudit(
    { startUrl: "https://public.example/", requests: { retries: 7 } },
    {
      ...(await storage()),
      clock,
      transport: network.transport,
      dns: () => Promise.resolve(["93.184.216.34"]),
    },
  );
  await flush();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    clock.advance(delay);
    await flush();
  }
  expect((await result).run.destination.outcome).toBe("robots-unavailable");
  expect(network.requests.map((request) => request.time - Date.UTC(2026, 0, 1))).toEqual([
    0, 1000, 3000, 7000, 15000, 31000, 61000, 91000,
  ]);
  expect(clock.timers.size).toBe(0);
});

test("exhausted transient robots retrieval skips the destination and reports incomplete coverage", async () => {
  const clock = new ManualClock();
  const network = createNetwork(
    { name: "unavailable-rules", routes: [{ path: "/robots.txt", responses: [{ status: 503 }] }] },
    clock,
  );
  const result = runAudit(
    { startUrl: "https://public.example/" },
    {
      ...(await storage()),
      clock,
      transport: network.transport,
      dns: () => Promise.resolve(["93.184.216.34"]),
    },
  );
  await flush();
  clock.advance(1000);
  await flush();
  clock.advance(2000);
  const audit = await result;
  expect(network.requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/robots.txt",
    "/robots.txt",
    "/robots.txt",
  ]);
  expect(audit.run.destination.outcome).toBe("robots-unavailable");
  expect(audit.run.executionStatus).toBe("completed");
  expect(audit.report).toContain("3 attempts");
  expect(audit.run.limitations.join(" ")).toContain("robots-unavailable");
  expect(clock.timers.size).toBe(0);
});

test("Retry-After cools down the hostname for the next destination request, not only retries", async () => {
  const clock = new ManualClock();
  const network = createNetwork(
    {
      name: "host-cooldown",
      routes: [
        { path: "/robots.txt", responses: [{ status: 404, headers: { "retry-after": "2" } }] },
        { path: "/", responses: [{ status: 200 }] },
      ],
    },
    clock,
  );
  const result = runAudit(
    { startUrl: "https://public.example/", requests: { hostnameIntervalMs: 1 } },
    {
      ...(await storage()),
      clock,
      transport: network.transport,
      dns: () => Promise.resolve(["93.184.216.34"]),
    },
  );
  await flush();
  clock.advance(1999);
  await flush();
  expect(network.requests).toHaveLength(1);
  clock.advance(1);
  expect((await result).run.destination.outcome).toBe("successful");
  expect(network.requests[1]!.time - network.requests[0]!.time).toBe(2000);
});

for (const phase of ["robots", "destination"] as const) {
  test(`run deadline interrupts ${phase} Retry-After wait and does not dispatch a retry`, async () => {
    const clock = new ManualClock();
    const network = createNetwork(
      {
        name: "deadline",
        routes: [
          {
            path: "/robots.txt",
            responses: [
              {
                status: phase === "robots" ? 429 : 404,
                headers:
                  phase === "robots" ? { "retry-after": "999999999999999999999999999999999" } : {},
              },
            ],
          },
          { path: "/", responses: [{ status: 503, headers: { "retry-after": "3600" } }] },
        ],
      },
      clock,
    );
    const result = runAudit(
      {
        startUrl: "https://public.example/",
        requests: { hostnameIntervalMs: 1 },
        limits: { maxDurationMs: 100 },
      },
      {
        ...(await storage()),
        clock,
        transport: network.transport,
        dns: () => Promise.resolve(["93.184.216.34"]),
      },
    );
    await flush();
    clock.advance(1);
    await flush();
    clock.advance(99);
    const audit = await result;
    expect(audit.run.executionStatus).toBe("limit-stopped");
    expect(audit.run.destination.outcome).toBe("limit-stopped");
    expect(network.requests).toHaveLength(phase === "robots" ? 1 : 2);
    expect(audit.report).toContain("Partial report");
    expect(clock.timers.size).toBe(0);
  });
}

for (const retryAfter of ["3", "Thu, 01 Jan 2026 00:00:03 GMT"]) {
  test(`honors Retry-After ${retryAfter} without leaking timers across reset runs`, async () => {
    const clock = new ManualClock();
    const paths = await storage();
    const network = createNetwork(
      {
        name: "retry-after",
        routes: [
          {
            path: "/robots.txt",
            responses: [{ status: 429, headers: { "retry-after": retryAfter } }, { status: 404 }],
          },
          { path: "/", responses: [{ status: 200 }] },
        ],
      },
      clock,
    );
    for (let invocation = 0; invocation < 2; invocation++) {
      clock.time = Date.UTC(2026, 0, 1);
      network.reset();
      const result = runAudit(
        { startUrl: "https://public.example/", requests: { hostnameIntervalMs: 100 } },
        {
          ...paths,
          clock,
          transport: network.transport,
          dns: () => Promise.resolve(["93.184.216.34"]),
        },
      );
      await flush();
      clock.advance(2999);
      await flush();
      expect(network.requests).toHaveLength(1);
      clock.advance(1);
      await flush();
      expect(network.requests).toHaveLength(2);
      clock.advance(100);
      expect((await result).run.destination.outcome).toBe("successful");
      expect(network.requests.map((request) => request.time - Date.UTC(2026, 0, 1))).toEqual([
        0, 3000, 3100,
      ]);
      expect(clock.timers.size).toBe(0);
    }
  });
}
