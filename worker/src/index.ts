// Cloudflare Worker that consumes R2 Event Notifications from the
// hornbook-audio bucket via a Queue, and fires a GitHub
// repository_dispatch event so process-lesson.yml runs in CI.
//
// Body shape from R2 EN: see https://developers.cloudflare.com/r2/buckets/event-notifications/
//
// Idempotency: every upload event is reduced to a stable identity
// (bucket + key + eTag/eventTime) and deduplicated through a Durable Object,
// so R2's at-least-once delivery and queue redeliveries can never start a
// second process-lesson.yml run for the same object version. The /replay
// operator endpoint feeds DLQ messages back through the same path.

interface R2EventBody {
  account: string;
  action: string;
  bucket: string;
  object: {
    key: string;
    size?: number;
    eTag?: string;
  };
  eventTime: string;
}

interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_TOKEN: string;
  // Optional allowlist: when set, events from any other bucket are dropped.
  // Anything later attached to the same queue can otherwise trigger lesson
  // runs.
  R2_BUCKET?: string;
  // Durable Object namespace holding one dedup record per upload identity.
  UPLOAD_DEDUP: DurableObjectNamespace;
  // Bearer token for the operator endpoints (/replay, /status). When unset,
  // the fetch handler answers 404 for everything — operator tooling disabled.
  REPLAY_TOKEN?: string;
}

// Upper bound on the GitHub API call. Without it a hung connection stalls the
// whole batch until the consumer's wall-clock limit, and every unacked
// message then burns one of its max_retries.
export const DISPATCH_TIMEOUT_MS = 10_000;

export const CREATE_ACTIONS = new Set(['PutObject', 'CompleteMultipartUpload', 'CopyObject']);

// Allowlist for R2 object keys.
// The CI workflow consistently passes the key through `env:` and references
// it as `"$R2_KEY"` (double-quoted) downstream, so we don't need a strict
// ASCII-only filter — we just have to block the bytes that break shell
// quoting or command substitution even inside double quotes:
//   "  closes the surrounding quote
//   $  triggers variable expansion
//   `  triggers command substitution
//   \  is the bash quote escape
//   \r \n \0  control bytes that can split commands
// Everything else (Unicode letters, spaces, commas, parens, etc.) is fine
// as a literal value once quoted. Extension must be one of the audio/video
// formats the pipeline can transcribe.
export const SAFE_R2_KEY = /^[^"$`\\\r\n\x00]+\.(mp4|m4a|mp3|wav|opus|ogg|webm|mov)$/iu;

// Carries the HTTP status from a failed GitHub dispatch so the queue
// handler can decide between ack (terminal 4xx) and retry (5xx/429).
export class GitHubDispatchError extends Error {
  status: number;
  bodyExcerpt: string;

  constructor(status: number, bodyExcerpt: string) {
    super(`GitHub dispatch failed (${status}): ${bodyExcerpt}`);
    this.name = 'GitHubDispatchError';
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

// Which failures should be retried (and, after max_retries, land in the
// dead-letter queue) versus dropped on the spot.
//
//   • 5xx / 429 — transient; retry.
//   • 401 / 403 / 404 — auth or configuration: a revoked or under-scoped PAT
//     (repository_dispatch needs contents:write; GitHub answers 404 for a
//     private repo the token cannot see). Retrying will not fix it either,
//     but *dropping* it loses the upload with nothing but a tail log line.
//     Retrying is bounded by max_retries and leaves the message in the DLQ
//     as a durable, replayable record for the operator.
//   • other 4xx (400, 422, …) — a malformed request, i.e. a bug in this
//     worker; drop and log.
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  if (status === 401 || status === 403 || status === 404) return true;
  return status >= 500 && status < 600;
}

async function dispatchToGitHub(env: Env, r2Key: string): Promise<void> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'hornbook-dispatcher',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'process-lesson',
      client_payload: { r2_key: r2Key },
    }),
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text();
    // Truncate to keep tail logs readable; GitHub error bodies are usually
    // small but no point letting a runaway payload flood the log line.
    const excerpt = body.length > 500 ? `${body.slice(0, 500)}…` : body;
    throw new GitHubDispatchError(resp.status, excerpt);
  }
}

// -----------------------------------------------------------------------------
// Idempotency
// -----------------------------------------------------------------------------

