import { config } from "./config";

/** Anything shaped like the global fetch. Tests pass a fake. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchResult {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  body: Buffer;
}

export interface FetchOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
}

// New-style ids (2401.12345) and old-style ids (hep-th/9711200, math.GT/0309136).
const ARXIV_URL =
  /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\.pdf)?\/?(?:[?#].*)?$/i;

/** Returns the version-less arxiv id for an arxiv abs/pdf/html URL, else null. */
export function parseArxivId(url: string): string | null {
  const m = url.trim().match(ARXIV_URL);
  return m ? m[1] : null;
}

/** Lowercase scheme/host, drop fragment, tracking params and trailing slash. */
export function normalizeUrl(url: string): string {
  const u = new URL(url.trim());
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (key.startsWith("utm_")) u.searchParams.delete(key);
  }
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return s;
}

/** Canonical paper id: "arxiv:<id>" for arxiv, otherwise the normalized URL. */
export function canonicalId(url: string): string {
  const arxivId = parseArxivId(url);
  return arxivId ? `arxiv:${arxivId}` : normalizeUrl(url);
}

export class FetchError extends Error {}

/**
 * GET a URL with a timeout. Retries once on network error, timeout or 5xx;
 * never retries 4xx. HTTP error statuses are returned, not thrown — only
 * network-level failures (after the retry) throw FetchError.
 */
export async function fetchUrl(
  url: string,
  fetchFn: FetchFn = fetch,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? config.fetchTimeoutMs;
  const retryDelayMs = opts.retryDelayMs ?? config.retryDelayMs;

  for (let attempt = 1; ; attempt++) {
    const isLastAttempt = attempt === 2;
    try {
      const res = await fetchFn(url, {
        headers: { "User-Agent": config.userAgent },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500 && !isLastAttempt) {
        await res.body?.cancel();
        await sleep(retryDelayMs);
        continue;
      }
      const body = Buffer.from(await res.arrayBuffer());
      return {
        url,
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get("content-type") ?? "",
        body,
      };
    } catch (err) {
      if (!isLastAttempt) {
        await sleep(retryDelayMs);
        continue;
      }
      const reason = err instanceof Error && err.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : String(err);
      throw new FetchError(`${url}: ${reason}`);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
