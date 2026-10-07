import type { AuditRun, DestinationOutcome, DestinationResult } from "./audit-results";

const outcomes: Record<DestinationOutcome, { title: string; severity: string; category: string }> =
  {
    "confirmed-broken": {
      title: "Confirmed broken links (404/410)",
      severity: "error",
      category: "link",
    },
    "server-error": { title: "Server errors", severity: "error", category: "link" },
    "client-error": { title: "Other client errors", severity: "warning", category: "link" },
    inaccessible: {
      title: "Inaccessible destinations",
      severity: "coverage",
      category: "coverage",
    },
    inconclusive: { title: "Inconclusive checks", severity: "coverage", category: "coverage" },
    refused: { title: "Refused destinations", severity: "coverage", category: "coverage" },
    "robots-excluded": {
      title: "Robots-excluded checks",
      severity: "coverage",
      category: "coverage",
    },
    "robots-unavailable": {
      title: "Unavailable robots rules",
      severity: "coverage",
      category: "coverage",
    },
    "limit-stopped": { title: "Limit-stopped checks", severity: "coverage", category: "coverage" },
    "redirect-not-followed": {
      title: "Redirect not followed",
      severity: "warning",
      category: "redirect-failure",
    },
    "redirect-loop": { title: "Redirect loops", severity: "warning", category: "redirect-failure" },
    "redirect-limit": {
      title: "Redirect hop limit exhausted",
      severity: "warning",
      category: "redirect-failure",
    },
    "redirect-invalid": {
      title: "Invalid redirects",
      severity: "warning",
      category: "redirect-failure",
    },
    successful: { title: "Successful response checks", severity: "info", category: "response" },
  };

