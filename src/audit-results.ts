import { Database } from "bun:sqlite";

import type { AuditConfig } from "./audit-config";
import type { CanonicalDeclaration } from "./canonicals";
import type { DuplicateMetadata, SeoObservation } from "./seo";

export type DestinationOutcome =
  | "successful"
  | "confirmed-broken"
  | "server-error"
  | "inaccessible"
  | "client-error"
  | "redirect-not-followed"
  | "redirect-loop"
  | "redirect-limit"
  | "redirect-invalid"
  | "inconclusive"
  | "refused"
  | "robots-excluded"
  | "robots-unavailable"
  | "limit-stopped";
export interface RedirectEvidence {
  url: string;
  status: number;
  location: string;
  target?: string;
  attempts: number;
  responseHeaders: Record<string, string>;
}
export interface DestinationResult {
  url: string;
  /** Original destination's identity; response health always belongs to url, not this key. */
  crawlIdentity: string;
  outcome: DestinationOutcome;
  status?: number;
  finalUrl?: string;
  responseHeaders?: Record<string, string>;
  redirects?: RedirectEvidence[];
  evidence: string;
}
export interface AuditRun {
  id: string;
  configuration: AuditConfig;
  startedAt: string;
  finishedAt: string;
  executionStatus: "completed" | "limit-stopped" | "failed";
  destination: DestinationResult;
  destinations: DestinationResult[];
  pages: { url: string; crawlIdentity: string; depth: number; seoEligible: boolean }[];
  links: { sourceUrl: string; href: string; destinationUrl: string }[];
  observations: SeoObservation[];
  canonicals: CanonicalDeclaration[];
  duplicateMetadata: DuplicateMetadata[];
  limitations: string[];
}

