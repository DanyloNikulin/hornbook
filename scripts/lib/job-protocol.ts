import { z } from 'zod';

export const JobEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stage'),
    id: z.enum(['hearing', 'slides', 'writing', 'checking']),
    status: z.enum(['running', 'done', 'skipped']),
  }),
  z.object({
    type: z.literal('progress'),
    progress: z.object({
      pct: z.number().transform((value) => Math.max(0, Math.min(100, value))),
      bytes: z.number().nonnegative().optional(),
      total: z.number().nonnegative().optional(),
      stage: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('result'),
    result: z.object({
      slug: z.string().optional(),
      id: z.string().optional(),
      tool: z.string().optional(),
      path: z.string().optional(),
      version: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal('cleanup'), error: z.string() }),
]);
export type JobEventT = z.infer<typeof JobEvent>;

/** Only the directly owned Node worker receives the IPC channel; tool output remains log text. */
export function emitJobEvent(event: JobEventT): void {
  if (process.send && process.connected) process.send(event);
  else console.log(JSON.stringify(event));
}
