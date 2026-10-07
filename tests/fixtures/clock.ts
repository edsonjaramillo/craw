import type { AuditClock } from "../../src/audit-run";

/** Explicit advancement keeps waits, timeouts and retries independent of wall time. */
export class ManualClock implements AuditClock {
  time = Date.UTC(2026, 0, 1);
  timers = new Set<{ due: number; finish(): void }>();
  now() {
    return this.time;
  }
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.timers.delete(timer);
        reject(new Error("Sleep aborted", { cause: signal.reason }));
      };
      const timer = {
        due: this.time + ms,
        finish: () => {
          signal.removeEventListener("abort", cancel);
          this.timers.delete(timer);
          resolve();
        },
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      this.timers.add(timer);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  advance(ms: number) {
    this.time += ms;
    for (const timer of this.timers) if (timer.due <= this.time) timer.finish();
  }
}
export const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
