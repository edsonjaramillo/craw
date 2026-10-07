# Craw

A Bun website auditor, under development. The current flow discovers navigation
links within the crawl boundary, with public-only, address-pinned HTTP(S), robots
rules, retained SQLite runs, and a standalone HTML report. It does not yet inspect
SEO. Public, robots-permitted redirects are followed for response health.

## Configuration and execution

Install dependencies with `bun install`. Edit the typed object in `src/config.ts`,
then execute either `bun run src/index.ts` or `bun run start`. No application CLI
arguments or environment-based settings are used.

```ts
import type { AuditConfigInput } from "./audit-config";

export const config = {
  startUrl: "https://example.com/blog",
  pathRestriction: "/blog", // optional absolute path
  limits: { maxPages: 100 }, // remaining fields receive defaults
  crawlerIdentity: "MySiteAuditor/1.0",
  trackingParameterExclusions: ["utm_source"],
} satisfies AuditConfigInput;
```

The checked-in starting URL is intentionally empty: supply your own target.
`validateAuditConfig` accepts unknown input, rejects unknown keys (also within
nested settings), applies defaults, and returns an effective `AuditConfig`.
`runAudit` performs the same validation before any execution. Errors name the
invalid field or unknown key; the script prints them to stderr and exits 1.

| Setting                       | Default                   |
| ----------------------------- | ------------------------- |
| `limits.maxPages`             | 500                       |
| `limits.maxDepth`             | 5 (starting page depth 0) |
| `limits.maxDestinations`      | 2,000                     |
| `limits.maxDurationMs`        | 1,800,000 (30 minutes)    |
| `requests.concurrency`        | 2                         |
| `requests.hostnameIntervalMs` | 1,000                     |
| `requests.timeoutMs`          | 20,000                    |
| `requests.retries`            | 2                         |
| `requests.maxRedirectHops`    | 10                        |
| `trackingParameterExclusions` | `[]`                      |
| `crawlerIdentity`             | `CrawAuditor/1.0`         |

All numeric settings are finite safe integers. Depth, retries, and redirect hops
may be zero; other numeric settings must be positive. There is no string-to-number
coercion. Starting URLs must use standard-port HTTP(S) without credentials.
Path restrictions are absolute URL paths without queries, fragments, or
backslashes. Query parameters and their order are not normalized by validation.
The identity must be printable ASCII without surrounding whitespace, and must
not impersonate Googlebot. Every request, including robots retrieval, rejects non-public literal or DNS
addresses and pins the connection to the validated address. Production TLS
verification remains enabled. There is no private-network configuration flag.

## Checks

```sh
bun run typecheck
bun test tests/integration/configuration.test.ts
bun run test
```

## Audit runs

`runAudit(input, dependencies?)` validates first and defaults to `audit.sqlite`
and `audit-report.html` in the working directory. It returns the retained run,
rendered report, and report path. Each invocation retains its own effective
configuration, timestamps, outcome, and coverage evidence. Reports escape
website-derived evidence and distinguish execution completion from coverage.
Refused, robots-excluded, unavailable, and inconclusive destinations are never
reported as healthy. Fatal execution/storage errors exit nonzero, while
attempting to preserve a failed run and partial report independently.

Requests use GET through a shared scheduler with a global concurrency cap and
per-hostname request-start spacing. Each hostname is also serialized through body
consumption; different hostnames can use separate global slots. The current
navigation traversal is sequential. Scheduling, retry waits, DNS, requests, and
body reads are bounded by the run deadline; each network attempt also has a
request timeout. Aborted attempts retain their slots until transport/body cleanup
settles, so a retry cannot overlap unfinished cancellation; queued retries still
stop at the run deadline. Robots bodies have a
512 KiB safety cap. Production requests ask for identity encoding; undecoded
compressed robots rules are treated as unavailable rather than interpreted as
empty rules. Only final successful, in-boundary HTML eligible for expansion is
consumed; other destination bodies are canceled after status is established.
HTML gzip/deflate/Brotli content encodings are decoded, and HTTP/BOM/meta charset
evidence is honored by Cheerio's encoding sniffer. Unsupported or invalid content
encodings retain response health but explicitly limit discovery and SEO eligibility.
No full-download integrity or SEO finding claim is made. Robots 404/410
allows access, 401/403 excludes all, and unavailable rules fail closed. Neither
robots nor destination redirects can bypass public-address validation, connection
pinning, request pacing, retries, or the run deadline. Robots redirects are
bootstrapped without recursive robots retrieval; destination hops are authorized
against rules cached by origin and evaluated for each path. CheerioCrawler owns
the deduplicated work queue and lifecycle; its HTTP request handler is replaced
with guarded fetching, so its HTTP client and automatic redirects never dispatch.
HTTP 408/429/5xx and network failures receive at most the configured number of
retries (two by default). Backoff starts at one second, doubles, and caps at thirty
seconds; a valid Retry-After delay or HTTP date can extend the wait. Exhausted
robots retrieval skips the destination and records unavailable coverage. Invalid
or oversized robots bodies and public-policy refusals are not retried.
Redirects follow at most `requests.maxRedirectHops` hops (zero disables following).
Loops, exhausted hop limits, and malformed locations are distinct outcomes, never
confirmed broken links. Informational redirect evidence, the final URL, and final
response headers are retained in SQLite and the report for later crawl-boundary
decisions. Cross-boundary redirects are not inherently broken.
Only 404/410 are confirmed broken links; persistent 5xx, 401/403, other unexpected
4xx, and exhausted transient/network failures retain separate server-error,
inaccessible, client-error, and inconclusive outcomes in SQLite and the report.
Attempt counts accompany response/failure evidence.
Navigation discovery uses anchor and image-map area hrefs, honors valid HTML base
URLs, removes fragments, and preserves query ordering and encoding. Exact hostname
and segment-aware path boundaries admit both standard-port HTTP and HTTPS as
distinct identities. External/out-of-path destinations and cross-boundary final
redirects are checked without expansion or SEO eligibility. Tracking exclusions
apply only to expansion identity; original destinations receive independent checks.
Exclusions default to an empty list. Configured names match decoded query keys
case-sensitively; all remaining query ordering and encoding is preserved. No
tracking-normalized URL is fetched in place of an original destination. Successful
expansion is deduplicated by the final response's crawl identity, while health
checks and destination budgets remain keyed by fragment-free originals.
SQLite response evidence and reports retain each original's crawl identity,
including failed or budget-excluded variants, alongside every source relationship
and discovered href.
Page, HTML-link depth (start is zero), and checked-destination budgets are
independent. Page/depth exclusions prevent expansion, not destination health
checks; check-only destinations do not consume page/depth budgets. Excluded work
is retained and produces visible limitations and a partial, limit-stopped report.
Successful eligible pages are retained for future SEO inspection; actual SEO
checks belong to the next implementation stage.
Non-HTML GET checks establish response health, not complete download integrity;
response streams are canceled without downloading the entire body.

Tests call the full-run seam with injected DNS, transport, clock/scheduler, and
artifact paths, using temporary real SQLite and the real renderer. The test
transport maps synthetic public destinations to local Hono/Bun fixtures only
after production policy checks. Separate connection contracts verify actual
address pinning and TLS with test-only certificate trust, never a verification
bypass. No live public website is required. Contract TLS fixtures require
`openssl` on PATH.

For manual fixture inspection: `bun run fixtures`. Automated tests start and
stop isolated fixtures directly; importing fixture modules never opens a server.
