import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "cheerio";

import { runAudit } from "../../src/audit-run";
import type { FixtureScenarioInput } from "../fixtures/scenarios";
import { startFixture } from "../fixtures/server";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const html = (body: string) => ({ headers: { "content-type": "text/html" }, body });
const page = (title: string, description: string, links = "") =>
  html(
    `<title>${title}</title><meta name="description" content="${description}"><h1>Heading</h1>${links}`,
  );
async function audit(
  routes: FixtureScenarioInput["routes"],
  options: { directory?: string; maxPages?: number } = {},
) {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "craw-duplicates-")));
  if (options.directory === undefined) directories.push(directory);
  const fixture = startFixture({ name: "duplicate-metadata", routes });
  const databasePath = join(directory, "audit.sqlite");
  try {
    const result = await runAudit(
      {
        startUrl: "https://site.example/blog",
        pathRestriction: "/blog",
        requests: { hostnameIntervalMs: 1, retries: 0 },
        ...(options.maxPages === undefined ? {} : { limits: { maxPages: options.maxPages } }),
      },
      {
        databasePath,
        reportPath: join(directory, "report.html"),
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: fixture.transport,
      },
    );
    return { ...result, databasePath, directory };
  } finally {
    await fixture.stop();
  }
}

function withDatabase<T>(path: string, inspect: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

test("retains grouped case-sensitive whitespace-equivalent metadata within this run", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [
        page(
          "  Shared\n title  ",
          " Shared\t &lt;description&gt; ",
          '<a href="/blog/second">second</a><a href="/blog/case">case</a>',
        ),
      ],
    },
    { path: "/blog/second", responses: [page("Shared title", "Shared &lt;description&gt;")] },
    { path: "/blog/case", responses: [page("shared title", "shared &lt;description&gt;")] },
  ]);
  const expected = [
    {
      kind: "duplicate-title",
      severity: "warning",
      scope: "within-this-run",
      value: "Shared title",
      pages: [
        { url: "https://site.example/blog", values: ["  Shared\n title  "] },
        { url: "https://site.example/blog/second", values: ["Shared title"] },
      ],
    },
    {
      kind: "duplicate-description",
      severity: "warning",
      scope: "within-this-run",
      value: "Shared <description>",
      pages: [
        { url: "https://site.example/blog", values: [" Shared\t <description> "] },
        { url: "https://site.example/blog/second", values: ["Shared <description>"] },
      ],
    },
  ] satisfies typeof result.run.duplicateMetadata;
  expect(result.run.pages.map((auditedPage) => auditedPage.url)).toContain(
    "https://site.example/blog/case",
  );
  expect(result.run.duplicateMetadata).toEqual(expected);
  withDatabase(result.databasePath, (db) => {
    const rows = db
      .query(
        "SELECT kind, severity, scope, value, pages FROM duplicate_metadata WHERE run_id = ? ORDER BY kind DESC, value",
      )
      .all(result.run.id);
    expect(rows).toEqual(
      expected.map((group) => ({ ...group, pages: JSON.stringify(group.pages) })),
    );
  });
});

test("escapes duplicate metadata values and their supporting declarations in HTML", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [
        page("&lt;script&gt;", "&lt;description&gt;", '<a href="/blog/second">second</a>'),
      ],
    },
    { path: "/blog/second", responses: [page("&lt;script&gt;", "&lt;description&gt;")] },
  ]);
  expect(result.report).toContain("&lt;script&gt;");
  expect(result.report).not.toContain("<script>");
  expect(result.report).toContain("&lt;description&gt;");
  expect(result.report).not.toContain("<description>");
});

test("counts duplicate metadata groups as SEO warnings in the report", async () => {
  const result = await audit([
    { path: "/blog", responses: [page("Shared", "Shared", '<a href="/blog/second">second</a>')] },
    { path: "/blog/second", responses: [page("Shared", "Shared")] },
  ]);
  expect(load(result.report)('[data-count="seo-warnings"]').text()).toBe("2");
});

