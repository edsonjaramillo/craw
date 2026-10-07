import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit } from "../../src/audit-run";
import type { FixtureScenarioInput } from "../fixtures/scenarios";
import { startFixture, type Fixture } from "../fixtures/server";

const directories: string[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function audit(routes: FixtureScenarioInput["routes"], maxRedirectHops = 10) {
  const directory = await mkdtemp(join(tmpdir(), "craw-redirects-"));
  directories.push(directory);
  const fixture = startFixture({ name: "redirects", routes });
  fixtures.push(fixture);
  const databasePath = join(directory, "audit.sqlite");
  const result = await runAudit(
    {
      startUrl: "https://public.example/start",
      requests: { hostnameIntervalMs: 1, retries: 0, maxRedirectHops },
    },
    {
      databasePath,
      reportPath: join(directory, "report.html"),
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: fixture.transport,
    },
  );
  return { ...result, fixture, databasePath };
}
const robots = { path: "/robots.txt", responses: [{ status: 404 }] };

test("follows cross-origin redirects with GET and retains final response and informational redirect evidence", async () => {
  const result = await audit([
    robots,
    {
      path: "/start",
      responses: [
        { status: 302, headers: { location: "http://external.example/document#section" } },
      ],
    },
    {
      hostname: "external.example",
      path: "/document",
      responses: [
        { status: 410, headers: { "content-type": "application/pdf", "x-robots-tag": "noindex" } },
      ],
    },
  ]);
  expect(result.run.destination.outcome).toBe("confirmed-broken");
  expect(result.run.destination.finalUrl).toBe("http://external.example/document");
  expect(result.run.destination.responseHeaders?.["content-type"]).toBe("application/pdf");
  expect(result.run.destination.redirects).toMatchObject([
    {
      url: "https://public.example/start",
      status: 302,
      location: "http://external.example/document#section",
      target: "http://external.example/document",
    },
  ]);
  expect(result.fixture.requests.map(({ method, url }) => [method, url])).toEqual([
    ["GET", "https://public.example/robots.txt"],
    ["GET", "https://public.example/start"],
    ["GET", "http://external.example/robots.txt"],
    ["GET", "http://external.example/document"],
  ]);
  expect(result.report).toContain("Informational redirects");
  expect(result.report).toContain("http://external.example/document");
  const db = new Database(result.databasePath, { readonly: true });
  try {
    const row = db
      .query<{ evidence: string }, []>("SELECT evidence FROM destination_responses")
      .get()!;
    expect(JSON.parse(row.evidence)).toMatchObject({
      finalUrl: "http://external.example/document",
      responseHeaders: { "x-robots-tag": "noindex" },
    });
  } finally {
    db.close();
  }
});

test("malformed redirects retain raw response evidence and attempt counts in storage and report", async () => {
  const result = await audit([
    robots,
    {
      path: "/start",
      responses: [{ status: 301, headers: { location: "http://[bad", "x-robots-tag": "noindex" } }],
    },
  ]);
  expect(result.run.destination.outcome).toBe("redirect-invalid");
  expect(result.run.destination.redirects).toHaveLength(1);
  expect(result.run.destination.redirects?.[0]).toMatchObject({
    url: "https://public.example/start",
    status: 301,
    location: "http://[bad",
    attempts: 1,
    responseHeaders: { "x-robots-tag": "noindex" },
  });
  expect(result.run.destination.redirects?.[0]?.target).toBeUndefined();
  expect(result.report).toContain("Informational redirects");
  expect(result.report).toContain("HTTP 301");
  expect(result.report).toContain("after 1 attempts");
  expect(result.report).toContain("noindex");
  const db = new Database(result.databasePath, { readonly: true });
  try {
    const row = db
      .query<{ evidence: string }, []>("SELECT evidence FROM destination_responses")
      .get()!;
    expect(JSON.parse(row.evidence)).toMatchObject({
      redirects: [
        {
          status: 301,
          location: "http://[bad",
          attempts: 1,
          responseHeaders: { "x-robots-tag": "noindex" },
        },
      ],
    });
  } finally {
    db.close();
  }
});

for (const target of [
  "http://127.0.0.1/private",
  "https://[::1]/private",
  "http://169.254.169.254/latest",
  "http://public.example:8080/private",
  "ftp://public.example/file",
  "http://user:secret@public.example/private",
]) {
  test(`refuses redirect to ${target} before dispatch`, async () => {
    const result = await audit([
      robots,
      { path: "/start", responses: [{ status: 307, headers: { location: target } }] },
    ]);
    expect(result.run.destination.outcome).toBe("refused");
    expect(result.fixture.requests.map(({ url }) => url)).toEqual([
      "https://public.example/robots.txt",
      "https://public.example/start",
    ]);
    expect(result.run.destination.redirects).toHaveLength(1);
    expect(result.report).toContain("Confirmed broken links: 0");
  });
}

for (const [name, location, maxHops, expected] of [
  ["loop", "/start#again", 10, "redirect-loop"],
  ["zero hops", "/final", 0, "redirect-limit"],
  ["exhaustion", "/next", 1, "redirect-limit"],
  ["exact hop bound", "/final", 1, "successful"],
  ["invalid Location", "http://[bad", 10, "redirect-invalid"],
] as const) {
  test(`redirect ${name} is distinct from confirmed broken links`, async () => {
    const result = await audit(
      [
        robots,
        { path: "/start", responses: [{ status: 301, headers: { location } }] },
        { path: "/next", responses: [{ status: 308, headers: { location: "/final" } }] },
        { path: "/final", responses: [{ status: 200 }] },
      ],
      maxHops,
    );
    expect(result.run.destination.outcome).toBe(expected);
    if (expected === "redirect-loop")
      expect(result.run.destination.evidence).toContain("after 1 attempts");
    expect(result.report).toContain("Confirmed broken links: 0");
    expect(result.fixture.requests.map(({ url }) => new URL(url).pathname)).toEqual(
      name === "exact hop bound"
        ? ["/robots.txt", "/start", "/final"]
        : name === "exhaustion"
          ? ["/robots.txt", "/start", "/next"]
          : ["/robots.txt", "/start"],
    );
  });
}

for (const [status, text, expected] of [
  [
    200,
    "User-agent: *\nAllow: /\n\nUser-agent: CrawAuditor\nDisallow: /blocked",
    "robots-excluded",
  ],
  [403, "", "robots-excluded"],
  [503, "", "robots-unavailable"],
] as const) {
  test(`new origin robots ${status} blocks the redirect destination`, async () => {
    const result = await audit([
      { hostname: "public.example", ...robots },
      {
        path: "/start",
        responses: [{ status: 303, headers: { location: "http://external.example/blocked" } }],
      },
      { hostname: "external.example", path: "/robots.txt", responses: [{ status, body: text }] },
    ]);
    expect(result.run.destination.outcome).toBe(expected);
    expect(result.fixture.requests.map(({ url }) => url)).toEqual([
      "https://public.example/robots.txt",
      "https://public.example/start",
      "http://external.example/robots.txt",
    ]);
  });
}

test("cached robots rules still authorize each path on the same origin", async () => {
  const result = await audit([
    { path: "/robots.txt", responses: [{ body: "User-agent: CrawAuditor\nDisallow: /blocked" }] },
    { path: "/start", responses: [{ status: 302, headers: { location: "/blocked" } }] },
  ]);
  expect(result.run.destination.outcome).toBe("robots-excluded");
  expect(result.fixture.requests.map(({ url }) => new URL(url).pathname)).toEqual([
    "/robots.txt",
    "/start",
  ]);
});

test("GET response health is retained when HEAD would disagree, without completing a non-HTML stream", async () => {
  const result = await audit([
    robots,
    { path: "/start", method: "HEAD", responses: [{ status: 404 }] },
    {
      path: "/start",
      method: "GET",
      responses: [
        {
          headers: { "content-type": "application/pdf" },
          stream: { chunk: "x".repeat(65536), chunks: 100, intervalMs: 20 },
        },
      ],
    },
  ]);
  expect(result.run.destination.outcome).toBe("successful");
  expect(result.run.destination.status).toBe(200);
  expect(result.run.destination.responseHeaders?.["content-type"]).toBe("application/pdf");
  expect(result.report).toContain("response health");
  expect(result.report).toContain("download integrity was not checked");
  await Bun.sleep(50);
  expect(result.fixture.requests.every(({ method }) => method === "GET")).toBe(true);
  expect(result.fixture.requests[1]!.bodyState).toBe("cancelled");
  expect(result.fixture.requests[1]!.bytesProduced).toBeLessThan(65536 * 100);
  const headUrl = new URL("/start", result.fixture.url);
  const head = await fetch(headUrl, { method: "HEAD" });
  expect(head.status).toBe(404);
});

test("robots bootstrap follows guarded redirects without recursive policy retrieval", async () => {
  const result = await audit([
    {
      path: "/robots.txt",
      responses: [{ status: 302, headers: { location: "http://rules.example/policy" } }],
    },
    {
      hostname: "rules.example",
      path: "/policy",
      responses: [{ body: "User-agent: *\nDisallow: /start" }],
    },
  ]);
  expect(result.run.destination.outcome).toBe("robots-excluded");
  expect(result.fixture.requests.map(({ url }) => url)).toEqual([
    "https://public.example/robots.txt",
    "http://rules.example/policy",
  ]);
});
