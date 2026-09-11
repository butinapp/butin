# Verifies Windows build output: every file matched by -Path must carry a Valid Authenticode signature whose signer
# subject starts with "CN=<Publisher>," and which is timestamped. Artifact Signing certificates live three days, so
# an untimestamped signature stops validating soon after the build.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-signature.ps1 `
#     -Publisher "Yann Allard" "packages/core/release/*.exe" "packages/core/release/win-unpacked/*.exe"
#
# Prints one line per file. Exits 1 when any file fails or when no file matches at all.
param(
  [Parameter(Mandatory = $true)] [string] $Publisher,
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)] [string[]] $Path
)

$files = @($Path | ForEach-Object { Get-ChildItem -Path $_ -File -ErrorAction SilentlyContinue })
if ($files.Count -eq 0) {
  Write-Host "No files match: $($Path -join ', ')"
  exit 1
}

$failed = 0
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -FilePath $file.FullName
  $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }

  $problems = @()
  if ($signature.Status -ne 'Valid') { $problems += "status $($signature.Status)" }
  if (-not $subject.StartsWith("CN=$Publisher,")) { $problems += "signer '$subject'" }
  if (-not $signature.TimeStamperCertificate) { $problems += 'no timestamp' }

  if ($problems.Count -gt 0) {
    Write-Host "FAIL $($file.Name): $($problems -join '; ')"
    $failed++
  } else {
    Write-Host "ok   $($file.Name): $subject"
  }
}

exit [int]($failed -gt 0)
