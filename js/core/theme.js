/* إدارة الثيم الليلي والملوّن ومزامنته - v5.0.0 */

// ==== 1. الاستيراد ====
import { EventBus } from './event-bus.js';
import { getCurrentUser } from './session.js';

// ==== 2. الثوابت العامة ====
export const THEME_CONSTANTS = {
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
  STORAGE_KEY: 'biologist_theme',
  COLOR_STORAGE_KEY: 'biologist_color_theme',
  PREFERS_DARK_MEDIA: '(prefers-color-scheme: dark)',
  AVAILABLE_COLORS: ['blue', 'pink', 'green', 'purple', 'orange'],
  DEFAULT_COLOR: 'blue',
  TRANSITION_DURATION: 300
};

// ==== 3. حالة النظام ====
let $themeState = {
  current: 'light',
  currentColor: 'blue',
  isInitialized: false,
  isSystem: false,
  isReducedMotion: false,
  listeners: [],
  colorListeners: [],
  transitionTimeout: null,
  systemListener: null,
  pendingTheme: null,
  pendingColor: null,
  syncListenerAttached: false,
  transitionOverlay: null,
  motionMedia: null,
  guestThemeChosen: false,
  guestColorChosen: false
};

// ==== 4. دوال النظام الأساسية ====

export function initializeTheme() {
  if ($themeState.isInitialized) {
    console.log('🎨 نظام الثيم تم تهيئته مسبقاً');
    return { theme: $themeState.current, colorTheme: $themeState.currentColor };
  }

  console.log('🎨 تهيئة نظام الثيم المركزي (مع دعم الألوان والتبديل التدريجي)...');

  try {
    const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    $themeState.isReducedMotion = motionMedia.matches;
    motionMedia.addEventListener('change', handleMotionPreferenceChange);
    $themeState.motionMedia = motionMedia;

    const savedTheme = localStorage.getItem(THEME_CONSTANTS.STORAGE_KEY);
    if (savedTheme === THEME_CONSTANTS.SYSTEM) {
      enableSystemTheme(false);
    } else if (savedTheme === THEME_CONSTANTS.DARK || savedTheme === THEME_CONSTANTS.LIGHT) {
      setTheme(savedTheme, false);
    } else {
      enableSystemTheme(true);
    }

    const savedColor = localStorage.getItem(THEME_CONSTANTS.COLOR_STORAGE_KEY);
    if (savedColor && THEME_CONSTANTS.AVAILABLE_COLORS.includes(savedColor)) {
      setColorTheme(savedColor, false);
    } else {
      setColorTheme(THEME_CONSTANTS.DEFAULT_COLOR, false);
    }

    applyThemeToDOM();
    applyColorThemeToDOM();

    $themeState.isInitialized = true;

    if (window.$appState) {
      window.$appState.theme = $themeState.current;
      window.$appState.colorTheme = $themeState.currentColor;
    }

    exposeGlobalFunctions();

    attachSyncListener();

    document.dispatchEvent(new CustomEvent('themeSystemInitialized', {
      detail: { theme: $themeState.current, colorTheme: $themeState.currentColor }
    }));

    console.log(`✅ نظام الثيم تم تهيئته بنجاح: ${$themeState.current} / ${$themeState.currentColor}`);
    return { theme: $themeState.current, colorTheme: $themeState.currentColor };

  } catch (error) {
    console.error('❌ فشل تهيئة نظام الثيم:', error);
    $themeState.current = THEME_CONSTANTS.LIGHT;
    $themeState.currentColor = THEME_CONSTANTS.DEFAULT_COLOR;
    applyThemeToDOM();
    exposeGlobalFunctions();
    attachSyncListener();
    return { theme: THEME_CONSTANTS.LIGHT, colorTheme: THEME_CONSTANTS.DEFAULT_COLOR };
  }
}

// ==== 5. ربط مستمع تسجيل الدخول ====
function attachSyncListener() {
  if ($themeState.syncListenerAttached) return;
  $themeState.syncListenerAttached = true;

  EventBus.on('userStateChanged', async (detail) => {
    if (detail.action === 'login' && detail.user) {
      await flushPendingSync();
    }
  });

}

