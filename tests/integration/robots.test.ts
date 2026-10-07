import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit } from "../../src/audit-run";

for (const [status, body, expected, dispatched] of [
  [404, "", "successful", true],
  [410, "", "successful", true],
  [401, "", "robots-excluded", false],
  [403, "", "robots-excluded", false],
  [503, "", "robots-unavailable", false],
  [429, "", "robots-unavailable", false],
  [302, "", "refused", false],
  [200, "User-agent: *\nDisallow: /", "robots-excluded", false],
  [200, "User-agent: *\nDisallow: /\n\nUser-agent: MyAudit\nAllow: /", "successful", true],
  [200, "User-agent: MyAudit\nDisallow: /", "robots-excluded", false],
] as const) {
  test(`robots ${status} ${body || "without rules"} yields ${expected}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "craw-robots-"));
    try {
      const attempts: { url: string; identity: string }[] = [];
      const result = await runAudit(
        {
          startUrl: "https://public.example/",
          crawlerIdentity: "MyAudit/1.0",
          requests: { hostnameIntervalMs: 1, retries: 0 },
        },
        {
          databasePath: join(directory, "audit.sqlite"),
          reportPath: join(directory, "report.html"),
          dns: () => Promise.resolve(["93.184.216.34"]),
          transport: (request) => {
            attempts.push({ url: request.url.href, identity: request.identity });
            return Promise.resolve(
              request.url.pathname === "/robots.txt"
                ? new Response(body, { status, headers: { location: "http://127.0.0.1/" } })
                : new Response("<title>Healthy</title>"),
            );
          },
        },
      );
      expect(result.run.destination.outcome).toBe(expected);
      expect(attempts).toEqual(
        dispatched
          ? [
              { url: "https://public.example/robots.txt", identity: "MyAudit/1.0" },
              { url: "https://public.example/", identity: "MyAudit/1.0" },
            ]
          : [{ url: "https://public.example/robots.txt", identity: "MyAudit/1.0" }],
      );
      if (!dispatched) expect(result.run.limitations.join(" ")).toContain(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("undecoded compressed robots rules fail closed rather than permitting access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-robots-encoded-"));
  try {
    const attempts: string[] = [];
    const result = await runAudit(
      { startUrl: "https://public.example/" },
      {
        databasePath: join(directory, "audit.sqlite"),
        reportPath: join(directory, "report.html"),
        dns: () => Promise.resolve(["93.184.216.34"]),
        transport: (request) => {
          attempts.push(request.url.pathname);
          return Promise.resolve(
            new Response(Bun.gzipSync("User-agent: *\nDisallow: /"), {
              headers: { "content-encoding": "gzip" },
            }),
          );
        },
      },
    );
    expect(result.run.destination.outcome).toBe("robots-unavailable");
    expect(attempts).toEqual(["/robots.txt"]);
    expect(result.report).toContain("encoding");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unavailable network rules fail closed and oversized rules never permit access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-robots-"));
  try {
    for (const failure of ["network", "oversized"]) {
      const attempted: string[] = [];
      const result = await runAudit(
        { startUrl: "http://public.example/", requests: { retries: 0 } },
        {
          databasePath: join(directory, "audit.sqlite"),
          reportPath: join(directory, "report.html"),
          dns: () => Promise.resolve(["93.184.216.34"]),
          transport: (request) => {
            attempted.push(request.url.pathname);
            return failure === "network"
              ? Promise.reject(new Error("Connection unavailable"))
              : Promise.resolve(new Response(" ".repeat(512 * 1024 + 1)));
          },
        },
      );
      expect(result.run.destination.outcome).toBe("robots-unavailable");
      expect(attempted).toEqual(["/robots.txt"]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
