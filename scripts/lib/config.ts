// Language names and providers for the pipeline scripts, read from the
// section a script is working on (see journal.ts → useSection /
// resolveSectionArg). Kept as zero-argument helpers because the prompt
// builders are called deep inside transcribe/extract.

import { languageName, providersFor, type ProvidersT } from '../../src/lib/journal-config.ts';
import { currentSection, loadJournalConfig, repoRootDir } from './journal.ts';

export { loadJournalConfig, repoRootDir };

export function targetLanguageName(): string {
  return languageName(currentSection().target);
}

export function learnerLanguageName(): string {
  return languageName(currentSection().learner);
}

export function targetLanguageCode(): string {
  return currentSection().target;
}

/** Effective providers for the current section (section override over journal default). */
export function currentProviders(): ProvidersT {
  return providersFor(loadJournalConfig(), currentSection());
}
