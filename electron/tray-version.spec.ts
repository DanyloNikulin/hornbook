import { describe, expect, it } from 'vitest';
import { trayVersionCopy } from './tray-version.ts';

describe('tray version copy', () => {
  it('shows the exact installed version in the label and tooltip', () => {
    expect(trayVersionCopy('0.9.2', false)).toEqual({
      label: 'Hornbook 0.9.2',
      tooltip: 'Hornbook 0.9.2',
    });
  });

  it('keeps the version visible when an update is waiting', () => {
    expect(trayVersionCopy('0.9.2', true).tooltip).toBe('Hornbook 0.9.2 · update available');
  });
});
