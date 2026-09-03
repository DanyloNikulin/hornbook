// Optional HTTP Basic authentication for hosted mode (`--password`). One
// owner, one password; the browser remembers it for the session. Anything
// more (users, sessions) is a non-goal — put an access proxy in front.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const REALM = 'Hornbook';

export function credentialsFromHeader(header: string | undefined): { user: string; password: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return { user: decoded, password: '' };
  return { user: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when the request carries the password (any user name). */
export function isAuthorized(req: Pick<IncomingMessage, 'headers'>, password: string): boolean {
  const creds = credentialsFromHeader(req.headers['authorization']);
  return !!creds && safeEqual(creds.password, password);
}

export function challenge(res: ServerResponse): void {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end('Hornbook: password required.');
}
