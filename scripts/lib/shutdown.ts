/** Share an active/successful shutdown, but allow a failed attempt to be retried. */
export function retryableShutdown(action: () => Promise<void>): () => Promise<void> {
  let flight: Promise<void> | undefined;
  return () => flight ??= Promise.resolve().then(action).catch((error) => {
    flight = undefined;
    throw error;
  });
}
