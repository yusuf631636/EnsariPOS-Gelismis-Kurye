; Gelismis Kurye Sistemi - Inno Setup 6 ile kurulum programi uretir.
; Mevcut "AlfaPOS Kurye Takip" kurulumundan TAMAMEN AYRI bir uygulamadir - ayni
; bilgisayara kurulursa bile FARKLI klasor, FARKLI Windows servisi, FARKLI port (4090)
; kullanir; var olan sisteme HICBIR sekilde dokunmaz, yaninda calisir.
#define AppName "Gelismis Kurye Sistemi"
#define AppVersion "1.0.8"
#define AppPublisher "AlfaPOS"
#define AppExeName "GelismisKuryeSistemi"

[Setup]
AppId={{A1B2C3D4-5E6F-4A7B-8C9D-GELISMIS0001}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\AlfaPOS\GelismisKuryeSistemi
OutputDir=dist
OutputBaseFilename=GelismisKuryeSistemiSetup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
SetupIconFile=assets\alfapos.ico
UninstallDisplayIcon={app}\assets\alfapos.ico

[Files]
Source: "server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "sql.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "sambapos.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "auth.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "db.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "ws.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "license.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "tunnel.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "updater.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "package-lock.json"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "nssm.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-requirements.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-services.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "remove-services.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\Gelişmiş Kurye - Kurye Ekranı"; Filename: "http://127.0.0.1:{code:GetPort}/courier"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{autodesktop}\Gelişmiş Kurye - Restoran Ekranı"; Filename: "http://127.0.0.1:{code:GetPort}/restoran"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Kurye Ekranı"; Filename: "http://127.0.0.1:{code:GetPort}/courier"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Restoran Ekranı"; Filename: "http://127.0.0.1:{code:GetPort}/restoran"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Servisi Yeniden Kur"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-services.ps1"""; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Servisi Durdur"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\remove-services.ps1"""; IconFilename: "{app}\assets\alfapos.ico"

[Run]
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""Gelismis Kurye Sistemi"" dir=in action=allow protocol=TCP localport={code:GetPort}"; Flags: runhidden; StatusMsg: "Güvenlik duvarı kuralı ekleniyor (telefonlardan erişim için)..."
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-requirements.ps1"""; StatusMsg: "Gereksinimler kuruluyor (Node.js, sqlcmd)..."; Flags: waituntilterminated runhidden
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-services.ps1"""; StatusMsg: "Servis kuruluyor ve başlatılıyor..."; Flags: waituntilterminated
Filename: "http://127.0.0.1:{code:GetPort}/restoran"; Description: "Restoran ekranını aç"; Flags: postinstall shellexec skipifsilent nowait

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\remove-services.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveServices"
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Gelismis Kurye Sistemi"""; Flags: runhidden; RunOnceId: "DelFwRule"

[Code]
var
  DBPage: TInputQueryWizardPage;
  OldBindHostLine: String;

function GetPort(Param: String): String;
begin
  Result := '4090';
end;

{ config.json icinden "key": "value" bicimindeki basit bir dize alanini okur -
  tam bir JSON ayristirici DEGIL, sadece bu kurulumun kendi yazdigi duz/tek-seviyeli
  alanlar icin yeterli (tirnak/backslash kacislarini islemez). }
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
  while (Length(S) > 0) and ((S[1] = ' ') or (S[1] = #9) or (S[1] = #13) or (S[1] = #10)) do
    S := Copy(S, 2, Length(S) - 1);
  if (Length(S) = 0) or (S[1] <> '"') then Exit;
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
  DBPage := CreateInputQueryPage(wpSelectDir,
    'SQL Server Bağlantısı',
    'SambaPOS veritabanı bağlantı bilgileri',
    'Bu bilgiler, bu bilgisayarda ZATEN çalışan Kurye Takip / SambaPOS sisteminizde ' +
    'kullandığınız bilgilerle AYNI olmalı. Kurulum sonunda config.json dosyasına otomatik yazılacak. ' +
    'SQL kullanıcı adı/şifresi boş bırakılırsa Windows kimlik doğrulama kullanılır.');
  DBPage.Add('SQL Server adresi  (ör: DESKTOP-ADI veya localhost):', False);
  DBPage.Add('Veritabanı adı:', False);
  DBPage.Add('SQL kullanıcı adı  (boş = Windows kimlik doğrulama):', False);
  DBPage.Add('SQL şifresi:', True);
  DBPage.Add('Gelişmiş Kurye aktivasyon anahtarı  (admin panelden bu ürün için üretilen AYRI anahtar - diğer ürünlerin anahtarı DEĞİL):', False);

  DBPage.Values[0] := 'localhost';
  DBPage.Values[1] := 'SAMBAPOS5';
end;

(* ONEMLI: app sabiti InitializeWizard SIRASINDA HENUZ HAZIR DEGIL - kullanici
   henuz kurulum klasorunu (wpSelectDir sayfasi) onaylamadi. Bunu InitializeWizard
   icinde ExpandConstant ile okumaya calismak HER SEFERINDE "Internal error: An
   attempt was made to expand the app constant before it was initialized" ile
   kurulumun DAHA BASLAMADAN cokmesine sebep oluyordu (13.09.2026, canli OZ URFA
   kurulumlarinda GUN BOYU tespit edilemeyen asil neden buydu - pencere acilip
   "basariyla" kapaniyor gibi gorunuyordu ama hicbir dosya asla guncellenmiyordu).
   Config.json'u on-dolu getirme islemi bu yuzden DBPage'e GECILDIGI anda
   (CurPageChanged) yapilir - o noktada app degiskeni zaten belli olur. *)
procedure CurPageChanged(CurPageID: Integer);
var
  ConfigPath, OldBindHost: String;
  OldJson: AnsiString;
begin
  if CurPageID = DBPage.ID then
  begin
    ConfigPath := ExpandConstant('{app}\config.json');
    if FileExists(ConfigPath) and LoadStringFromFile(ConfigPath, OldJson) then
    begin
      if ExtractJsonValue(OldJson, 'server') <> '' then DBPage.Values[0] := ExtractJsonValue(OldJson, 'server');
      if ExtractJsonValue(OldJson, 'database') <> '' then DBPage.Values[1] := ExtractJsonValue(OldJson, 'database');
      DBPage.Values[2] := ExtractJsonValue(OldJson, 'user');
      DBPage.Values[3] := ExtractJsonValue(OldJson, 'password');
      DBPage.Values[4] := ExtractJsonValue(OldJson, 'gkActivationKey');
      OldBindHost := ExtractJsonValue(OldJson, 'bindHost');
      if OldBindHost <> '' then
        OldBindHostLine := '  "bindHost": "' + JsonEscape(OldBindHost) + '",' + #13#10;
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = DBPage.ID then
  begin
    if Trim(DBPage.Values[0]) = '' then
    begin
      MsgBox('SQL sunucu adresi boş bırakılamaz.', mbError, MB_OK);
      Result := False;
    end
    else if Trim(DBPage.Values[1]) = '' then
    begin
      MsgBox('Veritabanı adı boş bırakılamaz.', mbError, MB_OK);
      Result := False;
    end
    else if Trim(DBPage.Values[4]) = '' then
    begin
      MsgBox('Gelişmiş Kurye aktivasyon anahtarı boş bırakılamaz - admin panelden bu ürün için üretilen anahtarı girin.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigPath: String;
  JsonContent: String;
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    { Servis CALISIRKEN .js dosyalarinin UZERINE YAZILAMIYOR - Windows dosyayi
      kilitli tutuyor, Inno Setup sessizce atliyor (veya reboot'a erteliyor),
      bu yuzden GUNCELLEME kurulumlarinda kod hic degismemis gibi kaliyordu
      (13.09.2026, OZ URFA'da canli tespit edildi - kurulum "basarili" gorundu
      ama tunnel.js saatler once kurulan ESKI surumdu, hicbir duzeltme
      calismamis oluyordu). Dosyalar kopyalanmadan ONCE servis durdurulur -
      "net stop" servis yoksa (ilk kurulum) sessizce hata verir, sorun degil. }
    Exec('net.exe', 'stop GelismisKuryeSistemi', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
  if CurStep = ssPostInstall then
  begin
    { Artik HER kurulumda (ilk kurulum VEYA guncelleme/tekrar kurulum farketmeksizin)
      config.json sihirbazdaki (gerekirse ON-DOLU getirilen) degerlerle YENIDEN
      yazilir - eskiden config.json VARSA bu sayfa tamamen atlaniyor VE dosyaya
      hic dokunulmuyordu, bu da gkActivationKey gibi yeni eklenen alanlarin
      yukseltmelerde asla yazilmamasina yol aciyordu. }
    ConfigPath := ExpandConstant('{app}\config.json');
    JsonContent :=
      '{' + #13#10 +
      '  "server": "' + JsonEscape(DBPage.Values[0]) + '",' + #13#10 +
      '  "database": "' + JsonEscape(DBPage.Values[1]) + '",' + #13#10 +
      '  "user": "' + JsonEscape(DBPage.Values[2]) + '",' + #13#10 +
      '  "password": "' + JsonEscape(DBPage.Values[3]) + '",' + #13#10 +
      '  "options": {' + #13#10 +
      '    "encrypt": false,' + #13#10 +
      '    "trustServerCertificate": true' + #13#10 +
      '  },' + #13#10 +
      '  "port": 4090,' + #13#10 +
      OldBindHostLine +
      '  "gkActivationKey": "' + JsonEscape(Trim(DBPage.Values[4])) + '",' + #13#10 +
      '  "cloudServerUrl": "https://app.ornek-alanadi.com"' + #13#10 +
      '}';
    SaveStringToFile(ConfigPath, JsonContent, False);
  end;
end;
