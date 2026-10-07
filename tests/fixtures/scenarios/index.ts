import { z } from "zod";

export const responseSchema = z.strictObject({
  status: z.number().int().min(200).max(599).default(200),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().default(""),
  delayMs: z.number().int().nonnegative().default(0),
  stream: z
    .strictObject({
      chunk: z.string().min(1),
      chunks: z.number().int().positive(),
      intervalMs: z.number().int().positive(),
    })
    .optional(),
});

export const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  routes: z
    .array(
      z.strictObject({
        path: z.string().startsWith("/"),
        hostname: z.string().min(1).optional(),
        scheme: z.enum(["http", "https"]).optional(),
        method: z.enum(["GET", "HEAD"]).optional(),
        responses: z.array(responseSchema).min(1),
      }),
    )
    .min(1),
});

export type FixtureScenario = z.infer<typeof scenarioSchema>;
export type FixtureScenarioInput = z.input<typeof scenarioSchema>;

export const healthyScenario = scenarioSchema.parse({
  name: "healthy",
  routes: [
    {
      path: "/robots.txt",
      responses: [{ headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" }],
    },
    {
      path: "/",
      responses: [
        {
          headers: { "content-type": "text/html; charset=utf-8" },
          body: '<!doctype html><html><head><title>Healthy fixture</title><meta name="description" content="A healthy destination"><link rel="canonical" href="/"></head><body><h1>Healthy fixture</h1></body></html>',
        },
      ],
    },
    { path: "/missing", responses: [{ status: 404, body: "Not found" }] },
    { path: "/gone", responses: [{ status: 410, body: "Gone" }] },
    { path: "/error", responses: [{ status: 503, body: "Unavailable" }] },
    {
      path: "/delayed",
      responses: [
        {
          delayMs: 100,
          headers: { "content-type": "text/html" },
          body: "<title>Delayed</title><h1>Delayed</h1>",
        },
      ],
    },
    {
      path: "/stream",
      responses: [
        {
          headers: { "content-type": "application/octet-stream" },
          stream: { chunk: "x".repeat(65536), chunks: 100, intervalMs: 20 },
        },
      ],
    },
  ],
} satisfies FixtureScenarioInput);
