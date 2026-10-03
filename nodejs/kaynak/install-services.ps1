# Gelismis Kurye Sistemi - NSSM ile TEK Windows servisi kurar (kendi-restoranim-kurye'deki
# "AlfaPOSKuryeTakip" servisinden TAMAMEN AYRI ad/port - ikisi ayni makinede yan yana
# calisabilir, biri digerine dokunmaz).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Bu script Yonetici olarak calistirilmalidir (Windows servisi kurmak icin gerekli). Kurulum programi (setup.exe) bunu otomatik yukseltilmis olarak calistirir.' }

$nssm = Join-Path $PSScriptRoot 'nssm.exe'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'node.exe bulunamadi. install-requirements.ps1 calistirin.' }
$nodeExe = $nodeCmd.Source

$config = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$port = if ($config.port) { $config.port } else { 4090 }

$runtimeDir = Join-Path $env:ProgramData 'EnsariPOS\GelismisKuryeSistemi'
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$name = 'GelismisKuryeSistemi'
if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
  Write-Host "$name zaten kurulu, durdurup guncelleniyor..." -ForegroundColor Yellow
  & $nssm stop $name 2>&1 | Out-Null
  & $nssm remove $name confirm 2>&1 | Out-Null
}
& $nssm install $name $nodeExe 2>&1 | Out-Null
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$name\Parameters" -Name AppParameters -Value "`"$PSScriptRoot\server.js`""
& $nssm set $name AppDirectory $PSScriptRoot 2>&1 | Out-Null
& $nssm set $name AppStdout (Join-Path $logDir 'server.log') 2>&1 | Out-Null
& $nssm set $name AppStderr (Join-Path $logDir 'server.err.log') 2>&1 | Out-Null
& $nssm set $name Start SERVICE_AUTO_START 2>&1 | Out-Null
& $nssm set $name AppExit Default Restart 2>&1 | Out-Null
& $nssm set $name AppThrottle 15000 2>&1 | Out-Null
& $nssm start $name 2>&1 | Out-Null
Start-Sleep -Seconds 3
$service = Get-Service -Name $name -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Running') {
  & $nssm stop $name 2>&1 | Out-Null
  Start-Sleep -Seconds 1
  & $nssm start $name 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
}

Write-Host ''
if ($service -and $service.Status -eq 'Running') {
  Write-Host "$name calisiyor (port $port)." -ForegroundColor Green
} else {
  Write-Warning "$name baslatilamadi (durum: $(if ($service) { $service.Status } else { 'kurulmadi' })). $logDir altindaki .err.log dosyasina bakin."
}
Write-Host "Kurye ekrani: http://127.0.0.1:$port/courier" -ForegroundColor DarkGray
Write-Host "Restoran ekrani: http://127.0.0.1:$port/restoran" -ForegroundColor DarkGray
Write-Host "Ayni WiFi'deki telefondan erismek icin bu bilgisayarin yerel IP adresini kullanin (orn. http://192.168.1.X:$port/courier)." -ForegroundColor DarkGray
Start-Sleep -Seconds 3