export function persistRun(path: string, run: AuditRun): void {
  const db = new Database(path, { create: true });
  try {
    db.run(`PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, configuration TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL, execution_status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS destinations (
        run_id TEXT NOT NULL REFERENCES runs(id), url TEXT NOT NULL, outcome TEXT NOT NULL,
        status INTEGER, evidence TEXT NOT NULL, PRIMARY KEY (run_id, url)
      );
      CREATE TABLE IF NOT EXISTS destination_responses (
        run_id TEXT NOT NULL, url TEXT NOT NULL, evidence TEXT NOT NULL,
        PRIMARY KEY (run_id, url), FOREIGN KEY (run_id, url) REFERENCES destinations(run_id, url)
      );
      CREATE TABLE IF NOT EXISTS pages (
        run_id TEXT NOT NULL REFERENCES runs(id), url TEXT NOT NULL, crawl_identity TEXT NOT NULL,
        depth INTEGER NOT NULL, seo_eligible INTEGER NOT NULL, PRIMARY KEY (run_id, crawl_identity)
      );
      CREATE TABLE IF NOT EXISTS source_links (
        run_id TEXT NOT NULL REFERENCES runs(id), source_url TEXT NOT NULL,
        href TEXT NOT NULL, destination_url TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canonical_declarations (
        run_id TEXT NOT NULL REFERENCES runs(id), source_url TEXT NOT NULL,
        href TEXT, destination_url TEXT, evidence TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seo_observations (
        run_id TEXT NOT NULL REFERENCES runs(id), url TEXT NOT NULL, kind TEXT NOT NULL,
        severity TEXT NOT NULL, evidence TEXT NOT NULL, scope TEXT, source TEXT
      );
      CREATE TABLE IF NOT EXISTS duplicate_metadata (
        run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, severity TEXT NOT NULL,
        scope TEXT NOT NULL, value TEXT NOT NULL, pages TEXT NOT NULL,
        PRIMARY KEY (run_id, kind, value)
      );
      CREATE TABLE IF NOT EXISTS coverage_limitations (
        run_id TEXT NOT NULL REFERENCES runs(id), evidence TEXT NOT NULL
      );`);
    db.transaction(() => {
      db.query(
        "INSERT INTO runs VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, execution_status = excluded.execution_status",
      ).run(
        run.id,
        JSON.stringify(run.configuration),
        run.startedAt,
        run.finishedAt,
        run.executionStatus,
      );
      for (const destination of run.destinations) {
        db.query(
          "INSERT INTO destinations VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, url) DO UPDATE SET outcome = excluded.outcome, status = excluded.status, evidence = excluded.evidence",
        ).run(
          run.id,
          destination.url,
          destination.outcome,
          destination.status ?? null,
          destination.evidence,
        );
        db.query(
          "INSERT INTO destination_responses VALUES (?, ?, ?) ON CONFLICT(run_id, url) DO UPDATE SET evidence = excluded.evidence",
        ).run(
          run.id,
          destination.url,
          JSON.stringify({
            crawlIdentity: destination.crawlIdentity,
            finalUrl: destination.finalUrl,
            responseHeaders: destination.responseHeaders,
            redirects: destination.redirects ?? [],
          }),
        );
      }
      db.query("DELETE FROM pages WHERE run_id = ?").run(run.id);
      for (const page of run.pages)
        db.query("INSERT INTO pages VALUES (?, ?, ?, ?, ?)").run(
          run.id,
          page.url,
          page.crawlIdentity,
          page.depth,
          Number(page.seoEligible),
        );
      db.query("DELETE FROM source_links WHERE run_id = ?").run(run.id);
      for (const link of run.links)
        db.query("INSERT INTO source_links VALUES (?, ?, ?, ?)").run(
          run.id,
          link.sourceUrl,
          link.href,
          link.destinationUrl,
        );
      db.query("DELETE FROM canonical_declarations WHERE run_id = ?").run(run.id);
      for (const declaration of run.canonicals)
        db.query("INSERT INTO canonical_declarations VALUES (?, ?, ?, ?, ?)").run(
          run.id,
          declaration.sourceUrl,
          declaration.href,
          declaration.destinationUrl ?? null,
          declaration.evidence,
        );
      db.query("DELETE FROM seo_observations WHERE run_id = ?").run(run.id);
      for (const observation of run.observations)
        db.query("INSERT INTO seo_observations VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          run.id,
          observation.url,
          observation.kind,
          observation.severity,
          observation.evidence,
          observation.scope ?? null,
          observation.source ?? null,
        );
      db.query("DELETE FROM duplicate_metadata WHERE run_id = ?").run(run.id);
      for (const group of run.duplicateMetadata)
        db.query("INSERT INTO duplicate_metadata VALUES (?, ?, ?, ?, ?, ?)").run(
          run.id,
          group.kind,
          group.severity,
          group.scope,
          group.value,
          JSON.stringify(group.pages),
        );
      db.query("DELETE FROM coverage_limitations WHERE run_id = ?").run(run.id);
      for (const evidence of run.limitations)
        db.query("INSERT INTO coverage_limitations VALUES (?, ?)").run(run.id, evidence);
    })();
  } finally {
    db.close();
  }
}

