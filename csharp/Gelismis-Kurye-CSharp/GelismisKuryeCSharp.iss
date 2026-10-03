; Gelişmiş Kurye Sistemi - C# SÜRÜM (30.09.2026, kullanici istegi: "tek tek tum projeleri C#'a cevirelim, node
; bagimliligi kalmasin"). Kurulumda Windows'un KENDI csc.exe'si ile derlenir, "GelismisKuryeSistemi" Windows servisi
; olarak kurulur. Node.js / NSSM / sqlcmd GEREKMEZ. SQLite icin resmi sqlite3.dll (sqlite.org) kurulumla gelir.
; AppId Node surumuyle AYNI: mevcut kurulumun uzerine kurulur; config.json, data\ (veritabani, VAPID anahtari,
; kurye oturumlari, bildirim abonelikleri) korunur, ayni aktivasyon anahtari kullanilir.
; Kurye/restoran sayfalari (public\) C:\Projeler\3-Gelismis-Kurye\kaynak'tan alinir.
#define AppName "Gelişmiş Kurye Sistemi"
#define AppVersion "1.0.0"
#define AppPublisher "AlfaPOS"
#define Web "C:\Projeler\3-Gelismis-Kurye\kaynak"
#define Ortak "C:\Projeler\9-CSharp-Projeler\ortak"

