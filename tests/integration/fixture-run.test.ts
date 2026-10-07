import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit } from "../../src/audit-run";
import { healthyScenario } from "../fixtures/scenarios";
import { startFixture } from "../fixtures/server";

for (const [status, outcome] of [
  [200, "successful"],
  [404, "confirmed-broken"],
  [410, "confirmed-broken"],
  [503, "server-error"],
  [401, "inaccessible"],
  [403, "inaccessible"],
  [422, "client-error"],
  [429, "inconclusive"],
  [408, "inconclusive"],
  [302, "redirect-not-followed"],
] as const) {
  test(`real fixture GET ${status} retains ${outcome} without fetching redirect targets or discovering links`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "craw-fixture-"));
    const fixture = startFixture({
      name: "status",
      routes: [
        { path: "/robots.txt", responses: [{ status: 404 }] },
        {
          path: "/",
          responses: [
            {
              status,
              headers: {
                "content-type": "text/html",
                location: 'http://127.0.0.1/"><script>alert(1)</script>',
              },
              body: '<a href="/must-not-discover">link</a>',
            },
          ],
        },
      ],
    });
    try {
      const result = await runAudit(
        { startUrl: "https://public.example/", requests: { hostnameIntervalMs: 1 } },
        {
          databasePath: join(directory, "audit.sqlite"),
          reportPath: join(directory, "report.html"),
          dns: () => Promise.resolve(["93.184.216.34"]),
          transport: fixture.transport,
        },
      );
      expect(result.run.destination.outcome).toBe(outcome);
      expect(fixture.requests.map((request) => [request.method, request.url])).toEqual([
        ["GET", "https://public.example/robots.txt"],
        ["GET", "https://public.example/"],
      ]);
      expect(result.report).not.toContain("<script>");
      if (status === 302) expect(result.report).toContain("&lt;script&gt;");
      const db = new Database(join(directory, "audit.sqlite"), { readonly: true });
      try {
        expect(db.query("SELECT outcome, status FROM destinations").get()).toEqual({
          outcome,
          status,
        });
      } finally {
        db.close();
      }
    } finally {
      await fixture.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("private destinations never reach an injected local fixture", async () => {
  const fixture = startFixture();
  const directory = await mkdtemp(join(tmpdir(), "craw-refused-"));
  try {
    const result = await runAudit(
      { startUrl: "http://127.0.0.1/" },
      {
        databasePath: join(directory, "audit.sqlite"),
        reportPath: join(directory, "report.html"),
        transport: fixture.transport,
      },
    );
    expect(result.run.destination.outcome).toBe("refused");
    expect(fixture.requests).toEqual([]);
  } finally {
    await fixture.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-HTML GET checks status without completing the fixture body stream", async () => {
  const fixture = startFixture(healthyScenario);
  const directory = await mkdtemp(join(tmpdir(), "craw-stream-"));
  try {
    const result = await runAudit(
      { startUrl: "http://public.example/stream", requests: { hostnameIntervalMs: 1 } },
      {
        databasePath: join(directory, "audit.sqlite"),
        reportPath: join(directory, "report.html"),
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: fixture.transport,
      },
    );
    expect(result.run.destination.outcome).toBe("successful");
    // Small real transport cancellation smoke test, not a scheduler assertion.
    await Bun.sleep(50);
    expect(fixture.requests[1]!.bodyState).toBe("cancelled");
    expect(fixture.requests[1]!.bytesProduced).toBeLessThan(65536 * 100);
  } finally {
    await fixture.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
