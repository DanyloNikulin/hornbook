import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api.service';
import { I18nService } from '../i18n.service';
import { PipelineSetupComponent } from './pipeline-setup.component';

describe('PipelineSetupComponent', () => {
  let post: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    localStorage.removeItem('hornbook-locale');
    post = vi.fn();
    await TestBed.configureTestingModule({
      imports: [PipelineSetupComponent],
      providers: [{ provide: ApiService, useValue: { post } }],
    }).compileComponents();
    TestBed.inject(I18nService).set('en');
  });

  function mount(job: 'transcribe' | 'extract', config: { driver: string; model: string }) {
    const fixture = TestBed.createComponent(PipelineSetupComponent);
    fixture.componentRef.setInput('job', job);
    fixture.componentRef.setInput('config', config);
    fixture.componentRef.setInput('showConnections', false);
    fixture.detectChanges();
    return fixture;
  }

  it('does not invent model names for a local whisper file', () => {
    const fixture = mount('transcribe', { driver: 'whisper-cli', model: '' });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('does not guess the filename');
    expect(root.querySelector('.il-pipe-models')).toBeNull();
    expect(root.textContent).not.toContain('ggml-medium.bin');
  });

  it('shows models returned by the live connection and does not auto-pick', async () => {
    post.mockResolvedValue({
      ok: false,
      pick: true,
      detail: 'Pick one',
      models: ['qwen2.5:7b', 'llama3.2:latest'],
    });
    const config = { driver: 'ollama', model: '' };
    const fixture = mount('extract', config);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).not.toContain('llama3.2:latest');
    const find = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Find models'));
    expect(find).toBeTruthy();
    find?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.textContent).toContain('Pulled on this host');
    expect(root.textContent).toContain('llama3.2:latest');
    const options = [...root.querySelectorAll<HTMLButtonElement>('.il-model-option')];
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      'llama3.2:latest',
      'qwen2.5:7b',
    ]);
    // A found list waits for a pick; it is neither "Ready." nor "Not yet.".
    const result = root.querySelector('.il-pipe-result') as HTMLElement;
    expect(result.classList.contains('il-pipe-result--pick')).toBe(true);
    expect(result.classList.contains('il-pipe-result--bad')).toBe(false);
    expect(result.textContent).toContain('Connected.');
    expect(result.textContent).not.toContain('Not yet.');
    const search = root.querySelector<HTMLInputElement>('.il-model-search');
    expect(search).toBeTruthy();
    search!.value = 'qwen';
    search!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const filtered = [...root.querySelectorAll<HTMLButtonElement>('.il-model-option')];
    expect(filtered.map((option) => option.textContent?.trim())).toEqual(['qwen2.5:7b']);
    filtered[0]?.click();
    fixture.detectChanges();
    expect(config.model).toBe('qwen2.5:7b');
    expect(root.querySelector('.il-model-picker-trigger')?.textContent).toContain('qwen2.5:7b');
    expect(root.querySelector('.il-model-picker-popover')).toBeNull();
  });

  it('labels an API list as belonging to the key, not to Hornbook', async () => {
    post.mockResolvedValue({
      ok: false,
      detail: 'Pick one',
      models: ['claude-sonnet-4-6', 'gpt-4o'],
    });
    const fixture = mount('extract', { driver: 'anthropic', model: '' });
    const root = fixture.nativeElement as HTMLElement;
    const find = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Find models'));
    find?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.textContent).toContain('This key can use');
    expect(root.textContent).toContain('claude-sonnet-4-6');
    expect(root.querySelector('.il-pipe-models .il-chip.active')).toBeNull();
  });

  it('paints a real failure red', async () => {
    post.mockResolvedValue({ ok: false, detail: 'Cannot reach Ollama at http://127.0.0.1:11434. Timed out.' });
    const fixture = mount('extract', { driver: 'ollama', model: 'qwen2.5:7b' });
    const root = fixture.nativeElement as HTMLElement;
    // Before any list arrives the button reads "Find models" even with a model typed.
    const check = [...root.querySelectorAll('button')].find((b) => /Find models|Check this step/.test(b.textContent ?? ''));
    expect(check).toBeTruthy();
    check?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    const result = root.querySelector('.il-pipe-result') as HTMLElement;
    expect(result.classList.contains('il-pipe-result--bad')).toBe(true);
    expect(result.classList.contains('il-pipe-result--pick')).toBe(false);
    expect(result.textContent).toContain('Not yet.');
  });

  it('hides model chips when hearing is skipped', () => {
    const fixture = mount('transcribe', { driver: 'skip', model: '-' });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.il-model-picker')).toBeNull();
    expect(root.textContent).not.toContain('This key can use');
  });

  it('checks every coding CLI, labels experimental choices, and explains the default model', async () => {
    post.mockResolvedValue({ ok: true, detail: 'CLI found. Uses its own sign-in.' });
    const config = { driver: 'ollama', model: 'qwen2.5:7b' };
    const fixture = mount('extract', config);
    const root = fixture.nativeElement as HTMLElement;
    const here = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('This computer'));
    expect(here).toBeTruthy();
    here?.click();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelectorAll('.il-cli-status--ok')).toHaveLength(4);
    });
    expect(config.driver).toBe('claude-cli');
    expect(config.model).toBe('-');
    expect(root.textContent).toContain('Claude Code');
    expect(root.textContent).toContain('Codex');
    expect(root.textContent).toContain('Grok');
    expect(root.textContent).toContain('Kimi');
    expect(root.textContent).toContain('stores no key');
    expect(root.querySelectorAll('.il-cli-option')).toHaveLength(4);
    expect(root.querySelectorAll('.il-cli-status--ok')).toHaveLength(4);
    expect(root.querySelectorAll('.il-cli-experimental')).toHaveLength(2);
    expect(root.textContent).toContain('A single dash means Hornbook does not override');
    expect(post).toHaveBeenCalledTimes(4);
    const probedDrivers = post.mock.calls.map((call) => call[1]?.driver).sort();
    expect(probedDrivers).toEqual(['claude-cli', 'codex-cli', 'grok-cli', 'kimi-cli']);
    const grok = [...root.querySelectorAll<HTMLButtonElement>('.il-cli-pick')].find(
      (button) => button.textContent?.trim() === 'Grok',
    );
    grok?.click();
    fixture.detectChanges();
    expect(config.driver).toBe('grok-cli');
    const kimi = [...root.querySelectorAll<HTMLButtonElement>('.il-cli-pick')].find(
      (button) => button.textContent?.trim() === 'Kimi',
    );
    kimi?.click();
    fixture.detectChanges();
    expect(config.driver).toBe('kimi-cli');
  });

  it('warns about a missing CLI but allows selecting it for configuration', async () => {
    post.mockImplementation(async (_url: string, body: { driver: string }) =>
      body.driver === 'grok-cli'
        ? { ok: false, detail: 'The grok CLI is not on PATH.' }
        : { ok: true, detail: `${body.driver} found.` },
    );
    const fixture = mount('extract', { driver: 'ollama', model: 'qwen2.5:7b' });
    const root = fixture.nativeElement as HTMLElement;
    const here = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('This computer'),
    );
    here?.click();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelectorAll('.il-cli-status--ok, .il-cli-status--bad')).toHaveLength(4);
    });

    const grokCard = [...root.querySelectorAll<HTMLElement>('.il-cli-option')].find((card) =>
      card.textContent?.includes('Grok'),
    );
    expect(grokCard?.classList.contains('il-cli-option--missing')).toBe(true);
    expect((grokCard as HTMLButtonElement).disabled).toBe(false);
    expect(grokCard?.textContent).toContain('GROK_BIN');
    expect(grokCard?.textContent).toContain('Install this CLI');
  });

  it('switches CLI from the card description and resets its model', async () => {
    post.mockResolvedValue({ ok: true, detail: 'Installed' });
    const config = { driver: 'claude-cli', model: 'opus' };
    const fixture = mount('extract', config);
    const root = fixture.nativeElement as HTMLElement;
    const card = root.querySelector<HTMLButtonElement>('.il-cli-option[aria-label="Codex"]')!;
    card.querySelector<HTMLElement>('.il-cli-option-copy')!.click();
    fixture.detectChanges();
    expect(card.getAttribute('aria-checked')).toBe('true');
    expect(config).toEqual({ driver: 'codex-cli', model: '-' });
    await fixture.whenStable();
  });

  it('discards a delayed cloud probe after switching to a CLI', async () => {
    let finish!: (value: unknown) => void;
    post.mockImplementation((_url, body) => body.driver === 'openai'
      ? new Promise((resolve) => finish = resolve)
      : Promise.resolve({ ok: true, detail: 'Installed' }));
    const config = { driver: 'openai', model: 'old-model' };
    const fixture = mount('extract', config);
    const component = fixture.componentInstance as unknown as { check(): Promise<void>; setPlace(place: string): void };
    const checking = component.check();
    component.setPlace('cli');
    finish({ ok: true, detail: 'Obsolete cloud result', models: ['old-model'] });
    await checking;
    fixture.detectChanges();
    expect(config).toEqual({ driver: 'claude-cli', model: '-' });
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Obsolete cloud result');
    await fixture.whenStable();
  });
});
