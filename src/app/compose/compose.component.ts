import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Lesson } from '../../lib/schema';
import { JournalService } from '../journal.service';

@Component({
  selector: 'app-compose',
  imports: [FormsModule, RouterLink],
  templateUrl: './compose.component.html',
})
export class ComposeComponent {
  private readonly journal = inject(JournalService);
  protected readonly brand = this.journal.brandName();

  protected title = '';
  protected date = new Date().toISOString().slice(0, 10);
  protected summary = '';
  protected article = '';
  protected error = signal<string | null>(null);
  protected ok = signal<string | null>(null);
  protected ingestUp = signal(false);

  constructor() {
    void fetch('http://127.0.0.1:8787/ingest', { method: 'OPTIONS' })
      .then(() => this.ingestUp.set(true))
      .catch(() => this.ingestUp.set(false));
  }

  protected downloadJson(): void {
    this.error.set(null);
    const slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'lesson';
    const draft = {
      id: `${this.date}-${slug}`,
      date: this.date,
      slug,
      title: this.title || 'Untitled',
      summary: this.summary || 'Summary',
      article_md: this.article || '## Takeaway\n\n',
    };
    const parsed = Lesson.safeParse(draft);
    if (!parsed.success) {
      this.error.set('Lesson is not valid yet. Add a title, date, and summary.');
      return;
    }
    const blob = new Blob([JSON.stringify(parsed.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${parsed.data.id}.json`;
    a.click();
    this.ok.set(`Downloaded ${a.download}. Put it in lessons/ and run npm start.`);
  }

  protected async saveLocal(): Promise<void> {
    this.error.set(null);
    this.ok.set(null);
    const slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'lesson';
    const draft = {
      id: `${this.date}-${slug}`,
      date: this.date,
      slug,
      title: this.title || 'Untitled',
      summary: this.summary || 'Summary',
      article_md: this.article || '## Takeaway\n\n',
    };
    const parsed = Lesson.safeParse(draft);
    if (!parsed.success) {
      this.error.set('Lesson is not valid yet.');
      return;
    }
    try {
      const res = await fetch('http://127.0.0.1:8787/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'json', date: this.date, lesson: parsed.data }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; path?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      this.ok.set(`Saved ${body.path}. Restart or refresh after prestart rebuilds.`);
    } catch (e) {
      this.error.set(
        `${(e as Error).message}. Start ingest with npm run ingest, or use Download JSON.`,
      );
    }
  }

  protected async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set(null);
    this.ok.set(null);
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const base64 = btoa(binary);
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const from = ['txt', 'vtt', 'srt'].includes(ext)
      ? 'transcript'
      : ['m4a', 'mp3', 'wav', 'ogg'].includes(ext)
        ? 'audio'
        : 'video';
    try {
      const res = await fetch('http://127.0.0.1:8787/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'file',
          date: this.date,
          filename: file.name,
          base64,
          from,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; log?: string };
      if (!res.ok) throw new Error(body.error ?? body.log ?? res.statusText);
      this.ok.set('Processed. Refresh after the derived build.');
    } catch (e) {
      this.error.set(`${(e as Error).message}. Run npm run ingest on this machine.`);
    }
  }
}
