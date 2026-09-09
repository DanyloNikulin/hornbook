import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_KEYS } from '../../lib/api-types';
import { ApiService } from '../api.service';
import { I18nService } from '../i18n.service';
import { AppSettingsComponent } from './app-settings.component';
import { JournalService } from '../journal.service';
import { UpdateService } from '../update.service';
import type { LocaleId } from '../../lib/i18n';

const emptyConnections = Object.fromEntries(
  CONNECTION_KEYS.map((k) => [k, { set: false, hint: '' }]),
);

describe('AppSettingsComponent', () => {
  beforeEach(async () => {
    localStorage.removeItem('hornbook-locale');
    await TestBed.configureTestingModule({
      imports: [AppSettingsComponent],
      providers: [
        provideRouter([]),
        {
          provide: ApiService,
          useValue: {
            get: vi.fn().mockImplementation((url: string) =>
              Promise.resolve(
                url === '/api/trash'
                  ? { entries: 2, files: 3, bytes: 2_100_000 }
                  : url === '/api/setup/clis'
                  ? []
                  : url === '/api/setup'
                  ? {
                      tools: [],
                      recommend: {
                        whisperModel: 'small',
                        whisperVariant: 'cpu',
                        ollamaModel: 'test',
                        note: '',
                      },
                      machine: { ramMb: 16000, arch: 'x64' },
                      platform: 'win32',
                      toolsDir: 'synthetic',
                      ollama: { running: false },
                    }
                  : {
                      providers: {
                        transcribe: { driver: 'whisper-cli', model: 'base' },
                        extract: { driver: 'ollama', model: 'llama3.1' },
                      },
                      connections: emptyConnections,
                    },
              ),
            ),
            post: vi.fn(),
            delete: vi.fn().mockResolvedValue({ entries: 0, files: 0, bytes: 0 }),
            put: vi.fn().mockImplementation((_url, input) => {
              const saved = {
                providers: structuredClone(input.providers),
                connections: emptyConnections,
              };
              vi.mocked(TestBed.inject(ApiService).get).mockResolvedValue(saved);
              return Promise.resolve(saved);
            }),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(I18nService).set('en');
  });

  it('switches the chrome locale from the application settings page', async () => {
    const fixture = TestBed.createComponent(AppSettingsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Application');
    expect(root.textContent).toContain('Interface');
    const select = root.querySelector<HTMLSelectElement>('.il-locale-select select');
    expect(select).toBeTruthy();
    expect([...select!.options].some((o) => o.textContent?.includes('Italiano'))).toBe(true);
    select!.value = 'it';
    select!.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(root.textContent).toContain('Applicazione');
    expect(root.textContent).toContain('Interfaccia');
    expect(TestBed.inject(I18nService).locale()).toBe('it');
  });

  it('reports the retained copies and empties them after a confirmation', async () => {
    const fixture = TestBed.createComponent(AppSettingsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const button = (label: string) =>
      [...root.querySelectorAll('.il-trash-action button')].find((b) =>
        b.textContent?.includes(label),
      ) as HTMLButtonElement | undefined;

    expect(root.querySelector('.il-trash-stats')!.textContent).toContain('2.0 MB');
    expect(root.querySelector('.il-trash-stats')!.textContent).toContain('3 files');
    expect(root.querySelector('.il-trash-stats')!.textContent).toContain('2 removals');

    // Emptying is destructive and asks before it runs.
    button('Empty trash')!.click();
    fixture.detectChanges();
    expect(TestBed.inject(ApiService).delete).not.toHaveBeenCalled();
    expect(root.querySelector('.il-trash-action')!.textContent).toContain('permanently?');

    button('Delete permanently')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(TestBed.inject(ApiService).delete).toHaveBeenCalledWith('/api/trash');
    expect(root.querySelector('.il-trash-stats')!.textContent).toContain('Nothing has been kept yet.');
    expect(root.querySelector('.il-trash-action')!.textContent).toContain('Trash emptied.');
    expect(button('Empty trash')).toBeUndefined();
  });

  it('keeps the retained copies when the confirmation is declined', async () => {
    const fixture = TestBed.createComponent(AppSettingsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const button = (label: string) =>
      [...root.querySelectorAll('.il-trash-action button')].find((b) =>
        b.textContent?.includes(label),
      ) as HTMLButtonElement | undefined;

    button('Empty trash')!.click();
    fixture.detectChanges();
    button('Keep them')!.click();
    fixture.detectChanges();
    expect(TestBed.inject(ApiService).delete).not.toHaveBeenCalled();
    expect(root.querySelector('.il-trash-stats')!.textContent).toContain('3 files');
    expect(button('Empty trash')).toBeTruthy();
  });

  it('shows the exact installed version in application settings', async () => {
    TestBed.inject(UpdateService).state.set({
      phase: 'current',
      currentVersion: '0.9.2',
      installable: false,
    });
    const fixture = TestBed.createComponent(AppSettingsComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const version = fixture.nativeElement.querySelector('.il-installed-version') as HTMLElement;
    expect(version.textContent).toContain('Installed version');
    expect(version.textContent).toContain('Hornbook 0.9.2');
  });

  it('publishes enabled, changed and disabled defaults after successful saves', async () => {
    const fixture = TestBed.createComponent(AppSettingsComponent);
    await fixture.whenStable();
    const component = fixture.componentInstance as unknown as {
      defaults: {
        transcribe: { driver: string; model: string };
        extract: { driver: string; model: string };
      };
      save(): Promise<void>;
    };
    for (const transcribe of [
      { driver: 'whisper-cli', model: 'small.bin' },
      { driver: 'whisper-cli', model: 'base.bin' },
      { driver: 'skip', model: '-' },
    ]) {
      component.defaults.transcribe = transcribe;
      await component.save();
      expect(TestBed.inject(JournalService).config().providers.transcribe).toEqual(transcribe);
    }
    fixture.destroy();
  });

  it('switches each new interface language and persists the choice', async () => {
    const fixture = TestBed.createComponent(AppSettingsComponent);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const choices: [LocaleId, string, string][] = [
      ['es', 'Español', 'Aplicación'],
      ['fr', 'Français', 'Application'],
      ['de', 'Deutsch', 'Anwendung'],
      ['pt', 'Português (Portugal)', 'Aplicação'],
      ['nl', 'Nederlands', 'Applicatie'],
      ['sv', 'Svenska', 'Program'],
      ['uk', 'Українська', 'Застосунок'],
    ];
    for (const [locale, label, title] of choices) {
      const select = root.querySelector<HTMLSelectElement>('.il-locale-select select');
      expect(select, label).toBeTruthy();
      const option = [...select!.options].find((o) => o.value === locale);
      expect(option?.textContent, label).toContain(label);
      select!.value = locale;
      select!.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(root.querySelector('h1')?.textContent).toBe(title);
      expect(select!.value).toBe(locale);
      expect([...select!.options].filter((o) => o.selected).length).toBe(1);
      expect(TestBed.inject(I18nService).locale()).toBe(locale);
      expect(localStorage.getItem('hornbook-locale')).toBe(locale);
      expect(document.documentElement.lang).toBe(locale);
    }
    fixture.destroy();
  });
});
