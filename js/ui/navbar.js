/* شريط التنقل العلوي والسفلي - v5.0.0 */

// ==== 1. الاستيراد ====
import { getCurrentUser } from '../core/session.js';
import { EventBus }        from '../core/event-bus.js';
import { toggleTheme, getCurrentTheme } from '../core/theme.js';
import { createAvatarElement, updateAvatarElement, shouldShowVerificationBadge, getFrameClass } from '../utils/avatar.js';
import { startLogoAnimation, stopLogoAnimation } from './logo-animation.js';

// ==== 2. الثوابت والمحددات ====

const SELECTORS = {
  navbarTop:           '#navbar-top',
  onlineIndicator:     '#navbar-online-indicator',
  themeToggle:         '.theme-toggle',
  searchBtn:           '#global-search-btn',
  notificationBtn:     '#notification-btn',
  notificationBadge:   '#notification-badge',
  avatarContainer:     '#user-avatar-container',
  userAvatar:          '#user-avatar',
  avatarFrame:         '#avatar-frame',
  verificationBadge:   '#user-verification-badge',
  dynamicLogo:         '#navbar-dynamic-logo',

  bottomNav:           '#bottom-navigation',
  bottomNavBtns:       '.bottom-nav-btn[data-nav-target]',
};

const PAGE_TO_NAV_MAP = {
  home:       'home',
  lessons:    'lessons',
  exams:      'exams',
};

// ==== 3. حالة الـ Navbar ====
let navbarState = {
  isInitialized:     false,
  currentPage:       'home',
  isOnline:          navigator.onLine,
  notificationsCount: 0,
  currentUser:       null,
  eventUnsubscribers: [],
  _domListeners:     [],
  isMobile:          window.innerWidth < 768,
  lastScrollY:       window.scrollY,
  _scrollState: {
    lastY:     0,
    ticking:   false,
    rafId:     null,
    isHidden:  false
  }
};

// ==== 4. مرجع عناصر DOM ====
let $el = {
  navbarTop:         null,
  onlineIndicator:   null,
  themeToggle:       null,
  searchBtn:         null,
  notificationBtn:   null,
  notificationBadge: null,
  avatarContainer:   null,
  verificationBadge: null,
  bottomNav:         null,
  bottomNavBtns:     [],
  dynamicLogo:       null,
};

// ==== 5. دوال مساعدة داخلية ====

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


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

function buildUserTitle(user) {
  if (!user) return '';
  const nameRaw  = user.full_name || user.username || 'مستخدم';
  const name     = escapeHtml(nameRaw.split(' ')[0]);
  if (user.user_type === 'teacher')   return `أستاذ ${name}`;
  if (user.user_type === 'moderator') return `المشرف ${name}`;
  return name;
}

// ==== 6. بناء الواجهة ====

function bindDomRefs() {
  $el.navbarTop         = document.querySelector(SELECTORS.navbarTop);
  $el.onlineIndicator   = document.querySelector(SELECTORS.onlineIndicator);
  $el.themeToggle       = document.querySelector(SELECTORS.themeToggle);
  $el.searchBtn         = document.querySelector(SELECTORS.searchBtn);
  $el.notificationBtn   = document.querySelector(SELECTORS.notificationBtn);
  $el.notificationBadge = document.querySelector(SELECTORS.notificationBadge);
  $el.avatarContainer   = document.querySelector(SELECTORS.avatarContainer);
  $el.verificationBadge = document.querySelector(SELECTORS.verificationBadge);
  $el.dynamicLogo       = document.querySelector(SELECTORS.dynamicLogo);
  $el.bottomNav         = document.querySelector(SELECTORS.bottomNav);
  $el.bottomNavBtns     = Array.from(
    document.querySelectorAll(SELECTORS.bottomNavBtns)
  );
}

function updateNavbarUI(user) {
  navbarState.currentUser = user;
  updateBodyMeta(user);

  if (user) {
    _applyLoggedInState(user);
  } else {
    _applyGuestState();
  }
}

