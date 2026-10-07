# Website Auditing

Website auditing identifies broken links and observes SEO characteristics of public website pages.

## Language

**Crawl boundary**:
The exact target hostname and optional path restriction defining which pages are eligible for crawling and SEO auditing. Other subdomains and sibling hostnames are outside this boundary.

**External link**:
A link whose destination has a different hostname from the target website. Its destination is eligible for a broken-link check, but not link discovery or SEO auditing.

**Out-of-path link**:
A link to the target hostname whose destination falls outside the configured path restriction. Its destination is eligible for a broken-link check, but not link discovery or SEO auditing.

**Public destination**:
An HTTP or HTTPS destination on a standard web port whose network addresses are public, including at every redirect hop. Private and internal network destinations are excluded.

**Source page**:
A page containing a discovered link, identifying where that link can be fixed.

**SEO observation**:
Evidence about a page's SEO characteristics without an assumption about its intended indexing or purpose. Intent-dependent characteristics are not definitive errors by themselves.

**Confirmed broken link**:
A link whose checked destination returns HTTP 404 or 410. Server errors, inaccessible destinations, and inconclusive checks are separate outcomes.
_Avoid_: Broken link as a catch-all for any failed request

**Inconclusive check**:
A destination check that cannot establish response health because network or transient failures exhausted the permitted attempts.

**Audit run**:
One bounded website audit with its own configuration, results, and execution status. Results describe only the coverage achieved during that run; normal completion does not imply complete coverage or website health.

**Original destination**:
A discovered HTTP(S) link destination resolved to an absolute URL with its fragment removed, before configured tracking-parameter exclusions. Link health refers to this destination, not its tracking-normalized counterpart.

**Crawl identity**:
The URL used to deduplicate crawl expansion and SEO auditing after configured tracking-parameter exclusions. Different original destinations can share a crawl identity while having different link-health outcomes.

**Coverage limitation**:
A restriction or unresolved check that bounds what an audit run can establish, including skipped destinations, inconclusive checks, and exhausted budgets.
