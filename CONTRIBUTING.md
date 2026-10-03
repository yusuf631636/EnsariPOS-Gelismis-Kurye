# Katkı rehberi

Katkı vermek isteyen herkese teşekkürler. Değişiklikler doğrudan ana dala yazılmaz; her katkı bir **Pull Request (PR)** olarak gelir ve proje sahibi inceleyip onaylayınca birleştirilir.

## Akış

1. Depoyu **Fork**'layın (sağ üstteki *Fork* düğmesi).
2. Kendi kopyanızda yeni bir dal açın: `git checkout -b duzeltme/kiosk-sepet-hatasi`
3. Değişikliğinizi yapın, yerelde çalıştırıp deneyin (bkz. README → *Yerelde çalıştırma*).
4. Commit edin ve kendi fork'unuza gönderin: `git push origin duzeltme/kiosk-sepet-hatasi`
5. GitHub'da **Pull Request** açın. Açıklamada *ne değişti, neden, nasıl test ettiniz* yazın.
6. İnceleme sırasında istenen düzeltmeleri aynı dala gönderin; PR otomatik güncellenir.

Büyük bir değişiklik düşünüyorsanız önce bir **Issue** açıp fikri konuşalım.

## Kurallar

- **Sır göndermeyin.** `config.json`, şifre, API anahtarı, aktivasyon anahtarı, müşteri verisi, veritabanı dosyası PR'a girmez. Yeni bir ayar eklerseniz `config.example.json`'a yer tutucuyla ekleyin.
- Canlı bir SambaPOS'a **test siparişi** göndermeyin; deneme ortamı kullanın.
- Mevcut kod stilini takip edin: aynı dosyadaki adlandırma, yorum yoğunluğu ve yazım biçimiyle uyumlu yazın. Kullanıcıya görünen metinler Türkçedir.
- C# projeleri .NET Framework 4.x ve Windows'un `csc.exe`'si (C# 5) ile derlenir — `$"..."` metin enterpolasyonu, `?.` gibi yeni sözdizimini kullanmayın.
- Bir PR tek bir konuyu çözsün; ilgisiz düzenlemeleri ayrı PR yapın.

## Hata bildirimi

Issue açarken: hangi ürün ve sürüm, ne yaptınız, ne bekliyordunuz, ne oldu; varsa ekran görüntüsü ve log satırı (şifre/anahtar içermediğinden emin olun).
