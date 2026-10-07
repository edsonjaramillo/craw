import { runAudit } from "./audit-run";
import { config } from "./config";

if (import.meta.main) {
  try {
    const result = await runAudit(config);
    console.log(
      `Audit ${result.run.id}: ${result.run.executionStatus}; destination ${result.run.destination.outcome}.`,
    );
    console.log(`Single-destination report: ${result.reportPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Review the audit settings in src/config.ts.");
    process.exitCode = 1;
  }
}
