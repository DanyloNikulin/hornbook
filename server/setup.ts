// Setup inside the app: the status of the local tools, a download plan for
// one of them (source, size, checksum, shown before anything is fetched),
// and the download itself as a job of the runner. The tools live in the
// tools folder, never in the journal.

import type { JobView, SetupPlanRequest, SetupView, DownloadPlan, StartSetupJob } from '../src/lib/api-types.ts';
import {
  OLLAMA_MODELS,
  TOOL_IDS,
  WHISPER_MODELS,
  installCommand,
  managedPaths,
  recommend,
  resolveDownload,
  toolsDir,
  type ToolId,
} from '../scripts/lib/tools.ts';
import { ollamaHost } from '../scripts/providers/ollama.ts';
import type { JobRunner } from './jobs.ts';
import type { ManagedOllama } from './managed-ollama.ts';
import { HttpError } from './store.ts';
import { defaultToolsDeps, machineInfo, toolStatuses, type ToolsDeps } from './tools.ts';

/** Jobs that belong to the journal, not to a pair, are filed under this section id. */
export const SETUP_SECTION = '_setup';

const PLAN_CACHE_MS = 60 * 60 * 1000;
const MODEL_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

export interface SetupDeps {
  journalDir: () => string;
  /** Environment the pipeline would see: process env plus the journal's secrets. */
  pipelineEnv: () => NodeJS.ProcessEnv;
  jobs: JobRunner;
  managed: ManagedOllama;
  tools?: ToolsDeps;
}

export interface SetupApi {
  view(): Promise<SetupView>;
  plan(raw: unknown): Promise<DownloadPlan>;
  start(raw: unknown): JobView;
  startOllama(): Promise<{ running: boolean; host: string; detail: string }>;
  /** At boot: run the managed Ollama when it is installed and nothing answers on the configured host. */
  bootManagedOllama(): Promise<void>;
}

export function createSetup(deps: SetupDeps): SetupApi {
  const tools = deps.tools ?? defaultToolsDeps();
  const planCache = new Map<string, { at: number; plan: DownloadPlan }>();

  const externalHost = (): string => ollamaHost({ OLLAMA_HOST: deps.pipelineEnv()['OLLAMA_HOST'] });

  async function externalAnswers(): Promise<boolean> {
    const host = externalHost();
    if (host === deps.managed.host) return false;
    try {
      const res = await tools.fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    async view(): Promise<SetupView> {
      const env = deps.pipelineEnv();
      const [statuses, machine] = await Promise.all([
        toolStatuses(tools, { env, managedOllama: { host: deps.managed.host, running: deps.managed.running() } }),
        machineInfo(tools),
      ]);
      const rec = recommend(machine);
      const commands = Object.fromEntries(
        TOOL_IDS.map((id) => [
          id,
          installCommand(id, tools.platform, id === 'whisper-model' ? rec.whisperModel : id === 'ollama-model' ? rec.ollamaModel : undefined),
        ]),
      ) as SetupView['commands'];
      return {
        toolsDir: toolsDir(tools.env, tools.platform),
        platform: tools.platform,
        machine,
        recommend: rec,
        tools: statuses,
        commands,
        whisperModels: WHISPER_MODELS.map((m) => ({ name: m.name, approxMb: m.approxMb })),
        ollamaModels: OLLAMA_MODELS.map((m) => ({ name: m.name, approxMb: m.approxMb, vision: m.vision })),
        ollama: {
          host: statuses[3].source === 'external' ? (statuses[3].path ?? externalHost()) : deps.managed.host,
          managed: statuses[3].source === 'managed',
          running: statuses[3].installed && (statuses[3].source === 'external' || !!statuses[3].running),
        },
      };
    },

    async plan(raw: unknown): Promise<DownloadPlan> {
      const req = parsePlanRequest(raw);
      const key = JSON.stringify(req);
      const cached = planCache.get(key);
      if (cached && Date.now() - cached.at < PLAN_CACHE_MS) return cached.plan;
      try {
        const plan = await resolveDownload(req.tool, {
          platform: tools.platform,
          arch: tools.arch,
          variant: req.variant,
          model: req.model,
          fetch: tools.fetch,
          ollamaHost: (await externalAnswers()) ? externalHost() : deps.managed.host,
        });
        planCache.set(key, { at: Date.now(), plan });
        return plan;
      } catch (err) {
        throw new HttpError(502, (err as Error).message);
      }
    },

    start(raw: unknown): JobView {
      const req = parsePlanRequest(raw);
      const input: StartSetupJob = { kind: 'setup', tool: req.tool };
      if (req.model) input.model = req.model;
      if (req.variant) input.variant = req.variant;
      const sha = raw && typeof raw === 'object' ? (raw as { sha256?: unknown }).sha256 : undefined;
      if (typeof sha === 'string') {
        if (!/^[0-9a-f]{64}$/i.test(sha)) throw new HttpError(400, 'sha256 must be 64 hex characters');
        input.sha256 = sha.toLowerCase();
      }
      return deps.jobs.enqueue(SETUP_SECTION, input);
    },

    async startOllama() {
      if (await externalAnswers()) {
        return { running: true, host: externalHost(), detail: `An Ollama already answers at ${externalHost()}; the managed one stays off.` };
      }
      if (!deps.managed.available()) {
        return { running: false, host: deps.managed.host, detail: `No managed Ollama at ${managedPaths(toolsDir(tools.env, tools.platform), tools.platform).ollama}.` };
      }
      const up = await deps.managed.start();
      return {
        running: up,
        host: deps.managed.host,
        detail: up ? `Hornbook's Ollama is up at ${deps.managed.host}.` : `It did not come up. Log: ${deps.managed.logTail().slice(-400)}`,
      };
    },

    async bootManagedOllama(): Promise<void> {
      if (!deps.managed.available()) return;
      if (await externalAnswers()) return;
      await deps.managed.start();
    },
  };
}

export function parsePlanRequest(raw: unknown): SetupPlanRequest {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Invalid setup request');
  const o = raw as Record<string, unknown>;
  const tool = o['tool'];
  if (typeof tool !== 'string' || !(TOOL_IDS as readonly string[]).includes(tool)) {
    throw new HttpError(400, `tool must be one of ${TOOL_IDS.join(', ')}`);
  }
  const out: SetupPlanRequest = { tool: tool as ToolId };
  if (o['model'] !== undefined) {
    if (typeof o['model'] !== 'string' || !MODEL_RE.test(o['model'])) throw new HttpError(400, 'model must be a short model name');
    out.model = o['model'];
  }
  if (o['variant'] !== undefined) {
    if (o['variant'] !== 'cpu' && o['variant'] !== 'cuda') throw new HttpError(400, 'variant must be cpu or cuda');
    out.variant = o['variant'];
  }
  return out;
}