// ==== 6. تنفيذ المزامنة المعلقة ====
async function flushPendingSync() {
  const user = getCurrentUser();
  if (!user || !user.id) return;

  let themeToSync = null;
  let colorToSync = null;

  if ($themeState.pendingTheme !== null) {
    themeToSync = $themeState.pendingTheme;
    $themeState.pendingTheme = null;
  }
  if ($themeState.pendingColor !== null) {
    colorToSync = $themeState.pendingColor;
    $themeState.pendingColor = null;
  }

  if (themeToSync === null && colorToSync === null) return;

  let updated = false;
  try {
    if (themeToSync !== null) {
      await syncThemeWithUser(themeToSync);
      updated = true;
    }
    if (colorToSync !== null) {
      await syncColorThemeWithUser(colorToSync);
      updated = true;
    }
    if (updated) {
      console.log(`✅ تمت مزامنة الثيمات المعلقة مع المستخدم ${user.id}`);
    }
  } catch (error) {
    console.warn('⚠️ فشل مزامنة الثيمات المعلقة بعد تسجيل الدخول:', error);
  }
}

// ==== 7. جدولة المزامنة ====
function scheduleSyncWithUser(theme, color) {
  if (!getCurrentUser()?.id) {
    if (theme !== undefined && theme !== null) $themeState.guestThemeChosen = true;
    if (color !== undefined && color !== null) $themeState.guestColorChosen = true;
  }
  if (theme !== undefined && theme !== null) {
    $themeState.pendingTheme = theme;
  }
  if (color !== undefined && color !== null) {
    $themeState.pendingColor = color;
  }

  if (getCurrentUser() && getCurrentUser().id) {
    flushPendingSync().catch(err => console.warn('⚠️ فشل المزامنة الفورية:', err));
  }
}

export function setTheme(theme, saveToStorage = true) {
  if (theme !== THEME_CONSTANTS.LIGHT && theme !== THEME_CONSTANTS.DARK) {
    console.warn(`⚠️ ثيم غير صالح: ${theme}, استخدام الوضع الافتراضي`);
    theme = THEME_CONSTANTS.LIGHT;
  }

  if (theme === $themeState.current) return theme;

  if ($themeState.isSystem && saveToStorage) {
    disableSystemTheme();
  }

  const oldTheme = $themeState.current;
  $themeState.current = theme;

  if (saveToStorage) {
    localStorage.setItem(THEME_CONSTANTS.STORAGE_KEY, theme);
    scheduleSyncWithUser(theme, undefined);
  }

  applyThemeToDOM();
  notifyThemeChange(oldTheme, theme);

  if (window.$appState) window.$appState.theme = theme;
  
  console.log(`🎨 تغيير الثيم: ${oldTheme} → ${theme}`);
  return theme;
}

export function setColorTheme(color, saveToStorage = true) {
  if (!THEME_CONSTANTS.AVAILABLE_COLORS.includes(color)) {
    console.warn(`⚠️ لون ثيم غير صالح: ${color}, استخدام الافتراضي`);
    color = THEME_CONSTANTS.DEFAULT_COLOR;
  }

  if (color === $themeState.currentColor) return color;

  const oldColor = $themeState.currentColor;
  $themeState.currentColor = color;

  if (saveToStorage) {
    localStorage.setItem(THEME_CONSTANTS.COLOR_STORAGE_KEY, color);
    scheduleSyncWithUser(undefined, color);
  }

  applyColorThemeWithTransition(oldColor, color);

  notifyColorThemeChange(oldColor, color);

  if (window.$appState) window.$appState.colorTheme = color;
  
  console.log(`🎨 تغيير الثيم الملون: ${oldColor} → ${color}`);
  return color;
}

