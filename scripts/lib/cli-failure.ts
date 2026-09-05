import { ProcessCleanupError } from './process-supervisor.ts';

/** Keep the CLI parent alive so its caller can still terminate the complete owned tree. */
export function retainFailedCleanup(error: unknown): boolean {
  if (!(error instanceof ProcessCleanupError)) return false;
  process.exitCode = 1;
  const report = (failure: Error) => console.error(`HORNBOOK_CLEANUP ${JSON.stringify({ error: failure.message })}`);
  report(error);
  console.error('Process cleanup is still pending. Retry cleanup in Jobs, or press Ctrl+C in this terminal.');
  const keepAlive = setInterval(() => undefined, 60_000);
  const retry = () => { void error.retryCleanup().catch(report); };
  process.on('SIGINT', retry);
  process.on('SIGTERM', retry);
  void error.owner.completion.then(() => {
    clearInterval(keepAlive);
    process.removeListener('SIGINT', retry);
    process.removeListener('SIGTERM', retry);
  });
  return true;
}
