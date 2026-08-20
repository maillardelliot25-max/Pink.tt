// Bumped whenever the backdrop video changes (now v4, video at ?v=5)
// -- activate() below deletes any cache bucket whose name doesn't match CACHE_NAME, so
// this forces every existing installed service worker to throw away whatever old
// (possibly blurrier, pre-re-encode) copy of the video it had already cached under the
// old un-versioned URL, and fetch the current one fresh instead of serving stale bytes
// forever. Bump this again alongside VIDEO_VERSION in index.html any time the video
// changes in the future.
const CACHE_NAME='pinktt-shell-v6';
const OFFLINE_URL='/offline.html';
// The offline page's backdrop video is precached too -- unlike every other use of this
// clip, this page can genuinely be shown with zero connectivity at all, so the video
// has to already be on the device rather than fetched fresh or it just won't play.
// Every clip is precached, not just the offline page's hardcoded default: offline.html
// picks up whatever the app last had in ptt_last_wallpaper, which can be any clip in the
// pool, so any of them may need to render with zero network.
const PRECACHE=[OFFLINE_URL,'/favicon.svg','/icons/icon-192.png','/icons/icon-512.png','/media/install-banner-bg.mp4?v=5','/media/install-banner-bg.webm?v=5'];

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
// The video was in PRECACHE but nothing ever read it back out -- only navigate
// requests were intercepted, so the offline page's own <video><source> fetch had no
// network and no cache fallback, and just failed silently (blank background, no loop).
// Network-first so online visitors always get the current file, falling back to the
// precached copy only when the network fetch genuinely fails.
async function _mediaNetworkFirst(request){
  try{return await fetch(request);}
  catch(e){
    // ignoreSearch is essential, not a nicety: the video URL carries a ?v=N cache-buster
    // that gets bumped whenever the file is re-encoded. A device still holding an older
    // cache (precached under a different ?v=, or none at all) would otherwise match
    // nothing and show a blank backdrop -- exactly when it matters most, with no network
    // to fall back on. Serving a slightly older copy of a decorative loop beats serving
    // nothing, and the moment connectivity returns the fetch above wins again.
    const hit=await caches.match(request,{ignoreSearch:true});
    return hit||Response.error();
  }
}
// Same network-first idea as _mediaNetworkFirst, but for the admin's custom background
// (/api/app-background.mp4|webm) -- this one can't be precached at install time since its
// content changes whenever an admin uploads a new one, so instead it's cached on the fly:
// every successful online fetch updates the cached copy, so the *last seen* custom
// background is what's available if the device later goes offline. Without this, offline.html
// requesting a custom background it was never able to cache would just fail straight
// through to its next <source> (the always-precached built-in default) -- correct, but
// loses the "same wallpaper everywhere" consistency the admin actually set.
async function _customBgNetworkFirst(request){
  try{
    const res=await fetch(request);
    if(res.ok){const cache=await caches.open(CACHE_NAME);cache.put(request,res.clone());}
    return res;
  }catch(e){
    const hit=await caches.match(request);
    return hit||Response.error();
  }
}
self.addEventListener('fetch',e=>{
  const pathname=new URL(e.request.url).pathname;
  if(e.request.mode==='navigate'){
    e.respondWith(_navigateWithRetry(e.request));
  }else if(/^\/media\/.+\.(mp4|webm)$/.test(pathname)){
    e.respondWith(_mediaNetworkFirst(e.request));
  }else if(/^\/api\/app-background\.(mp4|webm)$/.test(pathname)){
    e.respondWith(_customBgNetworkFirst(e.request));
  }
});

// Real phone push -- fires even when the app isn't open, which is the entire point (a
// driver's phone locked in their pocket still needs to hear about a new ride request).
// The server always sends {title,body,url} as its JSON payload (see pushToUser in
// server.js); falls back to a generic notification if a push somehow arrives malformed
// rather than throwing and dropping it silently.
self.addEventListener('push',e=>{
  let data={title:'Pink.TT',body:'You have a new notification',url:'/'};
  try{if(e.data)data={...data,...e.data.json()};}catch(err){}
  e.waitUntil(self.registration.showNotification(data.title,{
    body:data.body,
    icon:'/icons/icon-192.png',
    badge:'/icons/icon-192.png',
    data:{url:data.url||'/'}
  }));
});
// Focuses an already-open app tab rather than always opening a new one, same as any
// native app's notification tap behaviour.
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=e.notification.data?.url||'/';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){if('focus' in c)return c.focus();}
    if(self.clients.openWindow)return self.clients.openWindow(url);
  }));
});
