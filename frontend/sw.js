// Минимальный Service Worker для установки PWA на главный экран
// Не кэширует ничего (приложение всегда требует свежие токены)

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Просто пропускаем запросы без кэширования
});
