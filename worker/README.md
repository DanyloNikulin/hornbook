# Optional R2 dispatcher

Not required. Default ingest is local (`npm run process` or `npm run ingest`).

If you still want Cloudflare R2 → GitHub Actions:

1. Create a bucket and queues; put their names in `wrangler.toml` (placeholders `hornbook-audio`, `hornbook-uploads`).
2. Set `GITHUB_OWNER` / `GITHUB_REPO` to **your** repo.
3. Store `GITHUB_TOKEN` as a Worker secret.

Never point this worker at someone else’s private lesson bucket.
