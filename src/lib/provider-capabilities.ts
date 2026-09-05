/** Supported roles, shared by configuration validation and pipeline choices. */
export const PROVIDER_DRIVERS = {
  transcribe: ['openai', 'whisper-cli', 'skip'],
  extract: ['openai', 'anthropic', 'ollama', 'claude-cli', 'codex-cli', 'grok-cli', 'kimi-cli'],
} as const;

export function supportsRole(role: keyof typeof PROVIDER_DRIVERS, driver: string): boolean {
  return (PROVIDER_DRIVERS[role] as readonly string[]).includes(driver);
}
