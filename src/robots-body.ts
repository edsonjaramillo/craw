export class InvalidRobotsRules extends Error {}

/** Robots bodies are capped to keep both memory and coverage decisions bounded. */
export async function readRobots(response: Response, signal: AbortSignal): Promise<string> {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "identity") {
    throw new InvalidRobotsRules(`Robots rules use an unsupported content encoding: ${encoding}.`);
  }
  if (!response.body) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > 512 * 1024)
        throw new InvalidRobotsRules("Robots rules exceeded the 512 KiB safety bound.");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
