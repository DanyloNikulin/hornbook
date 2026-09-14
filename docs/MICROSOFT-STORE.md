# Microsoft Store / MSIX

Hornbook has a separate, unsigned MSIX packaging path for Windows. Microsoft
signs packages accepted through Partner Center. A locally built preview is not
a Store release and must not be uploaded to a public release as a trusted installer.

## Local preview

On Windows with Node.js, locked dependencies and the Windows 10/11 SDK installed:

```powershell
npm ci
npm run package:msix -- --preview
# Optional native ARM64 package:
npm run package:msix -- --preview --arm64
```

Each invocation writes a fresh directory under `release/msix/preview-<arch>-*/`:
the MSIX, manifest, unpacked payload and `build-info.json`. MakeAppx validates the
manifest and file mappings. Set `HORNBOOK_MAKEAPPX` only if the SDK is elsewhere.

The preview has the identity `Hornbook.MsixPreview` and displays as
**Hornbook MSIX Preview**. Its default profile, fictional demo journal and
downloaded tools live under `%APPDATA%/Hornbook MSIX Preview`, separate from a
regular Hornbook installation. Explicit journal/profile/tools overrides still work.
Do not use real lesson data in the preview; uninstalling MSIX may remove its app data.

Run the payload smoke with the exact generated build-info path:

```powershell
node node_modules/tsx/dist/cli.mjs harness/msix.ts <build-directory>/build-info.json
```

This launches the packaged payload with a throwaway profile, checks the UI, API
authentication, child processes and Store update behavior. It does **not** prove
installed MSIX compatibility or Store certification.

After installing a trusted preview, the same harness can check its real package
identity and journal persistence across restarts:

```powershell
$preview = Get-AppxPackage -Name Hornbook.MsixPreview
$env:HORNBOOK_MSIX_INSTALLED_EXE = Join-Path $preview.InstallLocation 'app/Hornbook.exe'
node node_modules/tsx/dist/cli.mjs harness/msix.ts <build-directory>/build-info.json
Remove-Item Env:HORNBOOK_MSIX_INSTALLED_EXE
```

For an installed test, create a short-lived local signature:

```powershell
./scripts/sign-msix-preview.ps1 -BuildInfo <build-directory>/build-info.json
```

The script creates a separate `*-test-signed.msix` and public `.cer`, and removes
the temporary private key. It does not install trust or the app. On a disposable
Windows test machine, trust that exact certificate in **Local Computer / Trusted
People**, then install the test-signed MSIX. Do not add it to Trusted Root
Certification Authorities. Remove the preview and certificate after testing.
No paid certificate is needed for this local test. Never distribute its `.cer`
as a way for public users to bypass Windows trust checks.

## Store identity

Hornbook was reserved on 2026-09-13. Its verified public identity is saved in
`build/microsoft-store.json` and used by default for Store builds:

- Product ID: `9NVZSSWQWMFM`
- Package family: `DanyloNikulin.Hornbook_adcvwnfm42128`
- Partner Center: <https://partner.microsoft.com/en-us/dashboard/products/9NVZSSWQWMFM/overview>
- Future Store listing: <https://apps.microsoft.com/detail/9NVZSSWQWMFM>

These values are public package metadata, not credentials. Reserving the name
does not publish the app. The current reservation requires submission within
three months. For another product, replace the identity file or provide all four
environment variables below together; partial environment overrides fail.

Register at <https://storedeveloper.microsoft.com/>, complete identity verification
and reserve the app name. From Partner Center's Product identity, supply:

| Environment / repository variable | Partner Center value |
| --- | --- |
| `HORNBOOK_STORE_IDENTITY_NAME` | Package/Identity/Name |
| `HORNBOOK_STORE_PUBLISHER` | Package/Identity/Publisher, including `CN=` |
| `HORNBOOK_STORE_PUBLISHER_DISPLAY_NAME` | Publisher display name |
| `HORNBOOK_STORE_DISPLAY_NAME` | Reserved display name |

Then run `npm run package:msix` without `--preview`. Missing identity values
are an error when neither the saved identity nor a complete environment override
is available; there is no fallback to the preview identity. The package version
preserves the application version: `1.0.0` becomes `1.0.0.0`, and `1.0.1`
becomes `1.0.1.0`. The fourth part is reserved for Store. Increment the application
version for a subsequent Store submission. A zero major, prerelease suffixes
and components above 65535 are rejected.

