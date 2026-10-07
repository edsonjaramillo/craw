import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "cheerio";

import { runAudit } from "../../src/audit-run";
import { ManualClock, flush } from "../fixtures/clock";
import type { FixtureScenarioInput } from "../fixtures/scenarios";
import { startFixture } from "../fixtures/server";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const html = (body: string) => ({ headers: { "content-type": "text/html" }, body });
async function audit(routes: FixtureScenarioInput["routes"], limits = {}) {
  const directory = await mkdtemp(join(tmpdir(), "craw-canonicals-"));
  directories.push(directory);
  const fixture = startFixture({ name: "canonicals", routes });
  const databasePath = join(directory, "audit.sqlite");
  try {
    const result = await runAudit(
      {
        startUrl: "https://site.example/blog",
        pathRestriction: "/blog",
        requests: { hostnameIntervalMs: 1, retries: 0 },
        limits,
      },
      {
        databasePath,
        reportPath: join(directory, "report.html"),
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: fixture.transport,
      },
    );
    return { ...result, databasePath, requests: fixture.requests };
  } finally {
    await fixture.stop();
  }
}

test("resolves canonical evidence with base URLs and fragments without expanding canonical-only targets", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [
        html(
          '<base href="/blog/base/"><link rel="alternate CANONICAL" href="../target?b=2&a=1#first"><link rel="canonical" href="https://site.example/blog/target?b=2&a=1#second"><a href="/blog/missing">missing</a>',
        ),
      ],
    },
    {
      path: "/blog/target?b=2&a=1",
      responses: [
        html(
          '<title>Shared title</title><meta name="description" content="Shared description"><h1>Canonical-only heading one</h1><h1>Canonical-only heading two</h1><a href="/blog/never">never</a>',
        ),
      ],
    },
    {
      path: "/blog/missing",
      responses: [
        html(
          '<title>Shared title</title><meta name="description" content="Shared description"><h1>Missing</h1>',
        ),
      ],
    },
  ]);
  expect(result.run.pages.map((page) => page.url)).toEqual([
    "https://site.example/blog",
    "https://site.example/blog/missing",
  ]);
  expect(result.requests.filter((request) => request.url.includes("/blog/target"))).toHaveLength(1);
  expect(result.requests.some((request) => request.url.endsWith("/never"))).toBe(false);
  expect(
    result.run.observations
      .filter((observation) => observation.kind.includes("canonical"))
      .map(({ kind, severity }) => [kind, severity]),
  ).toEqual([["missing-canonical", "info"]]);
  const db = new Database(result.databasePath, { readonly: true });
  try {
    expect(
      db
        .query(
          "SELECT source_url, href, destination_url FROM canonical_declarations ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      {
        source_url: "https://site.example/blog",
        href: "../target?b=2&a=1#first",
        destination_url: "https://site.example/blog/target?b=2&a=1",
      },
      {
        source_url: "https://site.example/blog",
        href: "https://site.example/blog/target?b=2&a=1#second",
        destination_url: "https://site.example/blog/target?b=2&a=1",
      },
    ]);
  } finally {
    db.close();
  }
  const artifacts = new Database(result.databasePath, { readonly: true });
  try {
    expect(artifacts.query("SELECT url FROM pages ORDER BY rowid").all()).toEqual([
      { url: "https://site.example/blog" },
      { url: "https://site.example/blog/missing" },
    ]);
    expect(artifacts.query("SELECT source_url, destination_url FROM source_links").all()).toEqual([
      {
        source_url: "https://site.example/blog",
        destination_url: "https://site.example/blog/missing",
      },
    ]);
    expect(
      artifacts
        .query(
          "SELECT count(*) AS count FROM seo_observations WHERE url = 'https://site.example/blog/target?b=2&a=1'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(artifacts.query("SELECT count(*) AS count FROM duplicate_metadata").get()).toEqual({
      count: 0,
    });
  } finally {
    artifacts.close();
  }
  expect(result.report).not.toContain("Canonical-only heading");
  expect(result.report).not.toContain("/blog/never");
  expect(result.report).not.toContain("duplicate-title — within this run");
  expect(result.report).not.toContain("duplicate-description — within this run");
  expect(load(result.report)('[data-count="seo-pages"]').text()).toBe("2");
  expect(result.report).toContain("../target?b=2&amp;a=1#first");
  expect(result.report).toContain("Canonical declarations");
});

