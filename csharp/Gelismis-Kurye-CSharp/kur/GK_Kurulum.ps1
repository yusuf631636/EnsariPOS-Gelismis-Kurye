# Gelişmiş Kurye Sistemi (C# sürüm) - Windows servis kurulumu (Garson / QR Menü C# ile ayni tarz)
# ============================================================================
# - Windows'un KENDI C# derleyicisi (csc.exe, .NET Framework 4) ile kur\kaynak\*.cs + kur\ortak\*.cs derlenir
#   (derlenemezse kurulumdaki hazir GelismisKuryeSrv.prebuilt.exe kullanilir).
# - "GelismisKuryeSistemi" Windows servisi kurulur (eski Node/NSSM surumu AYNI adla kuruluysa once kaldirilir;
#   config.json, data\ (SQLite veritabani, VAPID anahtari) oldugu gibi kalir).
# - Guvenlik duvarinda Gelişmiş Kurye portuna (varsayilan 4090) izin verilir.
# Node.js / NSSM / sqlcmd GEREKMEZ. Windows 7 (PowerShell 2) uyumlu yazilmistir.
param(
    [string]$InstallDir = "",
    [switch]$Silent
)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $InstallDir) { $InstallDir = Split-Path -Parent $ScriptDir }
$ServiceName = "GelismisKuryeSistemi"
$DisplayName = "Gelişmiş Kurye Sistemi"
$FwRule = "Gelismis Kurye Sistemi"

function Say([string]$msg, [string]$color) { if ($color) { Write-Host $msg -ForegroundColor $color } else { Write-Host $msg } }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Say "Lutfen YONETICI OLARAK calistirin." Red; exit 1 }
Say "--- $DisplayName (C#) kurulumu basliyor ---" Cyan
Say "Klasor: $InstallDir"

# 1) Eski servis (Node/NSSM ya da onceki C#)
Say "[1/5] Eski servis kontrol ediliyor..." Yellow
$old = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($old) {
    if ($old.Status -ne 'Stopped') {
        & sc.exe stop $ServiceName | Out-Null
        for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; $old = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue; if (-not $old -or $old.Status -eq 'Stopped') { break } }
    }
    & sc.exe delete $ServiceName | Out-Null
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) { break } }
    Say "      Eski servis kaldirildi (veriler korunuyor)."
}
Get-Process -Name GelismisKuryeSrv -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# eski Node surumunun kendi node.exe sureci (NSSM altinda) kaldiysa - sadece bu klasordeki server.js'i calistiran
try {
    Get-WmiObject Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$InstallDir*server.js*" } | ForEach-Object { $_.Terminate() | Out-Null }
} catch { }

# 2) Derleme
Say "[2/5] C# servisi derleniyor..." Yellow
$exe = Join-Path $InstallDir "GelismisKuryeSrv.exe"
$csc = $null
foreach ($c in @("$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe", "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe")) { if (Test-Path $c) { $csc = $c; break } }
$compiled = $false
$srcFiles = @(Get-ChildItem (Join-Path $ScriptDir "kaynak"), (Join-Path $ScriptDir "ortak") -Filter *.cs -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
if ($csc -and $srcFiles.Count -gt 0) {
    if (Test-Path $exe) { Remove-Item $exe -Force -ErrorAction SilentlyContinue }
    $a = @('/nologo', '/optimize+', '/target:exe', "/out:$exe", '/reference:System.ServiceProcess.dll', '/reference:System.Web.Extensions.dll',
           '/reference:System.Data.dll', '/reference:System.Core.dll', '/reference:System.Numerics.dll')
    $ico = Join-Path $ScriptDir "kaynak\alfapos.ico"
    if (Test-Path $ico) { $a += "/win32icon:$ico" }
    $a += $srcFiles
    $out = & $csc $a 2>&1
    if ($LASTEXITCODE -eq 0 -and (Test-Path $exe)) { $compiled = $true; Say "      Derlendi: $exe" }
    else { Say "      Derleme basarisiz, hazir surum kullanilacak:" Yellow; $out | ForEach-Object { Say "      $_" } }
} else { Say "      .NET Framework 4 derleyicisi bulunamadi, hazir surum kullanilacak." Yellow }
if (-not $compiled) {
    $pre = Join-Path $ScriptDir "GelismisKuryeSrv.prebuilt.exe"
    if (-not (Test-Path $pre)) { Say "HATA: Ne derleme yapilabildi ne de hazir surum var." Red; exit 1 }
    Copy-Item $pre $exe -Force
}

# 3) Port
$port = 4090
$cfgPath = Join-Path $InstallDir "config.json"
if (Test-Path $cfgPath) { $m = [regex]::Match([IO.File]::ReadAllText($cfgPath), '"port"\s*:\s*(\d+)'); if ($m.Success) { $port = [int]$m.Groups[1].Value } }

# 4) Servis + kurtarma (cokerse / guncellemeden sonra kendini yeniden baslatir)
Say "[3/5] Windows servisi kuruluyor..." Yellow
New-Service -Name $ServiceName -BinaryPathName ('"' + $exe + '"') -DisplayName $DisplayName `
    -Description "$DisplayName (C# sürüm) - kurye paket alma/teslim, restoran canlı takip (port $port). AlfaPOS" -StartupType Automatic | Out-Null
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
& sc.exe failureflag $ServiceName 1 | Out-Null

Say "[4/5] Guvenlik duvari izni veriliyor (TCP $port)..." Yellow
& netsh advfirewall firewall delete rule name="$FwRule" | Out-Null
& netsh advfirewall firewall add rule name="$FwRule" dir=in action=allow protocol=TCP localport=$port profile=any | Out-Null

Say "[5/5] Servis baslatiliyor..." Yellow
Start-Service -Name $ServiceName
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try { $wc = New-Object System.Net.WebClient; $null = $wc.DownloadString("http://localhost:$port/api/config"); $ok = $true; break }
    catch { if ($_.Exception.InnerException -and $_.Exception.InnerException.Response) { $ok = $true; break } }
}
Write-Host ""
if ($ok) { Say "--- KURULUM TAMAMLANDI --- http://localhost:$port/restoran" Green } else { Say "Servis kuruldu ama yanit vermedi. \logs\server.log dosyasina bakin." Yellow }
if ($ok) { exit 0 } else { exit 2 }
