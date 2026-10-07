import { Database } from "bun:sqlite";

import type { AuditConfig } from "./audit-config";

export type DestinationOutcome =
  | "successful"
  | "confirmed-broken"
  | "server-error"
  | "inaccessible"
  | "client-error"
  | "redirect-not-followed"
  | "inconclusive"
  | "refused"
  | "robots-excluded"
  | "robots-unavailable"
  | "limit-stopped";
export interface DestinationResult {
  url: string;
  outcome: DestinationOutcome;
  status?: number;
  evidence: string;
}
export interface AuditRun {
  id: string;
  configuration: AuditConfig;
  startedAt: string;
  finishedAt: string;
  executionStatus: "completed" | "limit-stopped" | "failed";
  destination: DestinationResult;
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
      const destination = run.destination;
      db.query(
        "INSERT INTO destinations VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, url) DO UPDATE SET outcome = excluded.outcome, status = excluded.status, evidence = excluded.evidence",
      ).run(
        run.id,
        destination.url,
        destination.outcome,
        destination.status ?? null,
        destination.evidence,
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
  const destination = run.destination;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Website audit</title>
<style>body{font:1rem system-ui;max-width:70rem;margin:2rem auto;padding:1rem}dt,h2{font-weight:bold}dd{overflow-wrap:anywhere}</style>
<h1>Website audit</h1>${run.executionStatus === "completed" ? "" : "<p>Partial report: execution stopped at a configured limit or fatal failure.</p>"}<p>Single-destination coverage: this run does not establish complete website health.</p>
<dl><dt>Run</dt><dd>${escape(run.id)}</dd><dt>Execution</dt><dd>${run.executionStatus}</dd><dt>Started</dt><dd>${escape(run.startedAt)}</dd><dt>Finished</dt><dd>${escape(run.finishedAt)}</dd></dl>
<h2>Summary</h2><p>Destinations retained: 1. Confirmed broken links: ${destination.outcome === "confirmed-broken" ? 1 : 0}. Coverage limitations: ${run.limitations.length}.</p>
<h2>${escape(destination.outcome)}</h2><dl><dt>Original destination</dt><dd>${escape(destination.url)}</dd><dt>Evidence</dt><dd>${escape(destination.evidence)}</dd></dl>
<h2>Coverage limitations</h2><ul>${run.limitations.map((value) => `<li>${escape(value)}</li>`).join("")}</ul>
<h2>Effective configuration</h2><pre>${escape(JSON.stringify(run.configuration, null, 2))}</pre></html>`;
}