[Setup]
AppId={{A1B2C3D4-5E6F-4A7B-8C9D-GELISMIS0001}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion} (C# sürüm)
AppPublisher={#AppPublisher}
AppPublisherURL=https://ornek-alanadi.com
DefaultDirName={autopf}\AlfaPOS\GelismisKuryeSistemi
UsePreviousAppDir=yes
DefaultGroupName=Gelişmiş Kurye Sistemi
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=GelismisKuryeCSharpSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
SetupIconFile=kaynak\alfapos.ico
UninstallDisplayIcon={app}\GelismisKuryeSrv.exe
UninstallDisplayName={#AppName} (C# sürüm)
VersionInfoVersion={#AppVersion}.0
VersionInfoDescription={#AppName} (C#) Kurulum

[Languages]
Name: "tr"; MessagesFile: "compiler:Languages\Turkish.isl"

[Messages]
tr.WelcomeLabel2=Bu program Gelişmiş Kurye Sistemi'nin C# sürümünü kurar.%n%n• Kurye kendi paketini alır, gerçek SambaPOS ödeme türleriyle teslim eder; restoran canlı izler.%n• Node.js gerekmez; Windows servisi olarak çalışır, bilgisayar açılınca kendiliğinden başlar.%n• Eski sürüm kuruluysa onun yerine geçer; raporlar ve kurye oturumları korunur.%n• Aynı aktivasyon anahtarı kullanılır.

[Files]
Source: "kaynak\*.cs"; DestDir: "{app}\kur\kaynak"; Flags: ignoreversion
Source: "kaynak\alfapos.ico"; DestDir: "{app}\kur\kaynak"; Flags: ignoreversion
Source: "{#Ortak}\*.cs"; DestDir: "{app}\kur\ortak"; Flags: ignoreversion
Source: "GelismisKuryeSrv.exe"; DestDir: "{app}\kur"; DestName: "GelismisKuryeSrv.prebuilt.exe"; Flags: ignoreversion
Source: "kur\GK_Kurulum.ps1"; DestDir: "{app}\kur"; Flags: ignoreversion
Source: "kur\kaldir.ps1"; DestDir: "{app}\kur"; Flags: ignoreversion
Source: "kur\yeniden-baslat.bat"; DestDir: "{app}\kur"; Flags: ignoreversion
Source: "{#Ortak}\sqlite\sqlite3-x64.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Ortak}\sqlite\sqlite3-x86.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "surum.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "kaynak\alfapos.ico"; DestDir: "{app}\assets"; Flags: ignoreversion
Source: "{#Web}\config.example.json"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; eski Node surumunun program dosyalari (veriler - data\ ve config.json - SILINMEZ)
Type: files; Name: "{app}\server.js"
Type: files; Name: "{app}\sql.js"
Type: files; Name: "{app}\sambapos.js"
Type: files; Name: "{app}\auth.js"
Type: files; Name: "{app}\db.js"
Type: files; Name: "{app}\ws.js"
Type: files; Name: "{app}\push.js"
Type: files; Name: "{app}\license.js"
Type: files; Name: "{app}\tunnel.js"
Type: files; Name: "{app}\updater.js"
Type: files; Name: "{app}\package.json"
Type: files; Name: "{app}\package-lock.json"
Type: files; Name: "{app}\nssm.exe"
Type: files; Name: "{app}\install-requirements.ps1"
Type: files; Name: "{app}\install-services.ps1"
Type: files; Name: "{app}\remove-services.ps1"
Type: filesandordirs; Name: "{app}\node_modules"

[Icons]
Name: "{autodesktop}\Gelişmiş Kurye - Kurye Ekranı"; Filename: "http://127.0.0.1:4090/courier"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{autodesktop}\Gelişmiş Kurye - Restoran Ekranı"; Filename: "http://127.0.0.1:4090/restoran"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Kurye Ekranı"; Filename: "http://127.0.0.1:4090/courier"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Restoran Ekranı"; Filename: "http://127.0.0.1:4090/restoran"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Servisi Yeniden Başlat"; Filename: "{app}\kur\yeniden-baslat.bat"; WorkingDir: "{app}\kur"
Name: "{group}\Kaldır"; Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\kur\GK_Kurulum.ps1"" -InstallDir ""{app}"" -Silent"; StatusMsg: "Gelişmiş Kurye servisi derleniyor ve kuruluyor..."; Flags: waituntilterminated runhidden
Filename: "http://127.0.0.1:4090/restoran"; Description: "Restoran ekranını aç"; Flags: postinstall shellexec skipifsilent nowait

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\kur\kaldir.ps1"" -Silent"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveGKService"

[UninstallDelete]
Type: files; Name: "{app}\GelismisKuryeSrv.exe"
Type: files; Name: "{app}\GelismisKuryeSrv.exe.old"
Type: filesandordirs; Name: "{app}\logs"

[Code]
var
  DBPage: TInputQueryWizardPage;
  KeyPage: TInputQueryWizardPage;
  OldBindHostLine: String;
  OldPort: String;

function GetActivationKey(): String;
begin
  Result := Trim(KeyPage.Values[0]);
  if Result = '' then Result := Trim(ExpandConstant('{param:ACTIVATIONKEY|}'));
end;

function ExtractJsonValue(const Json, Key: String): String;
var
  SearchStr, S: String;
  P, Q: Integer;
begin
  Result := '';
  SearchStr := '"' + Key + '"';
  P := Pos(SearchStr, Json);
  if P = 0 then Exit;
  S := Copy(Json, P + Length(SearchStr), Length(Json) - (P + Length(SearchStr)) + 1);
  P := Pos(':', S);
  if P = 0 then Exit;
  S := Copy(S, P + 1, Length(S) - P);
  while (Length(S) > 0) and ((S[1] = ' ') or (S[1] = #9) or (S[1] = #13) or (S[1] = #10)) do S := Copy(S, 2, Length(S) - 1);
  if Length(S) = 0 then Exit;
  if S[1] <> '"' then
  begin
    { sayi (ör. "port": 4099) }
    Q := 1;
    while (Q <= Length(S)) and (S[Q] >= '0') and (S[Q] <= '9') do Q := Q + 1;
    Result := Copy(S, 1, Q - 1);
    Exit;
  end;
  S := Copy(S, 2, Length(S) - 1);
  Q := Pos('"', S);
  if Q = 0 then Exit;
  Result := Copy(S, 1, Q - 1);
end;

function JsonEscape(S: String): String;
begin
  StringChangeEx(S, '\', '\\', True);
  StringChangeEx(S, '"', '\"', True);
  Result := S;
end;

procedure InitializeWizard;
begin
  DBPage := CreateInputQueryPage(wpSelectDir, 'SQL Server Bağlantısı', '', 'Adres boş bırakılırsa SambaPOS/AlfaPOS ayar dosyasından otomatik bulunur.');
  DBPage.Add('SQL Server adresi (ör: DESKTOP-ADI veya localhost):', False);
  DBPage.Add('Veritabanı adı:', False);
  DBPage.Add('SQL kullanıcı adı (boş = Windows kimlik doğrulama):', False);
  DBPage.Add('SQL şifresi:', True);
  DBPage.Values[0] := 'localhost';
  DBPage.Values[1] := 'SAMBAPOS5';
  KeyPage := CreateInputQueryPage(DBPage.ID, 'Gelişmiş Kurye Aktivasyonu', '', 'Mevcut kurulumdaki anahtar otomatik doldurulur (aynı anahtar).');
  KeyPage.Add('Gelişmiş Kurye aktivasyon anahtarı:', False);
  OldPort := '4090';
end;

procedure CurPageChanged(CurPageID: Integer);
var
  ConfigPath, OldBindHost: String;
  OldJson: AnsiString;
begin
  if CurPageID = DBPage.ID then
  begin
    OldBindHostLine := '';
    ConfigPath := ExpandConstant('{app}\config.json');
    if FileExists(ConfigPath) and LoadStringFromFile(ConfigPath, OldJson) then
    begin
      if ExtractJsonValue(OldJson, 'server') <> '' then DBPage.Values[0] := ExtractJsonValue(OldJson, 'server');
      if ExtractJsonValue(OldJson, 'database') <> '' then DBPage.Values[1] := ExtractJsonValue(OldJson, 'database');
      DBPage.Values[2] := ExtractJsonValue(OldJson, 'user');
      DBPage.Values[3] := ExtractJsonValue(OldJson, 'password');
      KeyPage.Values[0] := ExtractJsonValue(OldJson, 'gkActivationKey');
      if ExtractJsonValue(OldJson, 'port') <> '' then OldPort := ExtractJsonValue(OldJson, 'port');
      OldBindHost := ExtractJsonValue(OldJson, 'bindHost');
      if OldBindHost <> '' then OldBindHostLine := '  "bindHost": "' + JsonEscape(OldBindHost) + '",' + #13#10;
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = KeyPage.ID) and (GetActivationKey() = '') then
  begin
    MsgBox('Gelişmiş Kurye aktivasyon anahtarı boş bırakılamaz.', mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  rc: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop GelismisKuryeSistemi', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM GelismisKuryeSrv.exe', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Sleep(2500);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigPath, JsonContent: String;
  Lines: TArrayOfString;
begin
  if CurStep = ssPostInstall then
  begin
    ConfigPath := ExpandConstant('{app}\config.json');
    JsonContent :=
      '{' + #13#10 +
      '  "server": "' + JsonEscape(DBPage.Values[0]) + '",' + #13#10 +
      '  "database": "' + JsonEscape(DBPage.Values[1]) + '",' + #13#10 +
      '  "user": "' + JsonEscape(DBPage.Values[2]) + '",' + #13#10 +
      '  "password": "' + JsonEscape(DBPage.Values[3]) + '",' + #13#10 +
      '  "options": { "encrypt": false, "trustServerCertificate": true },' + #13#10 +
      '  "port": ' + OldPort + ',' + #13#10 +
      OldBindHostLine +
      '  "gkActivationKey": "' + JsonEscape(GetActivationKey()) + '",' + #13#10 +
      '  "cloudServerUrl": "https://app.ornek-alanadi.com"' + #13#10 +
      '}';
    Lines := [JsonContent];
    SaveStringsToUTF8File(ConfigPath, Lines, False);
  end;
end;
