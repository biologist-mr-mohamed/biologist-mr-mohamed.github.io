/* نقطة دخول المنصة وتنسيق التهيئة - v5.0.0 */

// ==== 1. الاستيراد ====
import { initializeTheme, toggleTheme, getCurrentTheme, getCurrentColorTheme, applyUserPreferences } from './core/theme.js';
import { EventBus } from './core/event-bus.js';
import {
  initPreloaderLogo,
  finishPreloaderLogo,
  stopPreloaderLogo,
  PRELOADER_TIMING
} from './ui/preloader-logo.js';
import { updateUserStreak as updateUserStreakInFirestore } from './core/api.js';
import {
  initializeSession,
  getCurrentUser,
  setSession,
  clearSession,
  isAuthenticated,
  isStudent,
  isTeacher,
  isModerator
} from './core/session.js';

// ==== 2. تكوين التطبيق ====
export const APP_CONFIG = {
  VERSION: '5.0.0',
  NAME: 'بيولوجست',
  DEBUG: false,
  MAX_INIT_ATTEMPTS: 3,
  INIT_TIMEOUT: 30000,
  FIREBASE_TIMEOUT: 10000,
  API_TIMEOUT: 10000,
  UI_COMPONENTS_TIMEOUT: 15000,
  PREFETCH_ROUTES: ['/lessons', '/exams'],
  MAX_EVENT_LISTENERS: 25,
  IMMUTABLE_MODE: true,
  COMPONENT_RETRY_DELAY: 2000,
  COMPONENT_MAX_RETRIES: 2
};

if (typeof window !== 'undefined') {
  window.APP_CONFIG = APP_CONFIG;
}

// ==== 3. وضع التصحيح ====
if (typeof window !== 'undefined' && window.location) {
  const isLocalhost =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname.includes('192.168.');
  APP_CONFIG.DEBUG = isLocalhost;
}

