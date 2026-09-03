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
      detail: 'Pick one',
      models: ['llama3.2:latest', 'qwen2.5:7b'],
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
    expect(root.querySelector('.il-pipe-models .il-chip.active')).toBeNull();
    const chip = [...root.querySelectorAll('.il-pipe-models .il-chip')].find((b) =>
      b.textContent?.includes('qwen2.5:7b'),
    ) as HTMLButtonElement | undefined;
    chip?.click();
    fixture.detectChanges();
    expect(config.model).toBe('qwen2.5:7b');
    expect(chip?.classList.contains('active')).toBe(true);
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

  it('hides model chips when hearing is skipped', () => {
    const fixture = mount('transcribe', { driver: 'skip', model: '-' });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.il-pipe-models')).toBeNull();
    expect(root.textContent).not.toContain('This key can use');
  });
});
