/* شريط التنقل العلوي والسفلي - v5.0.0 */

// ==== 1. الاستيراد ====
import { getCurrentUser } from '../core/session.js';
import { EventBus }        from '../core/event-bus.js';
import { toggleTheme, getCurrentTheme } from '../core/theme.js';
import { createAvatarElement, updateAvatarElement } from '../utils/avatar.js';
import { startLogoAnimation, stopLogoAnimation } from './logo-animation.js';

// ==== 2. الثوابت والمحددات ====

// شرط وضع الكمبيوتر مكرر في variables.css و navbar.css و drawer.css و drawer.js — لا يُغيَّر منفردًا
const DESKTOP_QUERY = '(min-width: 992px) and (hover: hover) and (pointer: fine)';
const MOBILE_QUERY  = '(max-width: 767.98px)';

const SCROLL_THRESHOLD_PX      = 10;
const SCROLL_HIDE_AFTER_PX     = 50;
const DRAWER_WAIT_INTERVAL_MS  = 100;
const DRAWER_WAIT_MAX_ATTEMPTS = 20;

const SELECTORS = {
  navbarTop:         '#navbar-top',
  themeToggle:       '.theme-toggle',
  searchBtn:         '#global-search-btn',
  notificationBtn:   '#notification-btn',
  notificationBadge: '#notification-badge',
  avatarContainer:   '#user-avatar-container',
  avatarMount:       '#user-avatar-mount',
  userName:          '#navbar-user-name',
  dynamicLogo:       '#navbar-dynamic-logo',
  bottomNav:         '#bottom-navigation',
  menuBtn:           '#open-drawer-btn',
  navLinks:          '#navbar-primary [data-nav-target], #bottom-navigation [data-nav-target]'
};

// اسم المسار → القسم الذي يُفعَّل في روابط التنقل
const PAGE_TO_NAV_MAP = {
  home:          'home',
  lessons:       'lessons',
  'lesson-view': 'lessons',
  exams:         'exams',
  'exam-view':   'exams',
  groups:        'groups',
  'group-view':  'groups'
};

// ==== 3. حالة الـ Navbar ====
let navbarState = {
  isInitialized:      false,
  currentPage:        'home',
  isOnline:           navigator.onLine,
  notificationsCount: 0,
  currentUser:        null,
  streak:             0,
  layoutMode:         '',
  isMobile:           false,
  lastScrollY:        0,
  isBottomNavHidden:  false,
  eventUnsubscribers: [],
  _domListeners:      []
};

// ==== 4. مرجع عناصر DOM ====
let $el = {
  navbarTop:         null,
  themeToggle:       null,
  searchBtn:         null,
  notificationBtn:   null,
  notificationBadge: null,
  avatarContainer:   null,
  avatarMount:       null,
  userName:          null,
  bottomNav:         null,
  menuBtn:           null,
  navLinks:          [],
  dynamicLogo:       null
};

// ==== 5. دوال مساعدة داخلية ====

function updateBodyMeta(user) {
  if (user) {
    document.body.dataset.auth = 'logged';
    document.body.dataset.role = user.user_type || '';
  } else {
    document.body.dataset.auth = 'guest';
    document.body.dataset.role = '';
  }
}

function getTimeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'صباح الخير ☀️';
  if (h < 18) return 'مساء الخير 🌤️';
  return 'مساء النور 🌙';
}

// نص خام (آمن للاستخدام في textContent و setAttribute بدون escape)
function buildUserTitle(user) {
  if (!user) return '';
  const nameRaw = String(user.full_name || user.username || 'مستخدم').trim();
  const name    = nameRaw.split(/\s+/)[0];
  if (user.user_type === 'teacher')   return `أستاذ ${name}`;
  if (user.user_type === 'moderator') return `المشرف ${name}`;
  return name;
}

function canUseSearch(user) {
  return user?.user_type === 'teacher' || user?.user_type === 'moderator';
}

// يقبل اسم المسار كنص أو كائن {name, params} (ما يرجعه router.getCurrentRoute)
function routeNameOf(value) {
  if (typeof value === 'string' && value) return value;
  return value?.name || value?.page || value?.route || 'home';
}

