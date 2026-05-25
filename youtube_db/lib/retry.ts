import { APIErrorCode, isNotionClientError } from "@notionhq/client";

export const MAX_ATTEMPTS = 6;

const RETRIABLE_CODES: ReadonlySet<string> = new Set([
  APIErrorCode.RateLimited,
  APIErrorCode.ServiceUnavailable,
  APIErrorCode.InternalServerError,
  "gateway_timeout",
]);

function backoffDelay(attempt: number, retryAfter: number): number {
  const base =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(2 ** attempt * 500, 30_000);
  return base + Math.floor(Math.random() * 250);
}

async function retryLoop(
  label: string,
  attempt: number,
  reason: string,
  retryAfter: number,
): Promise<void> {
  const delay = backoffDelay(attempt, retryAfter);
  console.log(
    `  ${label}: ${reason}, retrying in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS})`,
  );
  await Bun.sleep(delay);
}

function headerValue(headers: unknown, key: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(key) ?? undefined;
  if (typeof headers === "object") {
    const rec = headers as Record<string, unknown>;
    const v = rec[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retriable =
        isNotionClientError(err) && RETRIABLE_CODES.has(err.code);
      if (!retriable || attempt >= MAX_ATTEMPTS) throw err;
      const retryAfter = Number(
        headerValue((err as { headers?: unknown }).headers, "retry-after"),
      );
      await retryLoop(label, attempt, (err as { code: string }).code, retryAfter);
    }
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`${label} failed: ${res.status} ${await res.text()}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await retryLoop(label, attempt, `HTTP ${res.status}`, retryAfter);
  }
}
