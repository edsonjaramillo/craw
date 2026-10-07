import { runAudit } from "./audit-run";
import { config } from "./config";

if (import.meta.main) {
  try {
    await runAudit(config);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Review the audit settings in src/config.ts.");
    process.exitCode = 1;
  }
}
