import { expect, it } from 'vitest';
import { jobTimeout, jobTimeoutFromEnv } from './job-timeout.ts';

it('allows long CPU processing by default and exposes an environment override', () => {
  expect(jobTimeout('process')).toBe(24 * 60 * 60 * 1000);
  expect(jobTimeout('setup')).toBe(60 * 60 * 1000);
  expect(jobTimeout('process', jobTimeoutFromEnv({ HORNBOOK_JOB_TIMEOUT_MINUTES: '180' }))).toBe(180 * 60_000);
  expect(jobTimeoutFromEnv({})).toBeUndefined();
});
it.each(['0', '-1', 'NaN', 'Infinity', '10081'])('rejects invalid timeout %s', (value) => {
  expect(() => jobTimeoutFromEnv({ HORNBOOK_JOB_TIMEOUT_MINUTES: value })).toThrow('HORNBOOK_JOB_TIMEOUT_MINUTES');
});
