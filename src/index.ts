import { runAudit } from "./audit-run";
import { config } from "./config";

if (import.meta.main) {
  try {
    const result = await runAudit(config);
    console.log(
      `Audit ${result.run.id}: ${result.run.executionStatus}; destination ${result.run.destination.outcome}.`,
    );
    console.log(`Audit report: ${result.reportPath}`);
    if (result.run.executionStatus === "failed") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Review the audit settings in src/config.ts.");
    process.exitCode = 1;
  }
}