function _applyLoggedInState(user) {
  updateUserAvatarAndFrame(user);

  const isVerified = user.user_type === 'teacher' || user.user_type === 'moderator';
  if ($el.verificationBadge) {
    $el.verificationBadge.style.display = isVerified ? 'flex' : 'none';
    $el.verificationBadge.setAttribute('title',
      isVerified ? `حساب ${user.user_type === 'teacher' ? 'معلم' : 'مشرف'} موثّق` : ''
    );
  }

  if ($el.searchBtn) {
    const canSearch = user.user_type === 'teacher' || user.user_type === 'moderator';
    $el.searchBtn.style.display = canSearch ? 'flex' : 'none';
  }

  if ($el.avatarContainer) {
    const greeting = getTimeGreeting();
    const title    = buildUserTitle(user);
    const streak   = user.streak ? ` 🔥 ${user.streak}` : '';
    $el.avatarContainer.setAttribute('aria-label', `${greeting} ${title}${streak} – فتح القائمة`);
  }
}

function _applyGuestState() {
  resetAvatarToDefault();

  if ($el.verificationBadge) $el.verificationBadge.style.display = 'none';
  if ($el.searchBtn)         $el.searchBtn.style.display         = 'none';

  if ($el.avatarContainer) {
    $el.avatarContainer.setAttribute('aria-label', 'فتح القائمة – الضيف');
  }
}

// ==== 7. نظام الأفاتار والإطار ====

function updateUserAvatarAndFrame(user) {
  const container = $el.avatarContainer;
  if (!container) return;

  if (!user) {
    resetAvatarToDefault();
    return;
  }

  let avatarElement = container.querySelector('.avatar-wrapper');
  if (!avatarElement) {
    avatarElement = createAvatarElement(user, 'sm', {
      showFrame: true,
      showBadge: false,
      clickable: true,
      onClick: () => window.drawer?.open()
    });
    container.innerHTML = '';
    container.appendChild(avatarElement);
  } else {
    updateAvatarElement(avatarElement, user);
  }

  if ($el.verificationBadge) {
    $el.verificationBadge.style.display = shouldShowVerificationBadge(user) ? 'flex' : 'none';
  }
}

function resetAvatarToDefault() {
  const container = $el.avatarContainer;
  if (!container) return;

  const guestAvatar = createAvatarElement(null, 'sm', {
    showFrame: true,
    showBadge: false,
    clickable: false
  });
  container.innerHTML = '';
  container.appendChild(guestAvatar);

  if ($el.verificationBadge) $el.verificationBadge.style.display = 'none';
}

// ==== 8. إدارة عداد الإشعارات ====

function setNotificationsCount(count) {
  const num = Math.max(0, parseInt(count) || 0);
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
  navbarState.currentPage = page;
  updateActiveNavButton(page);
}

