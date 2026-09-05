import type { ConnectionKey, DesktopPreferencesView, DesktopState, DesktopUpdateState } from './api-types.js';

export type DesktopToolPath = Extract<ConnectionKey, 'FFMPEG_BIN' | 'WHISPER_BIN' | 'WHISPER_MODEL'>;

/** Deliberately narrow API exposed by Electron's isolated preload. */
export interface HornbookDesktopBridge {
  progressDraft(section: string, value?: unknown): { value: unknown; error?: string };
  state(): Promise<DesktopState>;
  chooseJournal(): Promise<boolean>;
  openJournal(): Promise<void>;
  chooseToolPath(kind: DesktopToolPath): Promise<string | null>;
  setPreferences(patch: Partial<DesktopPreferencesView>): Promise<DesktopState>;
  checkForUpdates(force?: boolean): Promise<DesktopUpdateState>;
  restartToUpdate(): Promise<boolean>;
  onUpdate(listener: (state: DesktopUpdateState) => void): () => void;
}
