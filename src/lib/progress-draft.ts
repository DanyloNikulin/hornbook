import { z } from 'zod';
import { Progress } from './schema.js';

export const ProgressDraft = z.object({ revision: z.string(), snapshot: Progress });
export type ProgressDraftT = z.infer<typeof ProgressDraft>;
