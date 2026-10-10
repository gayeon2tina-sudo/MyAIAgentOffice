const CACHE='friendhq-v4-cloud1';
const ASSETS=['./','./setup.js?v=20261010-cloud1','./cloud.js?v=20261010-cloud1','./vendor/supabase-2.57.4.js','./manifest.json','../application-tracker.js','../sprites/yard/office-yard.png','../sprites/yard/penguin-sheet.png','../sprites/yard/penguin-igloo.gif'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));});
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
 const url=new URL(e.request.url);
 if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
 // Authentication callbacks and account APIs must never be cached.
 if(url.searchParams.has('code')||url.searchParams.has('token')||url.searchParams.has('token_hash')||url.searchParams.has('error'))return;
 e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}return r;}).catch(()=>caches.open(CACHE).then(c=>c.match(e.request))));
});
