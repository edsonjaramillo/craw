import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit } from "../../src/audit-run";
import { ManualClock, flush } from "../fixtures/clock";
import { createNetwork } from "../fixtures/network";

for (const [status, outcome, attempts] of [
  [200, "successful", 1],
  [404, "confirmed-broken", 1],
  [410, "confirmed-broken", 1],
  [500, "server-error", 3],
  [503, "server-error", 3],
  [401, "inaccessible", 1],
  [403, "inaccessible", 1],
  [400, "client-error", 1],
  [422, "client-error", 1],
  [408, "inconclusive", 3],
  [429, "inconclusive", 3],
] as const) {
  test(`HTTP ${status} retains ${outcome} after ${attempts} attempts in storage and report`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "craw-classification-"));
    try {
      const clock = new ManualClock();
      const databasePath = join(directory, "audit.sqlite");
      const network = createNetwork(
        {
          name: "status",
          routes: [
            { path: "/robots.txt", responses: [{ status: 404 }] },
            { path: "/", responses: [{ status }] },
          ],
        },
        clock,
      );
      const result = runAudit(
        {
          startUrl: "https://public.example/",
          requests: { hostnameIntervalMs: 1, concurrency: 1 },
        },
        {
          databasePath,
          reportPath: join(directory, "report.html"),
          clock,
          dns: () => Promise.resolve(["93.184.216.34"]),
          transport: network.transport,
        },
      );
      await flush();
      clock.advance(1);
      await flush();
      if (attempts === 3) {
        clock.advance(1000);
        await flush();
        clock.advance(2000);
      }
      const audit = await result;
      expect(audit.run.destination.outcome).toBe(outcome);
      expect(
        network.requests.filter((request) => new URL(request.url).pathname === "/"),
      ).toHaveLength(attempts);
      expect(audit.report).toContain(`<h2>${outcome}</h2>`);
      expect(audit.report).toContain(
        `Confirmed broken links: ${outcome === "confirmed-broken" ? 1 : 0}`,
      );
      expect(audit.run.executionStatus).toBe("completed");
      if (outcome === "inaccessible" || outcome === "inconclusive")
        expect(audit.run.limitations.join(" ")).toContain(outcome);
      const db = new Database(databasePath, { readonly: true });
      try {
        expect(db.query("SELECT outcome, status FROM destinations").get()).toEqual({
          outcome,
          status,
        });
      } finally {
        db.close();
      }
      expect(network.peak).toBe(1);
      expect(clock.timers.size).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
