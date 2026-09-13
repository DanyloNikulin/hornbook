export interface MsixIdentity {
  name: string;
  publisher: string;
  publisherDisplayName: string;
  displayName: string;
}

export const PREVIEW_IDENTITY: MsixIdentity = {
  name: 'Hornbook.MsixPreview',
  publisher: 'CN=Hornbook MSIX Preview',
  publisherDisplayName: 'Hornbook local test',
  displayName: 'Hornbook MSIX Preview',
};

export function msixIdentity(preview: boolean, env: NodeJS.ProcessEnv): MsixIdentity {
  if (preview) return PREVIEW_IDENTITY;
  const name = env['HORNBOOK_STORE_IDENTITY_NAME']?.trim();
  const publisher = env['HORNBOOK_STORE_PUBLISHER']?.trim();
  const publisherDisplayName = env['HORNBOOK_STORE_PUBLISHER_DISPLAY_NAME']?.trim();
  const displayName = env['HORNBOOK_STORE_DISPLAY_NAME']?.trim();
  if (!name || !publisher || !publisherDisplayName || !displayName) {
    throw new Error('Store builds require HORNBOOK_STORE_IDENTITY_NAME, HORNBOOK_STORE_PUBLISHER, HORNBOOK_STORE_PUBLISHER_DISPLAY_NAME and HORNBOOK_STORE_DISPLAY_NAME from Partner Center. Use --preview for local testing.');
  }
  if (name === PREVIEW_IDENTITY.name || publisher === PREVIEW_IDENTITY.publisher) {
    throw new Error('The local preview identity must not be submitted to Microsoft Store.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,48}[A-Za-z0-9]$/.test(name) || !publisher.startsWith('CN=')) {
    throw new Error('Invalid Store identity name or publisher. Copy the exact values from Partner Center.');
  }
  return { name, publisher, publisherDisplayName, displayName };
}

export function msixVersion(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || Number(match[1]) >= 65535 || match.slice(2).some((part) => Number(part) > 65535)) {
    throw new Error('MSIX requires a release version with major at most 65534 and minor/patch at most 65535.');
  }
  // Store requires a nonzero major. Offset every release, including 1.x onward,
  // so the transition out of 0.x never collides with or downgrades a package.
  return `${Number(match[1]) + 1}.${match[2]}.${match[3]}.0`;
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function msixManifest(identity: MsixIdentity, version: string, arch: 'x64' | 'arm64'): string {
  return String.raw`<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
 IgnorableNamespaces="uap rescap">
  <Identity Name="${xml(identity.name)}" Publisher="${xml(identity.publisher)}" Version="${msixVersion(version)}" ProcessorArchitecture="${arch}" />
  <Properties>
    <DisplayName>${xml(identity.displayName)}</DisplayName>
    <PublisherDisplayName>${xml(identity.publisherDisplayName)}</PublisherDisplayName>
    <Description>A local-first journal for language lessons.</Description>
    <Logo>assets\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="en-us" /><Resource Language="de-de" /><Resource Language="es-es" /><Resource Language="fr-fr" /><Resource Language="it-it" /><Resource Language="nl-nl" /><Resource Language="pt-pt" /><Resource Language="sv-se" /><Resource Language="uk-ua" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Applications>
    <Application Id="Hornbook" Executable="app\Hornbook.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${xml(identity.displayName)}" Description="A local-first journal for language lessons."
       BackgroundColor="transparent" Square150x150Logo="assets\Square150x150Logo.png" Square44x44Logo="assets\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
`;
}
