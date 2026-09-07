// The coding CLIs Hornbook can write notes with, and how each one updates
// itself. Shared by the setup view (installed versions) and the update job.

import { CODING_CLIS, type CodingCliKind } from '../providers/cli-extract.ts';

export interface CodingCliMeta {
  /** Product name shown in the app. */
  name: string;
  /** Arguments of the CLI's own updater. */
  update: readonly string[];
}

export const CODING_CLI_META: Record<CodingCliKind, CodingCliMeta> = {
  claude: { name: 'Claude Code', update: ['update'] },
  codex: { name: 'Codex', update: ['update'] },
  grok: { name: 'Grok', update: ['update'] },
  kimi: { name: 'Kimi Code', update: ['upgrade'] },
};

export function isCodingCli(value: unknown): value is CodingCliKind {
  return typeof value === 'string' && (CODING_CLIS as readonly string[]).includes(value);
}

/** The first semantic version in what `--version` printed: "codex-cli 0.153.4", "2.1.234 (Claude Code)", "grok 1.0.13 (5e9a58) [stable]". */
export function parseCliVersion(output: string | undefined): string | undefined {
  return output?.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

/** The updater as a terminal line, e.g. `codex update`. Windows paths are split on either separator, whatever the host. */
export function updateCommandLine(kind: CodingCliKind, bin: string): string {
  const file = bin.split(/[\\/]/).pop() || bin;
  return [file.replace(/\.(?:exe|cmd|bat|com)$/i, ''), ...CODING_CLI_META[kind].update].join(' ');
}
