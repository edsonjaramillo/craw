import { Database } from "bun:sqlite";

export { renderReport } from "./audit-report";

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
