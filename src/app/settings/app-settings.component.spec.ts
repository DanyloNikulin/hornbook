import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_KEYS } from '../../lib/api-types';
import { ApiService } from '../api.service';
import { I18nService } from '../i18n.service';
import { AppSettingsComponent } from './app-settings.component';

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
            get: vi.fn().mockResolvedValue({
              providers: {
                transcribe: { driver: 'whisper-cli', model: 'base' },
                extract: { driver: 'ollama', model: 'llama3.1' },
              },
              connections: emptyConnections,
            }),
            post: vi.fn(),
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
    const italian = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Italiano'));
    expect(italian).toBeTruthy();
    italian?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(root.textContent).toContain('Applicazione');
    expect(root.textContent).toContain('Interfaccia');
    expect(TestBed.inject(I18nService).locale()).toBe('it');
  });
});
