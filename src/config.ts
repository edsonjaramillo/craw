import type { AuditConfigInput } from "./audit-config";

/** Edit this object before running `bun run src/index.ts` or `bun run start`. */
export const config = {
  // Required: supply the public HTTP(S) starting URL. Empty fails before network work.
  startUrl: "",
  // Omitted settings receive the defaults documented in README.md.
} satisfies AuditConfigInput;