The initial 0.9.9 candidate used the older offset scheme and produced 1.9.9.0.
On 2026-09-14 it was still held at Ready to publish, with publication not started.
That candidate must be replaced, not published, before releasing 1.0.0.0 under
this identity. Do not use a lower version to update any published package.

For submission, use the **MSIX preview** Actions workflow in `store` mode from a
reviewed revision, and upload its unsigned artifact to Partner Center. The
workflow builds and uploads an Actions artifact only; it cannot publish to Store,
create a GitHub release or spend money on signing. For an exploratory build use
its `preview` mode. Local builds are for validation, not public release uploads.

## Runtime differences

- Store payloads never query GitHub releases or invoke the EXE auto-updater.
  Settings and the tray link to Microsoft Store's downloads and updates page.
- Legacy registry-based startup is hidden and ignored. A Store startup task is
  intentionally not declared in this first package.
- The manifest declares `runFullTrust` for Electron and its local Node server,
  filesystem journal access and optional AI subprocesses. This is ordinary
  desktop execution, not an administrator/elevation request.
- Production journals still default to `~/Hornbook`; tools and working files
  are outside the read-only installation directory. Preview data is isolated.

## Before submitting

- Exercise actual installed x64/ARM64 packages on the corresponding machines:
  first launch, journal editing/switching, tray, notifications, restart, update,
  uninstall and persistence of journals outside the app data directory.
- Test downloading and running FFmpeg, Whisper and Ollama with consent, and
  a complete lesson job. Distinguish model downloads from executable downloads.
  Verify redistribution notices for all packaged/downloaded third-party tools.
- Explain optional tools and hosted AI dependencies in the listing and provide
  certification notes with a working test scenario that needs no private keys.
  Microsoft decides whether the described dependencies meet Store policy.
- Supply a public privacy policy describing local journals/audio, optional
  hosted AI uploads and user controls. Provide screenshots, support contact,
  age rating, supported languages and translated listings.
- Explain why `runFullTrust` is needed when Partner Center requests capability
  justification. No Store approval is implied by a successful local build.

References: [Electron packaging](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/electron-packaging),
[developer registration](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer),
[Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies).

## Validation on 2026-09-13

Built and test-signed the x64 `0.9.9.0` preview using Windows SDK 10.0.26100.
Installed it as `Hornbook.MsixPreview_0.9.9.0_x64__qgwz9q7nzd73c` on Windows 11.
All 14 installed smoke checks passed, including `process.windowsStore`, token
authentication, the compiled lesson-import subprocess, journal writes and
persistence after restart. The test package and its temporary Trusted People
certificate were removed after testing. The private signing key was removed
immediately after signing. Reports and local artifacts remain under ignored
`work/harness/` and `release/msix/` directories.

Still unverified: ARM64, real model/tool installation and inference inside MSIX,
Store updates and certification. The local test is not a public Store release.

## Partner Center draft on 2026-09-13

Submission `1152921505701880332` has these sections marked Complete:

- Pricing and availability: free (USD 0 base price), worldwide public audience.
- Properties: Education / Language, generative AI declared, source and support
  links, privacy policy provided directly as text. Local copy: `PRIVACY.md`.
- Store listing: English description, three feature bullets and four desktop
  screenshots of the fictional demo journal. Copy: `MICROSOFT-STORE-LISTING.txt`.
- Age ratings: the publisher explicitly approved accepting the IARC terms and
  the adulthood declaration. Generated ratings include global 12+, ESRB E10+,
  USK 6+, PEGI parental guidance and Russia 18+.
- Submission options: hold publication until the publisher selects Publish now.

Certification notes were saved and verified after reloading the page; a local
copy is in `MICROSOFT-STORE-CERTIFICATION.txt`. They disclose the optional tools,
the full-trust desktop capability and the limits of the completed testing.

Screenshots are in `work/store-listing/screenshots/` (ignored local artifacts).
They were captured through the browser from the built UI using a separate copy
of the bundled demo journal, and converted to actual PNG files before upload.
No personal journal or API keys were used. The temporary local server was stopped.

Packages is still Not started. No MSIX has been uploaded to this submission and
the submission has not been sent for certification. Build the submission package
through the Actions workflow from a reviewed revision as described above.
