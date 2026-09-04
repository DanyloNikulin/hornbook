const required = (names) => names.every((name) => process.env[name]);

const azureSigning = required([
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TRUSTED_SIGNING_ENDPOINT',
  'AZURE_TRUSTED_SIGNING_ACCOUNT',
  'AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE',
])
  ? {
      endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_TRUSTED_SIGNING_ACCOUNT,
      certificateProfileName: process.env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE,
    }
  : undefined;

const notarize = required(['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'])
  ? { teamId: process.env.APPLE_TEAM_ID }
  : false;

module.exports = {
  appId: 'io.github.danylonikulin.hornbook',
  productName: 'Hornbook',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: { output: 'release' },
  files: [
    'dist/hornbook/browser/**/*',
    'dist/node/**/*',
    'journal/**/*',
    'build/icon.png',
    'public/favicon.svg',
    'package.json',
    'LICENSE',
  ],
  asar: true,
  win: {
    icon: 'build/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64', 'arm64'] },
      { target: 'portable', arch: ['x64', 'arm64'] },
    ],
    ...(azureSigning ? { azureSignOptions: azureSigning } : {}),
  },
  nsis: { oneClick: true, perMachine: false },
  portable: { requestExecutionLevel: 'user' },
  mac: {
    icon: 'build/icon.icns',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    category: 'public.app-category.education',
    hardenedRuntime: true,
    notarize,
  },
  linux: {
    icon: 'build/icon.png',
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
    ],
    category: 'Education',
  },
  publish: { provider: 'github', owner: 'DanyloNikulin', repo: 'hornbook' },
};
