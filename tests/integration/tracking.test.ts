import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit } from "../../src/audit-run";
import type { FixtureScenarioInput } from "../fixtures/scenarios";
import { startFixture } from "../fixtures/server";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function audit(scenario: FixtureScenarioInput, configuration: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "craw-tracking-"));
  directories.push(directory);
  const databasePath = join(directory, "audit.sqlite");
  const fixture = startFixture(scenario);
  try {
    const result = await runAudit(
      {
        startUrl: "https://site.example/blog",
        pathRestriction: "/blog",
        requests: { hostnameIntervalMs: 1 },
        ...configuration,
      },
      {
        databasePath,
        reportPath: join(directory, "report.html"),
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: fixture.transport,
      },
    );
    return { ...result, databasePath, requests: fixture.requests.map((request) => request.url) };
  } finally {
    await fixture.stop();
  }
}

const html = (body: string) => ({ headers: { "content-type": "text/html" }, body });

const variants: FixtureScenarioInput = {
  name: "tracking-original-health",
  routes: [
    { path: "/robots.txt", responses: [{ status: 404 }] },
    {
      path: "/blog",
      responses: [
        html(
          '<a href="/blog/item?b=2&utm=ok&a=1#first">ok</a><a href="/blog/item?b=2&utm=gone&a=1#gone">gone</a><a href="/blog/item?b=2&utm=other&a=1">other</a><a href="/blog/source">source</a>',
        ),
      ],
    },
    { path: "/blog/item?b=2&utm=ok&a=1", responses: [html('<area href="/blog/leaf">leaf')] },
    { path: "/blog/item?b=2&utm=gone&a=1", responses: [{ status: 410 }] },
    { path: "/blog/item?b=2&utm=other&a=1", responses: [html('<a href="/blog/never">never</a>')] },
    { path: "/blog/leaf", responses: [html("leaf")] },
    {
      path: "/blog/source",
      responses: [html('<a href="/blog/item?b=2&utm=gone&a=1#again">gone again</a>')],
    },
  ],
};

test("original variants retain independent health, normalized identity and every source in SQLite and reports", async () => {
  const result = await audit(variants, { trackingParameterExclusions: ["utm"] });
  const originals = result.run.destinations.filter((destination) =>
    destination.url.includes("/item?"),
  );
  expect(originals.map((destination) => [destination.url, destination.status])).toEqual([
    ["https://site.example/blog/item?b=2&utm=ok&a=1", 200],
    ["https://site.example/blog/item?b=2&utm=gone&a=1", 410],
    ["https://site.example/blog/item?b=2&utm=other&a=1", 200],
  ]);
  expect(
    result.run.pages.filter(
      (page) => page.crawlIdentity === "https://site.example/blog/item?b=2&a=1",
    ),
  ).toHaveLength(1);
  expect(result.requests.filter((url) => url.includes("/item?"))).toHaveLength(3);
  expect(result.requests.some((url) => url.endsWith("/never"))).toBe(false);
  expect(result.report).toContain("Confirmed broken links: 1");
  expect(result.report).toContain("#gone");
  expect(result.report).toContain("#again");
  const db = new Database(result.databasePath, { readonly: true });
  try {
    expect(
      db
        .query("SELECT status, outcome FROM destinations WHERE url = ?")
        .get("https://site.example/blog/item?b=2&utm=gone&a=1"),
    ).toEqual({ status: 410, outcome: "confirmed-broken" });
    expect(
      db
        .query(
          "SELECT source_url, href FROM source_links WHERE destination_url = ? ORDER BY source_url",
        )
        .all("https://site.example/blog/item?b=2&utm=gone&a=1"),
    ).toEqual([
      { source_url: "https://site.example/blog", href: "/blog/item?b=2&utm=gone&a=1#gone" },
      { source_url: "https://site.example/blog/source", href: "/blog/item?b=2&utm=gone&a=1#again" },
    ]);
    const response = db
      .query<{ evidence: string }, [string]>(
        "SELECT evidence FROM destination_responses WHERE url = ?",
      )
      .get("https://site.example/blog/item?b=2&utm=gone&a=1");
    expect(JSON.parse(response!.evidence)).toMatchObject({
      crawlIdentity: "https://site.example/blog/item?b=2&a=1",
    });
  } finally {
    db.close();
  }
  expect(result.report).toContain(
    "<dt>Crawl identity</dt><dd>https://site.example/blog/item?b=2&amp;a=1</dd>",
  );
});