test("allows cross-boundary canonicals, reports conflicts and only confirmed broken targets as errors, and shares navigation checks", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [
        html(
          '<link rel="canonical" href="/outside"><link rel="canonical" href="https://other.example/alias"><link rel="canonical" href="/blog/gone"><a href="/blog/gone">gone</a><a href="/blog/child">child</a>',
        ),
      ],
    },
    { path: "/blog/child", responses: [html('<link rel="canonical" href="/blog/gone#again">')] },
    { path: "/outside", responses: [html('<a href="/blog/never">never</a>')] },
    {
      hostname: "other.example",
      path: "/alias",
      responses: [{ status: 302, headers: { location: "/missing" } }],
    },
    { hostname: "other.example", path: "/missing", responses: [{ status: 404 }] },
    { path: "/blog/gone", responses: [{ status: 410 }] },
  ]);
  expect(result.run.pages.map((page) => page.url)).toEqual([
    "https://site.example/blog",
    "https://site.example/blog/child",
  ]);
  expect(result.requests.filter((request) => request.url.endsWith("/blog/gone"))).toHaveLength(1);
  expect(result.requests.some((request) => request.url.endsWith("/never"))).toBe(false);
  expect(
    result.run.observations
      .filter((observation) => observation.kind.includes("canonical"))
      .map(({ url, kind, severity }) => [url, kind, severity]),
  ).toEqual([
    ["https://site.example/blog", "conflicting-canonicals", "warning"],
    ["https://site.example/blog", "broken-canonical", "error"],
    ["https://site.example/blog/child", "broken-canonical", "error"],
  ]);
  const db = new Database(result.databasePath, { readonly: true });
  try {
    expect(
      db.query("SELECT status FROM destinations WHERE url = 'https://other.example/alias'").get(),
    ).toEqual({ status: 404 });
    expect(
      db.query("SELECT severity FROM seo_observations WHERE kind = 'broken-canonical'").all(),
    ).toEqual([{ severity: "error" }, { severity: "error" }]);
    expect(db.query("SELECT count(*) AS count FROM canonical_declarations").get()).toEqual({
      count: 4,
    });
  } finally {
    db.close();
  }
  expect(load(result.report)('[data-count="seo-errors"]').text()).toBe("2");
  expect(result.report).toContain("conflicting-canonicals");
  expect(result.report).toContain("https://other.example/alias");
});

test("preserves unsupported, refused, robots-excluded, inaccessible and inconclusive canonical evidence without claiming broken targets", async () => {
  const result = await audit([
    { path: "/robots.txt", responses: [{ body: "User-agent: *\nDisallow: /blog/blocked\n" }] },
    {
      path: "/blog",
      responses: [
        html(
          '<link rel="canonical"><link rel="canonical" href="http://[invalid"><link rel="canonical" href="mailto:person@example.com"><link rel="canonical" href="http://127.0.0.1/private"><link rel="canonical" href="/blog/blocked"><link rel="canonical" href="/blog/auth"><link rel="canonical" href="/blog/transient">',
        ),
      ],
    },
    { path: "/blog/auth", responses: [{ status: 403 }] },
    { path: "/blog/transient", responses: [{ status: 429 }] },
  ]);
  expect(result.run.destinations.map(({ outcome }) => outcome)).toEqual([
    "successful",
    "refused",
    "robots-excluded",
    "inaccessible",
    "inconclusive",
  ]);
  expect(
    result.requests.some(
      (request) => request.url.includes("127.0.0.1") || request.url.endsWith("/blocked"),
    ),
  ).toBe(false);
  expect(
    result.run.observations.some((observation) => observation.kind === "broken-canonical"),
  ).toBe(false);
  const db = new Database(result.databasePath, { readonly: true });
  try {
    expect(
      db.query("SELECT href, destination_url FROM canonical_declarations LIMIT 3").all(),
    ).toEqual([
      { href: null, destination_url: null },
      { href: "http://[invalid", destination_url: null },
      { href: "mailto:person@example.com", destination_url: "mailto:person@example.com" },
    ]);
  } finally {
    db.close();
  }
  expect(result.report).toContain("Unsupported canonical scheme; target health not established.");
  expect(result.report).toContain("robots-excluded");
  expect(result.report).toContain("inconclusive");
});

