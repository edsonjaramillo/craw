import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "cheerio";

import { runAudit } from "../../src/audit-run";
import { startFixture } from "../fixtures/server";

const html = (body: string) => ({ headers: { "content-type": "text/html" }, body });

test("standalone issue groups reconcile mixed outcomes, sources and evidence with the retained run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-report-"));
  const fixture = startFixture({
    name: "actionable-report",
    routes: [
      {
        path: "/",
        responses: [
          html(
            '<title>Shared</title><meta name="description" content="Shared description"><h1>Home</h1><link rel="canonical" href="/gone"><a href="/gone#source">gone</a><a href="/missing">missing</a><a href="/server">server</a><a href="/private">private</a><a href="/client">client</a><a href="/transient">transient</a><a href="/excluded">excluded</a><a href="http://127.0.0.1/">refused</a><a href="/loop">loop</a><a href="/redirect">redirect</a><a href="/second">second</a>',
          ),
        ],
      },
      { path: "/robots.txt", responses: [{ body: "User-agent: *\nDisallow: /excluded" }] },
      { path: "/gone", responses: [{ status: 410 }] },
      { path: "/missing", responses: [{ status: 404 }] },
      { path: "/server", responses: [{ status: 500 }] },
      { path: "/private", responses: [{ status: 403 }] },
      { path: "/client", responses: [{ status: 422 }] },
      { path: "/transient", responses: [{ status: 429 }] },
      { path: "/loop", responses: [{ status: 302, headers: { location: "/loop" } }] },
      { path: "/redirect", responses: [{ status: 302, headers: { location: "/second" } }] },
      {
        path: "/second",
        responses: [
          html(
            '<title> Shared </title><meta name="description" content="Shared description"><h1>Second</h1><meta name="robots" content="&lt;img src=x onerror=alert(1)&gt;"><a href="/gone#second">gone</a>',
          ),
        ],
      },
    ],
  });
  const databasePath = join(directory, "audit.sqlite");
  try {
    const result = await runAudit(
      { startUrl: "https://site.example/", requests: { hostnameIntervalMs: 1, retries: 0 } },
      {
        databasePath,
        reportPath: join(directory, "report.html"),
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: fixture.transport,
      },
    );
    const $ = load(result.report);
    const db = new Database(databasePath, { readonly: true });
    try {
      const counts = db
        .query<{ outcome: string; count: number }, [string]>(
          "SELECT outcome, count(*) AS count FROM destinations WHERE run_id = ? GROUP BY outcome",
        )
        .all(result.run.id);
      for (const { outcome, count } of counts) {
        expect($(`[data-count="${outcome}"]`).text()).toBe(String(count));
        expect($(`[data-issue="${outcome}"] [data-destination]`)).toHaveLength(count);
      }
      const seoRows = db
        .query<{ kind: string; severity: string; count: number }, [string]>(
          "SELECT kind, severity, count(*) AS count FROM seo_observations WHERE run_id = ? GROUP BY kind, severity",
        )
        .all(result.run.id);
      for (const row of seoRows) {
        const group = $(`[data-issue="${row.kind}"]`);
        expect(group.attr("data-severity")).toBe(row.severity);
        expect(group.find("li")).toHaveLength(row.count);
      }
      for (const [severity, name] of [
        ["error", "seo-errors"],
        ["warning", "seo-warnings"],
        ["info", "seo-info"],
      ]) {
        const local = db
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM seo_observations WHERE run_id = ? AND severity = ?",
          )
          .get(result.run.id, severity!)!.count;
        const duplicates = db
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM duplicate_metadata WHERE run_id = ? AND severity = ?",
          )
          .get(result.run.id, severity!)!.count;
        expect($(`[data-count="${name}"]`).text()).toBe(String(local + duplicates));
      }
      expect($('[data-issue="confirmed-broken"]')).toHaveLength(1);
      expect($('[data-issue="confirmed-broken"]').attr("data-severity")).toBe("error");
      expect($('[data-issue="server-error"]').attr("data-severity")).toBe("error");
      expect($('[data-issue="redirects"]').attr("data-severity")).toBe("info");
      expect($('[data-issue="redirects"]').text()).toContain("https://site.example/redirect");
      expect($('[data-count="redirected-destinations"]').text()).toBe("2");
      expect($('[data-issue="inaccessible"]').attr("data-category")).toBe("coverage");
      const gone = $('[data-destination="https://site.example/gone"]');
      expect(gone.find('[data-source="navigation"]')).toHaveLength(2);
      expect(gone.find('[data-source="canonical"]')).toHaveLength(1);
      expect(gone.text()).toContain("/gone#source");
      expect(gone.text()).toContain("HTTP 410");
      const sources = db
        .query<{ source_url: string }, [string]>(
          "SELECT source_url FROM source_links WHERE run_id = ? AND destination_url = 'https://site.example/gone'",
        )
        .all(result.run.id);
      for (const source of sources)
        expect(gone.find(`a[href="${source.source_url}"]`).length).toBeGreaterThan(0);
      for (const link of $('a[href^="#"]').toArray())
        expect($($(link).attr("href")).length).toBe(1);
      const run = db
        .query<
          {
            configuration: string;
            started_at: string;
            finished_at: string;
            execution_status: string;
          },
          [string]
        >("SELECT * FROM runs WHERE id = ?")
        .get(result.run.id)!;
      expect($("#configuration pre").text()).toBe(
        JSON.stringify(JSON.parse(run.configuration), null, 2),
      );
      expect($("#attribution").text()).toContain(run.started_at);
      expect($("#attribution").text()).toContain(run.finished_at);
      expect($("#attribution").text()).toContain(run.execution_status);
      expect($("#attribution").text()).toContain(result.run.id);
      expect($('[data-count="seo-pages"]').text()).toBe("2");
      expect($('[data-count="duplicate-groups"]').text()).toBe("2");
      expect($('[data-issue="duplicate-title"]').text()).toContain("within this run");
      expect($('[data-issue="broken-canonical"]').attr("data-severity")).toBe("error");
      expect($("#coverage").text()).toContain("Coverage limitations");
      expect($("#coverage").text()).toContain("robots-excluded");
      expect($("#coverage").text()).toContain("inconclusive");
      expect($('[data-count="coverage-limitations"]').text()).toBe(
        String(
          db
            .query<{ count: number }, [string]>(
              "SELECT count(*) AS count FROM coverage_limitations WHERE run_id = ?",
            )
            .get(result.run.id)!.count,
        ),
      );
      expect(result.report).not.toContain("Partial report");
      expect(result.report).toContain("does not establish complete website health");
      expect($("script, img, iframe")).toHaveLength(0);
      expect($('[data-issue="indexing-directives"]').text()).toContain(
        "<img src=x onerror=alert(1)>",
      );
      expect($('link[rel="stylesheet"], script[src]')).toHaveLength(0);
      expect(await Bun.file(result.reportPath).text()).toBe(result.report);
    } finally {
      db.close();
    }
  } finally {
    await fixture.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