function applyColorThemeWithTransition(oldColor, newColor) {
  if ($themeState.isReducedMotion || !$themeState.isInitialized) {
    applyColorThemeToDOM();
    return;
  }

  clearTimeout($themeState.transitionTimeout);
  if ($themeState.transitionOverlay) {
    $themeState.transitionOverlay.remove();
    $themeState.transitionOverlay = null;
  }

  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:99999;opacity:0;' +
    `background-color:var(--primary);transition:opacity ${THEME_CONSTANTS.TRANSITION_DURATION}ms ease;`;
  document.body.appendChild(overlay);
  $themeState.transitionOverlay = overlay;

  applyColorThemeToDOM();

  requestAnimationFrame(() => {
    overlay.style.opacity = '0.15';
    $themeState.transitionTimeout = setTimeout(() => {
      overlay.style.opacity = '0';
      $themeState.transitionTimeout = setTimeout(() => {
        overlay.remove();
        if ($themeState.transitionOverlay === overlay) $themeState.transitionOverlay = null;
      }, THEME_CONSTANTS.TRANSITION_DURATION);
    }, THEME_CONSTANTS.TRANSITION_DURATION);
  });
}

async function syncThemeWithUser(theme) {
  if (getCurrentUser() && getCurrentUser().id) {
    try {
      const { updateUserPreferences } = await import('../core/api.js');
      await updateUserPreferences(getCurrentUser().id, { preferred_theme: theme });
      console.log(`✅ تم حفظ الثيم ${theme} في حساب المستخدم`);
    } catch (error) {
      console.warn('⚠️ فشل حفظ الثيم في قاعدة البيانات:', error);
    }
  }
}

async function syncColorThemeWithUser(color) {
  if (getCurrentUser() && getCurrentUser().id) {
    try {
      const { updateUserPreferences } = await import('../core/api.js');
      await updateUserPreferences(getCurrentUser().id, { preferred_color_theme: color });
      console.log(`✅ تم حفظ الثيم الملون ${color} في حساب المستخدم`);
    } catch (error) {
      console.warn('⚠️ فشل حفظ الثيم الملون في قاعدة البيانات:', error);
    }
  }
}

// ==== 8. تطبيق تفضيلات الحساب ====
export function applyUserPreferences(user) {
  if (!user) return;

  const color = user.preferred_color_theme;
  if (color && !$themeState.guestColorChosen && THEME_CONSTANTS.AVAILABLE_COLORS.includes(color)) {
    try { localStorage.setItem(THEME_CONSTANTS.COLOR_STORAGE_KEY, color); } catch (_) { }
    setColorTheme(color, false);
  }

  const theme = user.preferred_theme;
  if (!$themeState.isSystem && !$themeState.guestThemeChosen &&
      (theme === THEME_CONSTANTS.LIGHT || theme === THEME_CONSTANTS.DARK)) {
    try { localStorage.setItem(THEME_CONSTANTS.STORAGE_KEY, theme); } catch (_) { }
    setTheme(theme, false);
  }

  $themeState.guestThemeChosen = false;
  $themeState.guestColorChosen = false;
}

export function toggleTheme() {
  const newTheme = $themeState.current === THEME_CONSTANTS.DARK 
    ? THEME_CONSTANTS.LIGHT 
    : THEME_CONSTANTS.DARK;
  return setTheme(newTheme);
}

export function toggleColorTheme() {
  const currentIndex = THEME_CONSTANTS.AVAILABLE_COLORS.indexOf($themeState.currentColor);
  const nextIndex = (currentIndex + 1) % THEME_CONSTANTS.AVAILABLE_COLORS.length;
  return setColorTheme(THEME_CONSTANTS.AVAILABLE_COLORS[nextIndex]);
}

export function enableSystemTheme(saveToStorage = true) {
  if ($themeState.isSystem) return $themeState.current;

  const darkModeMedia = window.matchMedia(THEME_CONSTANTS.PREFERS_DARK_MEDIA);
  
  const handleSystemChange = (e) => {
    const systemTheme = e.matches ? THEME_CONSTANTS.DARK : THEME_CONSTANTS.LIGHT;
    setTheme(systemTheme, false);
  };

  $themeState.systemListener = handleSystemChange;
  darkModeMedia.addEventListener('change', handleSystemChange);
  
  $themeState.isSystem = true;
  const systemTheme = darkModeMedia.matches ? THEME_CONSTANTS.DARK : THEME_CONSTANTS.LIGHT;
  
  if (saveToStorage) {
    localStorage.setItem(THEME_CONSTANTS.STORAGE_KEY, THEME_CONSTANTS.SYSTEM);
  }
  
  setTheme(systemTheme, false);
  
  console.log(`🎨 تفعيل الثيم التلقائي: ${systemTheme}`);
  return systemTheme;
}

