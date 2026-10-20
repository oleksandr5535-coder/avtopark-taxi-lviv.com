// Service worker кабінету водія: потрібен Chrome для встановлення на екран.
// Дані не кешує (цифри завжди свіжі). Якщо немає інтернету — показує просте повідомлення.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:32px;text-align:center"><h2>Немає інтернету</h2><p>Підключіться до мережі й оновіть сторінку.</p></body>',
    {headers: {'Content-Type': 'text/html; charset=utf-8'}})));
});