// Stable identity for one uploaded object version. The eTag is R2's content
// hash, so re-uploading the same key with new content yields a NEW identity
// and is processed again (it is a new lesson version). When the eTag is
// absent we fall back to eventTime: a redelivered queue message carries a
// byte-identical body, so dedup still holds for redeliveries, while distinct
// uploads get distinct identities.
export async function uploadIdentity(event: R2EventBody): Promise<string> {
  const version = event.object.eTag ?? event.eventTime ?? '';
  const data = new TextEncoder().encode(`${event.bucket}\n${event.object.key}\n${version}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type DedupState = 'processing' | 'dispatched' | 'failed';

export interface DedupRecord {
  state: DedupState;
  updatedAt: number;
}

export type ClaimResult = 'claimed' | 'duplicate' | 'in-progress';

// How long a 'processing' record is trusted to have a live owner. If the
// worker died between claim and complete, the queue redelivers the unacked
// message and the expired lease lets that redelivery reclaim the identity.
export const CLAIM_LEASE_MS = 10 * 60 * 1000;

const RECORD_KEY = 'record';

// One Durable Object per upload identity. All claim transitions for the same
// identity serialize through this single object, so concurrent duplicate
// deliveries cannot race into duplicate dispatches.
export class UploadDedup {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/claim') {
      return Response.json({ result: await this.claim() });
    }

    if (request.method === 'POST' && url.pathname === '/complete') {
      const body = await request.json<{ outcome?: unknown }>().catch(() => null);
      if (body?.outcome !== 'dispatched' && body?.outcome !== 'failed') {
        return Response.json({ error: 'outcome must be "dispatched" or "failed"' }, { status: 400 });
      }
      const record: DedupRecord = { state: body.outcome, updatedAt: Date.now() };
      await this.ctx.storage.put(RECORD_KEY, record);
      return Response.json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      const record = await this.ctx.storage.get<DedupRecord>(RECORD_KEY);
      return record
        ? Response.json(record)
        : Response.json({ error: 'unknown identity' }, { status: 404 });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  }

  // Read-modify-write inside a storage transaction: a concurrent request
  // either sees the record before or after this transition, never in between.
  private async claim(): Promise<ClaimResult> {
    return this.ctx.storage.transaction(async () => {
      const record = await this.ctx.storage.get<DedupRecord>(RECORD_KEY);
      const now = Date.now();
      if (record?.state === 'dispatched') return 'duplicate';
      if (record?.state === 'processing' && now - record.updatedAt < CLAIM_LEASE_MS) {
        return 'in-progress';
      }
      // Absent, failed, or an expired lease: this delivery owns the identity.
      const next: DedupRecord = { state: 'processing', updatedAt: now };
      await this.ctx.storage.put(RECORD_KEY, next);
      return 'claimed';
    });
  }
}

function dedupStub(env: Env, identity: string): DurableObjectStub {
  return env.UPLOAD_DEDUP.get(env.UPLOAD_DEDUP.idFromName(identity));
}

async function completeDedup(
  stub: DurableObjectStub,
  outcome: 'dispatched' | 'failed',
): Promise<void> {
  await stub.fetch('https://dedup/complete', {
    method: 'POST',
    body: JSON.stringify({ outcome }),
  });
}

export type EventOutcome =
  // GitHub dispatch accepted; identity marked 'dispatched'.
  | 'dispatched'
  // Identity already dispatched — nothing sent to GitHub.
  | 'duplicate'
  // A concurrent delivery of the same identity is dispatching right now.
  | 'in-progress'
  // Dispatch failed retryably; identity marked 'failed', message should retry.
  | 'retry'
  // Dispatch failed non-retryably (our bug); identity marked 'failed'.
  | 'dropped'
  // Event failed validation before any dedup/dispatch happened.
  | 'rejected';

// Runs one R2 event through validation, dedup, and the GitHub dispatch.
// Shared by the queue handler and the operator /replay endpoint so a replayed
// DLQ message is exactly as safe as a normal delivery.
async function processEvent(event: R2EventBody, env: Env): Promise<EventOutcome> {
  // Shape check — malformed bodies should drop, not retry-loop into the DLQ.
  if (typeof event?.action !== 'string' || typeof event?.object?.key !== 'string') {
    console.error('Malformed R2 event body, dropping:', JSON.stringify(event));
    return 'rejected';
  }

  if (!CREATE_ACTIONS.has(event.action)) {
    console.log(`Skipping ${event.action} for ${event.object.key}`);
    return 'rejected';
  }

  if (env.R2_BUCKET && event.bucket !== env.R2_BUCKET) {
    console.error(
      `Ignoring event from unexpected bucket ${JSON.stringify(event.bucket)} (expected ${env.R2_BUCKET}), dropping: ${event.object.key}`,
    );
    return 'rejected';
  }

  const key = event.object.key;

  // Reject keys that don't match the strict allowlist — anything weird
  // would flow verbatim into a CI shell context downstream.
  if (!SAFE_R2_KEY.test(key)) {
    console.error(`Rejecting unsafe R2 key (drops, no retry): ${JSON.stringify(key)}`);
    return 'rejected';
  }

  const identity = await uploadIdentity(event);
  const stub = dedupStub(env, identity);
  const claimResp = await stub.fetch('https://dedup/claim', { method: 'POST' });
  const { result } = await claimResp.json<{ result: ClaimResult }>();

  if (result === 'duplicate') {
    console.log(`Skipping duplicate delivery of ${key} — already dispatched`);
    return 'duplicate';
  }
  if (result === 'in-progress') {
    // A racing delivery owns the identity and will dispatch (or fail and
    // retry itself). If its worker dies mid-dispatch the message stays
    // unacked, the queue redelivers it, and the expired lease lets that
    // redelivery reclaim. Either way: exactly one workflow run.
    console.log(`Skipping ${key} — a concurrent delivery is already dispatching`);
    return 'in-progress';
  }

  console.log(`Dispatching: ${key} (${event.object.size ?? '?'} bytes)`);

  try {
    await dispatchToGitHub(env, key);
    await completeDedup(stub, 'dispatched');
    console.log(`✓ ${key}`);
    return 'dispatched';
  } catch (err) {
    // Mark 'failed' (not 'processing') so the retried redelivery — and an
    // operator /replay of the DLQ message — is allowed to claim again.
    await completeDedup(stub, 'failed');
    // See isRetryableStatus for the policy: transient and auth-class
    // failures retry (and end up in the DLQ), malformed-request 4xx drop.
    // Network errors, timeouts and anything thrown without a status are
    // retryable.
    if (err instanceof GitHubDispatchError && !isRetryableStatus(err.status)) {
      console.error(
        `✘ ${key}: non-retryable GitHub dispatch error ${err.status} (dropping, no retry): ${err.bodyExcerpt}`,
      );
      return 'dropped';
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✘ ${key}: ${message}`);
    return 'retry';
  }
}