function updateActiveNavButton(page) {
  if (!$el.bottomNavBtns.length) return;

  const activeTarget = PAGE_TO_NAV_MAP[page] || null;

  $el.bottomNavBtns.forEach(btn => {
    const target   = btn.dataset.navTarget;
    const isActive = activeTarget && target === activeTarget;

    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

// ==== 10. مراقبة حالة الاتصال ====

let _onlineHandler  = null;
let _offlineHandler = null;

function startOnlineStatusMonitoring() {
  stopOnlineStatusMonitoring();

  _onlineHandler = () => _handleConnectionChange(true);
  _offlineHandler = () => _handleConnectionChange(false);

  window.addEventListener('online',  _onlineHandler);
  window.addEventListener('offline', _offlineHandler);

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

function _applyConnectionStatus(isOnline) {
  const navbar = $el.navbarTop;
  if (!navbar) return;

  navbar.classList.toggle('navbar--offline', !isOnline);
  navbar.classList.toggle('navbar--online',   isOnline);

  if ($el.notificationBtn) {
    $el.notificationBtn.title = isOnline
      ? 'متصل بالإنترنت'
      : 'غير متصل – تعمل بوضع Offline';
  }
}

// ==== 11. إخفاء الشريط السفلي عند التمرير ====

let scrollHandlerRef = null;
let resizeObserver   = null;

function initializeAutoHideBottomNav() {
  destroyAutoHideBottomNav();

  if (!$el.bottomNav) return;

  scrollHandlerRef = () => {
    if (!navbarState.isMobile) return;
    const currentScrollY = window.scrollY;
    const bottomNav      = $el.bottomNav;
    if (!bottomNav) return;

    const THRESHOLD = 10;
    if (Math.abs(currentScrollY - navbarState.lastScrollY) < THRESHOLD) return;

    if (currentScrollY > navbarState.lastScrollY && currentScrollY > 50) {
      bottomNav.classList.add('hide');
      navbarState._scrollState.isHidden = true;
    } else if (currentScrollY < navbarState.lastScrollY) {
      bottomNav.classList.remove('hide');
      navbarState._scrollState.isHidden = false;
    }
    navbarState.lastScrollY = currentScrollY;
  };

  const checkIsMobile = () => {
    navbarState.isMobile = window.innerWidth < 768;

    if (!navbarState.isMobile) {
      $el.bottomNav?.classList.remove('hide');
      navbarState._scrollState.isHidden = false;
      window.removeEventListener('scroll', scrollHandlerRef);
    } else {
      navbarState.lastScrollY = window.scrollY;
      window.removeEventListener('scroll', scrollHandlerRef);
      window.addEventListener('scroll', scrollHandlerRef, { passive: true });
    }
  };

  if (window.ResizeObserver) {
    resizeObserver = new ResizeObserver(checkIsMobile);
    resizeObserver.observe(document.body);
  } else {
    window.addEventListener('resize', checkIsMobile);
    _trackListener(window, 'resize', checkIsMobile);
  }

  checkIsMobile();
}

function destroyAutoHideBottomNav() {
  if (scrollHandlerRef) {
    window.removeEventListener('scroll', scrollHandlerRef);
    scrollHandlerRef = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  navbarState._scrollState.isHidden = false;
}

function _hideBottomNav() {
  if (!$el.bottomNav || navbarState._scrollState.isHidden) return;
  $el.bottomNav.classList.add('hide');
  navbarState._scrollState.isHidden = true;
}

function _showBottomNav() {
  if (!$el.bottomNav || !navbarState._scrollState.isHidden) return;
  $el.bottomNav.classList.remove('hide');
  navbarState._scrollState.isHidden = false;
}

// ==== 12. ربط الأحداث ====

function bindEvents() {
  if ($el.avatarContainer) {
    const openDrawer = (e) => {
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (window.drawer?.open) window.drawer.open();
    };
    $el.avatarContainer.addEventListener('click',   openDrawer);
    $el.avatarContainer.addEventListener('keydown', openDrawer);
    _trackListener($el.avatarContainer, 'click',   openDrawer);
    _trackListener($el.avatarContainer, 'keydown', openDrawer);
  }

  $el.bottomNavBtns.forEach(btn => {
    const handler = (e) => {
      e.preventDefault();
      const target = btn.dataset.navTarget;
      const action = btn.dataset.action;

if (action === 'open-sidebar' || btn.id === 'open-drawer-btn') {
  if (window.drawer?.open) {
    window.drawer.open();
  } else {
    if (window.modals?.toast) {
      window.modals.toast('جاري تحميل القائمة الجانبية...', 'info');
    }
    let attempts = 0;
    const maxAttempts = 20;
    const waitForDrawer = setInterval(() => {
      attempts++;
      if (window.drawer?.open) {
        clearInterval(waitForDrawer);
        window.drawer.open();
      } else if (attempts >= maxAttempts) {
        clearInterval(waitForDrawer);
        console.warn('[Navbar] تعذّر فتح القائمة الجانبية — لم يتم تحميل drawer.js في الوقت المناسب');
      }
    }, 100);
  }
  return;
}

      if (target && window.router?.navigateTo) {
        window.router.navigateTo(target);
      }
    };
    btn.addEventListener('click', handler);
    _trackListener(btn, 'click', handler);
  });

  if ($el.searchBtn) {
    const openSearch = () => {
      if (window.searchAPI?.open) window.searchAPI.open();
    };
    $el.searchBtn.addEventListener('click', openSearch);
    _trackListener($el.searchBtn, 'click', openSearch);
  }

  if ($el.themeToggle) {
  const toggleThemeHandler = () => {
    const newTheme = toggleTheme();
    _updateThemeToggleIcon(newTheme);
    if (window.drawer?.isOpen?.()) window.drawer.close();
  };
  $el.themeToggle.addEventListener('click', toggleThemeHandler);
  _trackListener($el.themeToggle, 'click', toggleThemeHandler);
}
}

function subscribeToGlobalEvents() {
  const onUserStateChanged = (data) => {
    const user = data?.user || null;
    updateNavbarUI(user);
  };

  const onProfileUpdated = (data) => {
    const user = data?.user || getCurrentUser();
    if (user) {
      updateUserAvatarAndFrame(user);
      navbarState.currentUser = user;
    }
  };

  const onStreakUpdated = (data) => {
    if (!navbarState.currentUser) return;
    const streak = data?.streak || 0;
    navbarState.currentUser.streak = streak;

    if ($el.avatarContainer && navbarState.currentUser) {
      const greeting = getTimeGreeting();
      const title    = buildUserTitle(navbarState.currentUser);
      const streakTxt = streak >= 5 ? ` 🔥 ${streak}` : '';
      $el.avatarContainer.setAttribute('aria-label',
        `${greeting} ${title}${streakTxt} – فتح القائمة`
      );
    }
  };

  const onRouterNavigated = (data) => {
    const page = data?.page || data?.route || 'home';
    updateCurrentPage(page);
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

  const unsubs = [
    EventBus.on('userStateChanged',           onUserStateChanged),
    EventBus.on('profileUpdated',             onProfileUpdated),
    EventBus.on('avatarUpdated',              onProfileUpdated),
    EventBus.on('streak:updated',             onStreakUpdated),
    EventBus.on('pageChanged',                onRouterNavigated),
    EventBus.on('notifications:countChanged', onNotificationsUpdated),
    EventBus.on('newNotification',            onNotificationsUpdated),
    EventBus.on('theme:toggled',              onThemeChanged),
  ];

  const docUserStateHandler = (e) => onUserStateChanged(e.detail);
  document.addEventListener('userStateChanged', docUserStateHandler);

  navbarState.eventUnsubscribers = unsubs;
  navbarState._domListeners.push({
    el: document, type: 'userStateChanged', fn: docUserStateHandler
  });
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

function _trackListener(el, type, fn) {
  navbarState._domListeners.push({ el, type, fn });
}

function _updateThemeToggleIcon(theme) {
  if (!$el.themeToggle) return;
  const isDark = theme === 'dark';
  $el.themeToggle.setAttribute('aria-pressed', String(isDark));
  $el.themeToggle.setAttribute('aria-label', isDark ? 'تفعيل الوضع النهاري' : 'تفعيل الوضع الليلي');
  $el.themeToggle.setAttribute('title',      isDark ? 'الوضع النهاري'       : 'الوضع الليلي');
}

// ==== 13. دورة الحياة ====

async function initializeNavbar() {
  if (navbarState.isInitialized) {
    console.warn('[Navbar] تم تهيئة الـ Navbar مسبقاً');
    return;
  }

  console.log('[Navbar] 🚀 بدء تهيئة شريط التنقل v5.0.0...');

  try {
    bindDomRefs();

    const user = getCurrentUser();

    updateNavbarUI(user);

    startOnlineStatusMonitoring();

    initializeAutoHideBottomNav();

    bindEvents();

    startLogoAnimation($el.dynamicLogo);

    subscribeToGlobalEvents();

    const currentRoute = window.router?.getCurrentRoute?.() || 'home';
    updateCurrentPage(currentRoute);

    const currentTheme = getCurrentTheme();
_updateThemeToggleIcon(currentTheme);

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

  stopLogoAnimation();

  unbindEvents();

  navbarState.isInitialized = false;
  console.log('[Navbar] 🧹 تم تنظيف شريط التنقل');
}

async function reinitializeNavbar() {
  destroyNavbar();
  await initializeNavbar();
}

// ==== 14. بوابات التحكم الخارجي ====

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
    isInitialized:     navbarState.isInitialized,
    currentPage:       navbarState.currentPage,
    isOnline:          navbarState.isOnline,
    notificationsCount: navbarState.notificationsCount,
    currentUser:       navbarState.currentUser
      ? { id: navbarState.currentUser.id, user_type: navbarState.currentUser.user_type }
      : null
  };
}

// ==== 15. الواجهة العامة ====

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
  startOnlineStatusMonitoring,
  stopOnlineStatusMonitoring,
  initializeAutoHideBottomNav,
  destroyAutoHideBottomNav
};

window.navbar = _publicAPI;

// ==== 16. التصدير ====
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
