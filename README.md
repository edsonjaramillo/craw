# Craw

A Bun website auditor, under development. The current flow audits only the
starting destination, with public-only, address-pinned HTTP(S), robots rules,
retained SQLite runs, and a standalone HTML report. It does not yet discover
links, inspect SEO, follow redirects, or retry transient failures.

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

## Single-destination runs

`runAudit(input, dependencies?)` validates first and defaults to `audit.sqlite`
and `audit-report.html` in the working directory. It returns the retained run,
rendered report, and report path. Each invocation retains its own effective
configuration, timestamps, outcome, and coverage evidence. Reports escape
website-derived evidence and distinguish execution completion from coverage.
Refused, robots-excluded, unavailable, and inconclusive destinations are never
reported as healthy. Fatal execution/storage errors exit nonzero, while
attempting to preserve a failed run and partial report independently.

Requests use GET, run sequentially (below the configured concurrency cap),
pace request starts, and enforce request/run deadlines. Robots bodies have a
512 KiB safety cap. Production requests ask for identity encoding; undecoded
compressed robots rules are treated as unavailable rather than interpreted as
empty rules. Destination response bodies are canceled after status is
established; no full-download integrity or SEO claim is made. Robots 404/410
allows access, 401/403 excludes all, and unavailable rules fail closed. Neither
robots nor destination redirects are followed. Crawlee is not dispatched in
this single-destination stage, so its internals cannot issue unguarded requests.
Retry/backoff and expanded scheduling arrive in #4, redirect handling in #5,
and crawl/SEO budgets become relevant when traversal lands in later tickets.

Tests call the full-run seam with injected DNS, transport, clock/scheduler, and
artifact paths, using temporary real SQLite and the real renderer. The test
transport maps synthetic public destinations to local Hono/Bun fixtures only
after production policy checks. Separate connection contracts verify actual
address pinning and TLS with test-only certificate trust, never a verification
bypass. No live public website is required. Contract TLS fixtures require
`openssl` on PATH.

For manual fixture inspection: `bun run fixtures`. Automated tests start and
stop isolated fixtures directly; importing fixture modules never opens a server.