function notFound(): Response {
  return Response.json({ error: 'not found' }, { status: 404 });
}

// HTTP status for a /replay outcome: the operator should see a non-200 when
// the replay did not (and will not) reach GitHub successfully.
const REPLAY_STATUS: Record<EventOutcome, number> = {
  dispatched: 200,
  duplicate: 200,
  'in-progress': 200,
  rejected: 400,
  dropped: 422,
  retry: 502,
};

export default {
  async queue(batch: MessageBatch<R2EventBody>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const outcome = await processEvent(msg.body, env);
      if (outcome === 'retry') {
        msg.retry();
      } else {
        msg.ack();
      }
    }
  },

  // Operator endpoints for the dead-letter queue. Both are gated
  // behind REPLAY_TOKEN; when the secret is not configured the worker answers
  // 404 for every route so the endpoints simply do not exist.
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.REPLAY_TOKEN) return notFound();

    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.REPLAY_TOKEN}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);

    // Replay a dead-lettered event: paste the DLQ message body verbatim.
    // Safe by construction — it goes through the same validation and dedup
    // as a live delivery, so replaying an already-dispatched event is a
    // no-op ({ result: 'duplicate' }) and never reaches GitHub.
    if (request.method === 'POST' && url.pathname === '/replay') {
      const body = await request.json<R2EventBody>().catch(() => null);
      if (body === null) {
        return Response.json({ error: 'body must be a JSON R2 event' }, { status: 400 });
      }
      const outcome = await processEvent(body, env);
      return Response.json({ result: outcome }, { status: REPLAY_STATUS[outcome] });
    }

    // Inspect the dedup record for an event without triggering anything.
    if (request.method === 'POST' && url.pathname === '/status') {
      const body = await request.json<R2EventBody>().catch(() => null);
      if (body === null || typeof body?.object?.key !== 'string') {
        return Response.json({ error: 'body must be a JSON R2 event' }, { status: 400 });
      }
      const identity = await uploadIdentity(body);
      const recordResp = await dedupStub(env, identity).fetch('https://dedup/status');
      const record = recordResp.ok ? await recordResp.json<DedupRecord>() : null;
      return Response.json({ identity, record });
    }

    return notFound();
  },
};
