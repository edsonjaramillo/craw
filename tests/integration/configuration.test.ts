import { describe, expect, test } from "bun:test";

import { validateAuditConfig } from "../../src/audit-config";

describe("audit configuration", () => {
  test("applies the specified defaults to a starting URL", () => {
    expect(validateAuditConfig({ startUrl: "https://example.com/" })).toEqual({
      startUrl: "https://example.com/",
      limits: {
        maxPages: 500,
        maxDepth: 5,
        maxDestinations: 2_000,
        maxDurationMs: 1_800_000,
      },
      requests: {
        concurrency: 2,
        hostnameIntervalMs: 1_000,
        timeoutMs: 20_000,
        retries: 2,
        maxRedirectHops: 10,
      },
      trackingParameterExclusions: [],
      crawlerIdentity: "CrawAuditor/1.0",
    });
  });

  test("accepts typed overrides and fills defaults in nested settings", () => {
    expect(
      validateAuditConfig({
        startUrl: "http://example.com:80/blog",
        pathRestriction: "/blog",
        limits: { maxPages: 12, maxDepth: 0 },
        requests: { retries: 0, maxRedirectHops: 0 },
        trackingParameterExclusions: ["utm_source"],
        crawlerIdentity: "SiteAudit/2.0 (+https://example.com/bot)",
      }),
    ).toEqual({
      startUrl: "http://example.com:80/blog",
      pathRestriction: "/blog",
      limits: { maxPages: 12, maxDepth: 0, maxDestinations: 2_000, maxDurationMs: 1_800_000 },
      requests: {
        concurrency: 2,
        hostnameIntervalMs: 1_000,
        timeoutMs: 20_000,
        retries: 0,
        maxRedirectHops: 0,
      },
      trackingParameterExclusions: ["utm_source"],
      crawlerIdentity: "SiteAudit/2.0 (+https://example.com/bot)",
    });
  });

  test.each([
    ["unknown root key", { typo: true }],
    ["unknown limit", { limits: { pageLimit: 1 } }],
    ["unknown request setting", { requests: { retry: 1 } }],
    ["non-HTTP URL", { startUrl: "ftp://example.com/" }],
    ["malformed URL", { startUrl: "not a URL" }],
    ["nonstandard port", { startUrl: "https://example.com:8080/" }],
    ["credentials", { startUrl: "https://user:secret@example.com/" }],
    ["zero pages", { limits: { maxPages: 0 } }],
    ["negative depth", { limits: { maxDepth: -1 } }],
    ["fractional destinations", { limits: { maxDestinations: 1.5 } }],
    ["infinite duration", { limits: { maxDurationMs: Infinity } }],
    ["zero concurrency", { requests: { concurrency: 0 } }],
    ["negative pacing", { requests: { hostnameIntervalMs: -1 } }],
    ["string timeout", { requests: { timeoutMs: "20000" } }],
    ["negative retries", { requests: { retries: -1 } }],
    ["fractional redirect limit", { requests: { maxRedirectHops: 0.5 } }],
    ["relative path restriction", { pathRestriction: "blog" }],
    ["query in path restriction", { pathRestriction: "/blog?q=1" }],
    ["empty exclusion", { trackingParameterExclusions: [""] }],
    ["empty identity", { crawlerIdentity: " " }],
    ["header injection", { crawlerIdentity: "Audit\r\nX-Test: yes" }],
    ["Googlebot impersonation", { crawlerIdentity: "GoogleBot/2.1" }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => validateAuditConfig({ startUrl: "https://example.com/", ...overrides })).toThrow();
  });
});
