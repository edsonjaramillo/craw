import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit, systemClock } from "../../src/audit-run";
import { ManualClock, flush } from "../fixtures/clock";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function storage() {
  const directory = await mkdtemp(join(tmpdir(), "craw-partial-"));
  directories.push(directory);
  return {
    databasePath: join(directory, "audit.sqlite"),
    reportPath: join(directory, "report.html"),
  };
}

test("fatal scheduler failure retains completed work, unchecked sources and separate runs", async () => {
  const paths = await storage();
  let failScheduling = false;
  const clock = {
    now: () => systemClock.now(),
    sleep(milliseconds: number, signal: AbortSignal) {
      if (failScheduling) throw new Error("Injected scheduler failure");
      return systemClock.sleep(milliseconds, signal);
    },
  };
  const dependencies = {
    ...paths,
    clock,
    dns: () => Promise.resolve(["93.184.216.34"]),
    transport: ({ url }: { url: URL }) => {
      if (url.pathname === "/robots.txt")
        return Promise.resolve(new Response(null, { status: 404 }));
      if (url.pathname === "/first") {
        failScheduling = true;
        return Promise.resolve(new Response(null, { status: 410 }));
      }
      return Promise.resolve(
        new Response(
          '<link rel="canonical" href="/first"><a href="/first#source">first</a><a href="/pending">pending</a>',
          {
            headers: { "content-type": "text/html" },
          },
        ),
      );
    },
  };
  const input = { startUrl: "https://site.example/", requests: { hostnameIntervalMs: 1 } };
  const failed = await runAudit(input, dependencies);
  expect(failed.run.executionStatus).toBe("failed");
  expect(
    failed.run.destinations.map((destination) => [destination.url, destination.outcome]),
  ).toEqual([
    ["https://site.example/", "successful"],
    ["https://site.example/first", "confirmed-broken"],
    ["https://site.example/pending", "inconclusive"],
  ]);
  expect(failed.report).toContain("Partial report");
  expect(failed.report).toContain("Injected scheduler failure");
  expect(failed.report).toContain("/first#source");
  expect(failed.report).toContain("/pending");
  expect(
    failed.run.observations.some((observation) => observation.kind === "broken-canonical"),
  ).toBe(true);
  expect(await Bun.file(paths.reportPath).text()).toBe(failed.report);
  const completed = await runAudit({ startUrl: "http://127.0.0.1/" }, paths);
  expect(completed.run.executionStatus).toBe("completed");
  expect(completed.report).not.toContain("Partial report");
  expect(completed.report).toContain("does not establish complete website health");
  const db = new Database(paths.databasePath, { readonly: true });
  try {
    expect(db.query("SELECT id, execution_status FROM runs ORDER BY rowid").all()).toEqual([
      { id: failed.run.id, execution_status: "failed" },
      { id: completed.run.id, execution_status: "completed" },
    ]);
    const row = db
      .query<{ configuration: string; started_at: string; finished_at: string }, [string]>(
        "SELECT configuration, started_at, finished_at FROM runs WHERE id = ?",
      )
      .get(failed.run.id)!;
    expect(JSON.parse(row.configuration)).toEqual(failed.run.configuration);
    expect(row.started_at).toBe(failed.run.startedAt);
    expect(row.finished_at).toBe(failed.run.finishedAt);
    expect(Date.parse(row.finished_at)).toBeGreaterThanOrEqual(Date.parse(row.started_at));
    expect(db.query("SELECT href FROM source_links WHERE run_id = ?").all(failed.run.id)).toEqual([
      { href: "/first#source" },
      { href: "/pending" },
    ]);
    expect(db.query("SELECT * FROM pages WHERE run_id = ?").all(failed.run.id)).toHaveLength(1);
    expect(
      db.query("SELECT * FROM source_links WHERE run_id = ?").all(completed.run.id),
    ).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("completed runs retain explicit boundary and check-only coverage exclusions", async () => {
  const paths = await storage();
  const result = await runAudit(
    {
      startUrl: "https://site.example/blog",
      pathRestriction: "/blog",
      requests: { hostnameIntervalMs: 1 },
    },
    {
      ...paths,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url }) =>
        Promise.resolve(
          url.pathname === "/robots.txt"
            ? new Response(null, { status: 404 })
            : new Response(
                url.pathname === "/blog"
                  ? '<a href="/outside">outside</a><a href="https://external.example/">external</a><link rel="canonical" href="/blog/canonical">'
                  : '<a href="/never">must not expand</a>',
                { headers: { "content-type": "text/html" } },
              ),
        ),
    },
  );
  expect(result.run.executionStatus).toBe("completed");
  expect(result.run.pages).toHaveLength(1);
  expect(result.run.destinations.every((destination) => destination.outcome === "successful")).toBe(
    true,
  );
  expect(result.run.limitations).toHaveLength(3);
  expect(result.report).not.toContain("Partial report");
  expect(result.report).toContain("Crawl boundary excluded HTML discovery and SEO eligibility");
  expect(result.report).toContain(
    "Canonical-only target excluded HTML discovery and SEO eligibility",
  );
  expect(result.report).toContain("Coverage limitations: 3");
  const db = new Database(paths.databasePath, { readonly: true });
  try {
    expect(db.query("SELECT evidence FROM coverage_limitations").all()).toHaveLength(3);
  } finally {
    db.close();
  }
});

test("unavailable report storage still retains a failed run and collected evidence", async () => {
  const paths = await storage();
  const unavailableReport = `${paths.reportPath}/missing/report.html`;
  await Bun.write(paths.reportPath, "not a directory");
  const failure: unknown = await runAudit(
    { startUrl: "http://127.0.0.1/" },
    { ...paths, reportPath: unavailableReport },
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  const db = new Database(paths.databasePath, { readonly: true });
  try {
    expect(db.query("SELECT execution_status FROM runs").get()).toEqual({
      execution_status: "failed",
    });
    expect(db.query("SELECT outcome FROM destinations").get()).toEqual({ outcome: "refused" });
    const limitations = db
      .query<{ evidence: string }, []>("SELECT evidence FROM coverage_limitations")
      .all();
    expect(limitations.some((row) => row.evidence.includes("Fatal artifact failure"))).toBe(true);
  } finally {
    db.close();
  }
});

test("fatal backoff scheduler rejection is not reported as destination health", async () => {
  const paths = await storage();
  const result = await runAudit(
    { startUrl: "https://site.example/", requests: { hostnameIntervalMs: 1 } },
    {
      ...paths,
      clock: {
        now: () => systemClock.now(),
        sleep(milliseconds, signal) {
          return milliseconds === 1000
            ? Promise.reject(new Error("Injected backoff scheduler failure"))
            : systemClock.sleep(milliseconds, signal);
        },
      },
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url }) =>
        Promise.resolve(new Response(null, { status: url.pathname === "/robots.txt" ? 404 : 503 })),
    },
  );
  expect(result.run.executionStatus).toBe("failed");
  expect(result.report).toContain("Partial report");
  expect(result.report).toContain("Injected backoff scheduler failure");
});

