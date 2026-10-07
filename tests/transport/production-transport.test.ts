import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { productionTransport } from "../../src/guarded-transport.ts";

const address = "127.0.0.2";
const identity = "ConnectionContract/1.0";
const hostname = "pinned.audit.invalid";

// Issue #3 explicitly approves this connection-only seam. Loopback and ephemeral
// ports stand in for an already validated address; this does not weaken or test
// the full-run destination guard. No DNS/HTTP/TLS implementation is mocked.
describe("production transport connection contract", () => {
  test("connects to the supplied address without resolving the logical host, preserving GET, Host and identity", async () => {
    const observed: {
      method: string;
      host: string | null;
      identity: string | null;
      path: string;
    }[] = [];
    const server = Bun.serve({
      hostname: address,
      port: 0,
      fetch(request) {
        observed.push({
          method: request.method,
          host: request.headers.get("host"),
          identity: request.headers.get("user-agent"),
          path: new URL(request.url).pathname + new URL(request.url).search,
        });
        return new Response("pinned connection");
      },
    });
    try {
      // .invalid cannot resolve via DNS. The listener is bound only to the exact
      // supplied loopback address, not 127.0.0.1 or an all-interface wildcard.
      const response = await productionTransport({
        url: new URL(`http://${hostname}:${server.port}/document?b=2&a=1`),
        address,
        identity,
        signal: AbortSignal.timeout(3_000),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("pinned connection");
      expect(observed).toEqual([
        {
          method: "GET",
          host: `${hostname}:${server.port}`,
          identity,
          path: "/document?b=2&a=1",
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test("returns the redirect without dispatching to its target", async () => {
    const arrivals: string[] = [];
    const target = Bun.serve({
      hostname: address,
      port: 0,
      fetch() {
        arrivals.push("target");
        return new Response("must not be fetched");
      },
    });
    const location = `http://${address}:${target.port}/redirect-target`;
    const source = Bun.serve({
      hostname: address,
      port: 0,
      fetch() {
        arrivals.push("source");
        return new Response("redirect evidence", { status: 302, headers: { location } });
      },
    });
    try {
      const response = await productionTransport({
        url: new URL(`http://${hostname}:${source.port}/redirect`),
        address,
        identity,
        signal: AbortSignal.timeout(3_000),
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(location);
      expect(await response.text()).toBe("redirect evidence");
      expect(arrivals).toEqual(["source"]);
    } finally {
      await source.stop(true);
      await target.stop(true);
    }
  });
});

test("production GET cancellation stops a non-HTML stream before complete download", async () => {
  let cancelled = false;
  let produced = 0;
  const server = Bun.serve({
    hostname: address,
    port: 0,
    fetch() {
      let timer: ReturnType<typeof setInterval>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(65536));
          produced++;
          timer = setInterval(() => {
            controller.enqueue(new Uint8Array(65536));
            produced++;
            if (produced === 100) {
              clearInterval(timer);
              controller.close();
            }
          }, 20);
        },
        cancel() {
          cancelled = true;
          clearInterval(timer);
        },
      });
      return new Response(body, { headers: { "content-type": "application/pdf" } });
    },
  });
  try {
    const response = await productionTransport({
      url: new URL(`http://${hostname}:${server.port}/document.pdf`),
      address,
      identity,
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    await response.body!.cancel();
    await Bun.sleep(50);
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThan(100);
  } finally {
    await server.stop(true);
  }
});

describe("production TLS verification", () => {
  let directory: string;
  let certificate: string;
  let server: ReturnType<typeof Bun.serve>;
  const observed: { method: string; host: string | null; identity: string | null }[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "craw-transport-tls-"));
    certificate = join(directory, "certificate.pem");
    const key = join(directory, "key.pem");
    try {
      // Ephemeral self-signed trust anchor valid only for the logical hostname.
      const command = Bun.spawn(
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
          `/CN=${hostname}`,
          "-addext",
          `subjectAltName=DNS:${hostname}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stderr] = await Promise.all([
        command.exited,
        new Response(command.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`TLS fixture certificate generation failed: ${stderr}`);
      server = Bun.serve({
        hostname: address,
        port: 0,
        tls: { key: await readFile(key), cert: await readFile(certificate) },
        fetch(request) {
          observed.push({
            method: request.method,
            host: request.headers.get("host"),
            identity: request.headers.get("user-agent"),
          });
          return new Response("verified TLS connection");
        },
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  });

  afterAll(async () => {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  });

  async function probe(logicalHostname: string, trustFixture: boolean) {
    const env = { ...process.env };
    // Never inherit an ambient verification bypass or ambient extra CA trust.
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete env.NODE_EXTRA_CA_CERTS;
    if (trustFixture) env.NODE_EXTRA_CA_CERTS = certificate;
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "tls-probe.ts"),
        `https://${logicalHostname}:${server.port}/secure`,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return z
      .strictObject({
        status: z.number().optional(),
        body: z.string().optional(),
        error: z.string().optional(),
        code: z.string().optional(),
      })
      .parse(JSON.parse(stdout));
  }

  test("rejects a self-signed certificate without test-only trust", async () => {
    const before = observed.length;
    const result = await probe(hostname, false);
    expect(result.status).toBeUndefined();
    expect(result.error).toMatch(/self.signed|certificate|issuer/iu);
    expect(observed.length).toBe(before);
  });

  test("accepts test-only trusted TLS for the logical hostname rather than the pinned IP", async () => {
    const before = observed.length;
    const result = await probe(hostname, true);
    expect(result).toEqual({ status: 200, body: "verified TLS connection" });
    expect(observed.slice(before)).toEqual([
      {
        method: "GET",
        host: `${hostname}:${server.port}`,
        identity,
      },
    ]);
  });

  test("rejects a wrong logical hostname even with test-only certificate trust", async () => {
    const before = observed.length;
    const result = await probe("wrong.audit.invalid", true);
    expect(result.status).toBeUndefined();
    expect(result.error).toMatch(/hostname|altname|does not match/iu);
    expect(observed.length).toBe(before);
  });
});
