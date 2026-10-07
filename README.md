# Craw

A Bun website auditor, under development. Issue #2 provides configuration
validation and execution preflight. Guarded network auditing, retained SQLite
runs, and HTML reports follow in issue #3; valid settings currently produce an
explicit nonzero "not implemented" failure rather than an unguarded request or
an apparent successful audit.

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
not impersonate Googlebot. Private-address/DNS protections are the responsibility
of the guarded transport in issue #3, not a configuration flag.

## Checks

```sh
bun run typecheck
bun test tests/integration/configuration.test.ts
bun run test
```

Tests exercise the configuration, audit-run rejection, and real Bun subprocess
boundaries without relying on a live public website.
