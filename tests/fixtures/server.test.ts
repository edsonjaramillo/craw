import { expect, test } from "bun:test";

import { scenarioSchema } from "./scenarios";
import { startFixture, type Fixture } from "./server";

function get(fixture: Fixture, path = "/", signal = new AbortController().signal) {
  return fixture.transport({
    url: new URL(path, "https://public.example"),
    address: "93.184.216.34",
    identity: "FixtureBot",
    signal,
  });
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Fixture observation timed out");
    await Bun.sleep(5);
  }
}

test("scenario validation rejects unknown keys, including nested objects", () => {
  expect(() => scenarioSchema.parse({ name: "bad", routes: [], extra: true })).toThrow();
  expect(() =>
    scenarioSchema.parse({ name: "bad", routes: [{ path: "/", responses: [{ extra: true }] }] }),
  ).toThrow();
  expect(() =>
    scenarioSchema.parse({
      name: "bad",
      routes: [
        {
          path: "/",
          responses: [{ stream: { chunk: "x", chunks: 1, intervalMs: 1, extra: true } }],
        },
      ],
    }),
  ).toThrow();
});

test("fixtures isolate logs and retain logical HTTPS URL, method and timestamp", async () => {
  const first = startFixture();
  const second = startFixture();
  try {
    const response = await get(first);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Healthy fixture");
    expect(first.requests[0]).toMatchObject({
      method: "GET",
      url: "https://public.example/",
      hostname: "public.example",
      bodyState: "completed",
    });
    expect(first.requests[0]?.arrivedAt).toBeGreaterThan(0);
    expect(second.requests).toHaveLength(0);
    expect(await (await get(first, "/robots.txt")).text()).toContain("Allow: /");
  } finally {
    await first.stop();
    await second.stop();
  }
});

test("response sequences repeat their final value, reset, and do not follow redirects", async () => {
  const fixture = startFixture({
    name: "sequence",
    routes: [
      {
        path: "/",
        responses: [
          { status: 503 },
          { status: 302, headers: { location: "https://other.example/" } },
        ],
      },
    ],
  });
  try {
    expect((await get(fixture)).status).toBe(503);
    expect((await get(fixture)).status).toBe(302);
    expect((await get(fixture)).status).toBe(302);
    expect(fixture.requests).toHaveLength(3);
    fixture.reset();
    expect(fixture.requests).toHaveLength(0);
    expect((await get(fixture)).status).toBe(503);
  } finally {
    await fixture.stop();
  }
});

test("exact query order and logical hostname select routes", async () => {
  const fixture = startFixture({
    name: "logical",
    routes: [{ hostname: "public.example", path: "/?b=2&a=1", responses: [{ body: "matched" }] }],
  });
  try {
    expect(await (await get(fixture, "/?b=2&a=1")).text()).toBe("matched");
    expect((await get(fixture, "/?a=1&b=2")).status).toBe(404);
  } finally {
    await fixture.stop();
  }
});

test("scheme-specific sequences and configured identities remain observable after reset", async () => {
  const fixture = startFixture({
    name: "schemes",
    routes: [
      { scheme: "http", path: "/", responses: [{ status: 410 }] },
      { scheme: "https", path: "/", responses: [{ status: 503 }, { status: 200 }] },
    ],
  });
  try {
    const request = (scheme: string) =>
      fixture.transport({
        url: new URL(`${scheme}://public.example/`),
        address: "93.184.216.34",
        identity: "AcceptanceBot/1.0",
        signal: new AbortController().signal,
      });
    expect((await request("http")).status).toBe(410);
    expect((await request("https")).status).toBe(503);
    expect((await request("https")).status).toBe(200);
    expect(fixture.requests.map(({ url, identity }) => [url, identity])).toEqual([
      ["http://public.example/", "AcceptanceBot/1.0"],
      ["https://public.example/", "AcceptanceBot/1.0"],
      ["https://public.example/", "AcceptanceBot/1.0"],
    ]);
    fixture.reset();
    expect((await request("https")).status).toBe(503);
    expect(fixture.requests).toHaveLength(1);
  } finally {
    await fixture.stop();
  }
});

test("stream consumption completes; cancellation stops production", async () => {
  const fixture = startFixture({
    name: "stream",
    routes: [
      { path: "/complete", responses: [{ stream: { chunk: "abc", chunks: 2, intervalMs: 5 } }] },
      {
        path: "/cancel",
        responses: [{ stream: { chunk: "x".repeat(65536), chunks: 100, intervalMs: 20 } }],
      },
    ],
  });
  try {
    expect(await (await get(fixture, "/complete")).text()).toBe("abcabc");
    await until(() => fixture.requests[0]?.bodyState === "completed");
    const response = await get(fixture, "/cancel");
    await response.body?.cancel();
    await until(() => fixture.requests[1]?.bodyState === "cancelled");
    expect(fixture.requests[1]?.bytesProduced).toBeLessThan(65536 * 100);
    expect(fixture.requests[1]?.bodyCancelledAt).toBeGreaterThan(0);
  } finally {
    await fixture.stop();
  }
});

test("reset cannot discard a pending stream's log or response state", async () => {
  const fixture = startFixture({
    name: "pending reset",
    routes: [{ path: "/", responses: [{ stream: { chunk: "x", chunks: 100, intervalMs: 20 } }] }],
  });
  try {
    const response = await get(fixture);
    expect(() => {
      fixture.reset();
    }).toThrow("Cannot reset an active fixture");
    expect(fixture.requests).toHaveLength(1);
    await response.body?.cancel();
    await until(() => fixture.requests[0]?.bodyState === "cancelled");
    fixture.reset();
    expect(fixture.requests).toEqual([]);
  } finally {
    await fixture.stop();
  }
});

test("aborted delayed responses and teardown clean up pending work", async () => {
  const fixture = startFixture({
    name: "delay",
    routes: [{ path: "/", responses: [{ delayMs: 1000, body: "late" }] }],
  });
  try {
    const controller = new AbortController();
    const pending = get(fixture, "/", controller.signal);
    // Attach rejection handler before triggering abort.
    const outcome = pending.then(
      () => "resolved",
      () => "rejected",
    );
    await until(() => fixture.requests.length === 1);
    controller.abort();
    expect(await outcome).toBe("rejected");
    await until(() => fixture.requests[0]?.bodyState === "cancelled");
  } finally {
    await fixture.stop();
  }
  await fixture.stop();
  expect(get(fixture)).rejects.toThrow("Fixture is stopped");
});
