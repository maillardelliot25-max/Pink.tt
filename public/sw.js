const CACHE_NAME='pinktt-shell-v1';
const OFFLINE_URL='/offline.html';
const PRECACHE=[OFFLINE_URL,'/favicon.svg','/icons/icon-192.png','/icons/icon-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first for page navigations, falling back to the offline page when unreachable.
// Everything else (API calls, WebSocket, app assets) always goes straight to the network --
// this is a real-time safety app, so we deliberately never cache live data.
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).catch(()=>caches.match(OFFLINE_URL)));
  }
});
