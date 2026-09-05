/** Values stay below Node's signed 32-bit timer range. */
export function jobTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env['HORNBOOK_JOB_TIMEOUT_MINUTES']?.trim();
  if (!raw) return undefined;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10_080)
    throw new Error('HORNBOOK_JOB_TIMEOUT_MINUTES must be greater than 0 and at most 10080 (one week).');
  return minutes * 60_000;
}

export function jobTimeout(kind: string, override?: number): number {
  return override ?? (kind === 'process' ? 24 : 1) * 60 * 60 * 1000;
}
