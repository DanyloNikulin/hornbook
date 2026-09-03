import { describe, expect, it } from 'vitest';
import { credentialsFromHeader, isAuthorized } from './auth.ts';

const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('Basic auth', () => {
  it('parses a header', () => {
    expect(credentialsFromHeader(basic('me', 's3cret'))).toEqual({ user: 'me', password: 's3cret' });
    expect(credentialsFromHeader(basic('', 'a:b'))).toEqual({ user: '', password: 'a:b' });
    expect(credentialsFromHeader(undefined)).toBeNull();
    expect(credentialsFromHeader('Bearer x')).toBeNull();
    expect(credentialsFromHeader('Basic ???')).toBeNull();
  });

  it('accepts the password with any user name and rejects everything else', () => {
    expect(isAuthorized({ headers: { authorization: basic('anyone', 'pw') } }, 'pw')).toBe(true);
    expect(isAuthorized({ headers: { authorization: basic('anyone', 'pw ') } }, 'pw')).toBe(false);
    expect(isAuthorized({ headers: { authorization: basic('anyone', '') } }, 'pw')).toBe(false);
    expect(isAuthorized({ headers: {} }, 'pw')).toBe(false);
  });
});
