import type { Fixture } from "./server";

/** Synchronize transport smoke assertions with observed server cleanup, not a fixed sleep. */
export async function waitForBodies(fixture: Fixture) {
  const deadline = Date.now() + 1000;
  while (fixture.requests.some(({ bodyState }) => bodyState === "pending")) {
    if (Date.now() > deadline) throw new Error("Fixture body cleanup timed out");
    await Bun.sleep(5);
  }
}
