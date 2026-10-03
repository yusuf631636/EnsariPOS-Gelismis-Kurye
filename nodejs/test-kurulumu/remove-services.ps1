# Gelismis Kurye Sistemi - NSSM servisini kaldirir (kaldirma/guncelleme oncesi).
$ErrorActionPreference = 'SilentlyContinue'
Set-Location $PSScriptRoot
$nssm = Join-Path $PSScriptRoot 'nssm.exe'
$name = 'GelismisKuryeSistemi'
if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
  & $nssm stop $name | Out-Null
  & $nssm remove $name confirm | Out-Null
  Write-Host "$name kaldirildi." -ForegroundColor Yellow
}
