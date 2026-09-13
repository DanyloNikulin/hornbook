/** The build marker also protects unpacked Store builds used in smoke tests. */
export function storeDistribution(windowsStore: boolean | undefined, metadata: Record<string, unknown>): boolean {
  return windowsStore === true || metadata['hornbookDistribution'] === 'microsoft-store';
}
