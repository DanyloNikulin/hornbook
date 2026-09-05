/** Explicit model files win over legacy saved or managed fallback paths. */
export function whisperModelPath(model: string, env: NodeJS.ProcessEnv): string {
  const selected = model.trim();
  if (/[/\\]/.test(selected) || /\.(?:bin|gguf)$/i.test(selected)) return selected;
  return env['WHISPER_MODEL']?.trim() || selected;
}