test("deadline stops queued navigation and canonical checks while retaining their sources", async () => {
  const clock = new ManualClock();
  const paths = await storage();
  const attempts: string[] = [];
  const started = Promise.withResolvers<void>();
  const schedulingClock = {
    now: () => clock.now(),
    sleep(milliseconds: number, signal: AbortSignal) {
      if (milliseconds === 1) {
        signal.throwIfAborted();
        clock.advance(1);
        return Promise.resolve();
      }
      return clock.sleep(milliseconds, signal);
    },
  };
  let cancelled = false;
  const pending = runAudit(
    {
      startUrl: "https://site.example/",
      requests: { hostnameIntervalMs: 1 },
      limits: { maxDurationMs: 100 },
    },
    {
      ...paths,
      clock: schedulingClock,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url, signal }) => {
        attempts.push(url.pathname);
        if (url.pathname === "/robots.txt")
          return Promise.resolve(new Response(null, { status: 404 }));
        if (url.pathname === "/")
          return Promise.resolve(
            new Response(
              '<a href="/slow">slow</a><a href="/pending#source">pending</a><link rel="canonical" href="/canonical">',
              { headers: { "content-type": "text/html" } },
            ),
          );
        started.resolve();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("Cancelled"));
            },
            { once: true },
          );
        });
      },
    },
  );
  await started.promise;
  expect(attempts).toEqual(["/robots.txt", "/", "/slow"]);
  clock.advance(100);
  const result = await pending;
  expect(cancelled).toBe(true);
  expect(result.run.executionStatus).toBe("limit-stopped");
  expect(attempts).toEqual(["/robots.txt", "/", "/slow"]);
  expect(
    result.run.destinations
      .filter((destination) => destination.outcome === "limit-stopped")
      .map((destination) => destination.url)
      .toSorted(),
  ).toEqual([
    "https://site.example/canonical",
    "https://site.example/pending",
    "https://site.example/slow",
  ]);
  expect(result.run.pages).toHaveLength(1);
  expect(result.report).toContain("/pending#source");
  expect(result.report).toContain("Not checked");
  expect(result.report).toContain("Partial report");
  expect(result.run.finishedAt).toBe(new Date(clock.now()).toISOString());
  expect(clock.timers.size).toBe(0);
});

for (const phase of ["html", "robots"] as const) {
  test(`deadline cancels streaming ${phase} bodies and retains partial artifacts`, async () => {
    const clock = new ManualClock();
    const paths = await storage();
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const pending = runAudit(
      {
        startUrl: "https://site.example/",
        requests: { hostnameIntervalMs: 1 },
        limits: { maxDurationMs: 100 },
      },
      {
        ...paths,
        clock,
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: (request) => {
          if (phase === "html" && request.url.pathname === "/robots.txt")
            return Promise.resolve(new Response(null, { status: 404 }));
          signal = request.signal;
          return Promise.resolve(
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              {
                headers: { "content-type": "text/html" },
              },
            ),
          );
        },
      },
    );
    await flush();
    clock.advance(1);
    await flush();
    clock.advance(99);
    const result = await pending;
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(result.run.executionStatus).toBe("limit-stopped");
    expect(result.report).toContain("Partial report");
    expect(await Bun.file(paths.reportPath).text()).toBe(result.report);
    const db = new Database(paths.databasePath, { readonly: true });
    try {
      expect(db.query("SELECT execution_status FROM runs").get()).toEqual({
        execution_status: "limit-stopped",
      });
    } finally {
      db.close();
    }
    expect(clock.timers.size).toBe(0);
  });
}