test("excludes empty values, error pages and check-only destinations, and counts each audited page once", async () => {
  const result = await audit([
    {
      path: "/blog",
      responses: [
        page(
          "Shared",
          "Shared",
          '<a href="/blog/alias">alias</a><a href="/blog/second">direct</a><a href="/blog/empty">empty</a><a href="/blog/missing">missing</a><a href="/blog/error">error</a><a href="/blog/server">server</a><a href="/outside">outside</a><a href="https://other.example/external">external</a><a href="/blog/file">file</a>',
        ),
      ],
    },
    { path: "/blog/alias", responses: [{ status: 302, headers: { location: "/blog/second" } }] },
    {
      path: "/blog/second",
      responses: [
        page(
          " Shared ",
          " Shared ",
          '<meta name="robots" content="noindex"><meta name="description" content="Shared">',
        ),
      ],
    },
    { path: "/blog/empty", responses: [page(" \n ", " \t ")] },
    {
      path: "/blog/missing",
      responses: [html("<h1>Heading</h1><svg><title>Shared</title></svg>")],
    },
    { path: "/blog/error", responses: [{ ...page("Shared", "Shared"), status: 404 }] },
    { path: "/blog/server", responses: [{ ...page("Shared", "Shared"), status: 500 }] },
    { path: "/outside", responses: [page("Shared", "Shared")] },
    { path: "/external", hostname: "other.example", responses: [page("Shared", "Shared")] },
    {
      path: "/blog/file",
      responses: [{ headers: { "content-type": "text/plain" }, body: "<title>Shared</title>" }],
    },
  ]);
  expect(
    result.run.duplicateMetadata.map(({ kind, pages }) => [kind, pages.map(({ url }) => url)]),
  ).toEqual([
    ["duplicate-title", ["https://site.example/blog", "https://site.example/blog/second"]],
    ["duplicate-description", ["https://site.example/blog", "https://site.example/blog/second"]],
  ]);
  expect(result.run.duplicateMetadata[1]?.pages[1]?.values).toEqual([" Shared ", "Shared"]);
  expect(result.run.pages).toHaveLength(4);
});

test("retains duplicate groups from partial coverage without implying a website-wide inventory", async () => {
  const result = await audit(
    [
      {
        path: "/blog",
        responses: [
          page(
            "Shared",
            "Shared",
            '<a href="/blog/second">second</a><a href="/blog/excluded">excluded</a>',
          ),
        ],
      },
      { path: "/blog/second", responses: [page("Shared", "Shared")] },
      { path: "/blog/excluded", responses: [page("Shared", "Shared")] },
    ],
    { maxPages: 2 },
  );
  expect(result.run.executionStatus).toBe("limit-stopped");
  expect(result.run.duplicateMetadata.map(({ pages }) => pages.map(({ url }) => url))).toEqual([
    ["https://site.example/blog", "https://site.example/blog/second"],
    ["https://site.example/blog", "https://site.example/blog/second"],
  ]);
  expect(result.report).toContain("Partial report");
  expect(result.report).toContain("not a website-wide inventory");
  withDatabase(result.databasePath, (db) => {
    expect(
      db
        .query("SELECT count(*) AS count FROM duplicate_metadata WHERE run_id = ?")
        .get(result.run.id),
    ).toEqual({ count: 2 });
  });
});

test("retains separate runs without grouping metadata across invocations", async () => {
  const first = await audit([
    { path: "/blog", responses: [page("Shared", "Shared", '<a href="/blog/second">second</a>')] },
    { path: "/blog/second", responses: [page("Shared", "Shared")] },
  ]);
  const second = await audit([{ path: "/blog", responses: [page("Shared", "Shared")] }], {
    directory: first.directory,
  });
  expect(second.run.duplicateMetadata).toEqual([]);
  expect(second.report).not.toContain("duplicate-title — within this run");
  expect(second.report).not.toContain("duplicate-description — within this run");
  withDatabase(first.databasePath, (db) => {
    expect(db.query("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 2 });
    expect(
      db.query("SELECT run_id, kind FROM duplicate_metadata ORDER BY kind DESC").all(),
    ).toEqual([
      { run_id: first.run.id, kind: "duplicate-title" },
      { run_id: first.run.id, kind: "duplicate-description" },
    ]);
  });
});