// ==== 6. بناء الواجهة ====

function bindDomRefs() {
  const $ = (selector) => document.querySelector(selector);

  $el.navbarTop         = $(SELECTORS.navbarTop);
  $el.themeToggle       = $(SELECTORS.themeToggle);
  $el.searchBtn         = $(SELECTORS.searchBtn);
  $el.notificationBtn   = $(SELECTORS.notificationBtn);
  $el.notificationBadge = $(SELECTORS.notificationBadge);
  $el.avatarContainer   = $(SELECTORS.avatarContainer);
  $el.avatarMount       = $(SELECTORS.avatarMount);
  $el.userName          = $(SELECTORS.userName);
  $el.dynamicLogo       = $(SELECTORS.dynamicLogo);
  $el.bottomNav         = $(SELECTORS.bottomNav);
  $el.menuBtn           = $(SELECTORS.menuBtn);
  $el.navLinks          = Array.from(document.querySelectorAll(SELECTORS.navLinks));
}

function updateNavbarUI(user) {
  navbarState.currentUser = user;
  navbarState.streak      = Number(user?.streak) || 0;
  updateBodyMeta(user);

  if (user) {
    _applyLoggedInState(user);
  } else {
    _applyGuestState();
  }
}

function _applyLoggedInState(user) {
  updateUserAvatarAndFrame(user);
  updateUserName(user);

  if ($el.searchBtn) {
    $el.searchBtn.style.display = canUseSearch(user) ? 'flex' : 'none';
  }

  refreshAvatarLabel();
}

function _applyGuestState() {
  resetAvatarToDefault();
  updateUserName(null);

  if ($el.searchBtn) $el.searchBtn.style.display = 'none';

  refreshAvatarLabel();
}

function refreshAvatarLabel() {
  const container = $el.avatarContainer;
  if (!container) return;

  const user = navbarState.currentUser;
  if (!user) {
    container.setAttribute('aria-label', 'فتح القائمة – الضيف');
    return;
  }

  const streak = navbarState.streak > 0 ? ` 🔥 ${navbarState.streak}` : '';
  container.setAttribute('aria-label', `${getTimeGreeting()} ${buildUserTitle(user)}${streak} – فتح القائمة`);
}

function updateUserName(user) {
  const el = $el.userName;
  if (!el) return;

  const title = user ? buildUserTitle(user) : '';
  el.textContent = title;
  el.hidden = !title;
}

// ==== 7. نظام الأفاتار والإطار ====

function getAvatarHost() {
  return $el.avatarMount || $el.avatarContainer;
}

function updateUserAvatarAndFrame(user) {
  const host = getAvatarHost();
  if (!host) return;

  if (!user) {
    resetAvatarToDefault();
    return;
  }

  let avatarElement = host.querySelector('.avatar-wrapper');
  if (!avatarElement) {
    // الأفاتار غير تفاعلي: الحاوية نفسها هي الزر (تجنّب عناصر تفاعلية متداخلة)
    avatarElement = createAvatarElement(user, 'sm', {
      showFrame: true,
      showBadge: false,
      clickable: false
    });
    host.replaceChildren(avatarElement);
  } else {
    updateAvatarElement(avatarElement, user);
  }
}

function resetAvatarToDefault() {
  const host = getAvatarHost();
  if (!host) return;

  const guestAvatar = createAvatarElement(null, 'sm', {
    showFrame: true,
    showBadge: false,
    clickable: false
  });
  host.replaceChildren(guestAvatar);
}

// ==== 8. إدارة عداد الإشعارات ====

