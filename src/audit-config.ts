import { z } from "zod";

const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();

const auditConfigSchema = z.strictObject({
  startUrl: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  }, "Use an HTTP(S) URL on its standard port without credentials"),
  pathRestriction: z
    .string()
    .regex(/^\/[^?#\\]*$/u, "Use an absolute URL path without query, fragment, or backslash")
    .optional(),
  limits: z
    .strictObject({
      maxPages: positiveInteger.default(500),
      maxDepth: nonnegativeInteger.default(5),
      maxDestinations: positiveInteger.default(2_000),
      maxDurationMs: positiveInteger.default(30 * 60 * 1_000),
    })
    .prefault({}),
  requests: z
    .strictObject({
      concurrency: positiveInteger.default(2),
      hostnameIntervalMs: positiveInteger.default(1_000),
      timeoutMs: positiveInteger.default(20_000),
      retries: nonnegativeInteger.default(2),
      maxRedirectHops: nonnegativeInteger.default(10),
    })
    .prefault({}),
  trackingParameterExclusions: z.array(z.string().min(1)).default([]),
  crawlerIdentity: z
    .string()
    .regex(
      /^[\u0021-\u007E](?:[\u0020-\u007E]*[\u0021-\u007E])?$/u,
      "Use a nonempty printable ASCII identity without surrounding whitespace",
    )
    .refine((value) => !/googlebot/iu.test(value), "Use your own crawler identity, not Googlebot")
    .default("CrawAuditor/1.0"),
});

/** Settings supplied by the maintainer, before defaults are applied. */
export type AuditConfigInput = z.input<typeof auditConfigSchema>;
/** Validated effective settings for one audit run. */
export type AuditConfig = z.output<typeof auditConfigSchema>;

export function validateAuditConfig(input: unknown): AuditConfig {
  const result = auditConfigSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`,
    );
    throw new Error(`Invalid audit configuration:\n${details.join("\n")}`);
  }
  return result.data;
}
