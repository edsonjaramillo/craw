import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "cheerio";

import { runAudit, systemClock } from "../../src/audit-run";
import { createNetwork } from "../fixtures/network";

const publicV4 = "93.184.216.34";
const publicV6 = "2606:4700:4700::1111";

test("combined public graph guards robots, rebinding, literal addresses and redirect hops under the configured identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-acceptance-safety-"));
  const network = createNetwork(
    {
      name: "adversarial-public-policy",
      routes: [
        {
          hostname: "site.example",
          path: "/blog",
          responses: [
            {
              headers: { "content-type": "text/html" },
              body: `<title>Safety</title><h1>Safety</h1>
        <a href="http://127.0.0.1/">v4 private</a><a href="http://[::1]/">v6 private</a>
        <a href="http://[::ffff:127.0.0.1]/">mapped private</a><a href="https://site.example:444/">port</a>
        <a href="https://mixed.example/">mixed answers</a><a href="https://rebind.example/">rebind</a>
        <a href="https://robots-redirect.example/">protected robots redirect</a>
        <a href="https://identity.example/blocked">identity</a><a href="/blog/redirect">redirect guard</a>
        <a href="http://${publicV4}/">public v4</a><a href="http://[${publicV6}]/">public v6</a>
        <a href="http://site.example/blog/plain">scheme separation</a><a href="https://site.example/blog/plain">secure</a>`,
            },
          ],
        },
        {
          hostname: "robots-redirect.example",
          path: "/robots.txt",
          responses: [{ status: 302, headers: { location: "http://[::1]/robots.txt" } }],
        },
        {
          hostname: "identity.example",
          path: "/robots.txt",
          responses: [
            { body: "User-agent: AcceptanceBot\nDisallow: /blocked\nUser-agent: *\nAllow: /" },
          ],
        },
        {
          path: "/blog/redirect",
          responses: [{ status: 302, headers: { location: "https://mixed.example/target" } }],
        },
        { path: "/", responses: [{ status: 200 }] },
        { scheme: "http", path: "/blog/plain", responses: [{ status: 410 }] },
        { scheme: "https", path: "/blog/plain", responses: [{ status: 200 }] },
        { path: "/robots.txt", responses: [{ status: 404 }] },
      ],
    },
    systemClock,
  );
  const resolutions: string[] = [];
  const databasePath = join(directory, "audit.sqlite");
  try {
    const result = await runAudit(
      {
        startUrl: "https://site.example/blog",
        pathRestriction: "/blog",
        crawlerIdentity: "AcceptanceBot",
        requests: { hostnameIntervalMs: 1, retries: 0 },
      },
      {
        databasePath,
        reportPath: join(directory, "report.html"),
        transport: network.transport,
        dns: (hostname) => {
          resolutions.push(hostname);
          if (hostname === "mixed.example") return Promise.resolve([publicV4, "10.0.0.1"]);
          if (hostname === "rebind.example")
            return Promise.resolve(
              resolutions.filter((host) => host === hostname).length === 1 ? [publicV6] : ["::1"],
            );
          return Promise.resolve([publicV4]);
        },
      },
    );
    expect(result.run.executionStatus).toBe("completed");
    expect(
      network.requests
        .map(({ url, address }) => [url, address])
        .toSorted(([a], [b]) => a!.localeCompare(b!)),
    ).toEqual(
      [
        ["https://site.example/robots.txt", publicV4],
        ["https://site.example/blog", publicV4],
        ["https://rebind.example/robots.txt", publicV6],
        ["https://robots-redirect.example/robots.txt", publicV4],
        ["https://identity.example/robots.txt", publicV4],
        ["https://site.example/blog/redirect", publicV4],
        [`http://${publicV4}/robots.txt`, publicV4],
        [`http://${publicV4}/`, publicV4],
        [`http://[${publicV6}]/robots.txt`, publicV6],
        [`http://[${publicV6}]/`, publicV6],
        ["http://site.example/robots.txt", publicV4],
        ["http://site.example/blog/plain", publicV4],
        ["https://site.example/blog/plain", publicV4],
      ].toSorted(([a], [b]) => a!.localeCompare(b!)),
    );
    expect(resolutions).not.toContain(publicV4);
    expect(resolutions).not.toContain(publicV6);
    expect(
      network.requests.every(
        ({ method, identity, bodyState }) =>
          method === "GET" && identity === "AcceptanceBot" && bodyState === "completed",
      ),
    ).toBe(true);
    const outcomes = Object.fromEntries(
      result.run.destinations.map(({ url, outcome }) => [url, outcome]),
    );
    expect(outcomes["https://rebind.example/"]).toBe("refused");
    expect(outcomes["https://robots-redirect.example/"]).toBe("refused");
    expect(outcomes["https://identity.example/blocked"]).toBe("robots-excluded");
    expect(outcomes["https://site.example/blog/redirect"]).toBe("refused");
    expect(outcomes["http://site.example/blog/plain"]).toBe("confirmed-broken");
    expect(outcomes["https://site.example/blog/plain"]).toBe("successful");
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(
        db
          .query(
            "SELECT outcome, count(*) AS count FROM destinations GROUP BY outcome ORDER BY outcome",
          )
          .all(),
      ).toEqual([
        { outcome: "confirmed-broken", count: 1 },
        { outcome: "refused", count: 8 },
        { outcome: "robots-excluded", count: 1 },
        { outcome: "successful", count: 4 },
      ]);
      expect(db.query("SELECT * FROM source_links").all()).toHaveLength(13);
    } finally {
      db.close();
    }
    const report = load(result.report);
    expect(report('[data-count="seo-pages"]').text()).toBe("1");
    expect(report.text()).toContain("Confirmed broken links: 1");
    expect(report.text()).toContain("Robots rules prevented access");
    expect(report.text()).toContain("non-public");
    expect(network.active).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
