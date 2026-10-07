import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "cheerio";
import { z } from "zod";

import { waitForBodies } from "../fixtures/observations";
import { startFixture, type Fixture } from "../fixtures/server";

test("trusted TLS redirects and check-only streams retain evidence while wrong-host robots fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-acceptance-tls-"));
  let fixture: Fixture | undefined;
  try {
    const key = join(directory, "key.pem");
    const certificate = join(directory, "certificate.pem");
    const openssl = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=tls.audit.invalid",
        "-addext",
        "subjectAltName=DNS:tls.audit.invalid",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [generated, errors] = await Promise.all([
      openssl.exited,
      new Response(openssl.stderr).text(),
    ]);
    expect(generated, errors).toBe(0);
    fixture = startFixture(
      {
        name: "TLS combined acceptance",
        routes: [
          { path: "/robots.txt", responses: [{ status: 404 }] },
          {
            path: "/blog",
            responses: [
              {
                headers: { "content-type": "text/html" },
                body: '<title>TLS audit</title><h1>TLS audit</h1><link rel="canonical" href="/outside"><a href="/blog/redirect">download</a><a href="https://wrong.audit.invalid/target">wrong certificate host</a>',
              },
            ],
          },
          {
            path: "/outside",
            responses: [
              {
                headers: { "content-type": "text/html" },
                body: '<title>Must not audit</title><a href="/blog/never">must not expand</a>',
              },
            ],
          },
          {
            path: "/blog/redirect",
            responses: [{ status: 302, headers: { location: "/download" } }],
          },
          {
            path: "/download",
            responses: [
              {
                headers: { "content-type": "application/pdf" },
                stream: { chunk: "x".repeat(65536), chunks: 100, intervalMs: 20 },
              },
            ],
          },
        ],
      },
      {
        hostname: "127.0.0.2",
        tls: { key: await readFile(key), cert: await readFile(certificate) },
      },
    );
    const databasePath = join(directory, "audit.sqlite");
    const reportPath = join(directory, "report.html");
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_EXTRA_CA_CERTS: certificate };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../fixtures/tls-audit.ts"),
        fixture.url.port,
        databasePath,
        reportPath,
      ],
      { env, stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = z
      .strictObject({ id: z.string(), executionStatus: z.literal("completed") })
      .parse(JSON.parse(stdout.trim().split("\n").at(-1)!));
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.query("SELECT url, outcome FROM destinations ORDER BY url").all()).toEqual([
        { url: "https://tls.audit.invalid/blog", outcome: "successful" },
        { url: "https://tls.audit.invalid/blog/redirect", outcome: "successful" },
        { url: "https://tls.audit.invalid/outside", outcome: "successful" },
        { url: "https://wrong.audit.invalid/target", outcome: "robots-unavailable" },
      ]);
      expect(db.query("SELECT url FROM pages").all()).toEqual([
        { url: "https://tls.audit.invalid/blog" },
      ]);
      expect(db.query("SELECT * FROM source_links WHERE run_id = ?").all(result.id)).toHaveLength(
        2,
      );
      const evidence = db
        .query<{ evidence: string }, []>(
          "SELECT evidence FROM destination_responses WHERE url = 'https://tls.audit.invalid/blog/redirect'",
        )
        .get();
      expect(JSON.parse(evidence!.evidence)).toMatchObject({
        finalUrl: "https://tls.audit.invalid/download",
        redirects: [{ status: 302, target: "https://tls.audit.invalid/download" }],
      });
    } finally {
      db.close();
    }
    const report = load(await readFile(reportPath, "utf8"));
    expect(report('[data-count="seo-pages"]').text()).toBe("1");
    expect(report.text()).toContain("wrong.audit.invalid");
    expect(report.text()).toMatch(/hostname|altname|does not match/iu);
    expect(report.text()).toContain("Redirect");
    await waitForBodies(fixture);
    expect(fixture.requests.map(({ url }) => new URL(url).pathname).toSorted()).toEqual(
      ["/robots.txt", "/blog", "/outside", "/blog/redirect", "/download"].toSorted(),
    );
    expect(
      fixture.requests.every(
        ({ hostname, method, identity }) =>
          hostname === "tls.audit.invalid" && method === "GET" && identity === "AcceptanceBot",
      ),
    ).toBe(true);
    const download = fixture.requests.find(({ url }) => new URL(url).pathname === "/download");
    expect(download?.bodyState).toBe("cancelled");
    expect(download?.bytesProduced).toBeLessThan(65536 * 100);
  } finally {
    await fixture?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
