import { runAudit } from "../../src/audit-run";
import { productionTransport } from "../../src/guarded-transport";

// Child-process seam: NODE_EXTRA_CA_CERTS is startup-only. This adapter maps only
// after public policy validation; independent contracts prove production pinning.
if (import.meta.main) {
  const [port, databasePath, reportPath] = process.argv.slice(2);
  if (
    port === undefined ||
    port === "" ||
    databasePath === undefined ||
    databasePath === "" ||
    reportPath === undefined ||
    reportPath === ""
  )
    throw new Error("TLS audit fixture paths required");
  const result = await runAudit(
    {
      startUrl: "https://tls.audit.invalid/blog",
      pathRestriction: "/blog",
      crawlerIdentity: "AcceptanceBot",
      requests: { hostnameIntervalMs: 1, retries: 0 },
    },
    {
      databasePath,
      reportPath,
      dns: () => Promise.resolve(["93.184.216.34"]),
      transport: (request) => {
        const mapped = new URL(request.url);
        mapped.port = port;
        return productionTransport({ ...request, url: mapped, address: "127.0.0.2" });
      },
    },
  );
  console.log(JSON.stringify({ id: result.run.id, executionStatus: result.run.executionStatus }));
}