export function disableSystemTheme() {
  if (!$themeState.isSystem) return;

  const darkModeMedia = window.matchMedia(THEME_CONSTANTS.PREFERS_DARK_MEDIA);
  if ($themeState.systemListener) {
    darkModeMedia.removeEventListener('change', $themeState.systemListener);
    $themeState.systemListener = null;
  }

  $themeState.isSystem = false;
  console.log('🎨 تعطيل الثيم التلقائي');
}

// ==== 9. تطبيق الثيم على DOM ====

function applyThemeToDOM() {
  document.body.setAttribute('data-theme', $themeState.current);
  document.documentElement.setAttribute('data-theme', $themeState.current);
  
  updateMetaThemeColor();

  updateThemeToggleButtons();
  updateThemeIcons();
}

// ==== 10. تحديث لون شريط الحالة ====
function updateMetaThemeColor() {
  const meta = document.getElementById('theme-color-meta');
  if (!meta) return;
  const isDark = $themeState.current === THEME_CONSTANTS.DARK;
  const styles = getComputedStyle(document.documentElement);
  const token = isDark ? '--background-light' : '--primary';
  const value = styles.getPropertyValue(token).trim();
  meta.content = value || (isDark ? '#121212' : '#2196f3');
}

function applyColorThemeToDOM() {
  const color = $themeState.currentColor;
  const links = THEME_CONSTANTS.AVAILABLE_COLORS.map(c => ({
    color: c,
    link: document.querySelector(`link[href*="theme-${c}.css"]`)
  }));
  const active = links.find(item => item.color === color)?.link;

  THEME_CONSTANTS.AVAILABLE_COLORS.forEach(c => document.body.classList.remove(`theme-${c}`));
  document.body.classList.add(`theme-${color}`);

  if (!active) {
    console.warn(`⚠️ لم يتم العثور على رابط الثيم الملون: theme-${color}.css`);
    return;
  }

  const finish = () => {
    if ($themeState.currentColor !== color) return;
    links.forEach(item => {
      if (item.link && item.link !== active) item.link.disabled = true;
    });
    updateMetaThemeColor();
    console.log(`🎨 تم تفعيل الثيم الملون: ${color}`);
  };

  const wasDisabled = active.disabled;
  active.disabled = false;

  if (!wasDisabled || active.sheet) {
    finish();
    return;
  }

  let done = false;
  const once = () => { if (done) return; done = true; finish(); };
  active.addEventListener('load', once, { once: true });
  active.addEventListener('error', once, { once: true });
  setTimeout(once, 3000);
}

function updateThemeToggleButtons() {
  const isDark = $themeState.current === THEME_CONSTANTS.DARK;

  // زر الشريط العلوي: زر عادي → aria-pressed
  document.querySelectorAll('.theme-toggle').forEach(button => {
    button.setAttribute('aria-pressed', String(isDark));
  });

  // مفتاح القائمة الجانبية: role="switch" → aria-checked، والنص ثابت "الوضع الليلي"
  document.querySelectorAll('.theme-toggle-sidebar').forEach(button => {
    button.setAttribute('aria-checked', String(isDark));
  });
}

function updateThemeIcons() {
  const isDark = $themeState.current === THEME_CONSTANTS.DARK;
  document.querySelectorAll('.theme-toggle .light-icon').forEach(icon => {
    icon.style.display = isDark ? 'none' : 'inline-block';
  });
  document.querySelectorAll('.theme-toggle .dark-icon').forEach(icon => {
    icon.style.display = isDark ? 'inline-block' : 'none';
  });
}

// ==== 11. إدارة الأحداث ====

