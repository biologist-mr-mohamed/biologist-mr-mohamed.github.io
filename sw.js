/* Service Worker للتخزين المؤقت وإشعارات Push - v5.0.0 */

// ==== 1. الإصدار والثوابت ====
const CACHE_VERSION = 'v5.0.5';
const STATIC_CACHE = `biologist-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `biologist-dynamic-${CACHE_VERSION}`;
const IMAGES_CACHE = `biologist-images-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline.html';
const MAX_CACHE_AGE = 30 * 24 * 60 * 60 * 1000;

// ==== 2. الملفات الثابتة ====
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
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
  '/assets/images/biologist.png',
  '/assets/images/biologist1.png',
  '/assets/images/biologist2.png',
  '/assets/images/biologist3.png',
  '/assets/images/biologist4.png',
  '/assets/images/M.png',
  '/assets/images/G.png',
  '/assets/avatars/directing/avatars_directing.png',
  '/assets/avatars/badges/medals.png',
  '/assets/avatars/jobs/avatars_male.png',
  '/assets/avatars/jobs/avatars_female.png',
  '/assets/icons/logo_icons/teal_mask.png',
  '/assets/icons/logo_icons/dark_mask.png',
  '/assets/icons/logo_icons/word_teal_mask.png',
  '/assets/icons/logo_icons/word_dark_mask.png'
];

// ==== 3. مسارات التجاهل ====
const IGNORE_PATTERNS = [
  /firestore\.googleapis\.com/,
  /firebase\.googleapis\.com/,
  /googleapis\.com/,
  /gstatic\.com/,
  /localhost.*\/__\/firebase/
];

// ==== 4. دوال مساعدة ====
function shouldIgnoreRequest(url) {
  return IGNORE_PATTERNS.some(pattern => pattern.test(url));
}

function isHtmlRequest(request) {
  return request.mode === 'navigate' ||
         request.destination === 'document' ||
         (request.headers.get('accept') && request.headers.get('accept').includes('text/html'));
}

function isApiRequest(url) {
  return url.pathname.startsWith('/api/') || url.pathname.includes('/api/');
}

// ==== 5. تثبيت Service Worker ====
self.addEventListener('install', (event) => {
  console.log('[SW] تثبيت الإصدار', CACHE_VERSION);
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(STATIC_CACHE);
        await Promise.allSettled(
          STATIC_ASSETS.map(async (asset) => {
            try {
              await cache.add(asset);
            } catch (err) {
              console.warn(`[SW] فشل إضافة ${asset}:`, err);
            }
          })
        );
        await self.skipWaiting();
        console.log('[SW] تم التثبيت بنجاح');
      } catch (error) {
        console.error('[SW] فشل التثبيت:', error);
      }
    })()
  );
});

// ==== 6. تنشيط وتنظيف المخابئ ====
self.addEventListener('activate', (event) => {
  console.log('[SW] تنشيط الإصدار', CACHE_VERSION);
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== STATIC_CACHE && cacheName !== DYNAMIC_CACHE && cacheName !== IMAGES_CACHE) {
            console.log('[SW] حذف المخبأ القديم:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
      await cleanExpiredCache(DYNAMIC_CACHE);
      await self.clients.claim();
      console.log('[SW] تم التنشيط والسيطرة على الصفحات');
    })()
  );
});

async function cleanExpiredCache(cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    const now = Date.now();
    let deletedCount = 0;
    for (const request of requests) {
      const response = await cache.match(request);
      if (response) {
        const dateHeader = response.headers.get('date');
        if (dateHeader) {
          const cachedDate = new Date(dateHeader).getTime();
          if (now - cachedDate > MAX_CACHE_AGE) {
            await cache.delete(request);
            deletedCount++;
          }
        }
      }
    }
    if (deletedCount > 0) {
      console.log(`[SW] تم حذف ${deletedCount} مدخلة قديمة من ${cacheName}`);
    }
  } catch (error) {
    console.warn('[SW] فشل تنظيف المخبأ القديم:', error);
  }
}

// ==== 7. استراتيجية Cache First ====
const cacheFirstWithRefresh = async (request) => {
  const cachedResponse = await caches.match(request);
  const fetchPromise = fetch(request).then(async (networkResponse) => {
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  }).catch(() => undefined);
  return cachedResponse || fetchPromise;
};

// ==== 8. استراتيجية Network First ====
const networkFirst = async (request) => {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request, { ignoreSearch: isHtmlRequest(request) });
    if (cachedResponse) return cachedResponse;

    if (isHtmlRequest(request)) {
      const appShell = (await caches.match('/index.html')) || (await caches.match('/'));
      if (appShell) return appShell;
      const offlinePage = await caches.match(OFFLINE_URL);
      return offlinePage || new Response('غير متصل بالإنترنت', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
    if (isApiRequest(new URL(request.url))) {
      return new Response(JSON.stringify({ error: 'غير متصل بالإنترنت' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('غير متصل بالإنترنت', { status: 503, statusText: 'Service Unavailable' });
  }
};

// ==== 9. استراتيجية Stale-While-Revalidate ====
const staleWhileRevalidate = async (request) => {
  const cachedResponse = await caches.match(request);
  const fetchPromise = fetch(request).then(async (networkResponse) => {
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(IMAGES_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  }).catch(() => undefined);
  return cachedResponse || fetchPromise;
};

// ==== 10. معالجة الطلبات ====
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const request = event.request;

  if (shouldIgnoreRequest(url)) {
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith('/views/') && request.destination !== 'image') {
    event.respondWith(networkFirst(request));
  }
  else if (request.destination === 'image') {
    event.respondWith(staleWhileRevalidate(request));
  }
  else if (
    STATIC_ASSETS.some(asset => url.pathname === asset) ||
    request.destination === 'style' ||
    request.destination === 'script' ||
    request.destination === 'font'
  ) {
    event.respondWith(cacheFirstWithRefresh(request));
  }
  else if (isHtmlRequest(request) || isApiRequest(url)) {
    event.respondWith(networkFirst(request));
  }
  else {
    event.respondWith(cacheFirstWithRefresh(request));
  }
});

// ==== 11. إشعارات Push ====
self.addEventListener('push', (event) => {
  if (!event.data) return;

  if (self.Notification.permission !== 'granted') {
    console.warn('[SW] صلاحية الإشعارات غير مفعلة');
    return;
  }

  let data;
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'بيولوجست', body: event.data.text() };
  }

  const options = {
    body: data.body || 'لديك إشعار جديد من منصة بيولوجست',
    icon: '/assets/images/biologist.png',
    badge: '/assets/images/biologist.png',
    vibrate: [200, 100, 200],
    dir: 'rtl',
    lang: 'ar',
    data: {
      url: data.url || '/',
      notificationId: data.notificationId || Date.now()
    },
    actions: [
      { action: 'open', title: 'فتح' },
      { action: 'dismiss', title: 'تجاهل' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'بيولوجست', options)
  );
});

// ==== 12. النقر على الإشعار ====
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';

  if (event.action === 'dismiss') {
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

// ==== 13. التواصل مع الصفحة ====
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEANUP') {
    caches.keys().then((cacheNames) => {
      cacheNames.forEach(cacheName => {
        if (cacheName !== STATIC_CACHE && cacheName !== DYNAMIC_CACHE && cacheName !== IMAGES_CACHE) {
          caches.delete(cacheName);
        }
      });
    });
  }
});