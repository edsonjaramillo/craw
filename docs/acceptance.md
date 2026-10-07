# Repeatable acceptance scenarios (#13)

Run from this single Bun project:

```sh
bun test tests/integration/acceptance*.test.ts
bun test tests/fixtures/server.test.ts tests/transport/production-transport.test.ts
bun run typecheck
bun run lint
bun run test
```

No public website is a correctness dependency. Tests own their servers and temporary
SQLite/report files. Imports never listen. Fixture controls (`reset`, `stop`) are
programmatic, not crawlable HTTP routes. Reset refuses pending delays/streams so it
cannot discard evidence while requests are active. Response sequences repeat their
last response until reset. Routes select exact logical hostname, optional HTTP/HTTPS
scheme, method and path including query order; first matching route wins.

## Combined scenarios

| Scenario                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance.test.ts`            | Real Hono/Bun graph: tracking collisions with differing original health, base/area navigation, query order, source retention, segment boundaries, external/canonical-only/cross-boundary redirect no-expansion, configured robots identity, noindex SEO, missing/empty/conflicting/broken metadata, within-run duplicates and retained-run isolation. Checks SQLite, semantic report content, GET attempts and stream cancellation. Repeats with independent page, depth and destination budgets.                             |
| `acceptance-safety.test.ts`     | Public IPv4/IPv6 literals, private and IPv4-mapped literals, nonstandard ports, mixed DNS answers, public robots followed by private DNS (rebinding), protected robots redirects and destination redirects, scoped identity exclusions and scheme separation in one graph. Observes validated addresses dispatched to the synthetic transport, persisted categories/source relationships and report coverage.                                                                                                                 |
| `acceptance-scheduling.test.ts` | One deterministic run combines hostname pacing (also across schemes/robots), concurrency cap, Retry-After longer than ordinary backoff, retry backoff/exhaustion, request timeout, cross-scheme redirects, hop limits and in-flight deadline cancellation. Exact virtual request starts, aborts, cleared timers, retained partial SQLite records and semantic report content are asserted. Traversal is currently sequential; this proves the configured cap is not exceeded, not that two requests are launched in parallel. |

`acceptance-tls.test.ts` adds a small full-run TLS smoke test: a test-only trusted
certificate permits robots, HTML and redirected non-HTML checks; a wrong logical
hostname fails certificate verification during protected robots retrieval. Real SQLite,
semantic report evidence and server observations verify retained sources, check-only
no-expansion and stream cancellation. A child process applies startup-only CA trust;
its test adapter maps public-policy-validated URLs to a TLS listener, without changing
production TLS verification or claiming to establish connection pinning.

These scenarios complement earlier tickets' focused behavioral suites; they do not
replace them. `robots.test.ts`, `recovery.test.ts`, `redirect-controls.test.ts`,
`request-bounds.test.ts` and `partial-runs.test.ts` cover individual denial,
unavailability, timeout/cleanup and failure cases. `seo.test.ts`,
`duplicate-metadata.test.ts`, `canonicals.test.ts` and report suites cover individual
findings, escaping and evidence navigation.

The real fixture adapter deliberately maps policy-validated logical public URLs to
loopback HTTP. It does **not** establish production connection pinning or TLS.
`tests/transport/production-transport.test.ts` independently covers actual validated
address use, logical Host/TLS hostname, trusted HTTPS and rejection of invalid
certificates with test-only trust (`openssl` required). Small real HTTP stream and
delay smoke tests live in `fixture-run.test.ts` and `server.test.ts`; timing guarantees
come from the injected clock, not wall-clock duration assertions.

The synthetic network fixture uses response sequences and simulated delays, records
logical URL/hostname, GET, identity, validated address, virtual arrival time and
completion/cancellation, and rejects streaming scenarios: use the real server for
body-stream evidence. Server completion means bytes produced, not proof the client
consumed them.

## Manual inspection

```sh
bun run fixtures
# Open http://127.0.0.1:3000/ or /blog in an ordinary browser, or use curl.
curl -H 'x-fixture-logical-url: https://site.example/blog' http://127.0.0.1:3000/blog
curl -H 'x-fixture-logical-url: https://external.example/target' http://127.0.0.1:3000/target
```

The script serves `tests/fixtures/scenarios/adversarial.ts`, the same graph used by
the acceptance suite. The logical-URL header selects synthetic hostname/scheme routes;
there is no reset/admin endpoint. SIGINT/SIGTERM cancels pending streams and stops the
listener. Synthetic external names are intentionally not public DNS fixtures for a
browser. Inspect their responses with the logical header as above. Do not point the
production auditor at loopback: its public-only protections remain enabled, and there
is no configuration bypass. Automated acceptance runs inject the test-only adapter.
