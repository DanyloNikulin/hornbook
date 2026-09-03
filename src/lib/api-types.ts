// Shapes exchanged between the server API and the client. Shared so both
// sides compile against one definition.

import type { JournalConfigT, SectionConfigT } from './journal-config';

export interface SectionSummary extends SectionConfigT {
  /** Explicit title or "Spanish → English". */
  label: string;
  flags: { target: string; learner: string };
  lessonCount: number;
}

export interface ConfigView {
  brand: JournalConfigT['brand'];
  providers: JournalConfigT['providers'];
  sections: SectionSummary[];
}

export interface ModeView {
  mode: 'local' | 'hosted';
  journal: string;
}

export interface ProcessResult {
  ok: boolean;
  log: string;
}
