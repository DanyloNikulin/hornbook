import { Injectable } from '@angular/core';
import { ProgressDraft, type ProgressDraftT } from '../lib/progress-draft';

/** Browser tabs own separate drafts; Electron stores its drafts outside the transient HTTP origin. */
@Injectable({ providedIn: 'root' })
export class ProgressDrafts {
  private readonly client = crypto.randomUUID();
  private readonly recovered = new Map<string, { key: string; text: string }>();

  private prefix(journal: string, section: string): string {
    return `hornbook-progress:${journal}:${section}:`;
  }

  read(journal: string, section: string): ProgressDraftT | null {
    const bridge = globalThis.window?.hornbookDesktop;
    if (bridge) {
      const result = bridge.progressDraft(section);
      if (result.error) throw new Error(result.error);
      return result.value === null ? null : ProgressDraft.parse(result.value);
    }
    const prefix = this.prefix(journal, section);
    const own = localStorage.getItem(prefix + this.client);
    if (own) return ProgressDraft.parse(JSON.parse(own));
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (!key.startsWith(prefix)) continue;
      const text = localStorage.getItem(key)!;
      const draft = ProgressDraft.parse(JSON.parse(text));
      this.recovered.set(prefix, { key, text });
      return draft;
    }
    return null;
  }

  write(journal: string, section: string, value: ProgressDraftT | null): void {
    const bridge = globalThis.window?.hornbookDesktop;
    if (bridge) {
      const result = bridge.progressDraft(section, value);
      if (result.error) throw new Error(result.error);
      return;
    }
    const prefix = this.prefix(journal, section);
    const key = prefix + this.client;
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else {
      localStorage.removeItem(key);
      const source = this.recovered.get(prefix);
      if (source && localStorage.getItem(source.key) === source.text)
        localStorage.removeItem(source.key);
      this.recovered.delete(prefix);
    }
  }
}