test("default exclusions preserve query order, tracking variants and raw query encoding", async () => {
  const paths = [
    "/blog/item?b=2&a=1&utm=one",
    "/blog/item?a=1&b=2&utm=one",
    "/blog/item?b=2&a=1&utm=two",
    "/blog/item?q=a%20b",
    "/blog/item?q=a+b",
  ];
  const result = await audit({
    name: "default-query-identities",
    routes: [
      { path: "/robots.txt", responses: [{ status: 404 }] },
      {
        path: "/blog",
        responses: [html(paths.map((path) => `<a href="${path}">item</a>`).join(""))],
      },
      ...paths.map((path) => ({ path, responses: [html("item")] })),
    ],
  });
  expect(result.run.configuration.trackingParameterExclusions).toEqual([]);
  expect(result.run.pages.slice(1).map((page) => page.crawlIdentity)).toEqual([
    "https://site.example/blog/item?b=2&a=1&utm=one",
    "https://site.example/blog/item?a=1&b=2&utm=one",
    "https://site.example/blog/item?b=2&a=1&utm=two",
    "https://site.example/blog/item?q=a%20b",
    "https://site.example/blog/item?q=a+b",
  ]);
  expect(result.run.destinations.every((destination) => destination.status === 200)).toBe(true);
});

test("exclusions remove only configured decoded keys without reserializing remaining queries", async () => {
  const result = await audit(
    {
      name: "lossless-query-exclusions",
      routes: [
        { path: "/robots.txt", responses: [{ status: 404 }] },
        {
          path: "/blog",
          responses: [html('<a href="/blog/item?b=2&%75tm=x&q=a%20b&utm=y&a=1&UTM=z">item</a>')],
        },
        { path: "/blog/item?b=2&%75tm=x&q=a%20b&utm=y&a=1&UTM=z", responses: [html("item")] },
      ],
    },
    { trackingParameterExclusions: ["utm"] },
  );
  expect(result.run.pages[1]?.crawlIdentity).toBe(
    "https://site.example/blog/item?b=2&q=a%20b&a=1&UTM=z",
  );
  expect(result.requests).toContain(
    "https://site.example/blog/item?b=2&%75tm=x&q=a%20b&utm=y&a=1&UTM=z",
  );
  expect(result.requests).not.toContain("https://site.example/blog/item?b=2&q=a%20b&a=1&UTM=z");
});

for (const [limits, pageCount, checkedUrls, budget] of [
  [{ maxPages: 2 }, 2, 6, "Page budget"],
  [{ maxDestinations: 3 }, 2, 3, "Checked-destination budget"],
] as const) {
  test(`normalized variants and check-only destinations cannot bypass ${budget}`, async () => {
    const result = await audit(
      {
        name: "tracking-budget",
        routes: [
          { path: "/robots.txt", responses: [{ status: 404 }] },
          {
            path: "/blog",
            responses: [
              html(
                '<a href="/blog/item?utm=one">one</a><a href="/outside?utm=one">outside</a><a href="/blog/item?utm=two">two</a><a href="/outside?utm=two">outside two</a><a href="/blog/other">other</a>',
              ),
            ],
          },
          { path: "/blog/item?utm=one", responses: [html("one")] },
          { path: "/blog/item?utm=two", responses: [html("two")] },
          { path: "/outside?utm=one", responses: [html('<a href="/blog/never">never</a>')] },
          { path: "/outside?utm=two", responses: [html('<a href="/blog/never">never</a>')] },
          { path: "/blog/other", responses: [html("other")] },
        ],
      },
      { trackingParameterExclusions: ["utm"], limits },
    );
    expect(result.run.executionStatus).toBe("limit-stopped");
    expect(result.run.pages).toHaveLength(pageCount);
    expect(result.requests.filter((url) => !url.endsWith("/robots.txt"))).toHaveLength(checkedUrls);
    expect(result.run.destinations).toHaveLength(6);
    expect(result.requests.some((url) => url.endsWith("/never"))).toBe(false);
    expect(result.report).toContain(budget);
    expect(result.report).toContain("Pages eligible for SEO: 2");
    expect(result.report).toContain("Destinations retained: 6");
    const db = new Database(result.databasePath, { readonly: true });
    try {
      expect(db.query("SELECT * FROM pages").all()).toHaveLength(2);
      expect(
        db.query("SELECT * FROM destinations WHERE outcome = 'successful'").all(),
      ).toHaveLength(checkedUrls);
      expect(db.query("SELECT * FROM source_links").all()).toHaveLength(5);
    } finally {
      db.close();
    }
  });
}
