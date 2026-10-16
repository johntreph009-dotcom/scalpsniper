// ScalpSniper service worker — офлайн-оболочка.
// Стратегия: свой origin → network-first (часто деплоим, юзер всегда получает свежую версию online, офлайн — из кэша);
//            шрифты (immutable) → cache-first для офлайн-вида; биржевые API/WS → напрямую в сеть (без кэша/CORS-проблем).
const CACHE='scalpsniper-v3';   // бамп имени → activate вычистит старый кэш с прошлой сборкой
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

  // Свой origin → network-first с фолбэком на кэш (офлайн-оболочка).
  // ЗАМЕРЕНО 2026-08-03: стратегия называлась network-first, но фактически ею не была.
  // Голый fetch(req) идёт через HTTP-кэш браузера, а GitHub Pages отдаёт HTML с max-age.
  // В итоге после деплоя пользователь ещё минуты получал ПРОШЛУЮ сборку, хотя на сервере
  // уже лежала новая — деплой до него не доезжал. cache:'no-cache' заставляет
  // перепроверять на сервере по ETag: свежесть гарантирована, трафик почти тот же
  // (304 при совпадении), офлайн-фолбэк ниже сохраняется без изменений.
  e.respondWith(
    fetch(req,{cache:'no-cache'}).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
      return res;
    }).catch(()=>caches.match(req).then(r=>r||caches.match('scalpsniper.html')))
  );
});
