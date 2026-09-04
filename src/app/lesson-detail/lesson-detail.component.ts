import { ChangeDetectionStrategy, Component, computed, inject, input, resource } from '@angular/core';
import { SectionService } from '../section.service';
import { RouterLink } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { LessonsService, type RelatedByTopicsMeta } from '../lessons.service';
import { TPipe } from '../i18n.pipe';
import { QuizComponent } from '../quiz/quiz.component';
import { REPO_URL } from '../constants';
import type { LessonT, LessonMetaT } from '../../lib/schema';

@Component({
  selector: 'app-lesson-detail',
  imports: [RouterLink, QuizComponent, TPipe],
  templateUrl: './lesson-detail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LessonDetailComponent {
  protected readonly sec = inject(SectionService);
  private readonly lessons = inject(LessonsService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly slug = input.required<string>();

  // Lazy fetch of full lesson content via Angular 21's resource() API.
  // The loader returns the cached promise from LessonsService (idempotent
  // per slug), so the route re-entering the same slug is free.
  protected readonly lessonResource = resource<LessonT | undefined, string>({
    params: () => this.slug(),
    loader: async ({ params: slug }) => this.lessons.bySlug(slug),
  });

  // Template consumers — three states (loading, error, value) projected
  // through the resource's signal helpers so the @if ladder in the HTML
  // stays cheap and stable.
  protected readonly lesson = computed<LessonT | undefined>(() =>
    this.lessonResource.error() ? undefined : this.lessonResource.value(),
  );
  protected readonly loading = computed(() => this.lessonResource.isLoading());
  protected readonly error = computed(() => this.lessonResource.error());

  // Sync metadata for "not found" and chrome (date pill, breadcrumb). Avoids
  // showing a blank skeleton when the slug just doesn't exist in the manifest.
  protected readonly meta = computed(() => this.lessons.getMetaBySlug(this.slug()));

  // Navigation runs off metadata only — never blocks on the full-lesson
  // fetch, so the prev/next chrome appears instantly.
  protected readonly neighbors = computed(() => this.lessons.neighborsMeta(this.slug()));

  protected readonly lessonIndex = computed(() => {
    return this.lessons.numberBySlug(this.slug()) ?? '—';
  });

  // Topic-overlap suggestions: lessons sharing >=1 topic with this one,
  // ranked by overlap count. Pure metadata — no need to wait for full
  // lesson content.
  protected readonly relatedByTopics = computed<readonly RelatedByTopicsMeta[]>(() => {
    const m = this.meta();
    return m ? this.lessons.relatedByTopicsForMeta(m) : [];
  });

  // Metas we'll render from `related[]` after dropping any already covered by
  // the topic-overlap section. The full lesson is required to know its
  // AI-picked related[], so this only resolves after the resource loads.
  // Each slug is resolved to a LessonMetaT via the manifest so the template
  // can render proper titles instead of raw slug strings; slugs not in the
  // manifest (lesson deleted, slug renamed) are silently dropped — better a
  // shorter list than a dead link.
  protected readonly aiRelatedFallback = computed<readonly LessonMetaT[]>(() => {
    const l = this.lesson();
    if (!l) return [];
    const covered = new Set(this.relatedByTopics().map((r) => r.meta.slug));
    return l.related
      .filter((slug) => !covered.has(slug))
      .map((slug) => this.lessons.getMetaBySlug(slug))
      .filter((m): m is LessonMetaT => m !== undefined);
  });

  protected readonly articleHtml = computed<SafeHtml | null>(() => {
    const l = this.lesson();
    if (!l) return null;
    return this.renderMarkdown(l.article_md);
  });

  protected readonly slideHtml = computed<readonly SafeHtml[]>(() => {
    const l = this.lesson();
    return l ? l.slides.map((slide) => this.renderMarkdown(slide.text_md)) : [];
  });

  private renderMarkdown(markdown: string): SafeHtml {
    const rawHtml = marked.parse(markdown, { async: false }) as string;
    const clean = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(clean);
  }

  protected reload(): void {
    this.lessonResource.reload();
  }

  protected flagUrl(): string {
    const l = this.lesson();
    const m = this.meta();
    const slug = this.slug();
    const title = l?.title ?? m?.title ?? slug;
    const date = l?.date ?? m?.date ?? '';
    if (!title) return REPO_URL;
    const issueTitle = `Lesson mistake: ${title} (${slug})`;
    const body =
      `**Lesson:** [${title}](/${this.sec.id()}/lesson/${slug})\n` +
      `**Date:** ${date}\n\n` +
      `**What's wrong (be specific):**\n\n` +
      `**Suggested correction:**\n\n`;
    const params = new URLSearchParams({ title: issueTitle, body });
    return `${REPO_URL}/issues/new?${params.toString()}`;
  }
}