function escape(value: string): string {
  return value.replaceAll(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

/** A URL may be evidence without being safe to navigate (for example a canonical scheme). */
function count(name: string, value: number): string {
  return `<span data-count="${name}">${value}</span>`;
}

function urlLink(value: string): string {
  const text = escape(value);
  return URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol)
    ? `<a href="${text}" rel="noreferrer">${text}</a>`
    : text;
}

export function renderReport(run: AuditRun): string {
  const destinationIds = new Map(
    run.destinations.map((destination, index) => [destination.url, `destination-${index}`]),
  );
  const pageIds = new Map(run.pages.map((page, index) => [page.url, `page-${index}`]));
  function reference(url: string): string {
    const id = pageIds.get(url) ?? destinationIds.get(url);
    return `${urlLink(url)}${id === undefined ? "" : ` (<a href="#${id}">retained evidence</a>)`}`;
  }
  function destinationEvidence(destination: DestinationResult): string {
    const links = run.links.filter((link) => link.destinationUrl === destination.url);
    const canonicals = run.canonicals.filter(
      (declaration) => declaration.destinationUrl === destination.url,
    );
    return `<article id="${destinationIds.get(destination.url)}" data-destination="${escape(destination.url)}">
<h4>${urlLink(destination.url)}</h4><dl><dt>Original destination</dt><dd>${escape(destination.url)}</dd><dt>Crawl identity</dt><dd>${escape(destination.crawlIdentity)}</dd><dt>Evidence</dt><dd>${escape(destination.evidence)}</dd>${destination.status === undefined ? "" : `<dt>HTTP status</dt><dd>${destination.status}</dd>`}</dl>
<h5>Source pages and discovered URL evidence</h5><ul>${links.map((link) => `<li data-source="navigation">${reference(link.sourceUrl)} — href: ${escape(link.href)}</li>`).join("")}${canonicals.map((declaration) => `<li data-source="canonical">Canonical: ${reference(declaration.sourceUrl)} — href: ${escape(declaration.href ?? "(missing)")}<pre>${escape(declaration.evidence)}</pre></li>`).join("")}</ul>${links.length + canonicals.length === 0 ? "<p>No discovered source page (starting destination).</p>" : ""}
${destination.finalUrl === undefined ? "" : `<h5>Final response</h5><p>${urlLink(destination.finalUrl)}</p><pre>${escape(JSON.stringify(destination.responseHeaders ?? {}, null, 2))}</pre>`}
${(destination.redirects?.length ?? 0) > 0 ? `<h5>Informational redirects</h5><ul>${destination.redirects!.map((redirect) => `<li>${urlLink(redirect.url)} — HTTP ${redirect.status} → ${redirect.target === undefined ? "Unresolved target" : urlLink(redirect.target)} (Location: ${escape(redirect.location)}; after ${redirect.attempts} attempts)<pre>${escape(JSON.stringify(redirect.responseHeaders, null, 2))}</pre></li>`).join("")}</ul>` : ""}</article>`;
  }
  const groups = Map.groupBy(run.destinations, (destination) => destination.outcome);
  const results = [...groups]
    .map(([outcome, destinations]) => {
      const group = outcomes[outcome];
      return `<section id="issue-${outcome}" data-issue="${outcome}" data-severity="${group.severity}" data-category="${group.category}"><h3>${group.title} — ${outcome} (${destinations.length})</h3><p>Classification: ${group.severity}</p>${destinations.map((destination) => destinationEvidence(destination)).join("")}</section>`;
    })
    .join("");
  const observationGroups = Map.groupBy(run.observations, (observation) => observation.kind);
  const duplicateGroups = Map.groupBy(run.duplicateMetadata, (group) => group.kind);
  const seo = [...observationGroups]
    .map(
      ([kind, observations]) =>
        `<section id="issue-${escape(kind)}" data-issue="${escape(kind)}" data-severity="${escape(observations[0]!.severity)}" data-category="seo"><h3>${escape(kind)} (${observations.length})</h3><ul>${observations.map((observation) => `<li><strong>${escape(observation.severity)}</strong> — ${reference(observation.url)}${observation.scope === undefined ? "" : ` — scope: ${escape(observation.scope)} (${escape(observation.source ?? "unspecified")})`}<pre>${escape(observation.evidence)}</pre></li>`).join("")}</ul></section>`,
    )
    .join("");
  const duplicates = [...duplicateGroups]
    .map(
      ([kind, metadataGroups]) =>
        `<section id="issue-${escape(kind)}" data-issue="${escape(kind)}" data-severity="warning" data-category="seo"><h3>${escape(kind)} — within this run (${metadataGroups.length} groups)</h3>${metadataGroups.map((group) => `<article><p><strong>${escape(group.severity)}</strong> — compared value: ${escape(group.value)}</p><h4>Affected pages and supporting values</h4><ul>${group.pages.map((page) => `<li>${reference(page.url)}<pre>${escape(JSON.stringify(page.values))}</pre></li>`).join("")}</ul></article>`).join("")}</section>`,
    )
    .join("");
  const seoCount = (severity: string) =>
    run.observations.filter((observation) => observation.severity === severity).length +
    run.duplicateMetadata.filter((group) => group.severity === severity).length;
  const redirected = run.destinations.filter(
    (destination) => (destination.redirects?.length ?? 0) > 0,
  );
  const redirects =
    redirected.length === 0
      ? ""
      : `<section id="issue-redirects" data-issue="redirects" data-severity="info" data-category="redirect"><h3>Informational redirects (${redirected.length} destinations)</h3><p>Redirects are not inherently broken; the final outcome is classified independently.</p><ul>${redirected.map((destination) => `<li>${reference(destination.url)} — ${escape(destination.outcome)}</li>`).join("")}</ul></section>`;
  const issueKinds = [
    ...groups.keys(),
    ...(redirected.length === 0 ? [] : ["redirects"]),
    ...observationGroups.keys(),
    ...duplicateGroups.keys(),
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Website audit</title>
<style>body{font:1rem system-ui;max-width:70rem;margin:2rem auto;padding:1rem}dt,h2{font-weight:bold}dd,pre,a{overflow-wrap:anywhere}pre{white-space:pre-wrap}article,section{border-top:1px solid #aaa;padding-top:1rem}a{color:#145caa}h3,h4{scroll-margin-top:1rem}</style></head><body>
<h1>Website audit</h1>${run.executionStatus === "completed" ? "" : "<p>Partial report: execution stopped at a configured limit or fatal failure.</p>"}<p>${run.destinations.length === 1 ? "Single-destination coverage: this" : "This"} run does not establish complete website health. SEO observations do not establish indexing intent or how search engines resolve directives.</p>
<dl id="attribution"><dt>Run</dt><dd>${escape(run.id)}</dd><dt>Execution</dt><dd>${escape(run.executionStatus)}</dd><dt>Started</dt><dd>${escape(run.startedAt)}</dd><dt>Finished</dt><dd>${escape(run.finishedAt)}</dd></dl>
<nav aria-label="Report sections"><a href="#summary">Summary</a> · <a href="#pages">Pages</a> · <a href="#issues">Issue groups</a> · <a href="#canonicals">Canonical declarations</a> · <a href="#coverage">Coverage limitations</a> · <a href="#configuration">Effective configuration</a></nav>
<section id="summary"><h2>Summary</h2><p>Destinations retained: ${count("destinations", run.destinations.length)}. Confirmed broken links: ${groups.get("confirmed-broken")?.length ?? 0}. Pages eligible for SEO: ${count("seo-pages", run.pages.filter((page) => page.seoEligible).length)}. Coverage limitations: ${count("coverage-limitations", run.limitations.length)}. SEO errors: ${count("seo-errors", seoCount("error"))}. SEO warnings: ${count("seo-warnings", seoCount("warning"))}. SEO informational observations: ${count("seo-info", seoCount("info"))}. Duplicate groups within this run: ${count("duplicate-groups", run.duplicateMetadata.length)}. Destinations with retained redirects: ${count("redirected-destinations", redirected.length)}.</p>
<p>Destination counts are unique original destinations, not HTTP requests or source occurrences. SEO counts are observations plus duplicate groups, not unique pages. Coverage limitations are retained evidence entries, which may overlap destination outcomes.</p>
<ul>${Object.entries(outcomes)
    .map(
      ([outcome, group]) =>
        `<li>${group.title}: ${count(outcome, run.destinations.filter((destination) => destination.outcome === outcome).length)}</li>`,
    )
    .join("")}</ul></section>
<section id="pages"><h2>Pages</h2><ul>${run.pages.map((page) => `<li id="${pageIds.get(page.url)}">${urlLink(page.url)} — depth ${page.depth}, crawl identity: ${escape(page.crawlIdentity)}, SEO eligible: ${page.seoEligible}</li>`).join("")}</ul></section>
<section id="issues"><h2>Issue groups and response outcomes</h2><ul>${issueKinds.map((kind) => `<li><a href="#issue-${escape(kind)}">${escape(kind)}</a></li>`).join("")}</ul>${results}${redirects}<h2>Page-local SEO observations</h2>${seo}<h2>Duplicate metadata within this run</h2><p>Only audited pages in this run are compared; these groups are not a website-wide inventory.</p>${duplicates}</section>
<section id="canonicals"><h2>Canonical declarations</h2><ul>${run.canonicals
    .map((declaration) => {
      const check = run.destinations.find(
        (destination) => destination.url === declaration.destinationUrl,
      );
      return `<li>${reference(declaration.sourceUrl)} — href: ${escape(declaration.href ?? "(missing)")} — target: ${declaration.destinationUrl === undefined ? "Unresolved" : reference(declaration.destinationUrl)}<pre>${escape(declaration.evidence)}${check ? ` ${escape(check.outcome)}: ${escape(check.evidence)}` : " No response health established."}</pre></li>`;
    })
    .join("")}</ul></section>
<section id="coverage"><h2>Coverage limitations</h2><p>Execution completion is separate from achieved coverage. Boundary exclusions, skipped checks and unresolved outcomes do not establish health.</p><ul>${run.limitations.map((value) => `<li>${escape(value)}</li>`).join("")}</ul></section>
<section id="configuration"><h2>Effective configuration</h2><pre>${escape(JSON.stringify(run.configuration, null, 2))}</pre></section></body></html>`;
}