function setNotificationsCount(count) {
  const num = Math.max(0, parseInt(count, 10) || 0);
  navbarState.notificationsCount = num;

  if (!$el.notificationBadge) return;

  if (num > 0) {
    const displayNum = num > 99 ? '99+' : String(num);
    $el.notificationBadge.textContent = displayNum;
    $el.notificationBadge.dataset.count = String(num);
    $el.notificationBadge.style.display = 'flex';

    $el.notificationBadge.classList.remove('badge-bounce');
    void $el.notificationBadge.offsetWidth;
    $el.notificationBadge.classList.add('badge-bounce');
  } else {
    $el.notificationBadge.textContent = '0';
    $el.notificationBadge.dataset.count = '0';
    $el.notificationBadge.style.display = 'none';
    $el.notificationBadge.classList.remove('badge-bounce');
  }

  if ($el.notificationBtn) {
    $el.notificationBtn.setAttribute(
      'aria-label',
      num > 0 ? `الإشعارات (${num} جديد)` : 'الإشعارات'
    );
  }

  EventBus.emit('navbar:notificationsUpdated', { count: num });
}

// ==== 9. مزامنة الصفحة النشطة ====

function updateCurrentPage(page) {
  const routeName = routeNameOf(page);
  navbarState.currentPage = routeName;
  updateActiveNavButton(routeName);
}

