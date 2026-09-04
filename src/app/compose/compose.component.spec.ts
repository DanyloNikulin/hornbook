import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatJobElapsed,
  formatStageElapsed,
  inferFrom,
  isAcceptedFile,
  previewSaveName,
  processStageProgress,
  providerName,
} from './compose.component';

describe('compose preflight helpers', () => {
  it('recognises every supported door without treating unknown files as video', () => {
    expect(inferFrom('lesson.MP4')).toBe('video');
    expect(inferFrom('lesson.m4a')).toBe('audio');
    expect(inferFrom('lesson.vtt')).toBe('transcript');
    expect(inferFrom('lesson.json')).toBe('json');
    expect(isAcceptedFile('lesson.webm')).toBe(true);
    expect(isAcceptedFile('lesson.exe')).toBe(false);
    expect(isAcceptedFile('lesson')).toBe(false);
    expect(isAcceptedFile('.json')).toBe(false);
  });

  it('previews the date and optional title in the eventual lesson filename', () => {
    expect(previewSaveName('2026-09-04', '')).toBe('2026-09-04-<title>.json');
    expect(previewSaveName('2026-09-04', '', 'titolo')).toBe('2026-09-04-<titolo>.json');
    expect(previewSaveName('2026-09-04', '  Città e caffè! ')).toBe('2026-09-04-citta-e-caffe.json');
  });

  it('keeps file and provider labels compact', () => {
    expect(formatBytes(552)).toBe('552 B');
    expect(formatBytes(202_656)).toBe('197.9 KB');
    expect(providerName('whisper-cli')).toBe('whisper.cpp');
    expect(providerName('claude-cli')).toBe('Claude Code');
  });

  it('formats live and finished elapsed time without counting queued time', () => {
    const now = Date.parse('2026-09-04T14:06:23.000Z');
    expect(
      formatJobElapsed(
        {
          createdAt: '2026-09-04T14:01:00.000Z',
          startedAt: '2026-09-04T14:02:11.000Z',
        },
        now,
      ),
    ).toBe('4:12');
    expect(
      formatJobElapsed({
        createdAt: '2026-09-04T14:01:00.000Z',
        startedAt: '2026-09-04T14:02:11.000Z',
        finishedAt: '2026-09-04T15:03:12.000Z',
      }),
    ).toBe('1:01:01');
  });

  it('shows per-stage elapsed time and progress across done, active and skipped stages', () => {
    const now = Date.parse('2026-09-04T14:06:23.000Z');
    expect(
      formatStageElapsed(
        { status: 'running', startedAt: '2026-09-04T14:04:59.000Z' },
        now,
      ),
    ).toBe('1:24');
    expect(formatStageElapsed({ status: 'skipped', startedAt: '2026-09-04T14:04:59.000Z' }, now)).toBe('');
    expect(processStageProgress([{ status: 'done' }, { status: 'skipped' }, { status: 'running' }, { status: 'waiting' }])).toBe(63);
  });
});
