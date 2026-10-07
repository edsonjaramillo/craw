import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "cheerio";

import { runAudit } from "../../src/audit-run";
import { ManualClock, flush } from "../fixtures/clock";
import { createNetwork } from "../fixtures/network";

test("combined scheduling bounds retries, hops and pressure before cancelling pending work at the deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-acceptance-scheduling-"));
  const clock = new ManualClock();
  const start = clock.now();
  const network = createNetwork(
    {
      name: "bounded combined run",
      routes: [
        { path: "/robots.txt", responses: [{ status: 404 }] },
        {
          path: "/",
          responses: [
            {
              headers: { "content-type": "text/html" },
              body: '<title>Scheduling</title><h1>Scheduling</h1><a href="/retry">retry</a><a href="/slow">timeout</a><a href="/hop">hop bound</a><a href="/deadline">deadline</a><a href="/never">excluded work</a>',
            },
          ],
        },
        {
          path: "/retry",
          responses: [{ status: 503, headers: { "retry-after": "2" } }, { status: 410 }],
        },
        { path: "/slow", responses: [{ delayMs: 200, status: 200 }] },
        {
          path: "/hop",
          responses: [{ status: 302, headers: { location: "http://site.example/next" } }],
        },
        { path: "/next", responses: [{ status: 302, headers: { location: "/too-far" } }] },
        { path: "/deadline", responses: [{ delayMs: 200, status: 200 }] },
      ],
    },
    clock,
  );
  const databasePath = join(directory, "audit.sqlite");
  let pending: ReturnType<typeof runAudit> | undefined;
  try {
    let settled = false;
    pending = runAudit(
      {
        startUrl: "https://site.example/",
        requests: {
          concurrency: 1,
          hostnameIntervalMs: 100,
          timeoutMs: 150,
          retries: 1,
          maxRedirectHops: 1,
        },
        limits: { maxDurationMs: 4000 },
      },
      {
        databasePath,
        reportPath: join(directory, "report.html"),
        clock,
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: network.transport,
      },
    );
    void pending.then(
      () => {
        settled = true;
        return settled;
      },
      () => {
        settled = true;
        return settled;
      },
    );
    // Crawlee queue startup uses real asynchronous work. Do not spend virtual
    // duration while waiting for it; advance only a scheduled request wait.
    const watchdog = Date.now() + 4000;
    while (true) {
      await flush();
      if (settled) break;
      if (Date.now() > watchdog) throw new Error("Scheduling acceptance did not settle");
      const waits = [...clock.timers].filter(({ due }) => due !== start + 4000);
      if (waits.length > 0)
        clock.advance(Math.min(...waits.map(({ due }) => due), start + 4000) - clock.now());
      else if (network.active) clock.advance(start + 4000 - clock.now());
    }
    const result = await pending;
    expect(result.run.executionStatus).toBe("limit-stopped");
    expect(network.peak).toBe(1);
    expect(network.active).toBe(0);
    const requests = network.requests.map(({ url, time }) => [url, time - start]);
    expect(requests).toEqual([
      ["https://site.example/robots.txt", 0],
      ["https://site.example/", 100],
      ["https://site.example/retry", 200],
      ["https://site.example/retry", 2200],
      ["https://site.example/slow", 2300],
      ["https://site.example/slow", 3450],
      ["https://site.example/hop", 3600],
      ["http://site.example/robots.txt", 3700],
      ["http://site.example/next", 3800],
      ["https://site.example/deadline", 3900],
    ]);
    expect(result.run.destinations.map(({ outcome }) => outcome)).toEqual([
      "successful",
      "confirmed-broken",
      "inconclusive",
      "redirect-limit",
      "limit-stopped",
      "limit-stopped",
    ]);
    expect(
      network.requests
        .filter(({ bodyState }) => bodyState === "cancelled")
        .map(({ url, signal }) => [url, signal.aborted]),
    ).toEqual([
      ["https://site.example/slow", true],
      ["https://site.example/slow", true],
      ["https://site.example/deadline", true],
    ]);
    expect(
      network.requests.some(({ url }) => url.endsWith("/too-far") || url.endsWith("/never")),
    ).toBe(false);
    expect(clock.now() - start).toBe(4000);
    expect(clock.timers.size).toBe(0);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.query("SELECT execution_status FROM runs").get()).toEqual({
        execution_status: "limit-stopped",
      });
      expect(db.query("SELECT * FROM pages").all()).toHaveLength(1);
      expect(db.query("SELECT * FROM source_links").all()).toHaveLength(5);
      expect(
        db
          .query("SELECT outcome FROM destinations WHERE url = ?")
          .get("https://site.example/never"),
      ).toEqual({ outcome: "limit-stopped" });
    } finally {
      db.close();
    }
    const report = load(result.report);
    expect(report.text()).toContain("Partial report");
    expect(report.text()).toContain("Run-duration limit reached");
    expect(report.text()).toContain("Confirmed broken links: 1");
  } finally {
    // Drain deadline cancellation even if the watchdog or an assertion fails.
    clock.advance(Math.max(0, start + 4000 - clock.now()));
    await pending?.catch(() => null);
    await rm(directory, { recursive: true, force: true });
  }
});