test("canonical redirects remain guarded and unavailable robots rules leave target health unresolved", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [
        html(
          '<link rel="canonical" href="/blog/redirect"><link rel="canonical" href="https://unavailable.example/target">',
        ),
      ],
    },
    {
      path: "/blog/redirect",
      responses: [{ status: 302, headers: { location: "http://127.0.0.1/secret" } }],
    },
    { hostname: "unavailable.example", path: "/robots.txt", responses: [{ status: 503 }] },
  ]);
  expect(result.run.destinations.map(({ outcome }) => outcome)).toEqual([
    "successful",
    "refused",
    "robots-unavailable",
  ]);
  expect(
    result.requests.some(
      (request) => request.url.includes("127.0.0.1") || request.url.endsWith("/target"),
    ),
  ).toBe(false);
  expect(
    result.run.observations.some((observation) => observation.kind === "broken-canonical"),
  ).toBe(false);
  expect(result.report).toContain("robots-unavailable");
  expect(result.report).toContain("Informational redirects");
});

test("canonical checks obey hostname pacing and Retry-After without expanding the target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-canonical-clock-"));
  directories.push(directory);
  const clock = new ManualClock();
  const attempts: { path: string; time: number }[] = [];
  let targetAttempts = 0;
  const pending = runAudit(
    {
      startUrl: "https://site.example/blog",
      requests: { hostnameIntervalMs: 100, retries: 1 },
    },
    {
      clock,
      databasePath: join(directory, "audit.sqlite"),
      reportPath: join(directory, "report.html"),
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url }) => {
        attempts.push({ path: url.pathname, time: clock.now() });
        if (url.pathname === "/robots.txt")
          return Promise.resolve(new Response(null, { status: 404 }));
        if (url.pathname === "/blog")
          return Promise.resolve(
            new Response('<link rel="canonical" href="/target">', {
              headers: { "content-type": "text/html" },
            }),
          );
        targetAttempts++;
        return Promise.resolve(
          targetAttempts === 1
            ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
            : new Response('<a href="/never">never</a>', {
                headers: { "content-type": "text/html" },
              }),
        );
      },
    },
  );
  await flush();
  clock.advance(100);
  await flush();
  clock.advance(100);
  await flush();
  expect(attempts.map(({ path }) => path)).toEqual(["/robots.txt", "/blog", "/target"]);
  clock.advance(1999);
  await flush();
  expect(targetAttempts).toBe(1);
  clock.advance(1);
  const result = await pending;
  expect(attempts.map(({ time }) => time - Date.UTC(2026, 0, 1))).toEqual([0, 100, 200, 2200]);
  expect(result.run.destinations[1]?.outcome).toBe("successful");
  expect(result.run.pages).toHaveLength(1);
  expect(result.report).toContain("HTTP 200 after 2 attempts");
  expect(clock.timers.size).toBe(0);
});

test("checks canonical-only references independently of depth and page limits but within the destination budget", async () => {
  const routes = [
    {
      path: "/blog",
      responses: [
        html('<link rel="canonical" href="/blog/first"><link rel="canonical" href="/blog/second">'),
      ],
    },
    { path: "/blog/first", responses: [html('<a href="/blog/never">never</a>')] },
    { path: "/blog/second", responses: [{ status: 404 }] },
  ];
  const result = await audit(routes, { maxPages: 1, maxDepth: 0, maxDestinations: 2 });
  expect(result.run.executionStatus).toBe("limit-stopped");
  expect(result.run.pages).toHaveLength(1);
  expect(result.run.destinations.map(({ outcome }) => outcome)).toEqual([
    "successful",
    "successful",
    "limit-stopped",
  ]);
  expect(
    result.requests.some(
      (request) => request.url.endsWith("/second") || request.url.endsWith("/never"),
    ),
  ).toBe(false);
  expect(result.report).toContain("Checked-destination budget excluded this destination.");
  expect(
    result.run.observations.some((observation) => observation.kind === "broken-canonical"),
  ).toBe(false);
});
