/* Service Worker للتخزين المؤقت وإشعارات Push - v5.0.0 */

// ==== 1. الإصدار والثوابت ====
const CACHE_VERSION = 'v5.0.1';
const STATIC_CACHE = `biologist-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `biologist-dynamic-${CACHE_VERSION}`;
const IMAGES_CACHE = `biologist-images-${CACHE_VERSION}`;
const VENDOR_CACHE = `biologist-vendor-${CACHE_VERSION}`;
const ALL_CACHES = [STATIC_CACHE, DYNAMIC_CACHE, IMAGES_CACHE, VENDOR_CACHE];
const OFFLINE_URL = '/offline.html';
const SHELL_URL = '/';
const MAX_CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
const DYNAMIC_MAX_ENTRIES = 60;
const IMAGES_MAX_ENTRIES = 80;
const VENDOR_MAX_ENTRIES = 80;
const NETWORK_TIMEOUT_MS = 4000;

// ==== 2. الملفات الأساسية ====
const CRITICAL_ASSETS = [
  '/',
  OFFLINE_URL
];

// ==== 3. الملفات الثابتة ====
const STATIC_ASSETS = [
  '/index.html',
  '/manifest.json',
  '/css/variables.css',
  '/css/main.css',
  '/css/layout.css',
  '/css/components.css',
  '/css/animations.css',
  '/css/notifications.css',
  '/css/layout/preloader.css',
  '/css/layout/drawer.css',
  '/css/layout/navbar.css',
  '/css/layout/directing.css',
  '/css/layout/modals.css',
  '/css/layout/announcements.css',
  '/css/themes/theme-blue.css',
  '/css/themes/theme-pink.css',
  '/css/themes/theme-green.css',
  '/css/themes/theme-purple.css',
  '/css/themes/theme-orange.css',
  '/js/main.js',
  '/js/core/api.js',
  '/js/core/firebase.js',
  '/js/core/theme.js',
  '/js/core/router.js',
  '/js/core/session.js',
  '/js/core/event-bus.js',
  '/js/ui/animations.js',
  '/js/utils/avatar.js',
  '/js/ui/drawer.js',
  '/js/ui/modals.js',
  '/js/ui/notifications.js',
  '/js/ui/navbar.js',
  '/js/ui/search.js',
  '/js/ui/directing.js',
  '/js/ui/offline.js',
  '/js/ui/preloader-logo.js',
  '/js/ui/logo-animation.js',
  '/js/ui/announcements.js',
  '/views/lessons/lesson-manager.js',
  '/views/exams/exam-manager.js',
  '/views/home/home.html',
  '/views/home/home.css',
  '/views/home/home.js',
  '/views/auth/login.html',
  '/views/auth/register.html',
  '/views/auth/auth.css',
  '/views/auth/auth.js',
  '/views/error/404.html',
  '/views/error/404.css',
  '/views/error/404.js',
  '/views/profile/profile.html',
  '/views/profile/profile.css',
  '/views/profile/profile.js',
  '/views/settings/settings.html',
  '/views/settings/settings.css',
  '/views/settings/settings.js',
  '/views/lessons/lessons.html',
  '/views/lessons/lesson-view.html',
  '/views/lessons/lessons.css',
  '/views/lessons/lessons.js',
  '/views/exams/exams.html',
  '/views/exams/exam-view.html',
  '/views/exams/exams.css',
  '/views/exams/exams.js',
  '/views/groups/groups.html',
  '/views/groups/group-view.html',
  '/views/groups/groups.css',
  '/views/groups/groups.js',
  '/views/dashboard/dashboard.html',
  '/views/dashboard/dashboard.css',
  '/views/dashboard/dashboard.js',
  '/views/saved/saved.html',
  '/views/saved/saved.css',
  '/views/saved/saved.js',
  '/assets/images/biologist.png',
  '/assets/images/biologist1.png',
  '/assets/images/biologist1-192.png',
  '/assets/images/biologist1.svg',
  '/assets/images/badge-96.png',
  '/assets/images/shortcuts/lessons.png',
  '/assets/images/shortcuts/exams.png',
  '/assets/images/shortcuts/groups.png',
  '/assets/images/shortcuts/profile.png',
  '/assets/images/biologist2.png',
  '/assets/images/biologist3.png',
  '/assets/images/biologist4.png',
  '/assets/images/M.png',
  '/assets/images/G.png',
  '/assets/avatars/directing/avatars_directing.png',
  '/assets/avatars/badges/medals.png',
  '/assets/avatars/jobs/avatars_male.png',
  '/assets/avatars/jobs/avatars_female.png',
  '/assets/icons/bacteria-6colors.svg',
  '/assets/icons/cell-6colors.svg',
  '/assets/icons/dna-helix-9colors.svg',
  '/assets/icons/molecule-4colors.svg',
  '/assets/icons/logo_icons/teal_mask.png',
  '/assets/icons/logo_icons/dark_mask.png',
  '/assets/icons/logo_icons/word_teal_mask.png',
  '/assets/icons/logo_icons/word_dark_mask.png'
];

// مجموعة البحث السريع عن الملفات المخزّنة مسبقًا
const STATIC_SET = new Set([...CRITICAL_ASSETS, ...STATIC_ASSETS]);

// أنواع الطلبات التي تمثل كود التطبيق ولا يجوز طردها من المخبأ
const CODE_DESTINATIONS = ['script', 'style', 'font', 'manifest', 'worker'];

// ==== 4. المصادر الخارجية المسموح تخزينها ====
const VENDOR_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com'
];

// ==== 5. دوال مساعدة ====
function isNavigation(request) {
  return request.mode === 'navigate' || request.destination === 'document';
}

function hasFileExtension(pathname) {
  return /\.[a-z0-9]+$/i.test(pathname);
}

function isApiRequest(url) {
  return url.pathname.includes('/api/');
}

function isCacheable(response) {
  return Boolean(response) &&
         response.status === 200 &&
         (response.type === 'basic' || response.type === 'cors');
}

// الملف المخزّن مسبقًا يبقى دائمًا في مخبأ واحد فقط
function cacheNameFor(url, fallbackName) {
  return STATIC_SET.has(url.pathname) && !url.search ? STATIC_CACHE : fallbackName;
}

function resolveSafeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : `${self.location.origin}/`;
  } catch (error) {
    return `${self.location.origin}/`;
  }
}

// إزالة علامة إعادة التوجيه حتى يُقبل الرد في التنقل
async function cleanResponse(response) {
  if (!response || !response.redirected) return response;
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

async function putInCache(cacheName, request, response, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
    if (cacheName !== STATIC_CACHE && Number.isFinite(maxEntries)) {
      await trimCache(cacheName, maxEntries);
    }
  } catch (error) {
    console.warn('[SW] تعذر الحفظ في المخبأ:', cacheName, error);
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

async function cleanExpiredCache(cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    const now = Date.now();
    let deletedCount = 0;
    for (const request of requests) {
      const response = await cache.match(request);
      const dateHeader = response && response.headers.get('date');
      if (!dateHeader) continue;
      if (now - new Date(dateHeader).getTime() > MAX_CACHE_AGE) {
        await cache.delete(request);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`[SW] تم حذف ${deletedCount} مدخلة قديمة من ${cacheName}`);
    }
  } catch (error) {
    console.warn('[SW] فشل تنظيف المخبأ القديم:', error);
  }
}

async function offlineFallback(request) {
  if (isNavigation(request)) {
    const appShell = (await caches.match(SHELL_URL)) || (await caches.match('/index.html'));
    if (appShell) return cleanResponse(appShell);
    const offlinePage = await caches.match(OFFLINE_URL);
    if (offlinePage) return cleanResponse(offlinePage);
  }
  if (isApiRequest(new URL(request.url))) {
    return new Response(JSON.stringify({ error: 'غير متصل بالإنترنت' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
  return new Response('غير متصل بالإنترنت', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// ==== 6. تثبيت Service Worker ====
async function precache(cache, assets) {
  const results = await Promise.allSettled(
    assets.map((asset) => cache.add(new Request(asset, { cache: 'reload' })))
  );
  return assets.filter((asset, index) => results[index].status === 'rejected');
}

self.addEventListener('install', (event) => {
  console.log('[SW] تثبيت الإصدار', CACHE_VERSION);
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cache.addAll(CRITICAL_ASSETS.map((asset) => new Request(asset, { cache: 'reload' })));
      let failed = await precache(cache, STATIC_ASSETS);
      if (failed.length > 0) {
        console.warn(`[SW] فشل تخزين ${failed.length} ملف، إعادة المحاولة...`);
        failed = await precache(cache, failed);
      }
      if (failed.length > 0) {
        console.warn(`[SW] تعذر تخزين ${failed.length} ملف:`, failed);
      }
      console.log('[SW] تم التثبيت بنجاح');
    })()
  );
});

// ==== 7. تنشيط وتنظيف المخابئ ====
self.addEventListener('activate', (event) => {
  console.log('[SW] تنشيط الإصدار', CACHE_VERSION);
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((cacheName) => !ALL_CACHES.includes(cacheName))
          .map((cacheName) => caches.delete(cacheName))
      );
      await Promise.all([
        cleanExpiredCache(DYNAMIC_CACHE),
        cleanExpiredCache(IMAGES_CACHE),
        cleanExpiredCache(VENDOR_CACHE)
      ]);
      await self.clients.claim();
      console.log('[SW] تم التنشيط والسيطرة على الصفحات');
    })()
  );
});

// ==== 8. استراتيجية Network First مع مهلة ====
async function respondNetworkFirst(event, networkPromise, getCached) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([networkPromise, timeout]);
    if (response && response.status < 500) return response;

    const cached = await getCached();
    if (cached) {
      if (!response) event.waitUntil(networkPromise.catch(() => undefined));
      return cached;
    }
    return response || (await networkPromise);
  } catch (error) {
    const cached = await getCached();
    return cached || offlineFallback(event.request);
  } finally {
    clearTimeout(timer);
  }
}

function networkFirst(event, cacheName, maxEntries) {
  const request = event.request;
  const networkPromise = fetch(request).then((response) => {
    if (isCacheable(response)) {
      event.waitUntil(putInCache(cacheName, request, response.clone(), maxEntries));
    }
    return response;
  });
  return respondNetworkFirst(event, networkPromise, () => caches.match(request));
}

// ==== 9. استراتيجية التنقل (صدفة التطبيق) ====
function handleNavigation(event) {
  const request = event.request;
  const url = new URL(request.url);
  const isShellRoute = !hasFileExtension(url.pathname);

  const networkPromise = fetch(request).then((response) => {
    if (url.pathname === '/' && isCacheable(response)) {
      event.waitUntil(putInCache(STATIC_CACHE, SHELL_URL, response.clone()));
    }
    return response;
  });

  const getCached = async () => {
    const cached = isShellRoute
      ? (await caches.match(SHELL_URL)) || (await caches.match('/index.html'))
      : await caches.match(request, { ignoreSearch: true });
    return cleanResponse(cached);
  };

  return respondNetworkFirst(event, networkPromise, getCached);
}

// ==== 10. استراتيجية Stale-While-Revalidate ====
async function staleWhileRevalidate(event, cacheName, maxEntries, allowOpaque = false) {
  const request = event.request;
  const url = new URL(request.url);
  const targetCache = cacheNameFor(url, cacheName);
  const cachedResponse = await caches.match(request);

  const networkPromise = fetch(request).then((response) => {
    // الردود المعتمة تُخزَّن فقط إن لم توجد نسخة سابقة
    const storable = isCacheable(response) ||
      (allowOpaque && !cachedResponse && response.type === 'opaque');
    if (storable) {
      event.waitUntil(putInCache(targetCache, request, response.clone(), maxEntries));
    }
    return response;
  });

  if (cachedResponse) {
    event.waitUntil(networkPromise.catch(() => undefined));
    return cachedResponse;
  }
  try {
    return await networkPromise;
  } catch (error) {
    return offlineFallback(request);
  }
}

// ==== 11. معالجة الطلبات ====
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin !== self.location.origin) {
    if (VENDOR_HOSTS.includes(url.hostname)) {
      event.respondWith(staleWhileRevalidate(event, VENDOR_CACHE, VENDOR_MAX_ENTRIES, true));
    }
    return;
  }

  if (url.pathname.startsWith('/__/')) return;

  if (isNavigation(request)) {
    event.respondWith(handleNavigation(event));
  } else if (url.pathname.startsWith('/views/') && request.destination !== 'image') {
    event.respondWith(networkFirst(event, cacheNameFor(url, DYNAMIC_CACHE), DYNAMIC_MAX_ENTRIES));
  } else if (url.pathname.startsWith('/js/') && request.destination === 'script') {
    event.respondWith(networkFirst(event, cacheNameFor(url, STATIC_CACHE), Infinity));
  } else if (request.destination === 'image') {
    event.respondWith(staleWhileRevalidate(event, IMAGES_CACHE, IMAGES_MAX_ENTRIES));
  } else if (isApiRequest(url)) {
    event.respondWith(networkFirst(event, DYNAMIC_CACHE, DYNAMIC_MAX_ENTRIES));
  } else if (CODE_DESTINATIONS.includes(request.destination) || STATIC_SET.has(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, STATIC_CACHE, Infinity));
  } else {
    event.respondWith(staleWhileRevalidate(event, DYNAMIC_CACHE, DYNAMIC_MAX_ENTRIES));
  }
});

// ==== 12. إشعارات Push ====
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (error) {
      data = { body: event.data.text() };
    }
  }
  if (!data || typeof data !== 'object') {
    data = { body: data ? String(data) : '' };
  }

  const notificationId = data.notificationId || Date.now();
  const title = typeof data.title === 'string' && data.title ? data.title : 'بيولوجست';
  const body = typeof data.body === 'string' && data.body
    ? data.body
    : 'لديك إشعار جديد من منصة بيولوجست';

  const options = {
    body,
    icon: '/assets/images/biologist1-192.png',
    badge: '/assets/images/badge-96.png',
    tag: String(notificationId),
    vibrate: [200, 100, 200],
    dir: 'rtl',
    lang: 'ar',
    data: {
      url: resolveSafeUrl(data.url),
      notificationId
    },
    actions: [
      { action: 'open', title: 'فتح' },
      { action: 'dismiss', title: 'تجاهل' }
    ]
  };

  // عرض الإشعار دائمًا حتى لا يظهر إشعار المتصفح الافتراضي
  event.waitUntil(
    self.registration.showNotification(title, options).catch((error) => {
      console.warn('[SW] تعذر عرض الإشعار:', error);
    })
  );
});

// ==== 13. النقر على الإشعار ====
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = resolveSafeUrl(event.notification.data && event.notification.data.url);

  event.waitUntil(
    (async () => {
      const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const sameOrigin = clientList.filter((client) => new URL(client.url).origin === self.location.origin);
      const target = sameOrigin.find((client) => client.visibilityState === 'visible') || sameOrigin[0];
      if (target) {
        try {
          const focused = (await target.focus()) || target;
          if (focused.url !== targetUrl && 'navigate' in focused) {
            await focused.navigate(targetUrl);
          }
          return;
        } catch (error) {
          console.warn('[SW] تعذر التركيز على النافذة الحالية:', error);
        }
      }
      if (clients.openWindow) await clients.openWindow(targetUrl);
    })()
  );
});

// ==== 14. التواصل مع الصفحة ====
self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (type === 'CLEANUP') {
    event.waitUntil(
      caches.keys().then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => !ALL_CACHES.includes(cacheName))
            .map((cacheName) => caches.delete(cacheName))
        )
      )
    );
  }
});