function escape(value: string): string {
  return value.replaceAll(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
export function renderReport(run: AuditRun): string {
  const results = run.destinations
    .map((destination) => {
      const sources = run.links.filter((link) => link.destinationUrl === destination.url);
      return `<section><h2>${escape(destination.outcome)}</h2><dl><dt>Original destination</dt><dd>${escape(destination.url)}</dd><dt>Crawl identity</dt><dd>${escape(destination.crawlIdentity)}</dd><dt>Evidence</dt><dd>${escape(destination.evidence)}</dd></dl>
<h3>Source pages and discovered URL evidence</h3><ul>${sources.map((link) => `<li>${escape(link.sourceUrl)} — href: ${escape(link.href)}</li>`).join("")}</ul>
${destination.finalUrl === undefined ? "" : `<h3>Final response</h3><p>${escape(destination.finalUrl)}</p><pre>${escape(JSON.stringify(destination.responseHeaders ?? {}, null, 2))}</pre>`}
${(destination.redirects?.length ?? 0) > 0 ? `<h3>Informational redirects</h3><ul>${destination.redirects!.map((redirect) => `<li>${escape(redirect.url)} — HTTP ${redirect.status} → ${escape(redirect.target ?? "Unresolved target")} (Location: ${escape(redirect.location)}; after ${redirect.attempts} attempts)<pre>${escape(JSON.stringify(redirect.responseHeaders, null, 2))}</pre></li>`).join("")}</ul>` : ""}</section>`;
    })
    .join("");
  const observationGroups = Map.groupBy(run.observations, (observation) => observation.kind);
  const seo = [...observationGroups]
    .map(
      ([kind, observations]) =>
        `<section><h3>${escape(kind)}</h3><ul>${observations.map((observation) => `<li><strong>${escape(observation.severity)}</strong> — ${escape(observation.url)}${observation.scope === undefined ? "" : ` — scope: ${escape(observation.scope)} (${escape(observation.source!)})`}<pre>${escape(observation.evidence)}</pre></li>`).join("")}</ul></section>`,
    )
    .join("");
  const duplicates = run.duplicateMetadata
    .map(
      (group) =>
        `<section><h3>${escape(group.kind)} — within this run</h3><p><strong>${group.severity}</strong> — compared value: ${escape(group.value)}</p><h4>Affected pages and supporting values</h4><ul>${group.pages.map((page) => `<li>${escape(page.url)}<pre>${escape(JSON.stringify(page.values))}</pre></li>`).join("")}</ul></section>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Website audit</title>
<style>body{font:1rem system-ui;max-width:70rem;margin:2rem auto;padding:1rem}dt,h2{font-weight:bold}dd{overflow-wrap:anywhere}</style>
<h1>Website audit</h1>${run.executionStatus === "completed" ? "" : "<p>Partial report: execution stopped at a configured limit or fatal failure.</p>"}<p>${run.destinations.length === 1 ? "Single-destination coverage: this" : "This"} run does not establish complete website health. SEO observations do not establish indexing intent or how search engines resolve directives.</p>
<dl><dt>Run</dt><dd>${escape(run.id)}</dd><dt>Execution</dt><dd>${run.executionStatus}</dd><dt>Started</dt><dd>${escape(run.startedAt)}</dd><dt>Finished</dt><dd>${escape(run.finishedAt)}</dd></dl>
<h2>Summary</h2><p>Destinations retained: ${run.destinations.length}. Confirmed broken links: ${run.destinations.filter((destination) => destination.outcome === "confirmed-broken").length}. Pages eligible for SEO: ${run.pages.length}. Coverage limitations: ${run.limitations.length}. SEO errors: ${run.observations.filter((observation) => observation.severity === "error").length}. SEO warnings: ${run.observations.filter((observation) => observation.severity === "warning").length + run.duplicateMetadata.length}. SEO informational observations: ${run.observations.filter((observation) => observation.severity === "info").length}.</p>
<h2>Pages</h2><ul>${run.pages.map((page) => `<li>${escape(page.url)} — depth ${page.depth}, crawl identity: ${escape(page.crawlIdentity)}</li>`).join("")}</ul>
${results}
<h2>Canonical declarations</h2><ul>${run.canonicals
    .map((declaration) => {
      const check = run.destinations.find(
        (destination) => destination.url === declaration.destinationUrl,
      );
      return `<li>${escape(declaration.sourceUrl)} — href: ${escape(declaration.href ?? "(missing)")} — target: ${escape(declaration.destinationUrl ?? "Unresolved")}<pre>${escape(declaration.evidence)}${check ? ` ${escape(check.outcome)}: ${escape(check.evidence)}` : ""}</pre></li>`;
    })
    .join("")}</ul>
<h2>Page-local SEO observations</h2>${seo}
<h2>Duplicate metadata within this run</h2><p>Only audited pages in this run are compared; these groups are not a website-wide inventory.</p>${duplicates}
<h2>Coverage limitations</h2><ul>${run.limitations.map((value) => `<li>${escape(value)}</li>`).join("")}</ul>
<h2>Effective configuration</h2><pre>${escape(JSON.stringify(run.configuration, null, 2))}</pre></html>`;
}
