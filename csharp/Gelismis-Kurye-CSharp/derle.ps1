# Gelişmiş Kurye (C#) - Windows'un kendi csc.exe'si ile derler (kurulumdaki ayni komut).
# Kaynak: kaynak\*.cs + ..\ortak\*.cs (ortak kutuphane). Cikti: GelismisKuryeSrv.exe
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (!(Test-Path $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
$src = @(Get-ChildItem kaynak\*.cs | ForEach-Object { $_.FullName }) + @(Get-ChildItem ..\ortak\*.cs | ForEach-Object { $_.FullName })
$a = @('/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/out:GelismisKuryeSrv.exe',
    '/reference:System.ServiceProcess.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Data.dll',
    '/reference:System.Core.dll', '/reference:System.Numerics.dll')
if (Test-Path kaynak\alfapos.ico) { $a += '/win32icon:kaynak\alfapos.ico' }
& $csc $a $src
if ($LASTEXITCODE -ne 0) { throw "Derleme hatasi" }
Get-Item GelismisKuryeSrv.exe | Select-Object Name, Length, LastWriteTime
