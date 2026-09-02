import { Injectable } from '@angular/core';
import {
  JournalConfig,
  languageName,
  pairLabel,
  speechLocale,
  type JournalConfigT,
} from '../lib/journal-config';
import raw from '../lib/journal.config.json';

@Injectable({ providedIn: 'root' })
export class JournalService {
  readonly config: JournalConfigT = JournalConfig.parse(raw);

  targetCode(): string {
    return this.config.pair.target;
  }
  learnerCode(): string {
    return this.config.pair.learner;
  }
  targetName(): string {
    return languageName(this.config.pair.target);
  }
  learnerName(): string {
    return languageName(this.config.pair.learner);
  }
  labels(): { fwd: string; rev: string } {
    return pairLabel(this.config.pair.target, this.config.pair.learner);
  }
  brandName(): string {
    return this.config.brand.name;
  }
  tagline(): string {
    return this.config.brand.tagline;
  }
  speechLang(): string {
    return speechLocale(this.config.pair.target);
  }
}
