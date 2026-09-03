import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Lesson, type LessonT } from '../../lib/schema';
import type { ProcessResult } from '../../lib/api-types';
import { ApiService } from '../api.service';
import { LessonsService } from '../lessons.service';
import { VocabService } from '../vocab.service';
import { CardsService } from '../cards.service';
import { SectionService } from '../section.service';

type From = 'video' | 'audio' | 'transcript' | 'json';

@Component({
  selector: 'app-compose',
  imports: [FormsModule, RouterLink],
  templateUrl: './compose.component.html',
})
export class ComposeComponent {
  protected readonly sec = inject(SectionService);
  private readonly api = inject(ApiService);
  private readonly lessons = inject(LessonsService);
  private readonly vocab = inject(VocabService);
  private readonly cards = inject(CardsService);
  private readonly router = inject(Router);

  protected title = '';
  protected date = new Date().toISOString().slice(0, 10);
  protected summary = '';
  protected article = '';
  protected readonly error = signal<string | null>(null);
  protected readonly ok = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly log = signal<string | null>(null);

  private draft(): LessonT | null {
    const slug =
      this.title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'lesson';
    const parsed = Lesson.safeParse({
      id: `${this.date}-${slug}`,
      date: this.date,
      slug,
      title: this.title.trim() || 'Untitled',
      summary: this.summary.trim() || 'Summary',
      article_md: this.article.trim() || '## Takeaway\n\n',
    });
    if (!parsed.success) {
      this.error.set('Lesson is not valid yet. Add a title, a date and a summary.');
      return null;
    }
    return parsed.data;
  }

  /** Write the lesson into the section folder and open it. */
  protected async save(): Promise<void> {
    this.error.set(null);
    this.ok.set(null);
    const lesson = this.draft();
    if (!lesson) return;
    this.busy.set(true);
    try {
      const saved = await this.lessons.save(lesson);
      this.vocab.invalidate();
      this.cards.invalidate();
      await this.router.navigate(this.sec.link('lesson', saved.slug));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  /** Keep a copy outside the journal (share it, or add it elsewhere). */
  protected downloadJson(): void {
    this.error.set(null);
    const lesson = this.draft();
    if (!lesson) return;
    const blob = new Blob([JSON.stringify(lesson, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${lesson.id}.json`;
    a.click();
    this.ok.set(`Downloaded ${a.download}.`);
  }

  protected async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set(null);
    this.ok.set(null);
    this.log.set(null);
    this.busy.set(true);
    try {
      const base64 = await toBase64(file);
      const from = inferFrom(file.name);
      const result = await this.api.post<ProcessResult>(`${this.sec.apiBase()}/process`, {
        filename: file.name,
        base64,
        date: this.date,
        from,
      });
      this.log.set(result.log);
      if (!result.ok) {
        this.error.set('Processing failed — see the log below.');
        return;
      }
      await this.lessons.reload();
      this.vocab.invalidate();
      this.cards.invalidate();
      this.ok.set('Lesson added to this pair.');
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
      input.value = '';
    }
  }
}

function inferFrom(name: string): From {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  if (['.txt', '.vtt', '.srt'].includes(ext)) return 'transcript';
  if (ext === '.json') return 'json';
  if (['.m4a', '.mp3', '.wav', '.ogg', '.opus', '.aac'].includes(ext)) return 'audio';
  return 'video';
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
