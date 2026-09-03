import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCliPrompt, cliCommand, parseCliLesson, removeExtractDir } from './cli-extract.ts';

const LESSON = {
  id: '2026-09-03-saludos',
  date: '2026-09-03',
  slug: 'saludos',
  title: 'Saludos',
  summary: 'Greetings.',
};

describe('parseCliLesson', () => {
  it('accepts a bare lesson object', () => {
    expect(parseCliLesson(JSON.stringify(LESSON))).toMatchObject({ slug: 'saludos' });
  });

  it('unwraps Claude Code print-mode { result: "<json>" }', () => {
    const wrapped = JSON.stringify({ type: 'result', result: JSON.stringify(LESSON) });
    expect(parseCliLesson(wrapped)).toMatchObject({ title: 'Saludos' });
  });

  it('unwraps a Grok-style { text: "<json>" } wrapper', () => {
    const wrapped = JSON.stringify({ text: JSON.stringify(LESSON) });
    expect(parseCliLesson(wrapped)).toMatchObject({ slug: 'saludos' });
  });

  it('takes the last assistant message out of Kimi stream-json', () => {
    const lines = [
      JSON.stringify({ role: 'meta', type: 'system.version', version: '0.40.1' }),
      JSON.stringify({ role: 'assistant', content: '', tool_calls: [{ name: 'read_file', arguments: { path: 'prompt.txt' } }] }),
      JSON.stringify({ role: 'tool', content: 'It must match this JSON Schema.\n{"type":"object","properties":{}}' }),
      JSON.stringify({ role: 'assistant', content: JSON.stringify(LESSON) }),
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', content: 'To resume this session: kimi -r session_1' }),
    ].join('\n');
    expect(parseCliLesson(lines)).toMatchObject({ slug: 'saludos' });
  });

  it('accepts a markdown-fenced object with prose around it', () => {
    const text = `Sure.\n\n\`\`\`json\n${JSON.stringify(LESSON, null, 2)}\n\`\`\`\n`;
    expect(parseCliLesson(text)).toMatchObject({ slug: 'saludos' });
  });

  it('rejects empty or non-JSON output', () => {
    expect(() => parseCliLesson('')).toThrow(/empty/);
    expect(() => parseCliLesson('no json here')).toThrow(/JSON/);
  });
});

describe('cliCommand', () => {
  const dir = join(tmpdir(), 'hornbook-cli-extract-spec');

  it('pipes the prompt to Claude Code and Codex, and gives Codex no approval flag', () => {
    const claude = cliCommand('claude', '-', 'PROMPT', dir, {});
    expect(claude.bin).toBe('claude');
    expect(claude.stdin).toBe('PROMPT');
    expect(claude.args).toEqual(['-p', '--output-format', 'json', '--tools', '', '--permission-mode', 'dontAsk']);

    const codex = cliCommand('codex', 'gpt-5-codex', 'PROMPT', dir, {});
    expect(codex.stdin).toBe('PROMPT');
    expect(codex.args.slice(0, 2)).toEqual(['exec', '--skip-git-repo-check']);
    expect(codex.args).not.toContain('--ask-for-approval');
    expect(codex.args.slice(-2)).toEqual(['-m', 'gpt-5-codex']);
    expect(codex.answerFile).toBe(join(dir, 'answer.txt'));
  });

  it('hands Grok the prompt file and tells Kimi to read it, keeping the prompt off the command line', () => {
    const grok = cliCommand('grok', '-', 'PROMPT', dir, {});
    expect(grok.stdin).toBeUndefined();
    expect(grok.args).toContain(join(dir, 'prompt.txt'));
    expect(grok.args).not.toContain('-m');

    const kimi = cliCommand('kimi', '-', 'PROMPT', dir, {});
    expect(kimi.stdin).toBeUndefined();
    expect(kimi.args.join(' ')).not.toContain('PROMPT');
    expect(kimi.args.join(' ')).toMatch(/prompt\.txt/);
    expect(kimi.args).toContain('stream-json');
  });

  it('honours *_BIN and treats "-" and "default" as the CLI default', () => {
    expect(cliCommand('kimi', 'default', 'P', dir, { KIMI_BIN: 'C:\\k\\kimi.exe' }).bin).toBe('C:\\k\\kimi.exe');
    expect(cliCommand('kimi', 'default', 'P', dir, {}).args).not.toContain('-m');
    expect(cliCommand('kimi', 'kimi-for-coding', 'P', dir, {}).args.slice(-2)).toEqual(['-m', 'kimi-for-coding']);
    expect(cliCommand('claude', 'sonnet', 'P', dir, {}).args.slice(-2)).toEqual(['--model', 'sonnet']);
  });
});

describe('buildCliPrompt', () => {
  it('puts the system prompt, the text parts and the JSON schema in the prompt, and drops images', () => {
    const prompt = buildCliPrompt({
      system: 'SYSTEM',
      userParts: [
        { type: 'text', text: 'TRANSCRIPT' },
        { type: 'image', imageJpeg: Buffer.from('jpeg-bytes') },
      ],
      jsonSchema: { type: 'object', properties: { slug: { type: 'string' } } },
      toolName: 'save_lesson',
      toolDescription: 'Save the lesson.',
    });
    expect(prompt.indexOf('SYSTEM')).toBeLessThan(prompt.indexOf('TRANSCRIPT'));
    expect(prompt).toContain('save_lesson');
    expect(prompt).toContain('Save the lesson.');
    expect(prompt).toContain('"properties":{"slug"');
    expect(prompt).not.toContain('jpeg-bytes');
  });
});

describe('removeExtractDir', () => {
  it('deletes a temp folder and ignores a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornbook-cli-extract-test-'));
    removeExtractDir(dir);
    expect(existsSync(dir)).toBe(false);
    expect(() => removeExtractDir(join(tmpdir(), 'hornbook-cli-extract-missing'))).not.toThrow();
  });
});
