import { fetchClientCredentialsToken } from './auth.ts';
import type { WCLCredentials } from './types.ts';

export const WCL_GRAPHQL_ENDPOINT = 'https://www.warcraftlogs.com/api/v2/client';

/** How much of the hourly point budget is left, as reported by WCL. */
export type RateLimitInfo = {
  /** Points allowed per hour for this client. */
  limit: number | null;
  /** Points left right now. */
  points: number | null;
  /** Epoch ms when the budget resets. */
  resetAt: number | null;
};

export class WCLError extends Error {
  status: number;
  errors: unknown;
  query: string;

  constructor(message: string, status: number, errors: unknown, query: string) {
    super(message);
    this.name = 'WCLError';
    this.status = status;
    this.errors = errors;
    this.query = query;
  }
}

export type WCLClientOptions = {
  /** Either credentials (client-credentials flow) or a pre-fetched token. */
  credentials?: WCLCredentials;
  token?: string;
  endpoint?: string;
  /** Retries on 429/5xx. Default 3. */
  maxRetries?: number;
  /** Minimum gap between requests, to stay polite. Default 0. */
  minRequestIntervalMs?: number;
  fetchImpl?: typeof fetch;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Process-wide response cache. Netlify keeps warm function instances around, so
 * repeated analyses of the same report/windows avoid hitting WCL again.
 *
 * Scope by client id (or token) so private reports can never leak between
 * callers. Entries are bounded and LRU-ish (Map insertion order).
 */
type ResponseCacheEntry = { data: unknown; expiresAt: number };

const RESPONSE_CACHE_TTL_MS = 10 * 60 * 1000;
const RESPONSE_CACHE_MAX = 250;
const responseCache = new Map<string, ResponseCacheEntry>();

function cacheKey(scope: string, query: string, variables: Record<string, unknown>) {
  return `${scope}|${query}|${JSON.stringify(variables)}`;
}

function readCachedResponse(key: string): unknown | undefined {
  const entry = responseCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return undefined;
  }
  // Refresh LRU position.
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.data;
}

function writeCachedResponse(key: string, data: unknown) {
  if (responseCache.size >= RESPONSE_CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest != null) responseCache.delete(oldest);
  }
  responseCache.set(key, { data, expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS });
}

/**
 * Thin GraphQL client over the WCL v2 API.
 *
 * Design choices that matter in practice:
 * - The bearer token is cached and refreshed proactively, and once more on 401.
 * - 429s are retried with the server's `Retry-After` when present.
 * - Every call goes through a throttle so parallel window batches don't stampede.
 */
export class WCLClient {
  endpoint: string;
  lastRateLimit: RateLimitInfo = { limit: null, points: null, resetAt: null };

  #credentials: WCLCredentials | undefined;
  #token: string | undefined;
  #expiresAt = 0;
  #maxRetries: number;
  #minRequestIntervalMs: number;
  #lastRequestAt = 0;
  #fetch: typeof fetch;

  constructor(options: WCLClientOptions = {}) {
    this.endpoint = options.endpoint ?? WCL_GRAPHQL_ENDPOINT;
    this.#credentials = options.credentials;
    this.#token = options.token;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#minRequestIntervalMs = options.minRequestIntervalMs ?? 0;
    this.#fetch = options.fetchImpl ?? fetch;

    if (!this.#credentials && !this.#token) {
      throw new Error('WCLClient needs either `credentials` or `token`');
    }
  }

  setToken(token: string, expiresAt = 0) {
    this.#token = token;
    this.#expiresAt = expiresAt;
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.#token && Date.now() < this.#expiresAt) {
      return this.#token;
    }

    // A caller-supplied token without expiry: keep using it, let 401 refresh handle it.
    if (!this.#credentials) {
      if (!this.#token) throw new Error('No WCL token and no credentials to mint one');
      return this.#token;
    }

    const { accessToken, expiresAt } = await fetchClientCredentialsToken(
      this.#credentials,
      this.#fetch,
    );
    this.#token = accessToken;
    this.#expiresAt = expiresAt;

    return accessToken;
  }

  async request<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const scope = this.#credentials?.clientId ?? 'token';
    const key = cacheKey(scope, query, variables);
    const cached = readCachedResponse(key);
    if (cached !== undefined) return cached as T;

    let refreshedToken = false;

    for (let attempt = 0; ; attempt += 1) {
      await this.#throttle();

      const token = await this.getToken(refreshedToken);
      const res = await this.#fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
      });

      this.#readRateLimit(res);

      if (res.status === 401 && !refreshedToken && this.#credentials) {
        refreshedToken = true;
        attempt -= 1;
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < this.#maxRetries) {
        await sleep(this.#retryDelay(res, attempt));
        continue;
      }

      const body = (await res.json().catch(() => null)) as
        | { data?: T; errors?: unknown[] }
        | null;

      if (body?.errors?.length) {
        throw new WCLError(
          `WCL GraphQL error: ${JSON.stringify(body.errors)}`,
          res.status,
          body.errors,
          query,
        );
      }

      if (!res.ok || !body?.data) {
        throw new WCLError(
          `WCL request failed (${res.status} ${res.statusText})`,
          res.status,
          body?.errors ?? null,
          query,
        );
      }

      writeCachedResponse(key, body.data);
      return body.data;
    }
  }

  async #throttle() {
    if (this.#minRequestIntervalMs <= 0) return;

    const wait = this.#lastRequestAt + this.#minRequestIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);

    this.#lastRequestAt = Date.now();
  }

  #retryDelay(res: Response, attempt: number): number {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 0);
    }

    // Exponential backoff with jitter: ~1s, 2s, 4s.
    return 1000 * 2 ** attempt + Math.random() * 250;
  }

  #readRateLimit(res: Response) {
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    const points = Number(res.headers.get('x-ratelimit-points'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));

    this.lastRateLimit = {
      limit: Number.isFinite(limit) ? limit : null,
      points: Number.isFinite(points) ? points : null,
      resetAt: Number.isFinite(reset) ? reset * 1000 : null,
    };
  }
}
