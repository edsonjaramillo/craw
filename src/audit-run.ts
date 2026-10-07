import { validateAuditConfig } from "./audit-config";

/** The audit-run boundary always validates settings before execution. */
export function runAudit(input: unknown): Promise<never> {
  return Promise.resolve().then(() => {
    validateAuditConfig(input);
    // Guarded transport, persistence, and reporting are implemented in issue #3.
    // Fail closed until then: never issue unguarded requests or claim a completed audit.
    throw new Error(
      "Audit execution is not implemented yet (issue #3). No network requests were made.",
    );
  });
}
