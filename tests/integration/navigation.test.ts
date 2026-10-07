import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { runAudit } from "../../src/audit-run";
import { startFixture } from "../fixtures/server";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function audit(
  pages: Record<
    string,
    string | { body: Uint8Array<ArrayBuffer>; headers: Record<string, string>; status?: number }
  >,
  configuration: Record<string, unknown> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "craw-navigation-"));
  directories.push(directory);
  const requests: string[] = [];
  const databasePath = join(directory, "audit.sqlite");
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
      transport: ({ url }) => {
        requests.push(url.href);
        const page = pages[url.href];
        return Promise.resolve(
          url.pathname === "/robots.txt" || page === undefined
            ? new Response(null, { status: 404 })
            : typeof page === "string"
              ? new Response(page, { headers: { "content-type": "text/html" } })
              : new Response(page.body, { headers: page.headers, status: page.status }),
        );
      },
    },
  );
  return { ...result, requests, databasePath };
}

test("traverses navigation links while retaining every source and checking boundary destinations only", async () => {
  const result = await audit({
    "https://site.example/blog":
      '<a href="/blog/child#one">child</a><area href="/blog/child#two"><a href="/blogger">sibling</a><a href="https://other.example/">external</a><a href="http://site.example/blog">http</a>',
    "https://site.example/blog/child":
      '<a href="/missing">broken</a><a href="https://other.example/">shared</a>',
    "http://site.example/blog": '<a href="/blog/child">http child</a>',
    "http://site.example/blog/child": "<p>child</p>",
    "https://site.example/blogger": '<a href="/never">never</a>',
    "https://other.example/": '<a href="/never">never</a>',
  });
  expect(result.run.pages.map((page) => page.url).toSorted()).toEqual([
    "http://site.example/blog",
    "http://site.example/blog/child",
    "https://site.example/blog",
    "https://site.example/blog/child",
  ]);
  expect(result.requests.filter((url) => url === "https://site.example/blog/child")).toHaveLength(
    1,
  );
  expect(result.requests.filter((url) => url === "https://other.example/")).toHaveLength(1);
  expect(result.requests.some((url) => url.includes("never"))).toBe(false);
  expect(
    result.run.links.filter((link) => link.destinationUrl === "https://site.example/blog/child"),
  ).toHaveLength(2);
  expect(result.report).toContain("https://site.example/blog/child");
  expect(result.report).toContain("/missing");
  const db = new Database(result.databasePath, { readonly: true });
  try {
    expect(db.query("SELECT * FROM pages").all()).toHaveLength(4);
    expect(
      db.query("SELECT * FROM source_links WHERE destination_url = 'https://other.example/'").all(),
    ).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("resolves valid bases and relative areas without losing query ordering or original health evidence", async () => {
  const result = await audit(
    {
      "https://site.example/blog":
        '<base href="http://["><base href="/blog/folder/"><base href="https://ignored.example/"><area href="../child?b=2&a=1#map"><a href="item?q=a%20b&utm=x">one</a><a href="item?q=a%20b&utm=y">two</a><a href="mailto:a@example.com">mail</a><a href="javascript:void(0)">js</a>',
      "https://site.example/blog/child?b=2&a=1": "<p>child</p>",
      "https://site.example/blog/folder/item?q=a%20b&utm=x": '<a href="/blog/only-once">expand</a>',
      "https://site.example/blog/only-once": "<p>once</p>",
    },
    { trackingParameterExclusions: ["utm"] },
  );
  expect(
    result.run.destinations.map((destination) => [destination.url, destination.outcome]),
  ).toContainEqual(["https://site.example/blog/folder/item?q=a%20b&utm=y", "confirmed-broken"]);
  expect(result.run.pages.map((page) => page.crawlIdentity)).toContain(
    "https://site.example/blog/folder/item?q=a%20b",
  );
  expect(result.requests).toContain("https://site.example/blog/child?b=2&a=1");
  expect(result.run.links.map((link) => link.href)).toContain("../child?b=2&a=1#map");
  expect(result.requests.some((url) => /ignored|mailto|javascript/u.test(url))).toBe(false);
});

test("decodes compressed HTML before discovering destinations", async () => {
  const result = await audit({
    "https://site.example/blog": {
      body: new Uint8Array(gzipSync('<a href="/blog/child">child</a>')),
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
    },
    "https://site.example/blog/child": "<p>child</p>",
  });
  expect(result.run.pages.map((page) => page.url)).toEqual([
    "https://site.example/blog",
    "https://site.example/blog/child",
  ]);
});

for (const declaration of ["http", "meta"] as const) {
  test(`decodes legacy HTML ${declaration} charsets without corrupting href evidence`, async () => {
    const result = await audit({
      "https://site.example/blog": {
        body: new Uint8Array(
          Buffer.from(
            `${declaration === "meta" ? '<meta charset="iso-8859-1">' : ""}<a href="/blog/café">café</a>`,
            "latin1",
          ),
        ),
        headers: {
          "content-type": declaration === "http" ? "text/html; charset=iso-8859-1" : "text/html",
        },
      },
      "https://site.example/blog/caf%C3%A9": "<p>child</p>",
    });
    expect(result.requests).toContain("https://site.example/blog/caf%C3%A9");
    expect(result.run.links[0]?.href).toBe("/blog/café");
    expect(result.report).toContain("/blog/café");
  });
}

test("unsupported content encoding retains health while visibly excluding HTML discovery", async () => {
  const result = await audit({
    "https://site.example/blog": {
      body: new Uint8Array([0, 1]),
      headers: { "content-type": "text/html", "content-encoding": "unknown" },
    },
  });
  expect(result.run.destination.outcome).toBe("successful");
  expect(result.run.pages).toHaveLength(0);
  expect(result.report).toContain("Unsupported HTML content encoding");
});

test("distinct final crawl identities expand even when redirecting originals share tracking identity", async () => {
  const result = await audit(
    {
      "https://site.example/blog":
        '<a href="/blog/alias?utm=one">one</a><a href="/blog/alias?utm=two">two</a>',
      "https://site.example/blog/alias?utm=one": {
        body: new Uint8Array(),
        status: 302,
        headers: { location: "/blog/first" },
      },
      "https://site.example/blog/alias?utm=two": {
        body: new Uint8Array(),
        status: 302,
        headers: { location: "/blog/second" },
      },
      "https://site.example/blog/first": '<area href="/blog/first-child">first</area>',
      "https://site.example/blog/second": '<a href="/blog/second-child">second</a>',
    },
    { trackingParameterExclusions: ["utm"], limits: { maxDepth: 1 } },
  );
  expect(result.run.pages.map((page) => [page.url, page.depth])).toEqual([
    ["https://site.example/blog", 0],
    ["https://site.example/blog/first", 1],
    ["https://site.example/blog/second", 1],
  ]);
  expect(result.requests).toContain("https://site.example/blog/second-child");
});

test("tracking exclusions leave untouched empty query identities distinct", async () => {
  const result = await audit(
    {
      "https://site.example/blog":
        '<a href="/blog/child?">empty query</a><a href="/blog/child">no query</a>',
      "https://site.example/blog/child?": "<p>empty query</p>",
      "https://site.example/blog/child": "<p>no query</p>",
    },
    { trackingParameterExclusions: ["utm"] },
  );
  expect(result.run.pages.map((page) => page.crawlIdentity)).toEqual([
    "https://site.example/blog",
    "https://site.example/blog/child?",
    "https://site.example/blog/child",
  ]);
});

for (const [limits, expectedPages, excluded] of [
  [{ maxPages: 1 }, ["https://site.example/blog"], "Page budget"],
  [{ maxDepth: 0 }, ["https://site.example/blog"], "HTML-link depth budget"],
  [
    { maxDestinations: 2 },
    ["https://site.example/blog", "https://site.example/blog/child"],
    "Checked-destination budget",
  ],
] as const) {
  test(`independent budgets visibly exclude work: ${excluded}`, async () => {
    const result = await audit(
      {
        "https://site.example/blog":
          '<a href="/blog/child">child</a><a href="https://other.example/">external</a>',
        "https://site.example/blog/child": '<a href="/blog/grandchild">grandchild</a>',
        "https://other.example/": '<a href="/never">never</a>',
      },
      { limits },
    );
    expect(result.run.executionStatus).toBe("limit-stopped");
    expect(result.run.pages.map((page) => page.url)).toEqual([...expectedPages]);
    expect(result.report).toContain(excluded);
    expect(result.report).toContain("Partial report");
    expect(result.requests.includes("https://other.example/")).toBe(
      excluded !== "Checked-destination budget",
    );
    if (excluded !== "Checked-destination budget")
      expect(
        result.run.destinations.find((destination) => destination.url === "https://other.example/")
          ?.outcome,
      ).toBe("successful");
  });
}

test("crawl identities deduplicate successful expansion but not original destination checks", async () => {
  const result = await audit(
    {
      "https://site.example/blog":
        '<a href="/blog/variant?utm=one">one</a><a href="/blog/variant?utm=two">two</a>',
      "https://site.example/blog/variant?utm=one": '<a href="/blog/first">first</a>',
      "https://site.example/blog/variant?utm=two": '<a href="/blog/second">second</a>',
      "https://site.example/blog/first": '<a href="/blog">cycle</a>',
    },
    { trackingParameterExclusions: ["utm"] },
  );
  expect(
    result.run.destinations.filter((destination) => destination.url.includes("variant")),
  ).toHaveLength(2);
  expect(
    result.run.pages.filter((page) => page.crawlIdentity === "https://site.example/blog/variant"),
  ).toHaveLength(1);
  expect(result.requests).not.toContain("https://site.example/blog/second");
  expect(result.requests.filter((url) => url === "https://site.example/blog")).toHaveLength(1);
});

test("real fixture redirects and robots never allow check-only HTML to expand scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-navigation-fixture-"));
  directories.push(directory);
  const fixture = startFixture({
    name: "navigation-boundary",
    routes: [
      { path: "/robots.txt", responses: [{ body: "User-agent: *\nDisallow: /blog/blocked\n" }] },
      {
        path: "/blog",
        responses: [
          {
            headers: { "content-type": "text/html" },
            body: '<a href="/blog/redirect">redirect</a><a href="https://other.example/back">external redirect</a><a href="/blog/blocked">blocked</a><a href="/blog/error">error</a><a href="/blog/noindex">noindex</a>',
          },
        ],
      },
      {
        path: "/blog/redirect",
        responses: [{ status: 302, headers: { location: "https://other.example/landing" } }],
      },
      {
        path: "/back",
        hostname: "other.example",
        responses: [{ status: 302, headers: { location: "https://site.example/blog/back" } }],
      },
      {
        path: "/landing",
        hostname: "other.example",
        responses: [
          { headers: { "content-type": "text/html" }, body: '<a href="/never">never</a>' },
        ],
      },
      {
        path: "/blog/back",
        responses: [
          { headers: { "content-type": "text/html" }, body: '<a href="/blog/never">never</a>' },
        ],
      },
      {
        path: "/blog/error",
        responses: [
          {
            status: 404,
            headers: { "content-type": "text/html" },
            body: '<a href="/blog/never">never</a>',
          },
        ],
      },
      {
        path: "/blog/noindex",
        responses: [
          {
            headers: { "content-type": "text/html" },
            body: '<meta name="robots" content="noindex"><area href="/blog/leaf">leaf',
          },
        ],
      },
      {
        path: "/blog/leaf",
        responses: [{ headers: { "content-type": "text/html" }, body: "<p>leaf</p>" }],
      },
    ],
  });
  try {
    const result = await runAudit(
      {
        startUrl: "https://site.example/blog",
        pathRestriction: "/blog/",
        requests: { hostnameIntervalMs: 1 },
      },
      {
        databasePath: join(directory, "audit.sqlite"),
        reportPath: join(directory, "report.html"),
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: fixture.transport,
      },
    );
    expect(result.run.pages.map((page) => page.url)).toEqual([
      "https://site.example/blog",
      "https://site.example/blog/noindex",
      "https://site.example/blog/leaf",
    ]);
    expect(fixture.requests.some((request) => /never|blocked/u.test(request.url))).toBe(false);
    expect(
      result.run.destinations.find((destination) => destination.url.endsWith("blocked"))?.outcome,
    ).toBe("robots-excluded");
    expect(
      result.run.destinations.find((destination) => destination.url.endsWith("redirect"))?.finalUrl,
    ).toBe("https://other.example/landing");
    expect(result.report).toContain("robots-excluded");
  } finally {
    await fixture.stop();
  }
});
