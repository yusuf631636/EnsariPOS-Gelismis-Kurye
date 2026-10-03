# Gelişmiş Kurye (C# sürüm) - otomatik guncelleme yayini.
# Kullanim: once surum.txt'yi artir (ve .iss AppVersion), sonra:  .\yayinla.ps1
# Cikti: C:\Projeler\1-Bulut\public\gk-cs-update\version.json + f\<sha256>.bin
# (ham .bin - Cloudflare HTML'i yolda degistirebiliyor). Restoranlardaki C# servisi saatte bir bakar,
# SHA-256 dogrular, program dosyasi degistiyse kendini yeniden baslatir. data\ (veritabani, VAPID anahtari),
# config.json ve veri dosyalari ASLA gonderilmez.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$web = "C:\Projeler\3-Gelismis-Kurye\kaynak\public"
$out = "C:\Projeler\1-Bulut\public\gk-cs-update"
$version = ([IO.File]::ReadAllText("$PSScriptRoot\surum.txt")).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "surum.txt gecersiz: $version" }

& "$PSScriptRoot\derle.ps1" | Out-Null

$files = New-Object System.Collections.ArrayList
function Add([string]$rel, [string]$full) { [void]$files.Add(@{ rel = $rel; full = $full }) }
Add 'GelismisKuryeSrv.exe' "$PSScriptRoot\GelismisKuryeSrv.exe"
Add 'surum.txt' "$PSScriptRoot\surum.txt"
Get-ChildItem $web -Recurse -File | ForEach-Object { Add ('public/' + $_.FullName.Substring($web.Length + 1).Replace('\', '/')) $_.FullName }

$safe = '^(?:[a-zA-Z0-9_-]+/){0,3}[a-zA-Z0-9_.-]+\.(?:html|css|json|webmanifest|js|png|ico|txt|exe|dll)$'
New-Item -ItemType Directory -Force "$out\f" | Out-Null
$list = @()
foreach ($f in $files) {
    if ($f.rel -notmatch $safe) { Write-Host "atlandi (guvenli yol degil): $($f.rel)" -ForegroundColor DarkGray; continue }
    $hash = (Get-FileHash $f.full -Algorithm SHA256).Hash.ToLowerInvariant()
    Copy-Item $f.full "$out\f\$hash.bin" -Force
    $list += '    { "path": "' + $f.rel + '", "sha256": "' + $hash + '" }'
}
$json = "{`n  ""version"": ""$version"",`n  ""publishedAt"": ""$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"",`n  ""files"": [`n" + ($list -join ",`n") + "`n  ]`n}"
[IO.File]::WriteAllText("$out\version.json", $json, (New-Object Text.UTF8Encoding($false)))
Write-Host "Yayinlandi: C# surum $version, $($list.Count) dosya -> $out" -ForegroundColor Green
