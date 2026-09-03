import { describe, expect, it } from 'vitest';
import {
  adoptPlace,
  canHear,
  cloudDriverFromKey,
  defaultPath,
  OPTIONAL_CONNECTIONS,
  pathFor,
  pathsFor,
  placeFor,
  PLACES_FOR,
} from './pipeline';

describe('pipeline paths', () => {
  it('gives transcribe skip, a computer path and a cloud path', () => {
    expect(PLACES_FOR.transcribe).toEqual(['skip', 'cli', 'cloud']);
    expect(pathFor('transcribe', 'skip')?.place).toBe('skip');
    expect(pathFor('transcribe', 'whisper-cli')?.place).toBe('cli');
    expect(pathFor('transcribe', 'openai')?.place).toBe('cloud');
    expect(pathFor('transcribe', 'ollama')).toBeUndefined();
  });

  it('gives extract a computer CLI, a LAN path and cloud APIs', () => {
    expect(PLACES_FOR.extract).toEqual(['cli', 'lan', 'cloud']);
    expect(placeFor('extract', 'claude-cli')).toBe('cli');
    expect(placeFor('extract', 'codex-cli')).toBe('cli');
    expect(placeFor('extract', 'ollama')).toBe('lan');
    expect(pathsFor('extract', 'cli').map((p) => p.driver)).toEqual([
      'claude-cli',
      'codex-cli',
      'grok-cli',
      'kimi-cli',
    ]);
    expect(placeFor('extract', 'grok-cli')).toBe('cli');
    expect(placeFor('extract', 'kimi-cli')).toBe('cli');
    expect(pathsFor('extract', 'cloud').map((p) => p.driver)).toEqual(['anthropic', 'openai']);
  });

  it('picks a default path when the place changes', () => {
    expect(defaultPath('transcribe', 'cli').driver).toBe('whisper-cli');
    expect(defaultPath('extract', 'cli').driver).toBe('claude-cli');
    // "-" = the model the CLI itself is set to; a guessed name is refused by the CLI
    expect(pathsFor('extract', 'cli').map((p) => p.defaultModel)).toEqual(['-', '-', '-', '-']);
    expect(defaultPath('extract', 'lan').driver).toBe('ollama');
    expect(defaultPath('extract', 'cloud').driver).toBe('anthropic');
  });

  it('sniffs the cloud driver from the key prefix', () => {
    expect(cloudDriverFromKey('sk-ant-abc')).toBe('anthropic');
    expect(cloudDriverFromKey('sk-proj-abc')).toBe('openai');
    expect(cloudDriverFromKey('not-a-key')).toBeUndefined();
  });

  it('does not invent a model name when switching place', () => {
    const cfg = { driver: 'ollama', model: 'qwen2.5:7b' };
    adoptPlace('extract', 'cloud', cfg);
    expect(cfg.driver).toBe('anthropic');
    expect(cfg.model).toBe('qwen2.5:7b');
    adoptPlace('extract', 'lan', cfg);
    expect(cfg.driver).toBe('ollama');
    expect(cfg.model).toBe('qwen2.5:7b');
  });

  it('does not bounce an already-cloud extract driver', () => {
    const cfg = { driver: 'openai', model: 'my-finetune' };
    adoptPlace('extract', 'cloud', cfg);
    expect(cfg.driver).toBe('openai');
    expect(cfg.model).toBe('my-finetune');
  });

  it('carries no model name onto a coding CLI, and none off it', () => {
    const cfg = { driver: 'ollama', model: 'gemma3:4b' };
    adoptPlace('extract', 'cli', cfg);
    expect(cfg.driver).toBe('claude-cli');
    expect(cfg.model).toBe('-');
    adoptPlace('extract', 'lan', cfg);
    expect(cfg.driver).toBe('ollama');
    expect(cfg.model).toBe('');
    const whisper = { driver: 'whisper-cli', model: 'C:\\models\\ggml-small.bin' };
    adoptPlace('transcribe', 'cloud', whisper);
    expect(whisper.driver).toBe('openai');
    expect(whisper.model).toBe('');
  });

  it('does not bounce Claude Code and Codex when writing stays on this computer', () => {
    const cfg = { driver: 'codex-cli', model: 'gpt-5-codex' };
    adoptPlace('extract', 'cli', cfg);
    expect(cfg.driver).toBe('codex-cli');
    expect(cfg.model).toBe('gpt-5-codex');
    const grok = { driver: 'grok-cli', model: 'grok-4' };
    adoptPlace('extract', 'cli', grok);
    expect(grok.driver).toBe('grok-cli');
    expect(grok.model).toBe('grok-4');
  });

  it('the free combination is whisper-cli on this computer plus Ollama on the LAN', () => {
    const hear = pathFor('transcribe', 'whisper-cli');
    const write = pathFor('extract', 'ollama');
    expect(hear).toMatchObject({ place: 'cli', modelKind: 'file', connections: ['WHISPER_BIN'] });
    expect(write).toMatchObject({ place: 'lan', modelKind: 'name', connections: ['OLLAMA_HOST'] });
    expect(canHear('whisper-cli')).toBe(true);
    expect(canHear('ollama')).toBe(false);
    expect(OPTIONAL_CONNECTIONS.has('OLLAMA_HOST')).toBe(true);
    expect(cloudDriverFromKey('')).toBeUndefined();
  });
});