function handleMotionPreferenceChange(e) {
  $themeState.isReducedMotion = e.matches;
  console.log(`🎨 تفضيلات الحركة: ${e.matches ? 'مخفضة' : 'عادية'}`);
}

function notifyThemeChange(oldTheme, newTheme) {
  if (typeof EventBus !== 'undefined' && EventBus.emit) {
    EventBus.emit('theme:toggled', { theme: newTheme, oldTheme });
  }
  
  $themeState.listeners.forEach(listener => {
    try { listener(oldTheme, newTheme); } catch (e) { console.error(e); }
  });
  
  document.dispatchEvent(new CustomEvent('themeChanged', {
    detail: { oldTheme, newTheme, isSystem: $themeState.isSystem, timestamp: Date.now() }
  }));
}

function notifyColorThemeChange(oldColor, newColor) {
  EventBus.emit('theme:colorChanged', { color: newColor, oldColor });

  $themeState.colorListeners.forEach(listener => {
    try { listener(oldColor, newColor); } catch (e) { console.error(e); }
  });
  
  document.dispatchEvent(new CustomEvent('colorThemeChanged', {
    detail: { oldColor, newColor, timestamp: Date.now() }
  }));
}

// ==== 12. تعريض الدوال عالميًا ====
function exposeGlobalFunctions() {
  window.toggleTheme = toggleTheme;
  window.getCurrentTheme = getCurrentTheme;
  window.getCurrentColorTheme = getCurrentColorTheme;
  window.setTheme = setTheme;
  window.setColorTheme = setColorTheme;
  
  window.$themeManager = {
    initialize: initializeTheme,
    setTheme,
    setColorTheme,
    applyUserPreferences,
    toggleTheme,
    toggleColorTheme,
    enableSystemTheme,
    disableSystemTheme,
    getCurrentTheme,
    getCurrentColorTheme,
    isDarkMode,
    isSystemTheme,
    addListener: addThemeListener,
    removeListener: removeThemeListener,
    getState: getThemeState,
    constants: THEME_CONSTANTS
  };
}

// ==== 13. التنظيف ====
export function destroyTheme() {
  disableSystemTheme();
  clearTimeout($themeState.transitionTimeout);
  $themeState.transitionOverlay?.remove();
  $themeState.transitionOverlay = null;
  $themeState.motionMedia?.removeEventListener('change', handleMotionPreferenceChange);
  $themeState.motionMedia = null;
  $themeState.listeners = [];
  $themeState.colorListeners = [];
  $themeState.isInitialized = false;
}

// ==== 14. الواجهة العامة ====

export function getCurrentTheme() {
  return $themeState.current;
}

export function getCurrentColorTheme() {
  return $themeState.currentColor;
}

export function isDarkMode() {
  return $themeState.current === THEME_CONSTANTS.DARK;
}

export function isSystemTheme() {
  return $themeState.isSystem;
}

export function addThemeListener(callback) {
  if (typeof callback === 'function') $themeState.listeners.push(callback);
}

export function removeThemeListener(callback) {
  const index = $themeState.listeners.indexOf(callback);
  if (index !== -1) $themeState.listeners.splice(index, 1);
}

export function addColorThemeListener(callback) {
  if (typeof callback === 'function') $themeState.colorListeners.push(callback);
}

export function removeColorThemeListener(callback) {
  const index = $themeState.colorListeners.indexOf(callback);
  if (index !== -1) $themeState.colorListeners.splice(index, 1);
}

export function getThemeState() {
  return { 
    theme: $themeState.current, 
    colorTheme: $themeState.currentColor,
    isSystem: $themeState.isSystem,
    isReducedMotion: $themeState.isReducedMotion,
    initialized: $themeState.isInitialized
  };
}

export default {
  initialize: initializeTheme,
  setTheme,
  setColorTheme,
  applyUserPreferences,
  toggleTheme,
  toggleColorTheme,
  getCurrentTheme,
  getCurrentColorTheme,
  isDarkMode,
  isSystemTheme,
  addListener: addThemeListener,
  removeListener: removeThemeListener,
  addColorListener: addColorThemeListener,
  removeColorListener: removeColorThemeListener,
  constants: THEME_CONSTANTS
};