$ErrorActionPreference = "Stop"

$version = "1.0.0"
$releaseRoot = if ($env:AIDLC_RELEASE_ROOT) { $env:AIDLC_RELEASE_ROOT.TrimEnd('/') } else { "https://github.com/sori883/aidlc/releases/download/v$version" }
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") { throw "AI-DLC installer: unsupported Windows architecture $env:PROCESSOR_ARCHITECTURE" }
$asset = "aidlc-windows-amd64.exe"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("aidlc-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $checksums = Join-Path $temporary "SHA256SUMS"
  $executable = Join-Path $temporary "aidlc.exe"
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseRoot/SHA256SUMS" -OutFile $checksums
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseRoot/$asset" -OutFile $executable
  $line = Get-Content $checksums | Where-Object { $_ -match "^[a-f0-9]{64}  $([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $line) { throw "AI-DLC installer: SHA256SUMS does not contain $asset" }
  $expected = ($line -split "  ")[0]
  $actual = (Get-FileHash -Algorithm SHA256 $executable).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "AI-DLC installer: downloaded CLI checksum mismatch" }
  & $executable install @args
  exit $LASTEXITCODE
} finally {
  Remove-Item -Recurse -Force $temporary -ErrorAction SilentlyContinue
}
