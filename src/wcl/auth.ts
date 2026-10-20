import type { WCLCredentials } from './types.ts';

const TOKEN_ENDPOINT = 'https://www.warcraftlogs.com/oauth/token';

export type Token = {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
};

export function basicAuthHeader({ clientId, clientSecret }: WCLCredentials): string {
  const pair = `${clientId}:${clientSecret}`;
  const encoded =
    typeof Buffer !== 'undefined'
      ? Buffer.from(pair).toString('base64')
      : btoa(pair);

  return `Basic ${encoded}`;
}

/**
 * OAuth2 client-credentials grant. Tokens are per-client, not per-user: the
 * client ID/secret identify your *application*, and every report you can see is
 * readable with it (public reports only, unless the user granted more).
 */
export async function fetchClientCredentialsToken(
  credentials: WCLCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<Token> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: basicAuthHeader(credentials),
    },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  });

  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string }
    | null;

  if (!res.ok || !body?.access_token) {
    throw new Error(
      `WCL token request failed (${res.status}): ${
        body?.error ?? res.statusText ?? 'no body'
      }`,
    );
  }

  const expiresIn = body.expires_in ?? 3600;

  return {
    accessToken: body.access_token,
    // Refresh a minute early so a request never races the expiry.
    expiresAt: Date.now() + Math.max(expiresIn - 60, 30) * 1000,
  };
}
