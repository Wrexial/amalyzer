import type { Handler } from '@netlify/functions';

import { handleApi } from '../../src/api.ts';

/**
 * Netlify Function adapter. All routing lives in `src/api.ts`; this file only
 * translates the Netlify event envelope to our ApiRequest/ApiResponse shape.
 */
export const handler: Handler = async (event) => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
  }

  let body: unknown = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Body must be JSON' }),
      };
    }
  }

  const path = new URL(event.rawUrl ?? `https://amalyzer.netlify.app${event.path}`).pathname;
  const result = await handleApi({
    method: event.httpMethod,
    path,
    headers,
    body,
  });

  return {
    statusCode: result.status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(result.body),
  };
};
