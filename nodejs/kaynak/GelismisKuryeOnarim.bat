@echo off
setlocal
title Gelismis Kurye Sistemi - Kurulum / Onarim Araci
:: Musteride kurulum/servis sorunu olursa indirip CIFT TIKLATIN.
:: Yonetici izni ister, takili surecleri temizler, eski kurulum dosyalarini siler,
:: guncel kurulumu indirip calistirir, servisin calisip calismadigini raporlar.
:: Musterinin ayarlari (config.json) ve verileri KORUNUR - kurulum bunlari ezmez.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Yonetici izni isteniyor...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ==========================================================
echo   Gelismis Kurye Sistemi - Kurulum / Onarim Araci
echo   EnsariPOS / AlfaPOS  -  Destek: 0537 618 63 16
echo ==========================================================
echo.

echo [1/5] Takili kalmis servis ve surecler durduruluyor...
sc stop GelismisKuryeSistemi >nul 2>&1
ping -n 4 127.0.0.1 >nul
powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*GelismisKuryeSistemi*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-Process -Name 'GelismisKuryeSistemiSetup*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"

echo [2/5] Eski kurulum dosyalari siliniyor (ayarlar ve veriler korunur)...
del /f /q "%TEMP%\GelismisKuryeSistemiSetup*.exe" >nul 2>&1
del /f /q "%USERPROFILE%\Downloads\GelismisKuryeSistemiSetup*.exe" >nul 2>&1

echo [3/5] Guncel kurulum indiriliyor...
set "SETUP=%TEMP%\GelismisKuryeSistemiSetup.exe"
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = 3072 } catch { }; try { (New-Object Net.WebClient).DownloadFile('https://ornek-alanadi.com/downloads/GelismisKuryeSistemiSetup.exe', (Join-Path $env:TEMP 'GelismisKuryeSistemiSetup.exe')); exit 0 } catch { Write-Host ('  Indirme hatasi: ' + $_.Exception.Message); exit 1 }"
if not exist "%SETUP%" (
    echo.
    echo HATA: Kurulum indirilemedi. Internet baglantisini kontrol edip tekrar deneyin.
    echo Destek: 0537 618 63 16
    pause
    exit /b 1
)

echo [4/5] Kurulum baslatiliyor - acilan penceredeki adimlari tamamlayin...
"%SETUP%"

echo [5/5] Servis kontrol ediliyor...
ping -n 6 127.0.0.1 >nul
sc query GelismisKuryeSistemi | find "RUNNING" >nul
if %errorLevel% equ 0 (
    echo   SERVIS CALISIYOR.
) else (
    echo   UYARI: Servis calismiyor. Bilgisayari yeniden baslatip bu araci tekrar calistirin.
    echo   Sorun devam ederse: 0537 618 63 16
)
powershell -NoProfile -Command "$p = 4090; $c = Join-Path ${env:ProgramFiles(x86)} 'AlfaPOS\GelismisKuryeSistemi\config.json'; if (-not (Test-Path $c)) { $c = Join-Path $env:ProgramFiles 'AlfaPOS\GelismisKuryeSistemi\config.json' }; if (Test-Path $c) { $q = [char]34; $m = [regex]::Match([IO.File]::ReadAllText($c), $q + 'port' + $q + '\s*:\s*(\d+)'); if ($m.Success) { $p = $m.Groups[1].Value } }; try { $null = (New-Object Net.WebClient).DownloadString('http://127.0.0.1:' + $p + '/courier'); Write-Host ('  Kurye ekrani yanit veriyor: http://127.0.0.1:' + $p + '/courier') } catch { Write-Host ('  Kurye ekrani yanit vermedi (port ' + $p + ').') }"
echo.
echo Islem tamamlandi.
pause
