import { productionTransport } from "../../src/guarded-transport.ts";

// A fresh process is required: TLS extra trust is read at process startup.
const url = process.argv[2];
if (url === undefined || url === "") throw new Error("Missing probe URL");
try {
  const response = await productionTransport({
    url: new URL(url),
    address: "127.0.0.2",
    identity: "ConnectionContract/1.0",
    signal: AbortSignal.timeout(3_000),
  });
  console.log(JSON.stringify({ status: response.status, body: await response.text() }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
