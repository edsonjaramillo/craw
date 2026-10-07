import type { RedirectEvidence } from "./audit-results";
import type { createGuardedFetch } from "./guarded-fetch";

export class RedirectFailure extends Error {
  constructor(
    public readonly outcome: "redirect-loop" | "redirect-limit" | "redirect-invalid",
    message: string,
  ) {
    super(message);
  }
}

/** Each hop re-enters the guarded scheduler; robots bootstrapping omits authorization only. */
export async function followRedirects<T>(
  url: URL,
  fetchGuarded: ReturnType<typeof createGuardedFetch>,
  maxHops: number,
  consume: (response: Response, signal: AbortSignal, url: URL) => T | Promise<T>,
  redirects: RedirectEvidence[],
  authorize?: (url: URL) => Promise<void>,
): Promise<{ value: T; attempts: number }> {
  const visited = new Set<string>();
  let current = url;
  let totalAttempts = 0;
  for (;;) {
    if (visited.has(current.href))
      throw new RedirectFailure(
        "redirect-loop",
        `Redirect loop at ${current.href} after ${totalAttempts} attempts.`,
      );
    visited.add(current.href);
    await authorize?.(current);
    const hop = current;
    const { value, attempts } = await fetchGuarded(hop, async (response, signal) => {
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null)
        return { terminal: true as const, value: await consume(response, signal, hop) };
      return {
        terminal: false as const,
        location,
        status: response.status,
        responseHeaders: Object.fromEntries(response.headers),
      };
    });
    totalAttempts += attempts;
    if (value.terminal) return { value: value.value, attempts };
    const redirect: RedirectEvidence = {
      url: current.href,
      status: value.status,
      location: value.location,
      responseHeaders: value.responseHeaders,
      attempts,
    };
    redirects.push(redirect);
    let target: URL;
    try {
      target = new URL(value.location, current);
      target.hash = "";
    } catch {
      throw new RedirectFailure(
        "redirect-invalid",
        `Invalid redirect Location at ${current.href}: ${value.location} after ${totalAttempts} attempts.`,
      );
    }
    redirect.target = target.href;
    if (redirects.length > maxHops)
      throw new RedirectFailure(
        "redirect-limit",
        `Redirect hop limit (${maxHops}) exhausted at ${current.href} after ${totalAttempts} attempts.`,
      );
    current = target;
  }
}
