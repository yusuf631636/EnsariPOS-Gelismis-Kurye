/* "Uygulama olarak yukle" + arka planda push bildirimi. Istekler aga dogrudan
   gecirilir (agresif onbellekleme yok, veri hep canli olmali). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass-through, custom caching yok */ });

/* Uygulama TAMAMEN KAPALIYKEN (sekme yok, hafizada calisan bir sey yok) gelebilecek
   TEK bildirim yolu bu - tarayicilar push event'inde ozel/uzun bir alarm sesi
   CALDIRMIYOR (eski Notification "sound" secenegi kaldirilali yillar oldu), bu yuzden
   burada cihazin KENDI standart bildirim sesi/titresimi devreye girer. Uygulama acikken
   (on planda ya da arka planda ama hafizada canliyken) gercek yuksek sesli/tekrar eden
   alarm app.js'teki Web Audio API ile calinir - ikisi birlikte "mumkun oldugunca"
   kapsam saglar. */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'Gelişmiş Kurye Sistemi';
  const isAssign = data.kind === 'atandi';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/courier/icons/icon-192.png',
    badge: '/courier/icons/icon-192.png',
    tag: data.tag || 'gks-bildirim',
    renotify: true,
    requireInteraction: true,
    vibrate: isAssign ? [300, 100, 300, 100, 300] : [400, 150, 400, 150, 400, 150, 400],
    data: { kind: data.kind || '' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.kind === 'atandi' ? '/courier#mine' : '/courier#unassigned';
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) { client.postMessage({ type: 'notification-click', kind: event.notification.data && event.notification.data.kind }); return client.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});
