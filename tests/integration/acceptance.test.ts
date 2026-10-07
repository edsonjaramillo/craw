import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "cheerio";

import { runAudit } from "../../src/audit-run";
import { waitForBodies } from "../fixtures/observations";
import { adversarialScenario } from "../fixtures/scenarios/adversarial";
import { startFixture } from "../fixtures/server";

const configuration = {
  startUrl: "https://site.example/blog",
  pathRestriction: "/blog",
  crawlerIdentity: "AcceptanceBot",
  trackingParameterExclusions: ["utm"],
  requests: { hostnameIntervalMs: 1, retries: 0 },
};

test("combined graph retains original health and sources without expanding check-only or colliding identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-acceptance-"));
  const fixture = startFixture(adversarialScenario);
  const databasePath = join(directory, "audit.sqlite");
  try {
    const result = await runAudit(configuration, {
      databasePath,
      reportPath: join(directory, "report.html"),
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: fixture.transport,
    });
    expect(result.run.executionStatus).toBe("completed");
    expect(result.run.pages.map(({ url }) => url).toSorted()).toEqual(
      [
        "https://site.example/blog",
        "https://site.example/blog/item?b=2&utm=ok&a=1",
        "https://site.example/blog/item?a=1&b=2",
        "https://site.example/blog/source",
        "https://site.example/blog/leaf",
      ].toSorted(),
    );
    const requests = fixture.requests.map(({ url }) => url);
    expect(requests).not.toContain("https://site.example/blog/never");
    expect(requests).not.toContain("https://site.example/blog/blocked");
    expect(requests).not.toContain("https://site.example/blog/item?b=2&a=1");
    expect(requests.filter((url) => url.includes("/item?"))).toHaveLength(4);
    expect(
      fixture.requests.every(
        ({ method, identity }) => method === "GET" && identity === "AcceptanceBot",
      ),
    ).toBe(true);
    expect(result.run.destinations.find(({ url }) => url.endsWith("/stream"))?.status).toBe(200);
    expect(
      result.run.duplicateMetadata.map(({ value, pages }) => ({
        value,
        pages: pages.map(({ url }) => url),
      })),
    ).toEqual([
      {
        value: "Shared title",
        pages: ["https://site.example/blog", "https://site.example/blog/item?b=2&utm=ok&a=1"],
      },
      {
        value: "Shared description",
        pages: ["https://site.example/blog", "https://site.example/blog/item?b=2&utm=ok&a=1"],
      },
    ]);
    const report = load(result.report);
    expect(report('[data-count="seo-pages"]').text()).toBe("5");
    expect(report.text()).toContain("Confirmed broken links: 2");
    expect(report.text()).toContain("noindex");
    expect(report.text()).toContain("within this run");
    expect(report.text()).toContain("#again");
    await waitForBodies(fixture);
    const stream = fixture.requests.find(({ url }) => url.endsWith("/stream"));
    expect(stream?.bodyState).toBe("cancelled");
    expect(stream?.bytesProduced).toBeLessThan(65536 * 100);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(
        db
          .query("SELECT status, outcome FROM destinations WHERE url = ?")
          .get("https://site.example/blog/item?b=2&utm=gone&a=1"),
      ).toEqual({ status: 410, outcome: "confirmed-broken" });
      expect(
        db
          .query(
            "SELECT source_url FROM source_links WHERE destination_url = ? ORDER BY source_url",
          )
          .all("https://site.example/blog/item?b=2&utm=gone&a=1"),
      ).toEqual([
        { source_url: "https://site.example/blog" },
        { source_url: "https://site.example/blog/source" },
      ]);
      expect(
        db
          .query(
            "SELECT kind FROM seo_observations WHERE kind IN ('conflicting-canonicals', 'broken-canonical') ORDER BY kind",
          )
          .all(),
      ).toEqual([{ kind: "broken-canonical" }, { kind: "conflicting-canonicals" }]);
      // A second retained run must not borrow the first run's duplicate groups.
      fixture.reset();
      const second = await runAudit(
        { ...configuration, startUrl: "https://site.example/blog/source" },
        {
          databasePath,
          reportPath: join(directory, "second.html"),
          dns: () => Promise.resolve(["93.184.216.34"]),
          transport: fixture.transport,
        },
      );
      expect(second.run.duplicateMetadata).toEqual([]);
      expect(db.query("SELECT id FROM runs").all()).toHaveLength(2);
      expect(
        db.query("SELECT * FROM duplicate_metadata WHERE run_id = ?").all(second.run.id),
      ).toEqual([]);
      expect(
        db.query("SELECT * FROM duplicate_metadata WHERE run_id = ?").all(result.run.id),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
    await waitForBodies(fixture);
    expect(fixture.requests.every(({ bodyState }) => bodyState !== "pending")).toBe(true);
  } finally {
    await fixture.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [limits, pages, budget] of [
  [{ maxPages: 2 }, 2, "Page budget"],
  [{ maxDepth: 0 }, 1, "HTML-link depth"],
  [{ maxDestinations: 3 }, 2, "Checked-destination budget"],
] as const) {
  test(`combined graph preserves partial results at ${budget}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "craw-acceptance-limit-"));
    const fixture = startFixture(adversarialScenario);
    try {
      const databasePath = join(directory, "audit.sqlite");
      const result = await runAudit(
        { ...configuration, limits },
        {
          databasePath,
          reportPath: join(directory, "report.html"),
          dns: () => Promise.resolve(["93.184.216.34"]),
          transport: fixture.transport,
        },
      );
      expect(result.run.executionStatus).toBe("limit-stopped");
      expect(result.run.pages).toHaveLength(pages);
      expect(load(result.report).text()).toContain(budget);
      const db = new Database(databasePath, { readonly: true });
      try {
        expect(db.query("SELECT execution_status FROM runs").get()).toEqual({
          execution_status: "limit-stopped",
        });
        expect(db.query("SELECT * FROM pages").all()).toHaveLength(pages);
        expect(db.query("SELECT * FROM source_links").all().length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
      expect(fixture.requests.some(({ url }) => url.endsWith("/never"))).toBe(false);
    } finally {
      await fixture.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
