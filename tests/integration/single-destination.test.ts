import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateAuditConfig } from "../../src/audit-config";
import { runAudit } from "../../src/audit-run";

for (const [name, startUrl, answers] of [
  ["loopback IPv4", "http://127.0.0.1/", []],
  ["private IPv4", "http://10.0.0.1/", []],
  ["link local", "http://169.254.169.254/", []],
  ["IPv6 loopback", "https://[::1]/", []],
  ["mapped IPv4", "https://[::ffff:127.0.0.1]/", []],
  ["unique local IPv6", "https://[fc00::1]/", []],
  ["mixed DNS", "https://public.example/", ["93.184.216.34", "192.168.1.1"]],
  ["empty DNS", "https://public.example/", []],
  ["multicast", "https://[ff02::1]/", []],
  ["documentation IPv6", "https://[2001:db8::1]/", []],
  ["resolved IPv6 link local", "https://public.example/", ["fe80::1"]],
  ["carrier-grade NAT", "http://100.64.0.1/", []],
  ["benchmark IPv4", "http://198.18.0.1/", []],
  ["unspecified IPv6", "https://[::]/", []],
] as const) {
  test(`refuses ${name} before robots or destination dispatch`, async () => {
    let attempts = 0;
    const result = await runAudit(
      { startUrl },
      {
        ...(await paths()),
        dns: () => Promise.resolve([...answers]),
        transport: () => {
          attempts++;
          return Promise.resolve(new Response());
        },
      },
    );
    expect(result.run.destination.outcome).toBe("refused");
    expect(result.report).toContain("refused");
    expect(attempts).toBe(0);
  });
}

for (const [startUrl, expectedAddress] of [
  ["http://8.8.8.8/", "8.8.8.8"],
  ["https://[2606:4700:4700::1111]/", "2606:4700:4700::1111"],
] as const) {
  test(`public literal ${startUrl} uses its checked address without DNS`, async () => {
    const addresses: string[] = [];
    const result = await runAudit(
      { startUrl, requests: { hostnameIntervalMs: 1 } },
      {
        ...(await paths()),
        dns: () => Promise.reject(new Error("Literal must not resolve")),
        transport: (request) => {
          addresses.push(request.address);
          return Promise.resolve(
            new Response(null, { status: request.url.pathname === "/robots.txt" ? 404 : 200 }),
          );
        },
      },
    );
    expect(result.run.destination.outcome).toBe("successful");
    expect(addresses).toEqual([expectedAddress, expectedAddress]);
  });
}

test("revalidates changing DNS before the destination rather than trusting robots resolution", async () => {
  const dispatched: string[] = [];
  let resolutions = 0;
  const result = await runAudit(
    { startUrl: "https://public.example/", requests: { hostnameIntervalMs: 1 } },
    {
      ...(await paths()),
      dns: () => Promise.resolve(++resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"]),
      transport: ({ url, address }) => {
        dispatched.push(`${url.pathname} ${address}`);
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    },
  );
  expect(result.run.destination.outcome).toBe("refused");
  expect(dispatched).toEqual(["/robots.txt 93.184.216.34"]);
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function paths() {
  const directory = await mkdtemp(join(tmpdir(), "craw-run-"));
  directories.push(directory);
  return {
    databasePath: join(directory, "audit.sqlite"),
    reportPath: join(directory, "report.html"),
  };
}

test("fatal report write failure retains a failed run and collected evidence in SQLite", async () => {
  const storage = await paths();
  await mkdir(storage.reportPath);
  const failure: unknown = await runAudit({ startUrl: "http://127.0.0.1/" }, storage).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  const db = new Database(storage.databasePath, { readonly: true });
  try {
    expect(db.query("SELECT execution_status FROM runs").get()).toEqual({
      execution_status: "failed",
    });
    expect(db.query("SELECT outcome FROM destinations").get()).toEqual({ outcome: "refused" });
    expect(
      db
        .query(
          "SELECT evidence FROM coverage_limitations WHERE evidence LIKE 'Fatal artifact failure:%'",
        )
        .all(),
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("retains separate single-destination runs and renders escaped evidence without claiming website health", async () => {
  const storage = await paths();
  const attempts: string[] = [];
  const dependencies = {
    ...storage,
    dns: () => Promise.resolve(["93.184.216.34"]),
    transport: ({ url }: { url: URL }) => {
      attempts.push(url.href);
      return Promise.resolve(
        new Response(null, { status: url.pathname === "/robots.txt" ? 404 : 410 }),
      );
    },
  };
  const input = {
    startUrl: "https://public.example/?q=%3Cscript%3E",
    requests: { hostnameIntervalMs: 1 },
  };
  const first = await runAudit(input, dependencies);
  const second = await runAudit(input, dependencies);
  expect(first.run.executionStatus).toBe("completed");
  expect(first.run.destination.outcome).toBe("confirmed-broken");
  expect(first.run.destination.status).toBe(410);
  expect(first.report).toContain("Single-destination coverage");
  expect(first.report).toContain("not establish complete website health");
  expect(first.report).not.toContain("<script>");
  expect(first.run.id).not.toBe(second.run.id);
  expect(attempts).toEqual([
    "https://public.example/robots.txt",
    input.startUrl,
    "https://public.example/robots.txt",
    input.startUrl,
  ]);
  const db = new Database(storage.databasePath, { readonly: true });
  try {
    const rows = db
      .query<{ configuration: string; started_at: string; finished_at: string }, []>(
        "SELECT configuration, started_at, finished_at FROM runs ORDER BY rowid",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(validateAuditConfig(JSON.parse(rows[0]!.configuration)).crawlerIdentity).toBe(
      "CrawAuditor/1.0",
    );
    expect(rows[0]!.finished_at >= rows[0]!.started_at).toBe(true);
    expect(db.query("SELECT outcome FROM destinations").all()).toEqual([
      { outcome: "confirmed-broken" },
      { outcome: "confirmed-broken" },
    ]);
  } finally {
    db.close();
  }
  expect(await Bun.file(storage.reportPath).text()).toBe(second.report);
});
