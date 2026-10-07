import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit } from "../../src/audit-run";
import type { AuditTransport } from "../../src/guarded-transport";
import type { FixtureScenarioInput } from "../fixtures/scenarios";
import { startFixture } from "../fixtures/server";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function audit(routes: FixtureScenarioInput["routes"], transport?: AuditTransport) {
  const directory = await mkdtemp(join(tmpdir(), "craw-seo-"));
  directories.push(directory);
  const fixture = startFixture({ name: "page-local-seo", routes });
  const databasePath = join(directory, "audit.sqlite");
  try {
    const result = await runAudit(
      {
        startUrl: "https://site.example/blog",
        pathRestriction: "/blog",
        requests: { hostnameIntervalMs: 1 },
      },
      {
        databasePath,
        reportPath: join(directory, "report.html"),
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: transport ?? fixture.transport,
      },
    );
    return { ...result, databasePath, requests: fixture.requests };
  } finally {
    await fixture.stop();
  }
}
const html = (body: string) => ({ headers: { "content-type": "text/html" }, body });

test("retains generic and bot-specific indexing evidence without treating noindex as an error", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [
        {
          headers: {
            "content-type": "text/html",
            "x-robots-tag":
              "noindex, max-snippet: 50, max-image-preview: large, max-video-preview: -1, googlebot: nofollow, noarchive, bingbot: index, follow, unavailable_after: 25 Jun 2030 15:00:00 PST",
          },
          body: '<title>Page</title><meta name="description"><h1>Heading</h1><meta name="ROBOTS" content="noindex, follow"><meta name="Googlebot" content="index, nofollow"><meta name="bingbot" content="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"><meta name="archive-agent" content="noindex">',
        },
      ],
    },
  ]);
  expect(result.run.pages).toHaveLength(1);
  expect(
    result.run.observations
      .filter((observation) => observation.kind === "indexing-directives")
      .map(({ scope, source, severity }) => [scope, source, severity]),
  ).toEqual([
    ["*", "meta", "info"],
    ["Googlebot", "meta", "info"],
    ["bingbot", "meta", "info"],
    ["archive-agent", "meta", "info"],
    ["*", "header", "info"],
    ["googlebot", "header", "info"],
    ["bingbot", "header", "info"],
  ]);
  expect(
    result.run.observations.find(
      (observation) => observation.source === "header" && observation.scope === "*",
    )?.evidence,
  ).toContain("max-snippet: 50, max-image-preview: large, max-video-preview: -1");
  expect(
    result.run.observations.find((observation) => observation.scope === "googlebot")?.evidence,
  ).toContain("nofollow, noarchive");
  expect(
    result.run.observations.find(
      (observation) => observation.scope === "bingbot" && observation.source === "header",
    )?.evidence,
  ).toContain("unavailable_after: 25 Jun 2030 15:00:00 PST");
  expect(
    result.run.observations.some((observation) => observation.kind === "empty-description"),
  ).toBe(true);
  expect(result.report).toContain("scope: Googlebot (meta)");
  expect(result.report).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  expect(result.report).not.toContain('<script>alert("x")</script>');
  const db = new Database(result.databasePath, { readonly: true });
  try {
    expect(
      db
        .query(
          "SELECT scope, source, severity FROM seo_observations WHERE kind = 'indexing-directives' ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      { scope: "*", source: "meta", severity: "info" },
      { scope: "Googlebot", source: "meta", severity: "info" },
      { scope: "bingbot", source: "meta", severity: "info" },
      { scope: "archive-agent", source: "meta", severity: "info" },
      { scope: "*", source: "header", severity: "info" },
      { scope: "googlebot", source: "header", severity: "info" },
      { scope: "bingbot", source: "header", severity: "info" },
    ]);
  } finally {
    db.close();
  }
});

test("keeps separate X-Robots-Tag field scopes rather than leaking a bot scope into a generic field", async () => {
  const result = await audit([{ path: "/unused", responses: [html("unused")] }], ({ url }) =>
    Promise.resolve(
      url.pathname === "/robots.txt"
        ? new Response(null, { status: 404 })
        : Object.assign(
            new Response(
              '<title>Title</title><meta name="description" content="Description"><h1>Heading</h1>',
              {
                headers: {
                  "content-type": "text/html",
                  "x-robots-tag": "googlebot: noindex, nofollow, noarchive",
                },
              },
            ),
            {
              rawHeaders: [
                "Content-Type",
                "text/html",
                "X-Robots-Tag",
                "googlebot: noindex, nofollow",
                "X-Robots-Tag",
                "noarchive",
              ],
            },
          ),
    ),
  );
  expect(
    result.run.observations
      .filter((observation) => observation.kind === "indexing-directives")
      .map(({ scope, source }) => [scope, source]),
  ).toEqual([
    ["googlebot", "header"],
    ["*", "header"],
  ]);
  expect(result.run.observations[1]?.evidence).toContain("noarchive");
});

