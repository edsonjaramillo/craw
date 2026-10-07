import { scenarioSchema, type FixtureScenarioInput } from "./index";

const html = (body: string) => ({ headers: { "content-type": "text/html" }, body });
const metadata =
  '<title> Shared   title </title><meta name="description" content="Shared description"><h1>Fixture</h1>';
const checkOnly = html(`${metadata}<a href="https://site.example/blog/never">must not expand</a>`);

/** Inspectable graph: original health, crawl identities and check-only scope interact. */
export const adversarialScenario = scenarioSchema.parse({
  name: "adversarial",
  routes: [
    {
      path: "/robots.txt",
      responses: [
        { body: "User-agent: AcceptanceBot\nDisallow: /blog/blocked\nUser-agent: *\nAllow: /" },
      ],
    },
    {
      path: "/",
      responses: [
        html(
          '<title>Acceptance fixture</title><h1>Acceptance fixture</h1><a href="/blog">Start graph</a><a href="/stream">Streaming download</a>',
        ),
      ],
    },
    {
      path: "/blog",
      responses: [
        html(
          `${metadata}<base href="/blog/"><meta name="robots" content="noindex"><link rel="canonical" href="https://canonical.example/target"><a href="item?b=2&utm=ok&a=1#first">ok</a><area href="item?b=2&utm=gone&a=1#gone"><a href="item?b=2&utm=other&a=1">collision</a><a href="item?a=1&b=2">order</a><a href="source">source</a><a href="/blogger">out of path</a><a href="https://external.example/target">external</a><a href="redirect">redirect</a><a href="blocked">robots excluded</a><a href="/stream">download</a>`,
        ),
      ],
    },
    {
      path: "/blog/item?b=2&utm=ok&a=1",
      responses: [html(`${metadata}<a href="/blog/leaf">leaf</a>`)],
    },
    { path: "/blog/item?b=2&utm=gone&a=1", responses: [{ status: 410 }] },
    { path: "/blog/item?b=2&utm=other&a=1", responses: [checkOnly] },
    {
      path: "/blog/item?a=1&b=2",
      responses: [html("<title>shared title</title><h1>Case sensitive</h1>")],
    },
    {
      path: "/blog/source",
      responses: [
        html(
          '<title></title><meta name="description" content=""><a href="/blog/item?b=2&utm=gone&a=1#again">gone again</a>',
        ),
      ],
    },
    {
      path: "/blog/leaf",
      responses: [
        html(
          '<h1>One</h1><h1>Two</h1><link rel="canonical" href="/gone"><link rel="canonical" href="https://canonical.example/target">',
        ),
      ],
    },
    { path: "/gone", responses: [{ status: 404 }] },
    { path: "/blogger", responses: [checkOnly] },
    { hostname: "external.example", path: "/target", responses: [checkOnly] },
    { hostname: "canonical.example", path: "/target", responses: [checkOnly] },
    {
      path: "/blog/redirect",
      responses: [{ status: 302, headers: { location: "https://external.example/target" } }],
    },
    { path: "/blog/blocked", responses: [html("must not be requested")] },
    { path: "/blog/never", responses: [html("must not be discovered")] },
    { path: "/stream", method: "HEAD", responses: [{ status: 404 }] },
    {
      path: "/stream",
      method: "GET",
      responses: [
        {
          headers: { "content-type": "application/octet-stream" },
          stream: { chunk: "x".repeat(65536), chunks: 100, intervalMs: 20 },
        },
      ],
    },
  ],
} satisfies FixtureScenarioInput);
