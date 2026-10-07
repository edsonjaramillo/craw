import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate } from "node:zlib";

import { loadBuffer } from "cheerio";

const decoders = {
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress),
};

export class HtmlInspectionUnavailable extends Error {}

/** Decode the bytes that the pinned transport deliberately leaves untouched. */
export async function readHtml(response: Response, signal: AbortSignal) {
  const encodings = (response.headers.get("content-encoding") ?? "identity")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .toReversed();
  for (const encoding of encodings) {
    if (encoding !== "identity" && !Object.hasOwn(decoders, encoding))
      throw new HtmlInspectionUnavailable(`Unsupported HTML content encoding: ${encoding}`);
  }
  let bytes = Buffer.from(await response.arrayBuffer());
  signal.throwIfAborted();
  try {
    for (const encoding of encodings) {
      if (encoding === "gzip" || encoding === "deflate" || encoding === "br") {
        bytes = await decoders[encoding](bytes);
        signal.throwIfAborted();
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    throw new HtmlInspectionUnavailable(
      `HTML decompression failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu.exec(
    response.headers.get("content-type") ?? "",
  );
  const label = charset?.[1] ?? charset?.[2] ?? charset?.[3];
  // Cheerio sniffs BOM/meta declarations and honors HTTP encoding with HTML's legacy fallback.
  return loadBuffer(bytes, { encoding: { transportLayerEncodingLabel: label } });
}
