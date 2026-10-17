/* Витрина переехала в терминал (17.10.2026): вкладка «Кейсы». Адрес сохраняет параметры и фрагмент — вход из мини-приложения
 * Telegram (#tgWebAppData=…) читает терминал. Без фрагмента — сразу на Кейсы. */
(function () { try { var h = location.hash || '#кейсы'; location.replace('scalpsniper.html' + location.search + h); } catch (e) {} })();
