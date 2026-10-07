import { expect, spyOn, test } from "bun:test";

import { runAudit } from "../../src/audit-run";

test("rejects invalid configuration before any network dispatch", async () => {
  const blockedFetch = Object.assign(
    () => Promise.reject(new Error("Unexpected network dispatch")),
    { preconnect: globalThis.fetch.preconnect },
  );
  const network = spyOn(globalThis, "fetch").mockImplementation(blockedFetch);
  try {
    const error = await runAudit({
      startUrl: "https://example.com/",
      requests: { timeoutMs: 0 },
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected configuration rejection");
    expect(error.message).toContain("requests.timeoutMs");
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
