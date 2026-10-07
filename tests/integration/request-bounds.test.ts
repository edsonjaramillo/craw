import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit } from "../../src/audit-run";
import { ManualClock, flush } from "../fixtures/clock";

test("run duration bounds pacing and in-flight work and retains a partial report", async () => {
  for (const stalled of [false, true]) {
    const paths = await storage();
    try {
      const clock = new ManualClock();
      const attempts: string[] = [];
      const result = runAudit(
        { startUrl: "https://public.example/", limits: { maxDurationMs: 100 } },
        {
          ...paths,
          clock,
          dns: () => Promise.resolve(["93.184.216.34"]),
          transport: ({ url }) => {
            attempts.push(url.pathname);
            return stalled
              ? new Promise<Response>(() => {})
              : Promise.resolve(new Response(null, { status: 404 }));
          },
        },
      );
      await flush();
      clock.advance(100);
      const audit = await result;
      expect(audit.run.executionStatus).toBe("limit-stopped");
      expect(audit.run.destination.outcome).toBe("limit-stopped");
      expect(attempts).toEqual(["/robots.txt"]);
      expect(audit.report).toContain("Run-duration limit reached");
      expect(clock.timers.size).toBe(0);
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  }
});
async function storage() {
  const directory = await mkdtemp(join(tmpdir(), "craw-bounds-"));
  return {
    directory,
    databasePath: join(directory, "audit.sqlite"),
    reportPath: join(directory, "report.html"),
  };
}

test("paces robots and destination starts under the hostname interval", async () => {
  const paths = await storage();
  try {
    const clock = new ManualClock();
    const attempts: { url: string; time: number }[] = [];
    const result = runAudit(
      { startUrl: "https://public.example/", requests: { timeoutMs: 50 } },
      {
        ...paths,
        clock,
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: ({ url }) => {
          attempts.push({ url: url.pathname, time: clock.now() });
          return Promise.resolve(
            new Response(null, { status: url.pathname === "/robots.txt" ? 404 : 200 }),
          );
        },
      },
    );
    await flush();
    expect(attempts).toEqual([{ url: "/robots.txt", time: Date.UTC(2026, 0, 1) }]);
    clock.advance(999);
    await flush();
    expect(attempts).toHaveLength(1);
    clock.advance(1);
    expect((await result).run.destination.outcome).toBe("successful");
    expect(attempts[1]!.time - attempts[0]!.time).toBe(1000);
    expect(clock.timers.size).toBe(0);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("destination timeout cancels in-flight work and retains an inconclusive outcome", async () => {
  const paths = await storage();
  try {
    const clock = new ManualClock();
    let signal: AbortSignal | undefined;
    const result = runAudit(
      {
        startUrl: "https://public.example/",
        requests: { hostnameIntervalMs: 1, timeoutMs: 50, retries: 0 },
      },
      {
        ...paths,
        clock,
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: (request) => {
          if (request.url.pathname === "/robots.txt")
            return Promise.resolve(new Response(null, { status: 404 }));
          signal = request.signal;
          return new Promise<Response>(() => {});
        },
      },
    );
    await flush();
    clock.advance(1);
    await flush();
    expect(signal?.aborted).toBe(false);
    clock.advance(50);
    const audit = await result;
    expect(audit.run.destination.outcome).toBe("inconclusive");
    expect(audit.run.executionStatus).toBe("completed");
    expect(signal?.aborted).toBe(true);
    expect(audit.report).toContain("timeout");
    expect(clock.timers.size).toBe(0);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("times out stalled robots fail-closed, including DNS, without destination dispatch", async () => {
  const paths = await storage();
  try {
    const clock = new ManualClock();
    let attempts = 0;
    const result = runAudit(
      { startUrl: "https://public.example/", requests: { timeoutMs: 50, retries: 0 } },
      {
        ...paths,
        clock,
        dns: () => new Promise(() => {}),
        transport: () => {
          attempts++;
          return Promise.resolve(new Response());
        },
      },
    );
    await flush();
    clock.advance(50);
    const audit = await result;
    expect(audit.run.executionStatus).toBe("completed");
    expect(audit.run.destination.outcome).toBe("robots-unavailable");
    expect(audit.report).toContain("timeout");
    expect(attempts).toBe(0);
    expect(clock.timers.size).toBe(0);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});
