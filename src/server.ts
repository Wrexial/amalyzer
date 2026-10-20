/**
 * Local dev server: static page + the shared API handler.
 *
 * Production runs the same handler as a Netlify Function
 * (`netlify/functions/api.ts`), so local behaviour matches the deployed app.
 *
 *   npm run serve   ->  http://127.0.0.1:3000
 */

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApi } from './api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const port = Number(process.env.PORT ?? 3000);

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Body must be JSON');
  }
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ');
  }
  return headers;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const body = req.method === 'POST' ? await readJson(req) : {};
    const result = await handleApi({
      method: req.method ?? 'GET',
      path: url.pathname,
      headers: headersOf(req),
      body,
    });

    sendJson(res, result.status, result.body);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Amalyzer UI  ->  http://127.0.0.1:${port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is busy. Start with PORT=3001 npm run serve`);
    process.exitCode = 1;
    return;
  }
  throw error;
});
