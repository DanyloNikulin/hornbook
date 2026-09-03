// Ollama's native API, for what its OpenAI-compatible endpoint cannot say:
// which pulled models can write text, and which can look at images.

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

/** OLLAMA_HOST without a trailing slash; empty or unset means the local default. */
export function ollamaHost(env: NodeJS.ProcessEnv = process.env): string {
  return (env['OLLAMA_HOST']?.trim() || DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
}

/**
 * Capabilities of a pulled model ("completion", "vision", "tools",
 * "embedding") from POST /api/show. Undefined when the server does not
 * report them (before Ollama 0.6.5) or cannot be reached: callers treat that
 * as "unknown", never as "no".
 */
export async function ollamaCapabilities(
  host: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<string[] | undefined> {
  try {
    const res = await fetchImpl(`${host}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { capabilities?: unknown };
    return Array.isArray(json.capabilities)
      ? json.capabilities.filter((c): c is string => typeof c === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}
