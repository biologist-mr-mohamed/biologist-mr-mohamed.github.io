/* منطق صفحة عدم الاتصال - v5.0.0 */

(function () {
  'use strict';

  // ==== 1. الثوابت ====
  const THEME_KEY = 'biologist_theme';
  const COLOR_KEY = 'biologist_color_theme';
  const COLORS = ['blue', 'pink', 'green', 'purple', 'orange'];
  const DEFAULT_COLOR = 'blue';
  const PROBE_URL = 'https://www.gstatic.com/generate_204';
  const PROBE_TIMEOUT_MS = 4000;
  const RELOAD_DELAY_MS = 1200;
  const RELOAD_GUARD_KEY = 'biologist_offline_last_reload';
  const RELOAD_GUARD_MS = 15000;

  const TEXT = {
    offline: 'يبدو أن اتصالك انقطع. تحقق من الواي فاي أو بيانات الجوال ثم حاول مرة أخرى. المحتوى الذي زرته من قبل متاح دون اتصال.',
    stillOffline: 'لا يزال الجهاز غير متصل. تأكد من تفعيل الإنترنت ثم حاول مجدداً.',
    restored: 'تم استعادة الاتصال! جاري إعادة تحميل الصفحة...',
    statusOffline: 'غير متصل',
    statusChecking: 'جاري التحقق من الاتصال...',
    statusOnline: 'الاتصال متاح'
  };

  // ==== 2. عناصر الصفحة ====
  const els = {
    message: document.getElementById('offline-message'),
    status: document.getElementById('offline-status'),
    retry: document.getElementById('offline-retry'),
    meta: document.getElementById('theme-color-meta')
  };

  let reloadTimer = null;
  let checking = false;

  // ==== 3. التخزين الآمن ====
  function readStorage(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  // ==== 4. تحديد الوضع الليلي والنهاري ====
  function resolveTheme() {
    const saved = readStorage(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  // ==== 5. تحديث لون شريط الحالة ====
  function updateMetaThemeColor(theme) {
    if (!els.meta) return;
    const token = theme === 'dark' ? '--background-light' : '--primary';
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (value) els.meta.content = value;
  }

  // ==== 6. تفعيل الثيم الملون ====
  function applyColorTheme(color, theme) {
    const links = COLORS.map(function (c) {
      return { color: c, link: document.querySelector('link[href*="theme-' + c + '.css"]') };
    });
    const active = links.find(function (item) { return item.color === color; });

    COLORS.forEach(function (c) { document.body.classList.remove('theme-' + c); });
    document.body.classList.add('theme-' + color);
    if (!active || !active.link) return;

    const finish = function () {
      links.forEach(function (item) {
        if (item.link && item.link !== active.link) item.link.disabled = true;
      });
      updateMetaThemeColor(theme);
    };

    const wasDisabled = active.link.disabled;
    active.link.disabled = false;
    if (!wasDisabled || active.link.sheet) { finish(); return; }

    let done = false;
    const once = function () { if (done) return; done = true; finish(); };
    active.link.addEventListener('load', once, { once: true });
    active.link.addEventListener('error', once, { once: true });
    setTimeout(once, 3000);
  }

  // ==== 7. تطبيق الثيم الكامل ====
  function applyTheme() {
    const theme = resolveTheme();
    const savedColor = readStorage(COLOR_KEY);
    const color = COLORS.indexOf(savedColor) !== -1 ? savedColor : DEFAULT_COLOR;
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
    applyColorTheme(color, theme);
  }

  // ==== 8. تحديث الواجهة ====
  function setStatus(text, online) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.setAttribute('data-online', online ? 'true' : 'false');
  }

  function setMessage(text) {
    if (els.message) els.message.textContent = text;
  }

  // ==== 9. فحص الاتصال الفعلي ====
  function probeConnection() {
    if (!navigator.onLine) return Promise.resolve(false);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(function () { if (controller) controller.abort(); }, PROBE_TIMEOUT_MS);
    return fetch(PROBE_URL, { mode: 'no-cors', cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function () { return true; })
      .catch(function () { return false; })
      .finally(function () { clearTimeout(timer); });
  }

  // ==== 10. حارس إعادة التحميل التلقائي ====
  function canAutoReload() {
    try {
      const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
      return Date.now() - last > RELOAD_GUARD_MS;
    } catch (e) { return true; }
  }

  function markAutoReload() {
    try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch (e) { }
  }

  // ==== 11. التحقق وإعادة التحميل ====
  function checkAndRecover() {
    if (checking) return;
    checking = true;
    setStatus(TEXT.statusChecking, false);

    probeConnection().then(function (online) {
      checking = false;
      if (!online) {
        setStatus(TEXT.statusOffline, false);
        setMessage(TEXT.offline);
        return;
      }
      setStatus(TEXT.statusOnline, true);
      if (!canAutoReload()) return;
      setMessage(TEXT.restored);
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(function () {
        markAutoReload();
        window.location.reload();
      }, RELOAD_DELAY_MS);
    });
  }

  // ==== 12. إعادة المحاولة اليدوية ====
  function handleRetry() {
    if (navigator.onLine) {
      window.location.reload();
      return;
    }
    setMessage(TEXT.stillOffline);
    setStatus(TEXT.statusOffline, false);
    setTimeout(function () { if (!navigator.onLine) setMessage(TEXT.offline); }, 2500);
  }

  // ==== 13. التهيئة ====
  function init() {
    try { applyTheme(); } catch (e) { }
    if (els.retry) els.retry.addEventListener('click', handleRetry);
    window.addEventListener('online', checkAndRecover);
    window.addEventListener('offline', function () {
      clearTimeout(reloadTimer);
      setStatus(TEXT.statusOffline, false);
      setMessage(TEXT.offline);
    });
    if (navigator.onLine) checkAndRecover();
  }

  init();
})();
