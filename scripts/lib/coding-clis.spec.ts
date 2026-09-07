import { describe, expect, it } from 'vitest';
import { CODING_CLI_META, isCodingCli, parseCliVersion, updateCommandLine } from './coding-clis.ts';

describe('coding CLIs', () => {
  it('reads the version out of what each CLI prints', () => {
    expect(parseCliVersion('codex-cli 0.153.4\n')).toBe('0.153.4');
    expect(parseCliVersion('2.1.234 (Claude Code)')).toBe('2.1.234');
    expect(parseCliVersion('grok 1.0.13 (5e9a58528b76) [stable]')).toBe('1.0.13');
    expect(parseCliVersion('0.40.1')).toBe('0.40.1');
    expect(parseCliVersion('1.2.3-beta.1 build')).toBe('1.2.3-beta.1');
    expect(parseCliVersion('no version here')).toBeUndefined();
    expect(parseCliVersion(undefined)).toBeUndefined();
  });

  it('knows each CLI’s updater and shows it as a terminal line', () => {
    expect(updateCommandLine('codex', 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd')).toBe('codex update');
    expect(updateCommandLine('kimi', '/home/me/.kimi-code/bin/kimi')).toBe('kimi upgrade');
    expect(updateCommandLine('claude', 'claude')).toBe('claude update');
    expect(CODING_CLI_META.grok.update).toEqual(['update']);
  });

  it('accepts only the four CLI ids', () => {
    expect(isCodingCli('codex')).toBe(true);
    expect(isCodingCli('gpt')).toBe(false);
    expect(isCodingCli(undefined)).toBe(false);
  });
});
