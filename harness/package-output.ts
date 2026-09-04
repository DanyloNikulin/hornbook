export function unpackedFolder(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  folders: readonly string[],
): string {
  const preferred = platform === 'win32'
    ? arch === 'arm64' ? ['win-arm64-unpacked', 'win-unpacked'] : ['win-unpacked', 'win-x64-unpacked']
    : platform === 'darwin'
      ? arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-x64']
      : arch === 'arm64' ? ['linux-arm64-unpacked', 'linux-unpacked'] : ['linux-unpacked', 'linux-x64-unpacked'];
  for (const name of preferred) if (folders.includes(name)) return name;
  const pattern = platform === 'win32'
    ? /^win(?:-.+)?-unpacked$/
    : platform === 'darwin'
      ? /^mac(?:-.+)?$/
      : /^linux(?:-.+)?-unpacked$/;
  return folders.find((name) => pattern.test(name)) ?? preferred[0];
}
