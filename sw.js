// ScalpSniper service worker — офлайн-оболочка.
// Стратегия: свой origin → network-first (часто деплоим, юзер всегда получает свежую версию online, офлайн — из кэша);
//            шрифты (immutable) → cache-first для офлайн-вида; биржевые API/WS → напрямую в сеть (без кэша/CORS-проблем).
const CACHE='scalpsniper-v2';
const ASSETS=['scalpsniper.html','manifest.json','icon-192.png','icon-512.png'];
const FONT_ORIGINS=['https://fonts.googleapis.com','https://fonts.gstatic.com'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()).catch(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);

  // Шрифты Google (неизменяемы) → cache-first: моментально офлайн и без сети на повторных загрузках
  if(FONT_ORIGINS.indexOf(url.origin)!==-1){
    e.respondWith(
      caches.match(req).then(hit=>hit||fetch(req).then(res=>{
        const copy=res.clone(); caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{}); return res;
      }).catch(()=>hit))
    );
    return;
  }

  // Чужой origin (Binance/Bybit/OKX/MEXC/CoinGecko/Deribit/воркер) → напрямую в сеть, не трогаем
  if(url.origin!==self.location.origin)return;

  // Свой origin → network-first с фолбэком на кэш (офлайн-оболочка)
  e.respondWith(
    fetch(req).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
      return res;
    }).catch(()=>caches.match(req).then(r=>r||caches.match('scalpsniper.html')))
  );
});
