# Gelismis Kurye Sistemi - gereksinimleri kontrol eder ve eksikse kurar.
# kendi-restoranim-kurye\install-requirements.ps1 ile ayni desen, ama cloudflared
# GEREKMEZ (bu sistem su an sadece yerel ag/mevcut tunel uzerinden test icindir).
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
Write-Host 'Gelismis Kurye Sistemi gereksinimleri kontrol ediliyor...' -ForegroundColor Cyan

function Install-WingetPackage($id, $name, $manualUrl) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { Write-Host "$name zaten kurulu." -ForegroundColor DarkGray; return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Write-Warning "$name bulunamadi ve winget yok. Elle kurulum: $manualUrl"; return }
  Write-Host "$name kuruluyor..." -ForegroundColor Yellow
  try { winget install --id $id --exact --accept-package-agreements --accept-source-agreements --silent }
  catch { Write-Warning "$name kurulumu basarisiz: $($_.Exception.Message). Elle kurulum: $manualUrl" }
}
Install-WingetPackage 'OpenJS.NodeJS.LTS' 'node' 'https://nodejs.org/'
if (-not (Get-Command sqlcmd -ErrorAction SilentlyContinue)) {
  Install-WingetPackage 'Microsoft.Sqlcmd' 'sqlcmd' 'https://aka.ms/sqlcmd'
}

# winget kurulumu basarili olsa bile bu PowerShell surecinin kendi $env:Path
# kopyasi guncellenmez (sadece YENI acilan surecler gorur) - bu yuzden az
# sonraki "Get-Command node" kontrolu, Node.js AZ ONCE basariyla kurulmus
# olsa dahi "bulunamadi" diyebiliyordu. PATH'i burada Machine+User'dan
# tazeleyerek bu yanlis pozitifi onluyoruz.
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "Node.js otomatik kurulamadi (internet baglantisi olmayabilir veya winget bu bilgisayarda yok)." + [Environment]::NewLine + [Environment]::NewLine +
    "Program bu bilgisayarda CALISMAYACAK. Lutfen https://nodejs.org adresinden Node.js LTS'i elle kurun," + [Environment]::NewLine +
    "sonra kurulum klasorundeki 'install-services.ps1' dosyasina sag tik > Yonetici olarak calistir'i secin.",
    'Gelismis Kurye Sistemi - Gereksinim eksik', 'OK', 'Warning'
  ) | Out-Null
  Write-Warning 'node.exe bulunamadi - kurulum programa gore YARIM kaldi.'
  exit 1
}

Write-Host 'Gereksinim kontrolu tamamlandi.' -ForegroundColor Green
exit 0
