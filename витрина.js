/* Витрина ScalpSniper (16.10.2026, этап 9). Спецификация — Документы/ВИТРИНА-UX.md; данные — /api/finds (Free/Pro решает сервер).
 * Здесь нет детекторов и запросов к биржам: только показ того, что прислал сервер. Чистые функции отрисовки отдаются наружу
 * (window.ВИТРИНА) — их гоняет connector/ТЕСТ-ВИТРИНА.js без браузера. Строки из данных всегда экранируются. */
(function (корень) {
  'use strict';
  var API = 'https://scalpsniper-ai-proxy.johntreph009.workers.dev';
  var K_SESS = 'msa_session', K_ВЫКЛ = 'vitrina_vykl_v1';
  var ВИДЫ = [['тест', 'Ретест после выхода'], ['ретест', 'Ретест H4'], ['этаж', 'Этажи'], ['оборот', 'Оборот'], ['всплеск', 'Всплеск']];
  var ЦВЕТ = { 'Как рынок': '', 'Хуже рынка': 'ниже', 'Лучше рынка': 'выше', 'Пока мало случаев': '' };

  function экр(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function силаHTML(n) {
    n = Number(n); if (!(n >= 1 && n <= 5)) return '';
    var b = ''; for (var i = 1; i <= 5; i++) b += '<b class="' + (i <= n ? 'да' : '') + '"></b>';
    return '<span class="сила" role="img" aria-label="сила ' + n + ' из 5">' + b + '</span>';
  }
  function назад(t, сейчас) { var м = Math.round((сейчас - t) / 6e4); return м < 1 ? 'только что' : м < 60 ? м + ' мин назад' : м < 48 * 60 ? Math.round(м / 60) + ' ч назад' : Math.round(м / 1440) + ' дн назад'; }
  function проц(x) { x = Number(x); return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1).replace('.', ',') + '%'; }
  function дата(t) { try { return new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', ''); } catch (e) { return ''; } }
  var МЕС = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  function деньДаты(s) { var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(s || '')); return m ? (+m[3]) + ' ' + МЕС[+m[2] - 1] : ''; }
  function подпись(x) { return x.впервые ? '<span>впервые</span>' : (x.раз30 > 1 ? '<span>' + Number(x.раз30) + '-й раз за 30 дней</span>' : ''); }

  function строкаHTML(x, сейчас, выбранId, новые) {
    var закрыто = !!x.закрыто, сИтогом = !!x.итог;
    var правый = сИтогом ? '<span class="итог ' + (x.итог.кРынку24 > 0 ? 'выше' : 'ниже') + '">' + проц(x.итог.кРынку24) + ' к рынку</span>'
      : закрыто ? '<span class="pro">Открыть в Pro</span>'
      : '<span class="итог ждёт">итог через ' + Math.max(1, Math.round(24 - (сейчас - x.t) / 36e5)) + ' ч</span>';
    var кл = 'строка' + (закрыто ? ' закрыто' : '') + (x.id === выбранId ? ' выбр' : '') + (новые && новые.has(x.id) ? ' захват' : '');
    return '<button class="' + кл + '" data-id="' + экр(x.id) + '" type="button">'
      + '<span class="тикер">' + (закрыто ? '••••' : экр(x.тикер)) + '</span>'
      + '<span class="время">' + (сИтогом ? экр(дата(x.t)) : экр(назад(x.t, сейчас))) + '</span>'
      + '<span class="вид">' + экр(x.имя) + ' ' + силаHTML(x.сила) + подпись(x) + '</span>' + правый + '</button>';
  }
  /* ══ Кейсы (17.10.2026, перенос дизайна шаг 4; холст «ScalpSniper — единый терминал», доски Main/Desktop) ══
     Первый экран: «В прицеле» — одна главная свежая находка; «Мозаика находок» — каждая клетка = находка из ответа сервера,
     цвет = что с ней стало через сутки; ниже списки «В работе» и «С итогом». Только то, что прислал сервер: ни вероятностей,
     ни счётчиков, которых в ответе нет (воронка «412 → 1» появится, когда сервер начнёт отдавать её числа). */
  function слово(n) { n = Math.abs(n) % 100; var к = n % 10; return n > 10 && n < 20 ? 'находок' : к === 1 ? 'находка' : к >= 2 && к <= 4 ? 'находки' : 'находок'; }
  function вПрицеле(список) {
    var свежие = список.filter(function (x) { return !x.итог; }), откр = свежие.filter(function (x) { return !x.закрыто; });
    return (откр.length ? откр : свежие).slice().sort(function (a, b) { return (Number(b.сила) || 0) - (Number(a.сила) || 0) || b.t - a.t; })[0] || null;
  }
  function прицелSVG() {
    return '<svg class="знак-п" viewBox="0 0 120 120" aria-hidden="true"><circle class="к1" cx="60" cy="60" r="46"/><circle class="к2" cx="60" cy="60" r="30"/>'
      + '<path class="штр" d="M60 2v24M60 94v24M2 60h24M94 60h24"/><circle class="точка" cx="60" cy="60" r="4"/></svg>';
  }
  function геройHTML(x, сейчас) {
    if (!x) return '<div class="герой тихо">' + прицелSVG() + '<span class="г-текст"><span class="г-метка">В прицеле</span><span class="г-тикер тикер">—</span>'
      + '<span class="г-вид">Свежих находок нет — сканер смотрит рынок.</span></span></div>';
    var ч = Math.max(1, Math.round(24 - (сейчас - x.t) / 36e5));
    return '<button class="герой" type="button" data-id="' + экр(x.id) + '">' + прицелSVG()
      + '<span class="г-текст"><span class="г-метка">В прицеле</span>'
      + '<span class="г-тикер тикер' + (x.закрыто ? ' скрыт' : '') + '">' + (x.закрыто ? '••••' : экр(x.тикер)) + '</span>'
      + '<span class="г-вид">' + экр(x.имя) + ' ' + силаHTML(x.сила) + '</span>'
      + '<span class="г-путь"><i class="есть">найдена ' + экр(назад(x.t, сейчас)) + '</i><i class="ждём">итог через ' + ч + ' ч</i></span>'
      + (x.закрыто ? '<span class="pro">Тикер свежей находки — в Pro</span>' : '') + '</span></button>';
  }
  function клеткаКласс(x, сейчас) {
    if (x.итог) { var v = Number(x.итог.кРынку24), а = Math.abs(v); return (v > 0 ? 'в' : 'н') + (а >= 5 ? '3' : а >= 2 ? '2' : '1'); }
    if (x.закрыто) return 'з';
    return сейчас - x.t < 36e5 ? 'гор' : 'с';
  }
  function мозаикаHTML(список, сейчас, выбранId) {
    if (!список.length) return '';
    var сИт = список.filter(function (x) { return x.итог; }), выше = сИт.filter(function (x) { return x.итог.кРынку24 > 0; }).length;
    var клетки = список.slice().sort(function (a, b) { return a.t - b.t; }).map(function (x) {
      return '<i class="' + клеткаКласс(x, сейчас) + (x.id === выбранId ? ' выбр' : '') + '" data-id="' + экр(x.id) + '" title="' + (x.закрыто ? экр(x.имя) : экр(String(x.тикер || '').replace(/[^0-9A-Za-z]/g, '')) + ', ' + экр(x.имя)) + '"></i>'; }).join('');
    var итог = сИт.length ? выше + ' из ' + сИт.length + ' обогнали рынок' : 'итогов ещё нет';
    return '<div class="мозаика"><div class="м-верх"><b>Мозаика находок</b><span>' + список.length + ' ' + слово(список.length) + ', ' + итог + '</span></div>'
      + '<div class="м-поле" role="img" aria-label="' + список.length + ' ' + слово(список.length) + ': ' + итог + '">' + клетки + '</div>'
      + '<div class="м-легенда"><span class="л-в">обогнала рынок за сутки</span><span class="л-н">отстала</span><span class="л-с">ждёт итога</span></div></div>';
  }
  function лентаHTML(д, фильтр, сейчас, выбранId, новые, выкл) {
    var все = (д.находки || []).filter(function (x) { return !выкл.has(x.вид) && (!фильтр || x.вид === фильтр); });
    var свежие = все.filter(function (x) { return !x.итог; }), прошлые = все.filter(function (x) { return x.итог; });
    var чипы = '<div class="чипы">' + [['', 'Все']].concat(ВИДЫ).map(function (в) {
      return '<button class="чип" type="button" data-вид="' + в[0] + '" aria-pressed="' + (в[0] === (фильтр || '')) + '">' + в[1] + '</button>'; }).join('') + '</div>';
    if (!все.length) return чипы + '<div class="пусто">Сегодня таких находок не было.' + (фильтр ? '<br><button class="кн" type="button" data-вид="">Показать все</button>' : '') + '</div>';
    return чипы + геройHTML(вПрицеле(все), сейчас) + мозаикаHTML(все, сейчас, выбранId)
      + (свежие.length ? '<div class="раздел">В работе' + (д.про ? '' : ' — бесплатно открыты 3 находки старше 15 минут') + '</div>' + свежие.map(function (x) { return строкаHTML(x, сейчас, выбранId, новые); }).join('') : '')
      + (прошлые.length ? '<div class="раздел">С итогом — старше суток</div>' + прошлые.map(function (x) { return строкаHTML(x, сейчас, выбранId, новые); }).join('') : '');
  }
  function полосаHTML(ит) {
    var т = ит.точки || [], в = т.filter(Boolean).length;
    return '<div class="полоса" role="img" aria-label="' + в + ' из ' + т.length + ' выше рынка">' + т.map(function (p) { return '<i class="' + (p ? 'в' : '') + '"></i>'; }).join('') + '</div>';
  }
  function похожиеHTML(ит) {
    if (!ит) return '<p class="пыль">По этому виду итогов ещё нет.</p>';
    if (ит.вердикт === 'Пока мало случаев') return полосаHTML(ит) + '<p>Пока мало случаев: ' + Number(ит.n) + ' из 30 — вывода нет.</p>';
    return полосаHTML(ит) + '<p><span class="вердикт ' + (ЦВЕТ[ит.вердикт] || '') + '">' + экр(ит.вердикт) + '.</span> ' + Number(ит.выше) + '% из ' + Number(ит.n) + ' находок обогнали биткоин за сутки.</p>'
      + '<p class="подпись">Каждая точка — прошлая находка этого вида: зелёная обогнала биткоин за сутки, красная — нет.</p>';
  }
  function монетаHTML(x, д, сейчас) {
    if (!x) return '<div class="пусто">Выберите находку в ленте.</div>';
    var ит = (д.итоги || []).filter(function (и) { return и.вид === x.вид; })[0];
    if (x.закрыто) return '<div class="монета"><h1 class="тикер">••••</h1><div class="пара">Тикер свежей находки виден в Pro</div>'
      + '<div class="блок"><h2>Что нашли</h2><div class="факты"><span>' + экр(x.имя) + '</span>' + силаHTML(x.сила) + '<span class="пыль">' + экр(назад(x.t, сейчас)) + '</span></div></div>'
      + '<div class="блок"><h2>Как было у похожих</h2>' + похожиеHTML(ит) + '</div>'
      + '<div class="кнопки"><a class="кн главная" href="scalpsniper.html">Тарифы и Pro</a></div></div>';
    var т = encodeURIComponent(String(x.тикер || ''));
    return '<div class="монета"><h1 class="тикер">' + экр(x.тикер) + '</h1><div class="пара">' + экр(x.тикер) + ' / USDT, фьючерс Binance</div>'
      + '<div class="блок"><h2>Что нашли</h2><div class="факты"><span>' + экр(x.имя) + '</span>' + силаHTML(x.сила) + (x.факт ? '<span class="пыль">' + экр(x.факт) + '</span>' : '')
      + '<span class="пыль">' + (x.итог ? экр(дата(x.t)) : экр(назад(x.t, сейчас))) + '</span></div>'
      + (x.сила ? '<p class="подпись о8">Сила — насколько ярко событие среди таких же. Не вероятность роста.</p>' : '')
      + (x.итог ? '<p class="о10">Через сутки: <span class="вердикт ' + (x.итог.кРынку24 > 0 ? 'выше' : 'ниже') + '">' + проц(x.итог.кРынку24) + ' к рынку</span> <span class="пыль">(цена ' + проц(x.итог.ход24) + ')</span></p>' : '')
      + (x.уровни && x.уровни.length ? '<p class="подпись о10">Уровни блоков на графике:</p><div class="уровни">' + x.уровни.map(function (у) { return '<span>' + экр(у.от) + ' – ' + экр(у.до) + '</span>'; }).join('') + '</div>' : '')
      + '</div>'
      + '<div class="блок"><h2>Как было у похожих</h2>' + похожиеHTML(ит) + '</div>'
      + '<p class="подпись о14">Подходит ли находка под ваш стиль — отметьте кнопками ✅ / ❌ под ней в боте: отметки проверяют детекторы.</p>'
      + '<div class="кнопки"><a class="кн" href="scalpsniper.html?tk=' + т + '">График в терминале</a>'
      + '<a class="кн" href="https://www.tradingview.com/chart/?symbol=BINANCE:' + т + 'USDT.P" target="_blank" rel="noopener noreferrer">TradingView</a></div></div>';
  }
  function итогиHTML(д) {
    var и = д.итоги || [];
    if (!и.length) return '<div class="итоги"><h1>Что стало с находками через сутки</h1><p class="под">Итогов ещё нет.</p></div>';
    return '<div class="итоги"><h1>Что стало с находками через сутки</h1><p class="под">По сравнению с биткоином' + (деньДаты(и[0].с) ? ', ' + деньДаты(и[0].с) + ' — ' + деньДаты(и[0].по) : '') + '</p>'
      + и.map(function (v) {
        var т = (v.точки || []).length;
        return '<div class="вид-итог"><div class="верх"><span class="имя">' + экр(v.имя) + '</span><span class="вердикт ' + (ЦВЕТ[v.вердикт] || '') + '">' + экр(v.вердикт) + '</span></div>'
          + полосаHTML(v) + '<div class="подпись">' + Number(v.выше) + '% обогнали биткоин, ' + Number(v.n) + ' находок' + (т < v.n ? ', показаны последние ' + т : '') + '</div></div>'; }).join('')
      + '<details><summary>Как считаем</summary><p>Итог находки — изменение цены монеты за 24 часа минус изменение биткоина за те же 24 часа. «Обогнала» — итог больше нуля. «Лучше» или «хуже» рынка ставится, только когда это видно на 30 и больше находках; иначе — «как рынок» или «пока мало случаев».</p></details></div>';
  }
  function профильHTML(me, д, выкл) {
    var имя = me && me.user ? (me.user.name || 'Аккаунт') : 'Аккаунт';
    return '<div class="профиль"><div class="пункт"><div>' + экр(имя) + '<div class="пыль">' + (д && д.про ? 'Pro — открыты все находки и уровни' : 'Free — 3 свежие находки старше 15 минут; итоги — все') + '</div></div>'
      + (д && д.про ? '' : '<a class="кн главная" href="scalpsniper.html">Тарифы и Pro</a>') + '</div>'
      + '<div class="раздел без-поля">Показывать в ленте</div>'
      + ВИДЫ.map(function (в) { var вкл = !выкл.has(в[0]); return '<div class="пункт"><span>' + в[1] + '</span><button class="тумблер" type="button" role="switch" data-выкл="' + в[0] + '" aria-checked="' + вкл + '" aria-label="' + в[1] + '"></button></div>'; }).join('')
      + '<div class="пункт"><a href="scalpsniper.html">Терминал</a></div><div class="пункт"><a href="terms.html" target="_blank" rel="noopener">Условия и риски</a></div>'
      + '<div class="пункт"><a href="https://t.me/inside_tree" target="_blank" rel="noopener noreferrer">Поддержка в Telegram</a></div>'
      + '<div class="пункт"><button class="кн" type="button" data-действие="выйти">Выйти</button></div></div>';
  }
  function входHTML(почему) {
    return '<div class="вход"><h1>Находки сканера и что с ними стало</h1><p>' + экр(почему || 'Чтобы видеть ленту, войдите — через Telegram или почту, в окне аккаунта терминала. Ключи бирж не нужны.') + '</p>'
      + '<a class="кн главная" href="scalpsniper.html">Войти</a></div>';
  }
  var ВИТРИНА = { экр: экр, силаHTML: силаHTML, геройHTML: геройHTML, мозаикаHTML: мозаикаHTML, вПрицеле: вПрицеле, клеткаКласс: клеткаКласс, строкаHTML: строкаHTML, лентаHTML: лентаHTML, монетаHTML: монетаHTML, итогиHTML: итогиHTML, профильHTML: профильHTML, входHTML: входHTML, проц: проц, ВИДЫ: ВИДЫ };
  корень.ВИТРИНА = ВИТРИНА;
  if (typeof document === 'undefined') return;

  /* ══ работа в браузере ══ */
  var ls = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }, del: function (k) { try { localStorage.removeItem(k); } catch (e) {} } };
  var $ = function (s) { return document.querySelector(s); };
  var сессия = ls.get(K_SESS), д = null, me = null, фильтр = '', выбранId = null, виденные = null, новые = new Set(), выкл = new Set();
  try { выкл = new Set(JSON.parse(ls.get(K_ВЫКЛ) || '[]')); } catch (e) {}
  function зов(м, p, body) {
    var h = {}; if (body !== undefined) h['Content-Type'] = 'application/json'; if (сессия) h.Authorization = 'Bearer ' + сессия;
    return fetch(API + p, { method: м, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { st: r.status, j: j }; }); });
  }
  /* Мини-приложение Telegram: подписанные данные — из адреса, только в памяти; сервер проверяет подпись и выдаёт сессию. */
  var тгДанные = (function () { try { var m = /(?:^#|&)tgWebAppData=([^&]*)/.exec(location.hash); return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; } })();
  if (/(^#|&)tgWebApp(Platform|Version|Data)=/.test(location.hash)) { try { history.replaceState(null, '', location.pathname + location.search + '#лента'); } catch (e) {} }
  function жив(текст, молчит) { var э = $('#жив'); э.textContent = текст; э.classList.toggle('молчит', !!молчит); }
  var первый = true;
  function отрисовать() {
    var сейчас = Date.now();
    if (!д) return;
    /* Входные анимации (прицел сходится, мозаика проявляется) — только при первом показе: ленту перерисовывает таймер раз в
       минуту, и повтор каждую минуту был бы мельтешением, а не смыслом. */
    if (первый) { первый = false; document.body.classList.add('первый'); setTimeout(function () { document.body.classList.remove('первый'); }, 2600); }
    $('#тариф').hidden = false; $('#тариф').textContent = д.про ? 'Pro' : 'Free';
    var выбран = (д.находки || []).filter(function (x) { return x.id === выбранId; })[0] || (д.находки || []).filter(function (x) { return !x.закрыто; })[0] || null;
    if (выбран) выбранId = выбран.id;
    $('#э-лента').innerHTML = лентаHTML(д, фильтр, сейчас, выбранId, новые, выкл);
    $('#э-монета').innerHTML = монетаHTML(выбран, д, сейчас);
    $('#э-итоги').innerHTML = итогиHTML(д);
    $('#э-профиль').innerHTML = профильHTML(me, д, выкл);
    var возраст = д.обновлено ? (сейчас - д.обновлено) / 6e4 : null;
    if (возраст == null) жив('');
    else if (возраст > 60) жив('Сканер молчит ' + Math.round(возраст) + ' мин — проверяем', true);
    else жив((innerWidth < 1000 ? '' : 'Обновлено ') + назад(д.обновлено, сейчас));
  }
  function показать() {
    var э = decodeURIComponent(location.hash.slice(1)) || 'лента';
    if (!сессия || !д) э = 'вход';
    document.body.classList.toggle('без-входа', э === 'вход');
    document.querySelectorAll('.экран').forEach(function (s) {
      var вкл = s.id === 'э-' + э || (innerWidth >= 1000 && э === 'лента' && s.id === 'э-монета') || (innerWidth >= 1000 && э === 'монета' && s.id === 'э-лента');
      s.classList.toggle('вкл', вкл); });
    document.querySelectorAll('[data-э]').forEach(function (a) { a.classList.toggle('вкл', a.dataset.э === э || (э === 'монета' && innerWidth >= 1000 && a.dataset.э === 'лента')); });
    document.body.classList.toggle('широко', innerWidth >= 1000 && (э === 'итоги' || э === 'профиль' || э === 'вход'));
  }
  function вход(почему) { $('#э-вход').innerHTML = входHTML(почему); д = null; показать(); }
  function загрузить() {
    if (!сессия) { вход(); return Promise.resolve(); }
    return зов('GET', '/api/finds').then(function (r) {
      if (r.st === 401) { сессия = null; ls.del(K_SESS); вход('Сессия закончилась — войдите снова.'); return; }
      if (r.st !== 200 || !r.j) { жив('Нет связи с сервером — повторю через минуту', true); return; }
      if (!r.j.опубликовано) { д = { находки: [], итоги: [], про: false }; жив(r.j.почему || 'Сканер ещё не публиковал находки', true); отрисовать(); показать(); return; }
      var ids = (r.j.находки || []).map(function (x) { return x.id; });
      новые = new Set(виденные ? ids.filter(function (i) { return !виденные.has(i); }) : []);
      виденные = new Set(ids); д = r.j; отрисовать(); показать();
    }).catch(function () { жив('Нет связи с сервером — повторю через минуту', true); });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-id],[data-вид],[data-выкл],[data-действие]'); if (!t) return;
    if (t.hasAttribute('data-id')) { выбранId = t.getAttribute('data-id'); новые = new Set(); отрисовать(); if (innerWidth < 1000) location.hash = 'монета'; else показать(); }
    else if (t.hasAttribute('data-вид')) { фильтр = t.getAttribute('data-вид'); отрисовать(); }
    else if (t.hasAttribute('data-выкл')) { var в = t.getAttribute('data-выкл'); if (выкл.has(в)) выкл.delete(в); else выкл.add(в); ls.set(K_ВЫКЛ, JSON.stringify(Array.from(выкл))); отрисовать(); }
    else if (t.getAttribute('data-действие') === 'выйти') { зов('POST', '/auth/logout').catch(function () {}).then(function () { сессия = null; ls.del(K_SESS); вход('Вы вышли.'); }); }
  });
  addEventListener('hashchange', показать); addEventListener('resize', показать);
  var старт = тгДанные && !сессия
    ? зов('POST', '/auth/telegram/webapp', { initData: тгДанные }).then(function (r) { if (r.st === 200 && r.j && r.j.session) { сессия = r.j.session; ls.set(K_SESS, сессия); } }).catch(function () {})
    : Promise.resolve();
  старт.then(function () { return сессия ? зов('GET', '/api/me').then(function (r) { if (r.st === 200) me = r.j; }) : null; }).then(загрузить);
  setInterval(загрузить, 60e3);
})(typeof window !== 'undefined' ? window : globalThis);
