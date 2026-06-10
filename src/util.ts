import { createHash } from "node:crypto";

/** Error whose `retryable` flag drives withRetry; `retryAfterMs` honors 429s. */
export class TransientError extends Error {
  retryable = true;
  retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  label?: string;
}

export const DEFAULT_RETRY: RetryOptions = {
  retries: 5,
  baseMs: 500,
  maxMs: 15_000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof TransientError ||
        (err instanceof TypeError && /fetch/i.test(err.message)); // network-level fetch failures
      if (!retryable || attempt === opts.retries) throw err;
      const backoff = Math.min(
        opts.maxMs,
        opts.baseMs * 2 ** attempt * (0.5 + Math.random()),
      );
      // Honor Retry-After but cap it: some edges (api.avax.network) send
      // hour-long values that would stall a run indefinitely.
      const delay =
        err instanceof TransientError && err.retryAfterMs !== null
          ? Math.min(Math.max(err.retryAfterMs, backoff), 60_000)
          : backoff;
      log(
        "warn",
        `retry ${attempt + 1}/${opts.retries} in ${Math.round(delay)}ms${opts.label ? ` [${opts.label}]` : ""}: ${(err as Error).message}`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal promise-concurrency limiter (p-limit equivalent). */
export function pLimit(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

/** Stable stringify (sorted keys) so content hashes are deterministic. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };
  // structured single-line JSON logs; human-readable enough on a terminal
  console.error(JSON.stringify(line));
}
