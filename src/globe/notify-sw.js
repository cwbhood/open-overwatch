// Service worker for sky alerts only (alerts.js): phones show page notifications through a worker. It caches nothing
// and intercepts no requests; tapping a notification brings the globe back.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.split('#')[0] === url && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
