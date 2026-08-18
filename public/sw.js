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

// Network-first for page navigations, falling back to the offline page only after
// retrying -- a single failed fetch used to go straight to "You're offline" with no
// second attempt, which for a safety app is too quick to give up: a slow host wake-up
// or one dropped packet on a mobile connection would show a scary offline screen even
// though the app is actually reachable a moment later. Everything else (API calls,
// WebSocket, app assets) always goes straight to the network -- we deliberately never
// cache live data.
async function _navigateWithRetry(request){
  const attempts=3,delays=[800,1600];
  for(let i=0;i<attempts;i++){
    try{return await fetch(request);}
    catch(e){if(i<attempts-1)await new Promise(r=>setTimeout(r,delays[i]));}
  }
  return caches.match(OFFLINE_URL);
}
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate'){
    e.respondWith(_navigateWithRetry(e.request));
  }
});
