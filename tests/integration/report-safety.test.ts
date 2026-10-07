import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "cheerio";

import { runAudit, systemClock } from "../../src/audit-run";

for (const status of ["limit-stopped", "failed"] as const) {
  test(`${status} report keeps attribution, source navigation and partial evidence`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "craw-report-partial-"));
    const databasePath = join(directory, "audit.sqlite");
    let receivedPage = false;
    try {
      const result = await runAudit(
        {
          startUrl: "https://site.example/",
          limits: { maxDestinations: status === "limit-stopped" ? 1 : 100 },
          requests: { hostnameIntervalMs: 1 },
        },
        {
          databasePath,
          reportPath: join(directory, "report.html"),
          clock: {
            now: () => systemClock.now(),
            sleep: (milliseconds, signal) => {
              if (status === "failed" && receivedPage)
                throw new Error("Report fixture scheduler failure");
              return systemClock.sleep(milliseconds, signal);
            },
          },
          dns: () => Promise.resolve(["93.184.216.34"]),
          transport: ({ url }) => {
            if (url.pathname === "/robots.txt")
              return Promise.resolve(new Response(null, { status: 404 }));
            receivedPage = true;
            return Promise.resolve(
              new Response('<a href="/pending#original">pending</a>', {
                headers: { "content-type": "text/html" },
              }),
            );
          },
        },
      );
      const $ = load(result.report);
      expect($("body").text()).toContain("Partial report");
      expect($("#attribution").text()).toContain(status);
      const pending = $('[data-destination="https://site.example/pending"]');
      expect(pending.text()).toContain("/pending#original");
      expect(pending.find('a[href="#page-0"]')).toHaveLength(1);
      const db = new Database(databasePath, { readonly: true });
      try {
        expect(db.query("SELECT execution_status FROM runs").get()).toEqual({
          execution_status: status,
        });
        expect($('[data-count="destinations"]').text()).toBe("2");
        expect($('[data-count="seo-pages"]').text()).toBe("1");
        expect(pending.text()).toContain(
          status === "failed" ? "Report fixture scheduler failure" : "Checked-destination budget",
        );
      } finally {
        db.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("escapes website evidence and unsafe canonical schemes, with no duplicate groups leaking between runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-report-safety-"));
  const payload = '<img src=x onerror="alert(1)">';
  const encoded = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;";
  const databasePath = join(directory, "audit.sqlite");
  try {
    const dependencies = {
      databasePath,
      reportPath: join(directory, "report.html"),
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: ({ url }: { url: URL }) =>
        Promise.resolve(
          url.pathname === "/robots.txt"
            ? new Response(null, { status: 404 })
            : new Response(
                `<title>${encoded}</title><meta name="description" content="${encoded}"><h1>${encoded}</h1><h1>Second</h1><meta name="robots" content="${encoded}"><link rel="canonical" href="javascript:alert(1)">${url.pathname === "/" ? '<a href="/second?x=&quot; onclick=&quot;alert(1)#evidence">second</a>' : ""}`,
                { headers: { "content-type": "text/html", "x-evidence": payload } },
              ),
        ),
    };
    const input = {
      startUrl: "https://site.example/",
      crawlerIdentity: payload,
      requests: { hostnameIntervalMs: 1 },
    };
    const first = await runAudit(input, dependencies);
    const $ = load(first.report);
    expect($("script, img, svg, iframe")).toHaveLength(0);
    expect($("[onclick], [onerror]")).toHaveLength(0);
    expect($('a[href^="javascript:"]')).toHaveLength(0);
    expect($("#canonicals").text()).toContain("javascript:alert(1)");
    expect($('[data-issue="duplicate-title"]').text()).toContain(payload);
    expect($('[data-issue="duplicate-description"]').text()).toContain(payload);
    expect($('[data-issue="multiple-h1"]').text()).toContain(payload.replaceAll('"', '\\"'));
    expect($("#configuration pre").text()).toContain(payload.replaceAll('"', '\\"'));
    expect($("#issues").text()).toContain("x-evidence");
    const second = await runAudit(
      { ...input, startUrl: "https://site.example/second" },
      dependencies,
    );
    const report = load(second.report);
    expect(report('[data-count="duplicate-groups"]').text()).toBe("0");
    expect(report('[data-issue="duplicate-title"]')).toHaveLength(0);
    expect(report("#attribution").text()).not.toContain(first.run.id);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(
        db.query("SELECT * FROM duplicate_metadata WHERE run_id = ?").all(first.run.id),
      ).toHaveLength(2);
      expect(
        db.query("SELECT * FROM duplicate_metadata WHERE run_id = ?").all(second.run.id),
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
