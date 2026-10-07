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
  const directory = await mkdtemp(join(tmpdir(), "craw-redirect-controls-"));
  directories.push(directory);
  return {
    databasePath: join(directory, "audit.sqlite"),
    reportPath: join(directory, "report.html"),
  };
}

test("redirects, robots, and retries retain per-host pacing and Retry-After cooldowns", async () => {
  const clock = new ManualClock();
  const network = createNetwork(
    {
      name: "redirect pressure",
      routes: [
        { path: "/robots.txt", responses: [{ status: 404 }] },
        {
          path: "/start",
          responses: [{ status: 302, headers: { location: "/next", "retry-after": "2" } }],
        },
        {
          path: "/next",
          responses: [
            { status: 503, headers: { "retry-after": "3" } },
            { status: 307, headers: { location: "http://external.example/final" } },
          ],
        },
        { path: "/final", responses: [{ status: 200 }] },
      ],
    },
    clock,
  );
  const audit = runAudit(
    { startUrl: "https://public.example/start", requests: { hostnameIntervalMs: 100, retries: 1 } },
    {
      ...(await storage()),
      clock,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: network.transport,
    },
  );
  await flush();
  const start = Date.UTC(2026, 0, 1);
  expect(network.requests.map(({ url, time }) => [url, time - start])).toEqual([
    ["https://public.example/robots.txt", 0],
  ]);
  clock.advance(100);
  await flush();
  expect(network.requests).toHaveLength(2);
  clock.advance(1999);
  await flush();
  expect(network.requests).toHaveLength(2);
  clock.advance(1);
  await flush();
  expect(network.requests).toHaveLength(3);
  clock.advance(2999);
  await flush();
  expect(network.requests).toHaveLength(3);
  clock.advance(1);
  await flush();
  expect(network.requests).toHaveLength(5);
  clock.advance(100);
  const result = await audit;
  expect(result.run.destination.outcome).toBe("successful");
  expect(network.requests.map(({ url, time }) => [url, time - start])).toEqual([
    ["https://public.example/robots.txt", 0],
    ["https://public.example/start", 100],
    ["https://public.example/next", 2100],
    ["https://public.example/next", 5100],
    ["http://external.example/robots.txt", 5100],
    ["http://external.example/final", 5200],
  ]);
  expect(clock.timers.size).toBe(0);
});

for (const sameOrigin of [false, true]) {
  test(`redirect ${sameOrigin ? "same origin rebinding" : "mixed DNS target"} cannot bypass address validation`, async () => {
    const clock = new ManualClock();
    const network = createNetwork(
      {
        name: "unsafe redirect DNS",
        routes: [
          { path: "/robots.txt", responses: [{ status: 404 }] },
          {
            path: "/start",
            responses: [
              {
                status: 302,
                headers: { location: sameOrigin ? "/private" : "https://unsafe.example/private" },
              },
            ],
          },
        ],
      },
      clock,
    );
    let resolutions = 0;
    const audit = runAudit(
      { startUrl: "https://public.example/start", requests: { hostnameIntervalMs: 1, retries: 0 } },
      {
        ...(await storage()),
        clock,
        transport: network.transport,
        dns: (hostname) =>
          Promise.resolve(
            hostname === "unsafe.example"
              ? ["93.184.216.34", "10.0.0.1"]
              : ++resolutions > 2
                ? ["127.0.0.1"]
                : ["93.184.216.34"],
          ),
      },
    );
    await flush();
    clock.advance(1);
    await flush();
    clock.advance(1);
    const result = await audit;
    expect(result.run.destination.outcome).toBe("refused");
    expect(network.requests.map(({ url }) => url)).toEqual([
      "https://public.example/robots.txt",
      "https://public.example/start",
    ]);
  });
}

test("run duration stops redirect waits without dispatching the next hop", async () => {
  const clock = new ManualClock();
  const network = createNetwork(
    {
      name: "redirect duration",
      routes: [
        { path: "/robots.txt", responses: [{ status: 404 }] },
        { path: "/start", responses: [{ status: 302, headers: { location: "/next" } }] },
      ],
    },
    clock,
  );
  const audit = runAudit(
    {
      startUrl: "https://public.example/start",
      requests: { hostnameIntervalMs: 100 },
      limits: { maxDurationMs: 150 },
    },
    {
      ...(await storage()),
      clock,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: network.transport,
    },
  );
  await flush();
  clock.advance(100);
  await flush();
  clock.advance(50);
  const result = await audit;
  expect(result.run.executionStatus).toBe("limit-stopped");
  expect(result.run.destination.outcome).toBe("limit-stopped");
  expect(result.run.destination.redirects).toHaveLength(1);
  expect(network.requests.map(({ url }) => new URL(url).pathname)).toEqual([
    "/robots.txt",
    "/start",
  ]);
  expect(result.report).toContain("Partial report");
  expect(clock.timers.size).toBe(0);
});
