// One JSON POST for the extract drivers, retried once when the request never
// reached HTTP (undici's "fetch failed": ECONNRESET, ECONNREFUSED). Ollama
// drops connections while it swaps one model out of memory for another,
// which is exactly when a cheat-sheet job follows a lesson written by a
// different model. HTTP errors are not retried; the caller reads them.

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  who: string,
  retryPauseMs: number,
): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
  try {
    return await fetch(url, init);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, retryPauseMs));
    try {
      return await fetch(url, init);
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`Extract ${who}: cannot reach ${url} (${cause?.code ?? cause?.message ?? (err as Error).message}).`);
    }
  }
}
