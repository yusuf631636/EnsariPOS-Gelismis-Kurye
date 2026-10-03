@echo off
rem Gelismis Kurye Sistemi (C#) servisini yeniden baslatir (yonetici olarak calistirin)
net stop GelismisKuryeSistemi
net start GelismisKuryeSistemi
pause
