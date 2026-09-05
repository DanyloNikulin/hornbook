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
                url === '/api/setup'
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
    const italian = [...root.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Italiano'),
    );
    expect(italian).toBeTruthy();
    italian?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(root.textContent).toContain('Applicazione');
    expect(root.textContent).toContain('Interfaccia');
    expect(TestBed.inject(I18nService).locale()).toBe('it');
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
      const choice = [...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (button) => button.textContent?.includes(label),
      );
      expect(choice, label).toBeTruthy();
      choice!.click();
      await fixture.whenStable();
      expect(root.querySelector('h1')?.textContent).toBe(title);
      expect(choice!.getAttribute('aria-checked')).toBe('true');
      expect(root.querySelectorAll('[role="radio"][aria-checked="true"]').length).toBe(1);
      expect(TestBed.inject(I18nService).locale()).toBe(locale);
      expect(localStorage.getItem('hornbook-locale')).toBe(locale);
      expect(document.documentElement.lang).toBe(locale);
    }
    fixture.destroy();
  });
});
