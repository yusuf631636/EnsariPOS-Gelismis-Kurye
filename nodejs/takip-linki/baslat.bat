@echo off
cd /d "%~dp0"
if not exist config.json (
  echo config.json yok. config.example.json dosyasini config.json olarak kopyalayip
  echo SQL Server bilgilerinizi girin, sonra bu dosyayi tekrar calistirin.
  copy config.example.json config.json
  notepad config.json
  exit /b 1
)
if not exist node_modules (
  echo Bagimliliklar kuruluyor...
  call npm install
)
node server.js
pause
