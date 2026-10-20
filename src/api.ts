import { analyzeReport } from './analysis/analyze.ts';
import { WCLClient } from './wcl/client.ts';
import type { WCLCredentials } from './wcl/types.ts';
import { fetchReportMeta, parseReportInput, selectFights } from './wcl/report.ts';

export type ApiRequest = {
  method: string;
  path: string;
  body: unknown;
  /** Header names must be lowercase. */
  headers: Record<string, string>;
};

export type ApiResponse = {
  status: number;
  body: unknown;
};

const CLIENT_ID_HEADER = 'x-wcl-client-id';
const CLIENT_SECRET_HEADER = 'x-wcl-client-secret';

function credentialsFromHeaders(headers: Record<string, string>): WCLCredentials | null {
  const clientId = headers[CLIENT_ID_HEADER]?.trim();
  const clientSecret = headers[CLIENT_SECRET_HEADER]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${name}" is required`);
  return value.trim();
}

function asOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`"${name}" must be a number`);
  return parsed;
}

function bodyOf(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) throw new Error('Body must be a JSON object');
  return body as Record<string, unknown>;
}

function makeClient(credentials: WCLCredentials): WCLClient {
  return new WCLClient({ credentials, minRequestIntervalMs: 120 });
}

function routeOf(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

/**
 * Framework-free API used by both the local dev server and the Netlify function.
 *
 * Stateless by design: every request carries the caller's WCL client id/secret
 * in headers. That is what lets it run on serverless hosting, where an
 * in-memory session would evaporate between invocations.
 */
export async function handleApi(request: ApiRequest): Promise<ApiResponse> {
  const route = routeOf(request.path);

  try {
    if (route === 'login') {
      if (request.method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };

      const body = bodyOf(request.body);
      const credentials: WCLCredentials = {
        clientId: asString(body.clientId, 'clientId'),
        clientSecret: asString(body.clientSecret, 'clientSecret'),
      };

      await makeClient(credentials).getToken(true); // throws on bad credentials
      return { status: 200, body: { authenticated: true } };
    }

    if (route === 'status') {
      return { status: 200, body: { ok: true, stateless: true } };
    }

    const credentials = credentialsFromHeaders(request.headers);
    if (!credentials) {
      return { status: 401, body: { error: 'Missing WCL credentials (connect first)' } };
    }

    if (request.method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };

    const body = bodyOf(request.body);
    const client = makeClient(credentials);

    if (route === 'meta') {
      const meta = await fetchReportMeta(client, parseReportInput(asString(body.report, 'report')).code);
      const encounterID = asOptionalNumber(body.encounterID, 'encounterID');

      return {
        status: 200,
        body: {
          code: meta.code,
          title: meta.title,
          region: meta.region.slug,
          zone: meta.zone?.name ?? null,
          fights: selectFights(meta, encounterID).map((fight) => ({
            id: fight.id,
            name: fight.name,
            encounterID: fight.encounterID,
            difficulty: fight.difficulty,
            kill: fight.kill,
            durationMs: fight.endTime - fight.startTime,
            fightPercentage: fight.fightPercentage,
          })),
          rateLimit: client.lastRateLimit,
        },
      };
    }

    if (route === 'damage') {
      const result = await analyzeReport(client, asString(body.report, 'report'), {
        ...(typeof body.fight === 'string' && body.fight ? { fight: body.fight } : {}),
        ...(asOptionalNumber(body.encounterID, 'encounterID') !== undefined
          ? { encounterID: asOptionalNumber(body.encounterID, 'encounterID')! }
          : {}),
        ...(asOptionalNumber(body.windowMs, 'windowMs') !== undefined
          ? { windowMs: asOptionalNumber(body.windowMs, 'windowMs')! }
          : {}),
        ...(asOptionalNumber(body.offsetMs, 'offsetMs') !== undefined
          ? { offsetMs: asOptionalNumber(body.offsetMs, 'offsetMs')! }
          : {}),
        ...(asOptionalNumber(body.slots, 'slots') !== undefined
          ? { slots: asOptionalNumber(body.slots, 'slots')! }
          : {}),
        ...(typeof body.filterExpression === 'string'
          ? { filterExpression: body.filterExpression }
          : {}),
        ...(asOptionalNumber(body.maxWindows, 'maxWindows') !== undefined
          ? { maxWindows: asOptionalNumber(body.maxWindows, 'maxWindows')! }
          : {}),
      });

      return { status: 200, body: result };
    }

    return { status: 404, body: { error: 'Not found' } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /credential|token request failed \(401\)|invalid_client/i.test(message) ? 401 : 400;
    return { status, body: { error: message } };
  }
}