test("inspects only final successful in-boundary HTML, including noindex, and escapes website evidence", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [
        html(
          '<title>Home</title><meta name="description" content="Home"><h1>Home</h1><a href="/blog/alias">alias</a><a href="/blog/landing">direct</a><a href="/blog/noindex">noindex</a><a href="/blog/error">error</a><a href="/blog/server-error">server</a><a href="/outside">outside</a><a href="https://other.example/external">external</a><a href="/blog/cross-boundary">cross boundary</a><a href="/blog/file">file</a>',
        ),
      ],
    },
    {
      path: "/blog/alias",
      responses: [
        {
          status: 302,
          headers: { location: "/blog/landing", "x-robots-tag": "redirect-only: noindex" },
        },
      ],
    },
    {
      path: "/blog/landing",
      responses: [
        html(
          '<title> </title><meta name="description" content="Landing"><h1>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</h1><h1>Second &amp; heading</h1>',
        ),
      ],
    },
    {
      path: "/blog/noindex",
      responses: [html('<meta name="robots" content="noindex"><a href="/blog/leaf">leaf</a>')],
    },
    {
      path: "/blog/leaf",
      responses: [html('<title>Leaf</title><meta name="description" content="Leaf"><h1>Leaf</h1>')],
    },
    {
      path: "/blog/error",
      responses: [{ ...html('<meta name="robots" content="excluded-error">'), status: 404 }],
    },
    {
      path: "/blog/server-error",
      responses: [{ ...html('<meta name="robots" content="excluded-server">'), status: 500 }],
    },
    {
      path: "/outside",
      responses: [
        html('<meta name="robots" content="excluded-outside"><a href="/blog/never">never</a>'),
      ],
    },
    {
      path: "/external",
      hostname: "other.example",
      responses: [
        html('<meta name="robots" content="excluded-external"><a href="/blog/never">never</a>'),
      ],
    },
    {
      path: "/blog/cross-boundary",
      responses: [{ status: 302, headers: { location: "/outside" } }],
    },
    {
      path: "/blog/file",
      responses: [
        {
          headers: { "content-type": "text/plain", "x-robots-tag": "excluded-file" },
          body: "<title> </title>",
        },
      ],
    },
  ]);
  expect(
    result.run.observations
      .filter((observation) => observation.kind !== "missing-canonical")
      .map((observation) => observation.url),
  ).toEqual([
    "https://site.example/blog/landing",
    "https://site.example/blog/landing",
    "https://site.example/blog/noindex",
    "https://site.example/blog/noindex",
    "https://site.example/blog/noindex",
    "https://site.example/blog/noindex",
  ]);
  expect(result.run.pages.map((page) => page.url)).toContain("https://site.example/blog/leaf");
  expect(result.run.observations.some((observation) => observation.scope === "redirect-only")).toBe(
    false,
  );
  expect(result.requests.some((request) => request.url.endsWith("/never"))).toBe(false);
  expect(result.report).toContain("&lt;img src=x onerror=\\&quot;alert(1)\\&quot;&gt;");
  expect(result.report).not.toContain('<img src=x onerror="alert(1)">');
});

test("does not confuse SVG titles or descriptive metadata with page SEO evidence", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [
        html(
          '<meta name="description" content="Description"><h1>Heading</h1><svg><title>Search icon</title></svg><meta name="copyright" content="All rights reserved"><meta name="rating" content="all"><a href="/blog/titled">titled</a>',
        ),
      ],
    },
    {
      path: "/blog/titled",
      responses: [
        html(
          '<title>Page title</title><meta name="description" content="Description"><h1>Heading</h1><svg><title> </title></svg>',
        ),
      ],
    },
  ]);
  expect(
    result.run.observations.filter((observation) => observation.kind !== "missing-canonical"),
  ).toEqual([
    {
      url: "https://site.example/blog",
      kind: "missing-title",
      severity: "warning",
      evidence: "No title declaration found.",
    },
  ]);
});

test("reports missing versus empty metadata and H1 counts with severities and retained evidence", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [html('<a href="/blog/empty">empty</a><a href="/blog/healthy">healthy</a>')],
    },
    {
      path: "/blog/empty",
      responses: [
        html(
          '<title> \n </title><meta name="description" content=" \t "><h1>First &amp; heading</h1><h1>Second</h1>',
        ),
      ],
    },
    {
      path: "/blog/healthy",
      responses: [
        html(
          '<title>Useful title</title><meta name="description" content="Useful description"><h1>One</h1>',
        ),
      ],
    },
  ]);
  expect(
    result.run.observations
      .filter((observation) => observation.kind !== "missing-canonical")
      .map(({ url, kind, severity }) => [url, kind, severity]),
  ).toEqual([
    ["https://site.example/blog", "missing-title", "warning"],
    ["https://site.example/blog", "missing-description", "info"],
    ["https://site.example/blog", "missing-h1", "warning"],
    ["https://site.example/blog/empty", "empty-title", "warning"],
    ["https://site.example/blog/empty", "empty-description", "info"],
    ["https://site.example/blog/empty", "multiple-h1", "warning"],
  ]);
  expect(
    result.run.observations.find((observation) => observation.kind === "multiple-h1")?.evidence,
  ).toContain("First & heading");
  expect(result.report).toContain("multiple-h1");
  expect(result.report).toContain("warning");
  expect(result.report).toContain("First &amp; heading");
  expect(result.report).not.toContain("SEO checks are not yet implemented");
  const db = new Database(result.databasePath, { readonly: true });
  try {
    expect(
      db
        .query("SELECT url, kind, severity FROM seo_observations WHERE run_id = ? ORDER BY rowid")
        .all(result.run.id),
    ).toEqual(result.run.observations.map(({ url, kind, severity }) => ({ url, kind, severity })));
    expect(
      db.query("SELECT evidence FROM seo_observations WHERE kind = 'multiple-h1'").get(),
    ).toEqual({
      evidence: result.run.observations.find((observation) => observation.kind === "multiple-h1")!
        .evidence,
    });
  } finally {
    db.close();
  }
});
