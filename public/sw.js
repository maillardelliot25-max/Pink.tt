// Bumped whenever the backdrop video changes (now v4, video at ?v=5)
// -- activate() below deletes any cache bucket whose name doesn't match CACHE_NAME, so
// this forces every existing installed service worker to throw away whatever old
// (possibly blurrier, pre-re-encode) copy of the video it had already cached under the
// old un-versioned URL, and fetch the current one fresh instead of serving stale bytes
// forever. Bump this again alongside VIDEO_VERSION in index.html any time the video
// changes in the future.
const CACHE_NAME='pinktt-shell-v4';
const OFFLINE_URL='/offline.html';
// The offline page's backdrop video is precached too -- unlike every other use of this
// clip, this page can genuinely be shown with zero connectivity at all, so the video
// has to already be on the device rather than fetched fresh or it just won't play.
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
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate'){
    e.respondWith(_navigateWithRetry(e.request));
  }else if(new URL(e.request.url).pathname.startsWith('/media/install-banner-bg')){
    e.respondWith(_mediaNetworkFirst(e.request));
  }
});
