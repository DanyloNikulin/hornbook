import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './store.ts';
import { JournalBusyError } from '../scripts/lib/file-commit.ts';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function requestBoundary(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    req.on('error', () => res.destroy());
    void (async () => {
      try {
        const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
        if (path.includes('\0')) throw new HttpError(400, 'Bad path');
        await handler(req, res);
      } catch (err) {
        if (res.destroyed) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (!req.complete) res.setHeader('Connection', 'close');
        const status = err instanceof JournalBusyError ? 503 : err instanceof HttpError ? err.status : err instanceof URIError ? 400 : 500;
        if (status === 503) res.setHeader('Retry-After', '1');
        sendJson(res, status, {
          error: status === 400 && err instanceof URIError ? 'Bad path' : (err as Error).message,
          ...(err instanceof HttpError && err.details !== undefined
            ? { details: err.details }
            : {}),
        });
      }
    })();
  };
}

/** Forwarded headers are not trusted. TLS proxies configure the public origin explicitly. */
export function checkMutationOrigin(req: IncomingMessage, publicOrigin?: string): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) return;
  if (req.headers['sec-fetch-site'] === 'cross-site')
    throw new HttpError(403, 'Cross-site mutation refused');
  const origin = req.headers.origin;
  if (origin === undefined) return; // Non-browser clients do not send Origin.
  const expected = publicOrigin || `http://${req.headers.host}`;
  try {
    if (
      origin === 'null' ||
      new URL(origin).origin !== origin ||
      origin !== new URL(expected).origin
    ) {
      throw new Error('origin mismatch');
    }
  } catch {
    throw new HttpError(403, 'Cross-origin mutation refused');
  }
}

export async function streamFile(path: string, res: ServerResponse): Promise<void> {
  await pipeline(createReadStream(path), res);
}

export function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json')
    throw new HttpError(415, 'Content-Type must be application/json');
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'Body too large');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const value: unknown = text.trim() ? JSON.parse(text) : {};
        settled = true;
        resolve(value);
      } catch {
        fail(new HttpError(400, 'Body is not valid JSON'));
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new HttpError(400, 'Request aborted')));
  });
}