// ==== 4. تتبع الأخطاء ====
const ErrorTracker = (() => {
  const errors = [];

  function capture(error, context = {}) {
    const errorObj = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`,
      message: error.message || String(error),
      stack: error.stack,
      context,
      timestamp: new Date().toISOString(),
      user: AppStore?.getUser()?.id || 'anonymous'
    };
    errors.push(errorObj);
    if (APP_CONFIG.DEBUG) {
      console.error('[ErrorTracker]', errorObj);
    }
    EventBus.emit('app:error', errorObj);
    return errorObj;
  }

  function getErrors() { return [...errors]; }
  function clearErrors() { errors.length = 0; }

  return { capture, getErrors, clearErrors };
})();

// ==== 5. إتاحة ErrorTracker عالميًا ====
window.ErrorTracker = ErrorTracker;

// ==== 6. الـ Store المركزي ====
const AppStore = (() => {
  let _state = {
    ready: false,
    user: null,
    appState: {
      online: navigator.onLine,
      theme: 'light',
      colorTheme: 'blue',
      language: 'ar',
      notifications: true
    },
    app: {
      version: APP_CONFIG.VERSION,
      name: APP_CONFIG.NAME,
      initialized: false,
      errors: []
    },
    initAttempts: 0,
    initStartTime: Date.now(),
    componentsStatus: new Map()
  };

  const listeners = new Set();

  function deepFreeze(obj) {
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
      Object.freeze(obj);
      Object.values(obj).forEach(deepFreeze);
    }
    return obj;
  }

  function cloneState(source) {
    try {
      if (source instanceof Map) return new Map(source);
      return window.structuredClone
        ? window.structuredClone(source)
        : JSON.parse(JSON.stringify(source));
    } catch {
      return { ...source };
    }
  }

  function getState() {
    return APP_CONFIG.IMMUTABLE_MODE ? deepFreeze(cloneState(_state)) : cloneState(_state);
  }

  function get(key) {
    const value = _state[key];
    return APP_CONFIG.IMMUTABLE_MODE && value && typeof value === 'object'
      ? deepFreeze(cloneState(value))
      : value;
  }

  function set(key, value) {
    const newValue = (value && typeof value === 'object') ? cloneState(value) : value;
    _state = { ..._state, [key]: newValue };
    listeners.forEach(fn => fn(key, newValue, _state[key]));
  }

  function update(updates) {
    const newState = { ..._state };
    Object.assign(newState, updates);
    _state = newState;
    listeners.forEach(fn => fn(null, _state, null));
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getUser() {
    return _state.user ? cloneState(_state.user) : null;
  }

  function getAppState() {
    return cloneState(_state.appState);
  }

  return { getState, get, set, update, subscribe, getUser, getAppState };
})();

// ==== 7. نظام Lifecycle ====
const Lifecycle = (() => {
  let status = 'uninitialized';
  const hooks = {
    beforeInit: [],
    afterCoreInit: [],
    afterUIInit: [],
    onReady: [],
    onError: []
  };

  function register(hook, callback) {
    if (hooks[hook]) hooks[hook].push(callback);
    else console.warn(`[Lifecycle] Hook غير معروف: ${hook}`);
  }

  async function runHook(hook, ...args) {
    if (!hooks[hook]) return;
    for (const cb of hooks[hook]) {
      try {
        await cb(...args);
      } catch (e) {
        ErrorTracker.capture(e, { hook, args });
      }
    }
  }

  function setStatus(newStatus) {
    status = newStatus;
    EventBus.emit('lifecycle:change', { status: newStatus });
  }

  return { register, runHook, setStatus, getStatus: () => status };
})();

// ==== 8. نظام Plugins ====
const PluginManager = (() => {
  const plugins = [];

  function use(plugin, options = {}) {
    if (!plugin || typeof plugin !== 'object' || !plugin.name) {
      console.error('[PluginManager] الـ plugin يجب أن يكون كائنًا يحتوي على خاصية name');
      return false;
    }
    if (plugins.find(p => p.name === plugin.name)) {
      console.warn(`[PluginManager] Plugin ${plugin.name} تم تسجيله مسبقاً`);
      return false;
    }
    try {
      if (plugin.install) plugin.install({ AppStore, EventBus, ErrorTracker, Lifecycle, options });
      if (plugin.onInit) plugin.onInit({ AppStore, EventBus, ErrorTracker, Lifecycle, options });
      plugins.push(plugin);
      console.log(`[PluginManager] تم تسجيل plugin: ${plugin.name}`);
      return true;
    } catch (e) {
      ErrorTracker.capture(e, { plugin: plugin.name });
      return false;
    }
  }

  function destroyAll() {
    plugins.forEach(plugin => {
      try {
        if (plugin.onDestroy) plugin.onDestroy();
      } catch (e) {
        ErrorTracker.capture(e, { plugin: plugin.name, action: 'onDestroy' });
      }
    });
    plugins.length = 0;
  }

  return { use, getPlugins: () => [...plugins], destroyAll };
})();

// ==== 9. دوال مساعدة ====
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateCurrentYear() {
  const yearElement = document.getElementById('current-year');
  if (yearElement) yearElement.textContent = new Date().getFullYear();
}

function addPrefetchLinks() {
  APP_CONFIG.PREFETCH_ROUTES.forEach(route => {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = route;
    link.as = 'document';
    document.head.appendChild(link);
  });
}

// ==== 10. أداة الانتظار ====
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==== 11. شريط تقدم Preloader ====
const PreloaderProgress = (() => {
  const TRICKLE_INTERVAL_MS = 280;
  const TRICKLE_AHEAD = 6;
  const TRICKLE_MAX = 94;
  const SWAP_MS = 160;

  let target = 0;
  let shown = 0;
  let trickleTimer = null;
  const swapTimers = new Map();

  function render() {
    const bar = document.getElementById('preloader-progress');
    const container = bar?.closest('[role="progressbar"]');
    const percentEl = document.getElementById('preloader-percent');
    if (bar) bar.style.setProperty('--pl-progress', shown.toFixed(2));
    if (container) container.setAttribute('aria-valuenow', Math.round(target));
    if (percentEl) percentEl.textContent = `${Math.round(shown)}%`;
  }

  function startTrickle() {
    if (trickleTimer) return;
    trickleTimer = setInterval(() => {
      const cap = Math.min(target + TRICKLE_AHEAD, TRICKLE_MAX);
      if (shown < cap) {
        shown = Math.min(cap, shown + Math.max(0.15, (cap - shown) * 0.06));
        render();
      }
    }, TRICKLE_INTERVAL_MS);
  }

  function stopTrickle() {
    if (trickleTimer) {
      clearInterval(trickleTimer);
      trickleTimer = null;
    }
  }

  function setProgress(percent) {
    target = Math.min(100, Math.max(0, percent));
    shown = target >= shown || target < shown - 10 ? target : shown;
    render();
    if (target < 100) startTrickle();
    else stopTrickle();
  }

  function swapText(el, value, key) {
    if (!el || el.textContent === value) return;
    el.classList.add('is-swapping');
    clearTimeout(swapTimers.get(key));
    swapTimers.set(key, setTimeout(() => {
      el.textContent = value;
      el.classList.remove('is-swapping');
    }, SWAP_MS));
  }

  function setText(text, subtext) {
    const statusEl = document.getElementById('preloader-status-text');
    const subtextEl = document.getElementById('preloader-subtext');
    if (text) swapText(statusEl, text, 'status');
    if (subtext !== undefined) swapText(subtextEl, subtext, 'subtext');
  }

  function complete(text) {
    setProgress(100);
    if (text) setText(text, '');
  }

  return { setProgress, setText, complete };
})();

// ==== 12. شاشة التحميل ====
const Preloader = {
  element: null,
  _shownAt: 0,
  _hiding: false,

  init() {
    this.element = document.getElementById('app-preloader');
  },

  show() {
    if (!this.element) return;
    this.element.classList.remove('preloader-hidden');
    this.element.classList.add('preloader-visible');
    this.element.setAttribute('aria-hidden', 'false');
    this.element.setAttribute('aria-busy', 'true');
    this.element.setAttribute('data-preloader-state', 'loading');
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.classList.add('content-loading');

    if (!this._shownAt) this._shownAt = performance.now();
    initPreloaderLogo(this.element);
  },

  async hide() {
    if (!this.element || this._hiding) return;
    this._hiding = true;

    try {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const minVisible = reduced
        ? PRELOADER_TIMING.MIN_VISIBLE_REDUCED_MS
        : PRELOADER_TIMING.MIN_VISIBLE_MS;
      const remaining = minVisible - (performance.now() - this._shownAt);
      if (remaining > 0) await wait(remaining);

      PreloaderProgress.complete('تم التحميل بنجاح!');
      await wait(PRELOADER_TIMING.COMPLETE_HOLD_MS);

      finishPreloaderLogo();
      this.element.classList.add('preloader-fade-out');
      this.element.setAttribute('aria-busy', 'false');
      const mainContent = document.getElementById('main-content');
      if (mainContent) {
        mainContent.classList.remove('content-loading');
        mainContent.classList.add('content-ready');
      }
      await wait(PRELOADER_TIMING.EXIT_MS);

      this.element.classList.add('preloader-hidden');
      this.element.classList.remove('preloader-visible', 'preloader-fade-out');
      this.element.setAttribute('aria-hidden', 'true');
      this.element.setAttribute('data-preloader-state', 'hidden');
      document.body.style.overflow = '';
      stopPreloaderLogo();
    } catch (err) {
      console.error('[Preloader] فشل تسلسل الإخفاء:', err);
      this.element.classList.add('preloader-hidden');
      this.element.classList.remove('preloader-visible', 'preloader-fade-out');
      const mainContent = document.getElementById('main-content');
      if (mainContent) {
        mainContent.classList.remove('content-loading');
        mainContent.classList.add('content-ready');
      }
    } finally {
      this._hiding = false;
    }
  },

  showError(error) {
    if (!this.element) return;
    stopPreloaderLogo();
    this.element.setAttribute('aria-busy', 'false');
    while (this.element.firstChild) this.element.removeChild(this.element.firstChild);

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-initialization';
    errorDiv.setAttribute('role', 'alert');

    const errorIcon = document.createElement('div');
    errorIcon.className = 'error-icon';
    const icon = document.createElement('i');
    icon.className = 'fas fa-exclamation-triangle';
    icon.setAttribute('aria-hidden', 'true');
    errorIcon.appendChild(icon);

    const title = document.createElement('h2');
    title.textContent = 'عذراً، حدث خطأ في تحميل التطبيق';

    const errorMessage = document.createElement('p');
    errorMessage.className = 'error-message';
    errorMessage.textContent = error.message || 'خطأ غير معروف';

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'error-actions';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-primary retry-btn';
    const retryIcon = document.createElement('i');
    retryIcon.className = 'fas fa-redo';
    retryIcon.setAttribute('aria-hidden', 'true');
    retryBtn.appendChild(retryIcon);
    retryBtn.appendChild(document.createTextNode(' إعادة المحاولة (كامل)'));
    retryBtn.addEventListener('click', () => location.reload());

    const retryComponentsBtn = document.createElement('button');
    retryComponentsBtn.type = 'button';
    retryComponentsBtn.className = 'btn btn-secondary retry-components-btn';
    const compIcon = document.createElement('i');
    compIcon.className = 'fas fa-sync-alt';
    compIcon.setAttribute('aria-hidden', 'true');
    retryComponentsBtn.appendChild(compIcon);
    retryComponentsBtn.appendChild(document.createTextNode(' محاولة إصلاح المكونات الفاشلة'));
    retryComponentsBtn.addEventListener('click', async () => {
      retryComponentsBtn.disabled = true;
      retryComponentsBtn.textContent = 'جاري الإصلاح...';
      try {
        const failedComponents = [];
        for (const [name, status] of ComponentsManager.loaded.entries()) {
          if (status.status === 'failed') {
            failedComponents.push(name);
          }
        }
        if (failedComponents.length === 0) {
          alert('لا توجد مكونات فاشلة، حاول إعادة التحميل الكامل.');
          retryComponentsBtn.disabled = false;
          return;
        }
        let successCount = 0;
        for (const name of failedComponents) {
          const comp = window.__componentMap?.get(name);
          if (comp) {
            const result = await ComponentsManager.retryComponent(name, comp.importFn);
            if (result) successCount++;
          } else {
            console.warn(`[Preloader] لا يوجد مسار للمكون ${name}`);
          }
        }
        alert(`تم إصلاح ${successCount} من ${failedComponents.length} مكونات فاشلة. يُرجى تحديث الصفحة يدوياً إن لزم الأمر.`);
        retryComponentsBtn.disabled = false;
        retryComponentsBtn.innerHTML = '<i class="fas fa-sync-alt" aria-hidden="true"></i> محاولة إصلاح المكونات الفاشلة';
        if (successCount === failedComponents.length) {
          location.reload();
        }
      } catch (err) {
        console.error('[Preloader] فشل إصلاح المكونات:', err);
        alert('حدث خطأ أثناء محاولة الإصلاح، يرجى إعادة تحميل الصفحة.');
        retryComponentsBtn.disabled = false;
      }
    });

    const supportBtn = document.createElement('button');
    supportBtn.type = 'button';
    supportBtn.className = 'btn btn-secondary support-btn';
    const supportIcon = document.createElement('i');
    supportIcon.className = 'fas fa-envelope';
    supportIcon.setAttribute('aria-hidden', 'true');
    supportBtn.appendChild(supportIcon);
    supportBtn.appendChild(document.createTextNode(' الاتصال بالدعم'));
    supportBtn.addEventListener('click', () => {
      window.location.href = 'mailto:biologist.mr.mohamed@gmail.com?subject=خطأ في تحميل المنصة';
    });

    actionsDiv.appendChild(retryBtn);
    actionsDiv.appendChild(retryComponentsBtn);
    actionsDiv.appendChild(supportBtn);

    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'error-details';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'تفاصيل تقنية';
    const pre = document.createElement('pre');
    pre.textContent = error.stack || error.message;
    details.appendChild(summary);
    details.appendChild(pre);
    detailsDiv.appendChild(details);

    errorDiv.appendChild(errorIcon);
    errorDiv.appendChild(title);
    errorDiv.appendChild(errorMessage);
    errorDiv.appendChild(actionsDiv);
    errorDiv.appendChild(detailsDiv);

    this.element.appendChild(errorDiv);
    this.element.setAttribute('data-preloader-state', 'error');
    this.element.classList.remove('preloader-hidden');
    this.element.classList.add('preloader-visible');
  }
};

// ==== 13. التحميل الكسول للمكونات ====
const ComponentsManager = {
  loaded: new Map(),

  _resolveInitFn(componentName, module) {
    const namedKey = `initialize${componentName.charAt(0).toUpperCase() + componentName.slice(1)}`;
    if (typeof module[namedKey] === 'function') return module[namedKey];

    if (module.default && typeof module.default.initialize === 'function') {
      return module.default.initialize;
    }

    return null;
  },

  async load(componentName, importFn, forceReload = false) {
    const existing = this.loaded.get(componentName);
    if (existing && existing.status === 'loaded' && !forceReload) return true;

    const retries = existing?.retries || 0;
    if (retries >= APP_CONFIG.COMPONENT_MAX_RETRIES) {
      console.warn(`[Components] تجاوز عدد محاولات تحميل ${componentName}`);
      this.loaded.set(componentName, { status: 'failed', retries, error: existing?.error });
      return false;
    }

    this.loaded.set(componentName, { status: 'loading', retries: retries + 1 });

    try {
      const module = await importFn();
      const initFn = this._resolveInitFn(componentName, module);
      if (initFn && typeof initFn === 'function') {
        await initFn();
      }
      this.loaded.set(componentName, { status: 'loaded', module, retries: retries + 1 });
      console.log(`[Components] تم تحميل ${componentName}`);
      return true;
    } catch (error) {
      ErrorTracker.capture(error, { component: componentName, attempt: retries + 1 });
      this.loaded.set(componentName, { status: 'failed', retries: retries + 1, error });
      console.error(`[Components] فشل تحميل ${componentName}:`, error);
      return false;
    }
  },

  async loadAll(components) {
    const results = await Promise.allSettled(
      components.map(c => this.load(c.name, c.importFn))
    );
    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    console.log(`[Components] تم تحميل ${succeeded}/${components.length} مكون بنجاح`);
    return succeeded === components.length;
  },

  async retryComponent(componentName, importFn) {
    const existing = this.loaded.get(componentName);
    if (existing?.status === 'loaded') return true;
    if (existing?.retries >= APP_CONFIG.COMPONENT_MAX_RETRIES) return false;
    return this.load(componentName, importFn, true);
  },

  getComponentStatus(name) {
    return this.loaded.get(name);
  },

  isComponentReady(name) {
    return this.loaded.get(name)?.status === 'loaded';
  }
};

// ==== 14. تهيئة Firebase ====
async function initializeFirebase() {
  console.log('📡 تهيئة Firebase...');
  try {
    const { initializeFirebase: initFirebase } = await import('./core/firebase.js');
    await initFirebase();
    console.log('✅ Firebase initialized');
    PreloaderProgress.setProgress(25);
    PreloaderProgress.setText('تم الاتصال بقاعدة البيانات', 'جاري تهيئة طبقة البيانات...');
    return true;
  } catch (error) {
    ErrorTracker.capture(error, { context: 'initializeFirebase' });
    EventBus.emit('firebase:init-error', { error });
    console.error('❌ فشل تهيئة Firebase:', error);
    return false;
  }
}

// ==== 15. تهيئة API ====
async function initializeApi() {
  console.log('📡 تهيئة طبقة API...');
  try {
    const { initializeApi: initApi } = await import('./core/api.js');
    await initApi();
    console.log('✅ API layer initialized');
    PreloaderProgress.setProgress(45);
    PreloaderProgress.setText('تم تهيئة البيانات', 'جاري استعادة الجلسة...');
    return true;
  } catch (error) {
    ErrorTracker.capture(error, { context: 'initializeApi' });
    EventBus.emit('api:init-error', { error });
    console.error('❌ فشل تهيئة طبقة API:', error);
    return false;
  }
}

// ==== 16. تهيئة مكونات الواجهة ====
async function initializeUIComponents() {
  console.log('🎨 تهيئة مكونات واجهة المستخدم...');
  PreloaderProgress.setText('تهيئة الواجهة', 'جاري تحميل المكونات...');

  const components = [
    { name: 'modals',        importFn: () => import('./ui/modals.js') },
    { name: 'animations',    importFn: () => import('./ui/animations.js') },
    { name: 'drawer',        importFn: () => import('./ui/drawer.js') },
    { name: 'notifications', importFn: () => import('./ui/notifications.js') },
    { name: 'search',        importFn: () => import('./ui/search.js') },
    { name: 'directing',     importFn: () => import('./ui/directing.js') },
    { name: 'navbar',        importFn: () => import('./ui/navbar.js') },
    { name: 'lessonManager', importFn: () => import('../views/lessons/lesson-manager.js') },
    { name: 'examManager',   importFn: () => import('../views/exams/exam-manager.js') }
  ];
window.__componentMap = new Map();
components.forEach(comp => window.__componentMap.set(comp.name, comp));
  const coreComponents = ['modals', 'animations'];
  const coreResults = await Promise.allSettled(
    coreComponents.map(name => {
      const comp = components.find(c => c.name === name);
      return comp ? ComponentsManager.load(comp.name, comp.importFn) : Promise.resolve(false);
    })
  );
  const coreSuccess = coreResults.every(r => r.status === 'fulfilled' && r.value === true);
  if (!coreSuccess) {
    console.warn('[Main] بعض المكونات الأساسية فشل تحميلها – قد تتعطل بعض الوظائف');
  }

  const otherComponents = components.filter(c => !coreComponents.includes(c.name));
  const otherResults = await Promise.allSettled(
    otherComponents.map(c => ComponentsManager.load(c.name, c.importFn))
  );

  const failed = otherResults.filter(
    r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value === false)
  );
  if (failed.length) {
    console.warn(`[Main] فشل تحميل ${failed.length} مكون ثانوي، سيتم إعادة المحاولة عند الحاجة`);
    failed.forEach((_, idx) => {
      const failedComp = otherComponents[idx];
      if (failedComp) AppStore.set(`component_${failedComp.name}_failed`, true);
    });
  }

  PreloaderProgress.setProgress(75);
  return true;
}

// ==== 17. تهيئة Router ====
async function initializeRouter() {
  console.log('🧭 تهيئة نظام التوجيه...');
  PreloaderProgress.setText('تهيئة التنقل', 'جاري تحميل الصفحات...');
  try {
    const { initializeRouter: initRouter } = await import('./core/router.js');
    await initRouter();
    console.log('✅ Router initialized');
    PreloaderProgress.setProgress(90);
    return true;
  } catch (error) {
    ErrorTracker.capture(error, { context: 'initializeRouter' });
    throw error;
  }
}

// ==== 18. الأحداث العامة ====
const _globalEventHandlers = {
  online: null,
  offline: null,
  click: null,
  error: null,
  unhandledrejection: null,
  userStateChanged: null
};

function setupGlobalEventListeners() {
  _globalEventHandlers.online = () => {
    AppStore.update({ appState: { ...AppStore.getAppState(), online: true } });
    EventBus.emit('app:online', {});
    if (window.modals?.toast) window.modals.toast('✅ اتصال بالإنترنت متاح', 'success');
  };

  _globalEventHandlers.offline = () => {
    AppStore.update({ appState: { ...AppStore.getAppState(), online: false } });
    EventBus.emit('app:offline', {});
    if (window.modals?.toast) window.modals.toast('⚠️ أنت غير متصل بالإنترنت', 'warning');
  };

  _globalEventHandlers.click = (e) => {
    const logoutBtn = e.target.closest('[data-action="logout"]');
    if (logoutBtn) {
      e.preventDefault();
      handleLogout();
      return;
    }

    const shareBtn = e.target.closest('[data-action="share-app"]');
    if (shareBtn) {
      e.preventDefault();
      handleShareApp();
      return;
    }

    const copyLinkBtn = e.target.closest('[data-action="copy-current-link"]');
    if (copyLinkBtn) {
      e.preventDefault();
      handleCopyCurrentLink();
      return;
    }
  };

  _globalEventHandlers.error = (event) => {
    ErrorTracker.capture(event.error || new Error(event.message), {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    });
  };

  _globalEventHandlers.unhandledrejection = (event) => {
    ErrorTracker.capture(event.reason, { type: 'unhandledrejection' });
  };

  _globalEventHandlers.userStateChanged = async (detail) => {
    const { action, user } = detail || {};
    if (action === 'login' && user) {
      AppStore.set('user', user);
      await applyUserThemeOnLogin(user);
      updateSidebarUserInfo(user);
    }
    if (action === 'logout') {
      AppStore.set('user', null);
      updateSidebarGuestMode();
    }
  };

  window.addEventListener('online', _globalEventHandlers.online);
  window.addEventListener('offline', _globalEventHandlers.offline);
  document.addEventListener('click', _globalEventHandlers.click);
  window.addEventListener('error', _globalEventHandlers.error);
  window.addEventListener('unhandledrejection', _globalEventHandlers.unhandledrejection);
  EventBus.on('userStateChanged', _globalEventHandlers.userStateChanged);
}

function removeGlobalEventListeners() {
  if (_globalEventHandlers.online)
    window.removeEventListener('online', _globalEventHandlers.online);
  if (_globalEventHandlers.offline)
    window.removeEventListener('offline', _globalEventHandlers.offline);
  if (_globalEventHandlers.click)
    document.removeEventListener('click', _globalEventHandlers.click);
  if (_globalEventHandlers.error)
    window.removeEventListener('error', _globalEventHandlers.error);
  if (_globalEventHandlers.unhandledrejection)
    window.removeEventListener('unhandledrejection', _globalEventHandlers.unhandledrejection);
  if (_globalEventHandlers.userStateChanged)
    EventBus.off('userStateChanged', _globalEventHandlers.userStateChanged);
}

// ==== 19. ثيم المستخدم عند الدخول ====
async function applyUserThemeOnLogin(user) {
  try {
    if (!user) return;
    applyUserPreferences(user);
  } catch (err) {
    console.warn('[Main] فشل تطبيق ثيم المستخدم:', err);
  }
}

// ==== 20. معلومات المستخدم في Sidebar ====
function updateSidebarUserInfo(user) {
  if (!user) return;

  document.body.setAttribute('data-auth', 'logged');
  document.body.setAttribute('data-role', user.user_type || 'student');

  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  const streakContainer = document.getElementById('sidebar-streak');
  const streakCount = document.getElementById('streak-count');

  if (nameEl) nameEl.textContent = user.full_name || user.username || 'المستخدم';
  if (roleEl) {
    const roleMap = { student: 'طالب', teacher: 'معلم', moderator: 'مشرف' };
    roleEl.textContent = roleMap[user.user_type] || 'طالب';
  }

  if (streakContainer && isStudent(user)) {
    streakContainer.removeAttribute('style');
    streakContainer.classList.remove('hidden');
    if (streakCount) streakCount.textContent = user.streak || 0;
  }

  const teacherOnlyEls = document.querySelectorAll('.teacher-only');
  const moderatorOnlyEls = document.querySelectorAll('.moderator-only');
  const teacherOrSupervisorEls = document.querySelectorAll('.teacher-or-supervisor-only');

  teacherOnlyEls.forEach(el => {
    if (isTeacher(user)) el.removeAttribute('style');
    else el.setAttribute('style', 'display:none');
  });
  moderatorOnlyEls.forEach(el => {
    if (isModerator(user)) el.removeAttribute('style');
    else el.setAttribute('style', 'display:none');
  });
  teacherOrSupervisorEls.forEach(el => {
    if (isTeacher(user) || isModerator(user)) el.removeAttribute('style');
    else el.setAttribute('style', 'display:none');
  });

  const guestContent = document.querySelector('.sidebar-guest');
  const loggedContent = document.querySelector('.sidebar-logged');
  if (guestContent) guestContent.setAttribute('style', 'display:none');
  if (loggedContent) {
    loggedContent.removeAttribute('aria-hidden');
    loggedContent.removeAttribute('style');
  }

  const modNotifTab = document.querySelector('.moderator-only-tab');
  const teacherNotifTab = document.querySelector('.teacher-only-tab');
  if (modNotifTab) {
    if (isModerator(user)) modNotifTab.removeAttribute('style');
    else modNotifTab.setAttribute('style', 'display:none');
  }
  if (teacherNotifTab) {
    if (isTeacher(user)) teacherNotifTab.removeAttribute('style');
    else teacherNotifTab.setAttribute('style', 'display:none');
  }
}

function updateSidebarGuestMode() {
  document.body.setAttribute('data-auth', 'guest');
  document.body.setAttribute('data-role', '');
  const guestContent = document.querySelector('.sidebar-guest');
  const loggedContent = document.querySelector('.sidebar-logged');
  if (guestContent) guestContent.removeAttribute('style');
  if (loggedContent) {
    loggedContent.setAttribute('aria-hidden', 'true');
    loggedContent.setAttribute('style', 'display:none');
  }
}

// ==== 21. تسجيل الخروج ====
async function handleLogout() {
  try {
    const confirmed = window.modals?.confirm
      ? await new Promise(resolve => {
          window.modals.confirm({
            title: 'تسجيل الخروج',
            message: 'هل أنت متأكد من تسجيل الخروج؟',
            confirmText: 'خروج',
            cancelText: 'إلغاء',
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false)
          });
        })
      : true;

    if (!confirmed) return;

    await clearSession();
    AppStore.set('user', null);
    EventBus.emit('user:logout', {});
    if (window.router?.navigateTo) {
      window.router.navigateTo('login', {}, { replace: true });
    }
  } catch (err) {
    ErrorTracker.capture(err, { context: 'handleLogout' });
    console.error('[Main] فشل تسجيل الخروج:', err);
  }
}

// ==== 22. مشاركة المنصة ====
async function handleShareApp() {
  const shareData = {
    title: 'منصة بيولوجست التعليمية',
    text: 'تعلم الأحياء بتجربة رقمية فريدة!',
    url: window.location.origin
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else {
      await navigator.clipboard.writeText(window.location.origin);
      if (window.modals?.toast) window.modals.toast('تم نسخ رابط المنصة', 'success');
    }
  } catch (err) {
    console.warn('[Main] فشل مشاركة المنصة:', err);
  }
}

// ==== 23. نسخ رابط الصفحة ====
async function handleCopyCurrentLink() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    if (window.modals?.toast) window.modals.toast('تم نسخ الرابط', 'success');
  } catch (err) {
    console.warn('[Main] فشل نسخ الرابط:', err);
  }
}

// ==== 24. إعداد PWA ====
function setupPWA() {
  if (!('serviceWorker' in navigator)) return;

  const registerSW = () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(registration => {
        console.log('✅ ServiceWorker registered with scope:', registration.scope);

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          console.log('🔄 New Service Worker found, updating...');
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              const showUpdateDialog = () => {
                if (window.modals?.confirm) {
                  window.modals.confirm({
                    title: 'تحديث متاح',
                    message: 'يتوفر تحديث جديد للمنصة. هل تريد التحديث الآن؟',
                    confirmText: 'تحديث',
                    cancelText: 'لاحقاً',
                    onConfirm: () => {
                      newWorker.postMessage({ type: 'SKIP_WAITING' });
                      window.location.reload();
                    }
                  });
                } else {
                  const handler = () => {
                    if (window.modals?.confirm) {
                      window.modals.confirm({
                        title: 'تحديث متاح',
                        message: 'يتوفر تحديث جديد للمنصة. هل تريد التحديث الآن؟',
                        confirmText: 'تحديث',
                        cancelText: 'لاحقاً',
                        onConfirm: () => {
                          newWorker.postMessage({ type: 'SKIP_WAITING' });
                          window.location.reload();
                        }
                      });
                      EventBus.off('modals:ready', handler);
                    }
                  };
                  EventBus.once('modals:ready', handler);
                  setTimeout(() => {
                    EventBus.off('modals:ready', handler);
                    if (confirm('يتوفر تحديث جديد للمنصة. هل تريد التحديث الآن؟')) {
                      newWorker.postMessage({ type: 'SKIP_WAITING' });
                      window.location.reload();
                    }
                  }, 5000);
                }
              };
              showUpdateDialog();
            }
          });
        });
      })
      .catch(error => console.log('⚠️ ServiceWorker registration failed:', error));
  };

  if (document.readyState === 'complete') registerSW();
  else window.addEventListener('load', registerSW, { once: true });
}

// ==== 25. نظام Streak ====
const STREAK_STORAGE_KEY = 'biologist_streak_data';

async function updateUserStreak() {
  const user = getCurrentUser();
  if (!user || !isStudent(user)) {
    console.log('[Streak] تم تخطي الـ Streak لأن المستخدم ليس طالباً.');
    return 0;
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const streakData = JSON.parse(localStorage.getItem(STREAK_STORAGE_KEY) || '{}');
    const userStreak = streakData[user.id] || { lastDate: null, count: 0 };

    let newCount = userStreak.count;
    let streakUpdated = false;

    if (userStreak.lastDate !== today) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      if (userStreak.lastDate === yesterdayStr) {
        newCount = userStreak.count + 1;
      } else {
        newCount = 1;
      }
      streakUpdated = true;

      streakData[user.id] = { lastDate: today, count: newCount };
      localStorage.setItem(STREAK_STORAGE_KEY, JSON.stringify(streakData));

      if (user.streak !== newCount) {
        const updatedUser = { ...user, streak: newCount };
        const rememberKey = 'biologist_remember_key';
        const isRemembered = localStorage.getItem(rememberKey) !== null;
        await setSession(updatedUser, isRemembered);
      }

      updateUserStreakInFirestore(user.id, newCount)
        .then(() => console.log(`[Streak] تمت المزامنة مع Firestore: ${newCount}`))
        .catch(err => {
          console.warn('[Streak] فشل مزامنة الـ Streak مع قاعدة البيانات:', err);
          EventBus.emit('streak:sync-failed', { userId: user.id, error: err });
        });

      const streakCountEl = document.getElementById('streak-count');
      if (streakCountEl) streakCountEl.textContent = newCount;
    }

    EventBus.emit('streak:updated', {
      userId: user.id,
      streak: newCount,
      updated: streakUpdated
    });

    return newCount;
  } catch (error) {
    console.error('[Streak] ❌ فشل تحديث الـ Streak:', error);
    EventBus.emit('streak:error', { userId: user.id, error });
    return user?.streak || 0;
  }
}

// ==== 26. المنسق الرئيسي للتهيئة ====
let _initializationLock = false;
let _globalAbortController = null;

async function initializeApp() {
  if (AppStore.get('ready') || _initializationLock) {
    console.log('[Main] التطبيق جاهز بالفعل أو جارٍ التهيئة');
    return;
  }
  _initializationLock = true;
  Lifecycle.setStatus('initializing');

  const currentAttempts = AppStore.get('initAttempts') + 1;
  AppStore.set('initAttempts', currentAttempts);

  if (currentAttempts > APP_CONFIG.MAX_INIT_ATTEMPTS) {
    Lifecycle.setStatus('error');
    const error = new Error('فشل تحميل التطبيق بعد عدة محاولات');
    ErrorTracker.capture(error);
    Preloader.showError(error);
    _initializationLock = false;
    return;
  }

  console.log(`🚀 بدء تهيئة ${APP_CONFIG.NAME} (محاولة ${currentAttempts}/${APP_CONFIG.MAX_INIT_ATTEMPTS})...`);

  Preloader.init();
  Preloader.show();
  updateCurrentYear();
  addPrefetchLinks();
  PreloaderProgress.setProgress(5);
  PreloaderProgress.setText('جاري تهيئة بيئة التعلم...', 'جاري الاتصال بقاعدة البيانات...');

  if (_globalAbortController) _globalAbortController.abort();
  _globalAbortController = new AbortController();
  const timeoutId = setTimeout(
    () => _globalAbortController.abort(),
    APP_CONFIG.INIT_TIMEOUT
  );
  const timeoutPromise = new Promise((_, reject) => {
    _globalAbortController.signal.addEventListener('abort', () => {
      reject(new Error('انتهت المهلة العامة لتهيئة التطبيق'));
    });
  });

  try {
    await Promise.race([
      (async () => {
        await Lifecycle.runHook('beforeInit');

        console.log('[Main] تهيئة نظام الثيم...');
        const themeResult = initializeTheme();
        AppStore.update({
          appState: {
            ...AppStore.getAppState(),
            theme: themeResult.theme,
            colorTheme: themeResult.colorTheme
          }
        });
        PreloaderProgress.setProgress(10);

        const firebaseSuccess = await initializeFirebase();
        if (!firebaseSuccess) throw new Error('فشل تهيئة Firebase');

        const apiSuccess = await initializeApi();
        if (!apiSuccess) throw new Error('فشل تهيئة طبقة API');

        await initializeSession();
        const user = getCurrentUser();
        AppStore.set('user', user);
        PreloaderProgress.setProgress(55);
        PreloaderProgress.setText('تم استعادة الجلسة', 'جاري تهيئة الواجهة...');

        if (user) {
          await applyUserThemeOnLogin(user);
          updateSidebarUserInfo(user);
          await updateUserStreak();
        } else {
          updateSidebarGuestMode();
        }

        await Lifecycle.runHook('afterCoreInit');

        console.log('[Main] تهيئة مكونات واجهة المستخدم...');
        await initializeUIComponents();
        await Lifecycle.runHook('afterUIInit');

        await initializeRouter();

        setupGlobalEventListeners();
        setupPWA();

        AppStore.set('ready', true);
        AppStore.update({ app: { ...AppStore.get('app'), initialized: true } });

        const initTime = Date.now() - AppStore.get('initStartTime');
        console.log(`✅ ${APP_CONFIG.NAME} initialized successfully in ${initTime}ms`);

        const preloaderHidden = Preloader.hide();

        await Lifecycle.runHook('onReady', { initTime });

        preloaderHidden.then(() => setTimeout(() => {
          if (!localStorage.getItem('biologist_welcome_shown')) {
            const userName = user?.full_name || user?.username;
            const message = userName
              ? `🎓 مرحباً ${escapeHtml(userName)} في منصة بيولوجست التعليمية`
              : '🎓 مرحباً بك في منصة بيولوجست التعليمية';
            if (window.modals?.toast) window.modals.toast(message, 'success', 5000);
            localStorage.setItem('biologist_welcome_shown', 'true');
          }
        }, 1000));

        EventBus.emit('app:ready', { initTime, user, theme: themeResult.theme });

        import('./ui/announcements.js')
          .then(({ initAnnouncements }) => initAnnouncements())
          .catch(err => console.warn('[Announcements] تعذّر تحميل الإعلانات:', err));
        Lifecycle.setStatus('initialized');
        clearTimeout(timeoutId);
      })(),
      timeoutPromise
    ]);
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('❌ فشل تهيئة التطبيق:', error);
    ErrorTracker.capture(error, { attempt: currentAttempts });
    Lifecycle.setStatus('error');
    await Lifecycle.runHook('onError', error);

    if (currentAttempts < APP_CONFIG.MAX_INIT_ATTEMPTS) {
      console.log(
        `🔄 إعادة محاولة التهيئة بعد 3 ثوانٍ... (محاولة ${currentAttempts + 1}/${APP_CONFIG.MAX_INIT_ATTEMPTS})`
      );
      setTimeout(() => {
        _initializationLock = false;
        initializeApp();
      }, 3000);
    } else {
      Preloader.showError(error);
    }
  } finally {
    _initializationLock = false;
    if (_globalAbortController) _globalAbortController = null;
  }
}

// ==== 27. التنظيف الشامل ====
function cleanup() {
  removeGlobalEventListeners();
  PluginManager.destroyAll();
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEANUP' });
  }
  if (_globalAbortController) _globalAbortController.abort();
  console.log('[Main] تم تنظيف الموارد');
}

// ==== 28. الواجهة العامة ====
if (APP_CONFIG.DEBUG) {
  window.$appStore = AppStore;
  window.$eventBus = EventBus;
}

window.app = {
  version: APP_CONFIG.VERSION,
  initialize: initializeApp,
  cleanup,
  getState: () => AppStore.getState(),
  getUser: () => AppStore.getUser(),
  toggleTheme,
  getCurrentTheme,
  getCurrentColorTheme,
  use: PluginManager.use,
  getPlugins: PluginManager.getPlugins,
  getErrors: ErrorTracker.getErrors,
  clearErrors: ErrorTracker.clearErrors,
  retryComponent: (name, importFn) => ComponentsManager.retryComponent(name, importFn),
  getComponentStatus: (name) => ComponentsManager.getComponentStatus(name)
};

// ==== 29. تعريض دوال الثيم ====
window.toggleTheme = toggleTheme;
window.getCurrentTheme = getCurrentTheme;
window.EventBus = EventBus;

// ==== 30. بدء التهيئة بعد DOM ====
document.addEventListener('DOMContentLoaded', () => {
  console.log('📄 DOM fully loaded, starting app initialization...');
  setTimeout(initializeApp, 100);
});

// ==== 31. التصدير ====
export {
  initializeApp,
  toggleTheme,
  getCurrentTheme,
  getCurrentColorTheme,
  AppStore,
  EventBus,
  ErrorTracker,
  Lifecycle,
  PluginManager,
  cleanup
};
