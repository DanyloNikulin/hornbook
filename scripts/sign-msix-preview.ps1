param(
    [Parameter(Mandatory = $true)][string]$BuildInfo
)
$ErrorActionPreference = 'Stop'
$infoFile = (Resolve-Path -LiteralPath $BuildInfo).Path
$info = Get-Content -LiteralPath $infoFile -Raw | ConvertFrom-Json
if (-not $info.preview -or $info.identity.name -ne 'Hornbook.MsixPreview' -or $info.identity.publisher -ne 'CN=Hornbook MSIX Preview') {
    throw 'Only a local Hornbook MSIX preview can use a test certificate.'
}
$artifact = (Resolve-Path -LiteralPath $info.artifact).Path
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\release\msix')) + [IO.Path]::DirectorySeparatorChar
if (-not $artifact.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The preview must be inside this workspace release/msix directory.'
}
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$sdk = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Where-Object { $_.Name -match '^10\.[\d.]+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'x64\signtool.exe') } |
    Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK signtool.exe is required.' }
$signedPath = Join-Path (Split-Path -Parent $artifact) ([IO.Path]::GetFileNameWithoutExtension($artifact) + '-test-signed.msix')
$publicCert = Join-Path (Split-Path -Parent $artifact) 'Hornbook-MsixPreview.cer'
if ((Test-Path -LiteralPath $signedPath) -or (Test-Path -LiteralPath $publicCert)) {
    throw 'Test signing files already exist. Create a fresh preview build instead of replacing them.'
}
$certificate = $null
try {
    $certificate = New-SelfSignedCertificate -Type Custom -Subject $info.identity.publisher `
        -KeyUsage DigitalSignature -FriendlyName 'Hornbook MSIX local test only' `
        -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(30) `
        -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    Copy-Item -LiteralPath $artifact -Destination $signedPath
    Export-Certificate -Cert $certificate -FilePath $publicCert | Out-Null
    & (Join-Path $sdk.FullName 'x64\signtool.exe') sign /fd SHA256 /s My /sha1 $certificate.Thumbprint $signedPath
    if ($LASTEXITCODE -ne 0) { throw 'Test signing failed.' }
    Write-Output "Test-signed preview: $signedPath"
    Write-Output "Public test certificate: $publicCert"
    Write-Output "Certificate thumbprint: $($certificate.Thumbprint)"
    Write-Output 'No trust was installed and no app was installed. This certificate is not valid for public distribution.'
} finally {
    if ($certificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey
    }
}
