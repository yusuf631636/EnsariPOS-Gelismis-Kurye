/* Minimal service worker - sadece "uygulama olarak yukle" kosulunu
   saglamak icin var. Siparis verisi canli olmali, bu yuzden agresif
   onbellekleme yapilmiyor; istekler dogrudan aga gecirilir. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass-through, custom caching yok */ });
