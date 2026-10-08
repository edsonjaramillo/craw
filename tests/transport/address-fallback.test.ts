import { expect, test } from "bun:test";

import { validateAuditConfig } from "../../src/audit-config";
import { createGuardedFetch } from "../../src/guarded-fetch";
import { DestinationRefused } from "../../src/guarded-transport";
import type { AuditTransport } from "../../src/guarded-transport";
import { ManualClock, flush } from "../fixtures/clock";

const ipv6 = "2606:4700:4700::1111";
const ipv4 = "93.184.216.34";
const url = new URL("https://public.example/robots.txt");
const refused = () =>
  Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED", syscall: "connect" });

function setup(addresses: string[], transport: AuditTransport, timeoutMs = 5000) {
  const clock = new ManualClock();
  let resolutions = 0;
  const fetch = createGuardedFetch(
    validateAuditConfig({
      startUrl: url.origin,
      requests: { hostnameIntervalMs: 1000, retries: 0, timeoutMs },
    }),
    clock,
    () => {
      resolutions++;
      return Promise.resolve(addresses);
    },
    transport,
    clock.now(),
  );
  return { clock, fetch, resolutions: () => resolutions };
}

for (const addresses of [
  [ipv6, ipv4],
  [ipv4, ipv6],
]) {
  test(`falls back from ${addresses[0]} with pacing and no extra DNS resolution`, async () => {
    const requests: { address: string; time: number }[] = [];
    const { clock, fetch, resolutions } = setup(addresses, ({ address }) => {
      requests.push({ address, time: clock.now() });
      if (address === addresses[0]) return Promise.reject(refused());
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const result = fetch(url, (response) => response.status);
    await flush();
    expect(requests).toHaveLength(1);
    clock.advance(999);
    await flush();
    expect(requests).toHaveLength(1);
    clock.advance(1);
    expect(await result).toEqual({ value: 404, attempts: 1 });
    expect(requests.map((request) => request.address)).toEqual(addresses);
    expect(requests[1]!.time - requests[0]!.time).toBe(1000);
    expect(resolutions()).toBe(1);
    expect(clock.timers.size).toBe(0);
  });
}

test("rejects the whole DNS answer set before dispatch, including unsafe fallback addresses", async () => {
  let dispatched = 0;
  const { fetch } = setup([ipv6, "127.0.0.1"], () => {
    dispatched++;
    return Promise.reject(refused());
  });
  const failure = await fetch(url, (response) => response.status).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DestinationRefused);
  expect(dispatched).toBe(0);
});

for (const failure of [
  Object.assign(new Error("TLS certificate invalid"), { code: "CERT_HAS_EXPIRED" }),
  new Error("Other transport error"),
]) {
  test(`does not fall back for ${failure.message}`, async () => {
    const dispatched: string[] = [];
    const { fetch } = setup([ipv6, ipv4], ({ address }) => {
      dispatched.push(address);
      return Promise.reject(failure);
    });
    const error = await fetch(url, (response) => response.status).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error && error.message).toContain(failure.message);
    expect(dispatched).toEqual([ipv6]);
  });
}

test("does not fall back after an HTTP response or body-consumption failure", async () => {
  for (const bodyFailure of [false, true]) {
    const dispatched: string[] = [];
    const { fetch } = setup([ipv6, ipv4], ({ address }) => {
      dispatched.push(address);
      return Promise.resolve(new Response(null, { status: 503 }));
    });
    const result = fetch(url, (response) => {
      if (bodyFailure) throw refused();
      return response.status;
    });
    const outcome = await result.catch((error: unknown) => error);
    if (bodyFailure) {
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome instanceof Error && outcome.message).toContain("Connection refused");
    } else expect(outcome).toEqual({ value: 503, attempts: 1 });
    expect(dispatched).toEqual([ipv6]);
  }
});

test("the request timeout cancels fallback pacing without dispatching another address", async () => {
  const dispatched: string[] = [];
  const { clock, fetch } = setup(
    [ipv6, ipv4],
    ({ address }) => {
      dispatched.push(address);
      return Promise.reject(refused());
    },
    50,
  );
  const result = fetch(url, (response) => response.status).catch((error: unknown) => error);
  await flush();
  clock.advance(50);
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error && error.message).toContain("Request timeout");
  clock.advance(1000);
  await flush();
  expect(dispatched).toEqual([ipv6]);
  expect(clock.timers.size).toBe(0);
});

test("retains the exhausted connection failure when all validated addresses fail", async () => {
  const dispatched: string[] = [];
  const { clock, fetch } = setup([ipv6, ipv4], ({ address }) => {
    dispatched.push(address);
    return Promise.reject(refused());
  });
  const result = fetch(url, (response) => response.status).catch((error: unknown) => error);
  await flush();
  clock.advance(1000);
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error && error.message).toContain("Connection refused after 1 attempts");
  expect(dispatched).toEqual([ipv6, ipv4]);
  expect(clock.timers.size).toBe(0);
});