function updateActiveNavButton(page) {
  if (!$el.navLinks.length) return;

  const activeTarget = PAGE_TO_NAV_MAP[routeNameOf(page)] || null;

  $el.navLinks.forEach(link => {
    const isActive = Boolean(activeTarget) && link.dataset.navTarget === activeTarget;

    link.classList.toggle('active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

// ==== 10. مراقبة حالة الاتصال ====

let _onlineHandler  = null;
let _offlineHandler = null;

function startOnlineStatusMonitoring() {
  stopOnlineStatusMonitoring();

  _onlineHandler  = () => _handleConnectionChange(true);
  _offlineHandler = () => _handleConnectionChange(false);

  window.addEventListener('online',  _onlineHandler);
  window.addEventListener('offline', _offlineHandler);

  navbarState.isOnline = navigator.onLine;
  _applyConnectionStatus(navigator.onLine);
}

function stopOnlineStatusMonitoring() {
  if (_onlineHandler)  window.removeEventListener('online',  _onlineHandler);
  if (_offlineHandler) window.removeEventListener('offline', _offlineHandler);
  _onlineHandler  = null;
  _offlineHandler = null;
}

function _handleConnectionChange(isOnline) {
  navbarState.isOnline = isOnline;
  _applyConnectionStatus(isOnline);
  EventBus.emit('navbar:connectionChanged', { online: isOnline });
}

// حالة الانقطاع تظهر كخط تحذير أسفل الشريط (CSS) — لا نغيّر title زر الإشعارات
function _applyConnectionStatus(isOnline) {
  const navbar = $el.navbarTop;
  if (!navbar) return;

  navbar.classList.toggle('navbar--offline', !isOnline);
  navbar.classList.toggle('navbar--online',   isOnline);
  navbar.dataset.connection = isOnline ? 'online' : 'offline';
}

// ==== 11. وضع العرض (كمبيوتر / موبايل) ====

let desktopMedia        = null;
let desktopMediaHandler = null;

function applyLayoutMode(notify) {
  const mode    = desktopMedia?.matches ? 'desktop' : 'mobile';
  const changed = mode !== navbarState.layoutMode;

  navbarState.layoutMode = mode;
  document.documentElement.dataset.layout = mode;

  if (changed && notify) {
    EventBus.emit('layout:mode-changed', { mode, isDesktop: mode === 'desktop' });
  }
  if (changed && mode === 'desktop') _showBottomNav();
}

function initializeLayoutMode() {
  destroyLayoutMode();

  desktopMedia = window.matchMedia(DESKTOP_QUERY);
  desktopMediaHandler = () => applyLayoutMode(true);
  desktopMedia.addEventListener('change', desktopMediaHandler);

  navbarState.layoutMode = '';
  applyLayoutMode(false);
}

function destroyLayoutMode() {
  if (desktopMedia && desktopMediaHandler) {
    desktopMedia.removeEventListener('change', desktopMediaHandler);
  }
  desktopMedia = null;
  desktopMediaHandler = null;
}

// ==== 12. إخفاء الشريط السفلي عند التمرير (الهاتف فقط) ====

let scrollHandlerRef   = null;
let mobileMedia        = null;
let mobileMediaHandler = null;

function applyMobileState() {
  navbarState.isMobile = Boolean(mobileMedia?.matches);

  window.removeEventListener('scroll', scrollHandlerRef);

  if (navbarState.isMobile) {
    navbarState.lastScrollY = window.scrollY;
    window.addEventListener('scroll', scrollHandlerRef, { passive: true });
  } else {
    _showBottomNav();
  }
}

function initializeAutoHideBottomNav() {
  destroyAutoHideBottomNav();

  if (!$el.bottomNav) return;

  scrollHandlerRef = () => {
    if (!navbarState.isMobile || !$el.bottomNav) return;

    const currentScrollY = window.scrollY;
    if (Math.abs(currentScrollY - navbarState.lastScrollY) < SCROLL_THRESHOLD_PX) return;

    if (currentScrollY > navbarState.lastScrollY && currentScrollY > SCROLL_HIDE_AFTER_PX) {
      _hideBottomNav();
    } else if (currentScrollY < navbarState.lastScrollY) {
      _showBottomNav();
    }
    navbarState.lastScrollY = currentScrollY;
  };

  mobileMedia = window.matchMedia(MOBILE_QUERY);
  mobileMediaHandler = applyMobileState;
  mobileMedia.addEventListener('change', mobileMediaHandler);

  applyMobileState();
}

function destroyAutoHideBottomNav() {
  if (scrollHandlerRef) {
    window.removeEventListener('scroll', scrollHandlerRef);
  }
  if (mobileMedia && mobileMediaHandler) {
    mobileMedia.removeEventListener('change', mobileMediaHandler);
  }
  scrollHandlerRef   = null;
  mobileMedia        = null;
  mobileMediaHandler = null;
  _showBottomNav();
}

function _hideBottomNav() {
  if (!$el.bottomNav || navbarState.isBottomNavHidden) return;
  $el.bottomNav.classList.add('hide');
  navbarState.isBottomNavHidden = true;
}

function _showBottomNav() {
  if (!$el.bottomNav || !navbarState.isBottomNavHidden) return;
  $el.bottomNav.classList.remove('hide');
  navbarState.isBottomNavHidden = false;
}

// ==== 13. فتح القائمة الجانبية ====

let drawerWaitTimer = null;

function clearDrawerWait() {
  if (drawerWaitTimer) clearInterval(drawerWaitTimer);
  drawerWaitTimer = null;
}

// drawer.js يُحمَّل بعد الشريط أحيانًا: ننتظره بحد أقصى ثانيتين
function openDrawerWhenReady() {
  if (window.drawer?.open) {
    window.drawer.open();
    return;
  }

  if (window.modals?.toast) {
    window.modals.toast('جاري تحميل القائمة الجانبية...', 'info');
  }

  clearDrawerWait();
  let attempts = 0;
  drawerWaitTimer = setInterval(() => {
    attempts++;
    if (window.drawer?.open) {
      clearDrawerWait();
      window.drawer.open();
    } else if (attempts >= DRAWER_WAIT_MAX_ATTEMPTS) {
      clearDrawerWait();
      console.warn('[Navbar] تعذّر فتح القائمة الجانبية — لم يتم تحميل drawer.js في الوقت المناسب');
    }
  }, DRAWER_WAIT_INTERVAL_MS);
}

function toggleDrawerMenu() {
  if (window.drawer?.toggle) window.drawer.toggle();
  else openDrawerWhenReady();
}

function closeDrawerIfOpen() {
  if (window.drawer?.isOpen?.()) window.drawer.close();
}

// ==== 14. ربط الأحداث ====

function _trackListener(el, type, fn) {
  navbarState._domListeners.push({ el, type, fn });
}

function _bind(el, type, fn) {
  if (!el) return;
  el.addEventListener(type, fn);
  _trackListener(el, type, fn);
}

function onAvatarActivate(event) {
  if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  toggleDrawerMenu();
}

// زر القائمة السفلي: drawer.js يربطه بنفسه، وهذا المعالج احتياطي لو لم يكن جاهزًا بعد
function onMenuButtonClick() {
  if (window.drawer?.initialized) return;
  openDrawerWhenReady();
}

function onSearchClick() {
  closeDrawerIfOpen();
  if (window.searchAPI?.open) window.searchAPI.open();
}

function onThemeToggleClick() {
  const newTheme = toggleTheme();
  _updateThemeToggleIcon(newTheme);
  closeDrawerIfOpen();
}

// Ctrl/⌘ + K أو "/" لفتح البحث (للمعلم والمشرف فقط)
function onGlobalKeydown(event) {
  if (event.isComposing || event.altKey) return;
  if (!canUseSearch(navbarState.currentUser) || !window.searchAPI?.open) return;

  const isCtrlK = (event.ctrlKey || event.metaKey) && event.code === 'KeyK';
  const isSlash = event.code === 'Slash' && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if (!isCtrlK && !isSlash) return;

  if (isSlash) {
    const target = event.target;
    const tag = target?.tagName;
    if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  }

  event.preventDefault();
  closeDrawerIfOpen();
  window.searchAPI.open();
}

function bindEvents() {
  // التنقل بين الصفحات يتولاه معالج النقر العام في الراوتر (data-nav-target)
  _bind($el.avatarContainer, 'click',   onAvatarActivate);
  _bind($el.avatarContainer, 'keydown', onAvatarActivate);
  _bind($el.menuBtn,         'click',   onMenuButtonClick);
  _bind($el.searchBtn,       'click',   onSearchClick);
  _bind($el.notificationBtn, 'click',   closeDrawerIfOpen);
  _bind($el.themeToggle,     'click',   onThemeToggleClick);
  _bind(document,            'keydown', onGlobalKeydown);
}

function subscribeToGlobalEvents() {
  const onUserStateChanged = (data) => {
    const user = data?.user || null;
    updateNavbarUI(user);
  };

  // profileUpdated قد يخص مستخدمًا آخر (معلم يعدّل ملف طالب) — نتجاهله
  const onProfileUpdated = (data) => {
    const current = getCurrentUser();
    if (!current) return;

    const updated = data?.user;
    if (updated && String(updated.id) !== String(current.id)) return;

    const user = updated || current;
    navbarState.currentUser = user;
    updateUserAvatarAndFrame(user);
    updateUserName(user);
    refreshAvatarLabel();
  };

  const onStreakUpdated = (data) => {
    const current = navbarState.currentUser;
    if (!current) return;
    if (data?.userId && current.id && String(data.userId) !== String(current.id)) return;

    navbarState.streak = Number(data?.streak) || 0;
    refreshAvatarLabel();
  };

  const onRouterNavigated = (data) => {
    updateCurrentPage(data?.page || data?.route || 'home');
    _showBottomNav();
  };

  const onNotificationsUpdated = (data) => {
    if (typeof data?.count === 'number') {
      setNotificationsCount(data.count);
    }
  };

  const onThemeChanged = (data) => {
    const theme = data?.theme || data?.mode || window.getCurrentTheme?.() || 'light';
    _updateThemeToggleIcon(theme);
  };

  navbarState.eventUnsubscribers = [
    EventBus.on('userStateChanged',           onUserStateChanged),
    EventBus.on('profileUpdated',             onProfileUpdated),
    EventBus.on('avatarUpdated',              onProfileUpdated),
    EventBus.on('streak:updated',             onStreakUpdated),
    EventBus.on('pageChanged',                onRouterNavigated),
    EventBus.on('notifications:countChanged', onNotificationsUpdated),
    EventBus.on('newNotification',            onNotificationsUpdated),
    EventBus.on('theme:toggled',              onThemeChanged)
  ];

  const docUserStateHandler = (e) => onUserStateChanged(e.detail);
  document.addEventListener('userStateChanged', docUserStateHandler);
  _trackListener(document, 'userStateChanged', docUserStateHandler);
}

function unbindEvents() {
  navbarState.eventUnsubscribers.forEach(unsub => {
    if (typeof unsub === 'function') unsub();
  });
  navbarState.eventUnsubscribers = [];

  navbarState._domListeners.forEach(({ el, type, fn }) => {
    if (el && typeof el.removeEventListener === 'function') {
      el.removeEventListener(type, fn);
    }
  });
  navbarState._domListeners = [];
}

function _updateThemeToggleIcon(theme) {
  if (!$el.themeToggle) return;
  const isDark = theme === 'dark';
  $el.themeToggle.setAttribute('aria-pressed', String(isDark));
  $el.themeToggle.setAttribute('aria-label', isDark ? 'تفعيل الوضع النهاري' : 'تفعيل الوضع الليلي');
  $el.themeToggle.setAttribute('title',      isDark ? 'الوضع النهاري'       : 'الوضع الليلي');
}

// ==== 15. دورة الحياة ====

async function initializeNavbar() {
  if (navbarState.isInitialized) {
    console.warn('[Navbar] تم تهيئة الـ Navbar مسبقاً');
    return;
  }

  console.log('[Navbar] 🚀 بدء تهيئة شريط التنقل v5.0.0...');

  try {
    bindDomRefs();

    initializeLayoutMode();

    const user = getCurrentUser();

    updateNavbarUI(user);

    startOnlineStatusMonitoring();

    initializeAutoHideBottomNav();

    bindEvents();

    startLogoAnimation($el.dynamicLogo);

    subscribeToGlobalEvents();

    updateCurrentPage(window.router?.getCurrentRoute?.() || 'home');

    _updateThemeToggleIcon(getCurrentTheme());

    navbarState.isInitialized = true;

    EventBus.emit('navbar:ready', { user });

    window.navbar = _publicAPI;

    console.log('[Navbar] ✅ شريط التنقل جاهز');
  } catch (error) {
    console.error('[Navbar] ❌ فشل التهيئة:', error);
    throw error;
  }
}

function destroyNavbar() {
  if (!navbarState.isInitialized) return;

  stopOnlineStatusMonitoring();

  destroyAutoHideBottomNav();

  destroyLayoutMode();

  clearDrawerWait();

  stopLogoAnimation();

  unbindEvents();

  navbarState.isInitialized = false;
  console.log('[Navbar] 🧹 تم تنظيف شريط التنقل');
}

async function reinitializeNavbar() {
  destroyNavbar();
  await initializeNavbar();
}

// ==== 16. بوابات التحكم الخارجي ====

function updateAfterLogin(userData) {
  updateNavbarUI(userData);
  EventBus.emit('navbar:userLoggedIn', { user: userData });
}

function updateAfterLogout() {
  updateNavbarUI(null);
  setNotificationsCount(0);
  EventBus.emit('navbar:userLoggedOut');
}

function getState() {
  return {
    isInitialized:      navbarState.isInitialized,
    currentPage:        navbarState.currentPage,
    isOnline:           navbarState.isOnline,
    layoutMode:         navbarState.layoutMode,
    notificationsCount: navbarState.notificationsCount,
    currentUser:        navbarState.currentUser
      ? { id: navbarState.currentUser.id, user_type: navbarState.currentUser.user_type }
      : null
  };
}

// ==== 17. الواجهة العامة ====

const _publicAPI = {
  initialize:           initializeNavbar,
  destroy:              destroyNavbar,
  reinitialize:         reinitializeNavbar,
  updateNavbarUI,
  updateUserAvatarAndFrame,
  resetAvatarToDefault,
  setNotificationsCount,
  updateCurrentPage,
  updateActiveNavButton,
  updateAfterLogin,
  updateAfterLogout,
  getState,
  isDesktopMode:        () => navbarState.layoutMode === 'desktop',
  startOnlineStatusMonitoring,
  stopOnlineStatusMonitoring,
  initializeAutoHideBottomNav,
  destroyAutoHideBottomNav
};

window.navbar = _publicAPI;

// ==== 18. التصدير ====
export {
  initializeNavbar,
  destroyNavbar,
  reinitializeNavbar,
  updateNavbarUI,
  updateUserAvatarAndFrame,
  resetAvatarToDefault,
  setNotificationsCount,
  updateCurrentPage,
  updateActiveNavButton,
  updateAfterLogin,
  updateAfterLogout,
  getState
};

export default _publicAPI;

console.log('✅ [navbar.js] شريط التنقل v5.0.0 – جاهز للتهيئة');
