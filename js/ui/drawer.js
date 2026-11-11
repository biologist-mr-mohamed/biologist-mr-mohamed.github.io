/* القائمة الجانبية - v5.0.0 */

// ==== 1. الاستيراد ====
import { clearSession, getCurrentUser } from '../core/session.js';
import { createAvatarElement } from '../utils/avatar.js';
import { EventBus } from '../core/event-bus.js';

// ==== 2. الثوابت ====
const DRAWER_CONSTANTS = Object.freeze({
  OPEN_CLASS: 'drawer-open',
  OVERLAY_VISIBLE_CLASS: 'overlay-visible',
  DRAGGING_CLASS: 'drawer-dragging',
  EDGE_ZONE_PX: 20,
  EDGE_OPEN_DISTANCE: 50,
  DRAG_LOCK_DISTANCE: 8,
  DRAG_CLOSE_RATIO: 0.3,
  DRAG_CLOSE_VELOCITY: 0.5,
  FOCUS_DELAY_MS: 100,
  LOGOUT_NAVIGATE_DELAY_MS: 300,
  LOGOUT_TOAST_DELAY_MS: 400,
  PLATFORM_URL: 'https://biologist-mr-mohamed.netlify.app/'
});

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const STREAK_LEVEL_CLASSES = ['streak--low', 'streak--medium', 'streak--high', 'streak--legend'];

const ROLE_LABELS = Object.freeze({ student: 'طالب', moderator: 'مشرف', teacher: 'معلم' });

const ROLE_MESSAGES = Object.freeze({
  student: 'استمر يا بطل 💪',
  teacher: 'أنت تقود الجيل 🚀',
  moderator: 'تحكم كامل 🔥'
});

const ADD_MENU_ITEMS = Object.freeze([
  { type: 'lesson', icon: 'fa-book', label: 'درس جديد', roles: ['teacher', 'moderator'] },
  { type: 'exam', icon: 'fa-file-alt', label: 'امتحان جديد', roles: ['teacher', 'moderator'] },
  { type: 'event', icon: 'fa-calendar-plus', label: 'حدث / إعلان', roles: ['teacher', 'moderator'] },
  { type: 'unit', icon: 'fa-layer-group', label: 'وحدة / باب', roles: ['teacher'] },
  { type: 'moderator', icon: 'fa-user-shield', label: 'مشرف جديد', roles: ['teacher'] }
]);

// ==== 3. سجل عناصر DOM ====
const $drawerElements = {
  sidebar: null,
  overlay: null,
  openBtn: null,
  closeBtn: null,
  avatarContainer: null,
  userName: null,
  userRole: null,
  streak: null,
  streakCount: null,
  loggedSection: null,
  guestSection: null,
  logoutBtn: null,
  teacherItems: null,
  moderatorItems: null,
  addButton: null,
  shareBtn: null,
  copyLinkBtn: null,
  themeToggle: null,
  stats: null,
  progress: null,
  progressFill: null,
  progressPercent: null,
  lastActivity: null,
  lastActivityText: null,
  greeting: null,
  roleBanner: null,
  devInfo: null
};

// ==== 4. حالة القائمة ====
function createDragState() {
  return { active: false, axis: null, startX: 0, startY: 0, dx: 0, lastX: 0, lastT: 0, velocity: 0 };
}

const $drawerState = {
  isOpen: false,
  isInitialized: false,
  routeKey: '',
  edgeStartX: 0,
  eventUnsubscribers: [],
  drag: createDragState()
};

// ==== 5. دوال مساعدة ====
function getUserRoleArabic(userType) {
  return ROLE_LABELS[userType] || 'مستخدم';
}

function getRoleMessage(user) {
  if (!user) return '';
  return ROLE_MESSAGES[user.user_type] || 'مرحباً بك 🌟';
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'صباح الخير ☀️';
  if (hour < 18) return 'مساء الخير 🌤️';
  return 'مساء النور 🌙';
}

function getActiveTheme() {
  return document.documentElement.getAttribute('data-theme')
    || document.body?.getAttribute('data-theme')
    || 'light';
}

function safeToast(message, type = 'info') {
  if (window.modals?.toast) window.modals.toast(message, type);
}

function setVisible(el, visible) {
  if (el) el.hidden = !visible;
}

function formatLastActivity(lastActivity) {
  const empty = 'لا يوجد نشاط حديث';
  if (!lastActivity) return empty;

  let date;
  if (lastActivity?.toDate) date = lastActivity.toDate();
  else if (lastActivity?.seconds) date = new Date(lastActivity.seconds * 1000);
  else date = new Date(lastActivity);

  if (Number.isNaN(date.getTime())) return empty;

  const diffMins = Math.floor((Date.now() - date.getTime()) / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'الآن';
  if (diffMins < 60) return `منذ ${diffMins} دقيقة`;
  if (diffHours < 24) return `منذ ${diffHours} ساعة`;
  return `منذ ${diffDays} يوم`;
}

function getFocusableElements() {
  if (!$drawerElements.sidebar) return [];
  return Array.from($drawerElements.sidebar.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => !el.closest('[hidden]') && el.getClientRects().length > 0);
}

async function copyText(text, successMessage, fallbackLabel) {
  try {
    await navigator.clipboard.writeText(text);
    safeToast(successMessage, 'success');
  } catch (_) {
    safeToast(`${fallbackLabel}: ${text}`, 'info');
  }
}

// ==== 6. الصلاحيات ====
function updateRoleBasedElements(user) {
  const isTeacher = user?.user_type === 'teacher';
  const isModerator = user?.user_type === 'moderator';

  $drawerElements.teacherItems?.forEach(item => setVisible(item, isTeacher));
  $drawerElements.moderatorItems?.forEach(item => setVisible(item, isModerator));
  $drawerElements.sidebar?.querySelectorAll('.teacher-or-supervisor-only')
    .forEach(el => setVisible(el, isTeacher || isModerator));
}

// ==== 7. مفتاح الوضع الليلي ====
function syncThemeToggleState() {
  $drawerElements.themeToggle?.setAttribute('aria-checked', String(getActiveTheme() === 'dark'));
}

// ==== 8. الرابط النشط ====
function normalizeRouteKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');
}

function resolveRouteKey(payload) {
  const raw = payload?.route ?? payload?.page ?? payload?.name ?? payload?.to ?? payload?.path ?? payload;
  const candidate = typeof raw === 'string' ? raw : (raw?.name || raw?.path || '');
  if (candidate) return normalizeRouteKey(candidate);

  const current = window.router?.getCurrentRoute?.() ?? window.router?.currentRoute;
  const fromRouter = typeof current === 'string' ? current : (current?.name || current?.path || '');
  if (fromRouter) return normalizeRouteKey(fromRouter);

  const segments = [
    ...window.location.pathname.split('/'),
    ...window.location.hash.replace(/^#\/?/, '').split('/')
  ].filter(Boolean);
  return normalizeRouteKey(segments[0] || 'home');
}

function syncActiveLink(payload) {
  if (!$drawerElements.sidebar) return;

  let routeKey;
  if (payload !== undefined) {
    routeKey = resolveRouteKey(payload);
    $drawerState.routeKey = routeKey;
  } else {
    routeKey = $drawerState.routeKey || resolveRouteKey();
  }

  $drawerElements.sidebar.querySelectorAll('.sidebar-link[data-nav-target]').forEach(link => {
    const target = normalizeRouteKey(link.dataset.navTarget);
    const isActive = Boolean(routeKey && target && routeKey.startsWith(target));
    link.classList.toggle('active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

// ==== 9. تهيئة عناصر DOM ====
function initDrawerElements() {
  const byId = id => document.getElementById(id);
  const el = $drawerElements;

  el.sidebar = byId('sidebar');
  el.overlay = byId('sidebar-overlay');
  el.openBtn = byId('open-drawer-btn');
  el.closeBtn = byId('close-sidebar');
  el.avatarContainer = byId('sidebar-avatar-container');
  el.userName = byId('sidebar-user-name');
  el.userRole = byId('sidebar-user-role');
  el.streak = byId('sidebar-streak');
  el.streakCount = byId('streak-count');
  el.loggedSection = document.querySelector('.sidebar-logged');
  el.guestSection = document.querySelector('.sidebar-guest');
  el.logoutBtn = byId('logout-btn');
  el.teacherItems = document.querySelectorAll('.sidebar .teacher-only');
  el.moderatorItems = document.querySelectorAll('.sidebar .moderator-only');
  el.addButton = byId('add-button');
  el.shareBtn = byId('share-app-btn');
  el.copyLinkBtn = byId('copy-link-btn');
  el.themeToggle = document.querySelector('.theme-toggle-sidebar');
  el.stats = byId('sidebar-user-stats');
  el.progress = byId('sidebar-progress-container');
  el.progressFill = byId('sidebar-progress-bar');
  el.progressPercent = byId('sidebar-progress-percent');
  el.lastActivity = byId('sidebar-last-activity');
  el.lastActivityText = byId('sidebar-last-activity-text');
  el.greeting = byId('sidebar-greeting');
  el.roleBanner = byId('role-banner');
  el.devInfo = byId('dev-info');

  const missing = ['sidebar', 'overlay', 'openBtn', 'closeBtn'].filter(key => !el[key]);
  if (missing.length) {
    console.warn('⚠️ عناصر القائمة المفقودة:', missing);
    return false;
  }
  return true;
}

// ==== 10. التحكم الأساسي ====
function openDrawer() {
  const { sidebar, overlay } = $drawerElements;
  if (!sidebar || $drawerState.isOpen) return;

  try {
    sidebar.inert = false;
    sidebar.classList.add(DRAWER_CONSTANTS.OPEN_CLASS);
    sidebar.setAttribute('aria-hidden', 'false');

    overlay?.classList.add(DRAWER_CONSTANTS.OVERLAY_VISIBLE_CLASS);
    overlay?.setAttribute('aria-hidden', 'false');

    document.body.classList.add(DRAWER_CONSTANTS.OPEN_CLASS);
    $drawerElements.openBtn?.setAttribute('aria-expanded', 'true');
    $drawerState.isOpen = true;

    requestAnimationFrame(() => {
      if (!$drawerState.isOpen) return;
      document.addEventListener('keydown', handleDrawerKeydown);
    });

    syncActiveLink();
    syncThemeToggleState();
    updateGreeting();

    setTimeout(() => {
      if ($drawerState.isOpen) getFocusableElements()[0]?.focus();
    }, DRAWER_CONSTANTS.FOCUS_DELAY_MS);

    document.dispatchEvent(new CustomEvent('drawerOpened'));
  } catch (error) {
    console.error('❌ خطأ في فتح القائمة:', error);
  }
}

function closeDrawer(force = false) {
  const { sidebar, overlay, openBtn } = $drawerElements;
  if (!sidebar || (!$drawerState.isOpen && !force)) return;

  try {
    sidebar.classList.remove(DRAWER_CONSTANTS.OPEN_CLASS, DRAWER_CONSTANTS.DRAGGING_CLASS);
    sidebar.setAttribute('aria-hidden', 'true');
    sidebar.inert = true;
    sidebar.style.removeProperty('--drawer-drag');

    overlay?.classList.remove(DRAWER_CONSTANTS.OVERLAY_VISIBLE_CLASS, DRAWER_CONSTANTS.DRAGGING_CLASS);
    overlay?.setAttribute('aria-hidden', 'true');
    overlay?.style.removeProperty('--overlay-progress');

    document.body.classList.remove(DRAWER_CONSTANTS.OPEN_CLASS);
    openBtn?.setAttribute('aria-expanded', 'false');

    document.removeEventListener('keydown', handleDrawerKeydown);

    $drawerState.isOpen = false;

    if (openBtn && document.body.contains(openBtn)) {
      setTimeout(() => {
        try { openBtn.focus({ preventScroll: true }); } catch (_) { }
      }, DRAWER_CONSTANTS.FOCUS_DELAY_MS);
    }

    document.dispatchEvent(new CustomEvent('drawerClosed'));
  } catch (error) {
    console.error('❌ خطأ في إغلاق القائمة:', error);
    $drawerState.isOpen = false;
    document.body.classList.remove(DRAWER_CONSTANTS.OPEN_CLASS);
  }
}

function toggleDrawer() {
  if ($drawerState.isOpen) closeDrawer();
  else openDrawer();
}

// ==== 11. مستمعات النقر والكيبورد ====
function handleDrawerKeydown(event) {
  if (!$drawerState.isOpen) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    closeDrawer();
    return;
  }

  if (event.key !== 'Tab') return;

  const focusable = getFocusableElements();
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (!$drawerElements.sidebar.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

// ==== 12. إيماءات اللمس ====
function resetDragState() {
  $drawerState.drag = createDragState();
}

function handleEdgeSwipeStart(event) {
  if (event.touches.length !== 1) return;
  $drawerState.edgeStartX = event.touches[0].clientX;
}

function handleEdgeSwipeEnd(event) {
  if (event.changedTouches.length !== 1 || $drawerState.isOpen) return;

  const startX = $drawerState.edgeStartX;
  const deltaX = event.changedTouches[0].clientX - startX;
  if (startX < DRAWER_CONSTANTS.EDGE_ZONE_PX && deltaX > DRAWER_CONSTANTS.EDGE_OPEN_DISTANCE) {
    openDrawer();
  }
}

function handleTouchStart(event) {
  if (!$drawerState.isOpen || event.touches.length !== 1) return;

  const touch = event.touches[0];
  $drawerState.drag = {
    ...createDragState(),
    active: true,
    startX: touch.clientX,
    startY: touch.clientY,
    lastX: touch.clientX,
    lastT: performance.now()
  };
}

function handleTouchMove(event) {
  const drag = $drawerState.drag;
  if (!drag.active || !$drawerState.isOpen || event.touches.length !== 1) return;

  const { sidebar, overlay } = $drawerElements;
  const touch = event.touches[0];
  const dx = touch.clientX - drag.startX;
  const dy = touch.clientY - drag.startY;

  if (drag.axis === null) {
    const lock = DRAWER_CONSTANTS.DRAG_LOCK_DISTANCE;
    if (Math.abs(dx) < lock && Math.abs(dy) < lock) return;

    drag.axis = (Math.abs(dx) > Math.abs(dy) * 1.2 && dx < 0) ? 'x' : 'y';
    if (drag.axis === 'x') {
      sidebar.classList.add(DRAWER_CONSTANTS.DRAGGING_CLASS);
      overlay?.classList.add(DRAWER_CONSTANTS.DRAGGING_CLASS);
    }
  }
  if (drag.axis !== 'x') return;

  event.preventDefault();

  const now = performance.now();
  const dt = now - drag.lastT;
  if (dt > 0) drag.velocity = (touch.clientX - drag.lastX) / dt;
  drag.lastX = touch.clientX;
  drag.lastT = now;

  drag.dx = Math.min(0, dx);
  const width = sidebar.offsetWidth || 1;
  sidebar.style.setProperty('--drawer-drag', `${drag.dx}px`);
  overlay?.style.setProperty('--overlay-progress', String(Math.max(0, 1 + drag.dx / width)));
}

function handleTouchEnd() {
  const drag = $drawerState.drag;
  if (!drag.active) return;

  const { sidebar, overlay } = $drawerElements;

  if (drag.axis === 'x' && sidebar) {
    const width = sidebar.offsetWidth || 1;
    const shouldClose =
      Math.abs(drag.dx) > width * DRAWER_CONSTANTS.DRAG_CLOSE_RATIO ||
      drag.velocity < -DRAWER_CONSTANTS.DRAG_CLOSE_VELOCITY;

    sidebar.classList.remove(DRAWER_CONSTANTS.DRAGGING_CLASS);
    overlay?.classList.remove(DRAWER_CONSTANTS.DRAGGING_CLASS);

    if (shouldClose) {
      closeDrawer();
    } else {
      sidebar.style.removeProperty('--drawer-drag');
      overlay?.style.removeProperty('--overlay-progress');
    }
  }

  resetDragState();
}

function initSwipeGestures() {
  const { sidebar } = $drawerElements;
  if (!sidebar || !('ontouchstart' in window)) return;

  sidebar.addEventListener('touchstart', handleTouchStart, { passive: true });
  sidebar.addEventListener('touchmove', handleTouchMove, { passive: false });
  sidebar.addEventListener('touchend', handleTouchEnd, { passive: true });
  sidebar.addEventListener('touchcancel', handleTouchEnd, { passive: true });

  document.addEventListener('touchstart', handleEdgeSwipeStart, { passive: true });
  document.addEventListener('touchend', handleEdgeSwipeEnd, { passive: true });
}

function removeSwipeGestures() {
  const { sidebar } = $drawerElements;
  if (sidebar) {
    sidebar.removeEventListener('touchstart', handleTouchStart);
    sidebar.removeEventListener('touchmove', handleTouchMove);
    sidebar.removeEventListener('touchend', handleTouchEnd);
    sidebar.removeEventListener('touchcancel', handleTouchEnd);
  }
  document.removeEventListener('touchstart', handleEdgeSwipeStart);
  document.removeEventListener('touchend', handleEdgeSwipeEnd);
}

// ==== 13. تسجيل الخروج ====
async function handleLogout(event) {
  event?.stopPropagation();

  try {
    safeToast('جاري تسجيل الخروج...', 'info');
    await clearSession();
    updateDrawerContent(null);
    window.navbar?.updateAfterLogout?.();
    closeDrawer();

    setTimeout(() => window.router?.navigateTo?.('home'), DRAWER_CONSTANTS.LOGOUT_NAVIGATE_DELAY_MS);
    setTimeout(() => safeToast('تم تسجيل الخروج بنجاح', 'success'), DRAWER_CONSTANTS.LOGOUT_TOAST_DELAY_MS);
  } catch (error) {
    console.error('❌ خطأ في تسجيل الخروج:', error);
    safeToast('حدث خطأ أثناء تسجيل الخروج', 'error');
  }
}

// ==== 14. تبديل الثيم ====
function handleSidebarThemeToggle(event) {
  event.stopPropagation();
  if (typeof window.toggleTheme !== 'function') return;

  const result = window.toggleTheme();
  const theme = typeof result === 'string' ? result : getActiveTheme();

  syncThemeToggleState();
  safeToast(`تم التبديل للوضع ${theme === 'dark' ? 'الليلي' : 'النهاري'}`, 'success');
}

// ==== 15. المشاركة والنسخ ====
async function handleSharePlatform(event) {
  event?.stopPropagation();

  const shareData = {
    title: 'منصة بيولوجست التعليمية',
    text: 'انضم إلى منصة بيولوجست — تجربة تعليمية متكاملة لمادة الأحياء والعلوم 🌿',
    url: DRAWER_CONSTANTS.PLATFORM_URL
  };

  if (!navigator.share) {
    await copyText(DRAWER_CONSTANTS.PLATFORM_URL, 'تم نسخ رابط المنصة 📋', 'رابط المنصة');
    return;
  }

  try {
    await navigator.share(shareData);
    safeToast('تمت المشاركة بنجاح ✅', 'success');
  } catch (error) {
    if (error.name !== 'AbortError') {
      await copyText(DRAWER_CONSTANTS.PLATFORM_URL, 'تم نسخ رابط المنصة 📋', 'رابط المنصة');
    }
  }
}

function handleCopyCurrentLink(event) {
  event?.stopPropagation();
  return copyText(window.location.href, 'تم نسخ رابط الصفحة 📋', 'رابط الصفحة');
}

// ==== 16. قائمة الإضافة السريعة ====
async function openManagerForm({ globalName, method, load, loadingMessage, errorMessage }) {
  try {
    const manager = window[globalName];
    if (typeof manager?.[method] === 'function') {
      manager[method]();
      return;
    }

    safeToast(loadingMessage, 'info');
    const module = await load();
    if (typeof module[method] === 'function') module[method]();
  } catch (error) {
    console.error(`❌ ${errorMessage}:`, error);
    safeToast(errorMessage, 'error');
  }
}

const ADD_ACTIONS = {
  lesson: () => openManagerForm({
    globalName: 'lessonManager',
    method: 'openAddLessonModal',
    load: () => import('../../views/lessons/lesson-manager.js'),
    loadingMessage: 'جاري تحميل نموذج إضافة درس...',
    errorMessage: 'تعذّر تحميل نموذج الدرس'
  }),
  exam: () => openManagerForm({
    globalName: 'examManager',
    method: 'openAddExamModal',
    load: () => import('../../views/exams/exam-manager.js'),
    loadingMessage: 'جاري تحميل نموذج إضافة امتحان...',
    errorMessage: 'تعذّر تحميل نموذج الامتحان'
  }),
  unit: () => openManagerForm({
    globalName: 'lessonManager',
    method: 'openAddUnitModal',
    load: () => import('../../views/lessons/lesson-manager.js'),
    loadingMessage: 'جاري تحميل نموذج إضافة وحدة...',
    errorMessage: 'تعذّر تحميل نموذج الوحدة'
  }),
  event: () => openAddEventModal(),
  moderator: () => {
    if (window.router?.navigateTo) window.router.navigateTo('dashboard');
    else safeToast('توجه إلى لوحة التحكم لإضافة مشرف', 'info');
  }
};

function buildAddMenuHTML(items) {
  const itemsHTML = items.map(item => `
    <button class="add-menu-item" type="button" data-add-type="${item.type}" role="menuitem" aria-label="${item.label}">
      <span class="add-menu-icon add-menu-icon--${item.type}">
        <i class="fas ${item.icon}" aria-hidden="true"></i>
      </span>
      <span class="add-menu-label">${item.label}</span>
      <span class="add-menu-arrow">
        <i class="fas fa-chevron-left" aria-hidden="true"></i>
      </span>
    </button>
  `).join('');

  return `
    <div class="add-menu-container" role="menu" aria-label="قائمة الإضافة">
      <div class="add-menu-grid">${itemsHTML}</div>
      <div class="add-menu-footer">
        <p class="add-menu-note">
          <i class="fas fa-info-circle" aria-hidden="true"></i>
          أضف محتوى تعليمي جديد للمنصة
        </p>
      </div>
    </div>
  `;
}

function showAddMenu() {
  if (!window.modals?.showModal) {
    safeToast('هذه الميزة غير متاحة حالياً', 'warning');
    return;
  }

  const user = getCurrentUser();
  if (!user) {
    safeToast('يجب تسجيل الدخول أولاً', 'error');
    return;
  }

  const items = ADD_MENU_ITEMS.filter(item => item.roles.includes(user.user_type));
  if (!items.length) {
    safeToast('ليس لديك صلاحية لإضافة محتوى', 'error');
    return;
  }

  window.modals.showModal({
    title: 'إضافة محتوى جديد',
    html: buildAddMenuHTML(items),
    size: 'medium',
    buttons: [{ text: 'إلغاء', role: 'cancel', type: 'secondary' }],
    onOpen: () => {
      const container = document.querySelector('.add-menu-container');
      if (!container) return;

      container.addEventListener('click', (event) => {
        const button = event.target.closest('.add-menu-item');
        if (!button) return;

        window.modals.closeAllModals?.();
        ADD_ACTIONS[button.dataset.addType]?.();
      });
    }
  });
}

function handleAddButtonClick(event) {
  event.stopPropagation();
  closeDrawer(true);
  requestAnimationFrame(showAddMenu);
}

function openAddEventModal() {
  if (!window.modals?.showModal) return;

  window.modals.showModal({
    title: 'إضافة حدث أو إعلان',
    html: `
      <div class="add-event-form" role="form" aria-label="نموذج إضافة حدث">
        <div class="form-group">
          <label class="form-label" for="event-type">
            <i class="fas fa-tag input-icon" aria-hidden="true"></i> نوع المحتوى
            <span class="required-mark" aria-hidden="true">*</span>
          </label>
          <select id="event-type" class="form-control" required aria-required="true">
            <option value="event">حدث</option>
            <option value="announcement">إعلان</option>
            <option value="offer">عرض</option>
            <option value="feature">ميزة للطلاب</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="event-title">
            <i class="fas fa-heading input-icon" aria-hidden="true"></i> العنوان
            <span class="required-mark" aria-hidden="true">*</span>
          </label>
          <input type="text" id="event-title" class="form-control"
            placeholder="عنوان الحدث أو الإعلان" required aria-required="true" maxlength="200">
        </div>
        <div class="form-group">
          <label class="form-label" for="event-body">
            <i class="fas fa-align-left input-icon" aria-hidden="true"></i> التفاصيل
          </label>
          <textarea id="event-body" class="form-control" rows="4"
            placeholder="اكتب تفاصيل الحدث أو الإعلان هنا..." maxlength="1000"></textarea>
        </div>
      </div>
    `,
    buttons: [
      { text: 'إلغاء', role: 'cancel', type: 'secondary' },
      { text: 'نشر', role: 'confirm', type: 'primary' }
    ],
    onConfirm: async () => {
      const type = document.getElementById('event-type')?.value;
      const title = document.getElementById('event-title')?.value?.trim();
      const body = document.getElementById('event-body')?.value?.trim() || '';

      if (!type || !title) {
        safeToast('يرجى ملء الحقول المطلوبة', 'warning');
        return false;
      }

      EventBus.emit('platformEventCreated', { type, title, body, createdAt: Date.now() });
      safeToast('تم نشر الحدث بنجاح ✅', 'success');
      return true;
    }
  });
}

// ==== 17. تحديث عناصر المستخدم ====
function createStatItem(iconClass, value, label, title) {
  const item = document.createElement('span');
  item.className = 'sb-stat';
  item.title = title;

  const icon = document.createElement('i');
  icon.className = `fas ${iconClass} sb-stat-icon`;
  icon.setAttribute('aria-hidden', 'true');

  const valueEl = document.createElement('strong');
  valueEl.className = 'sb-stat-value';
  valueEl.textContent = String(value);

  const labelEl = document.createElement('small');
  labelEl.className = 'sb-stat-label';
  labelEl.textContent = label;

  item.append(icon, valueEl, labelEl);
  return item;
}

function createInfoRow(iconClass, text) {
  const row = document.createElement('div');
  row.className = 'sb-dev-info-row';

  const icon = document.createElement('i');
  icon.className = `fas ${iconClass}`;
  icon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.textContent = text;

  row.append(icon, label);
  return row;
}

function updateQuickStats(user) {
  const { stats } = $drawerElements;
  if (!stats) return;

  const isStudent = user?.user_type === 'student';
  if (isStudent) {
    stats.replaceChildren(
      createStatItem('fa-book', user.completed_lessons || 0, 'درس', 'الدروس المكتملة'),
      createStatItem('fa-file-alt', user.exams_taken || 0, 'امتحان', 'الامتحانات المؤداة'),
      createStatItem('fa-star', user.total_score || 0, 'نقطة', 'مجموع النقاط')
    );
  }
  setVisible(stats, isStudent);
}

function updateProgressBar(user) {
  const { progress, progressFill, progressPercent } = $drawerElements;
  if (!progress || !progressFill) return;

  const isStudent = user?.user_type === 'student';
  if (isStudent) {
    const value = Math.min(100, Math.max(0, Number(user.progress) || 0));
    progressFill.style.setProperty('--sb-progress', String(value));
    progressFill.parentElement?.setAttribute('aria-valuenow', String(value));
    if (progressPercent) progressPercent.textContent = `${value}%`;
  }
  setVisible(progress, isStudent);
}

function updateLastActivityDisplay(user) {
  const { lastActivity, lastActivityText } = $drawerElements;
  if (!lastActivity || !lastActivityText) return;

  lastActivityText.textContent = formatLastActivity(user?.last_activity);
  setVisible(lastActivity, true);
}

function updateGreeting() {
  if ($drawerElements.greeting) $drawerElements.greeting.textContent = getGreeting();
}

function updateRoleBanner(user) {
  const { roleBanner } = $drawerElements;
  if (!roleBanner) return;

  const message = getRoleMessage(user);
  roleBanner.textContent = message;
  setVisible(roleBanner, Boolean(message));
}

function updateStreakDisplay(user) {
  const { streak, streakCount } = $drawerElements;
  if (!streak) return;

  const isStudent = user?.user_type === 'student';
  setVisible(streak, isStudent);
  if (!isStudent || !streakCount) return;

  const days = user.streak || 0;
  streakCount.textContent = String(days);
  streak.classList.remove(...STREAK_LEVEL_CLASSES);

  if (days < 7) streak.classList.add('streak--low');
  else if (days < 30) streak.classList.add('streak--medium');
  else if (days < 100) streak.classList.add('streak--high');
  else streak.classList.add('streak--legend');

  streak.title = `${days} يوم متواصل 🔥`;
}

function updateDevInfo(user) {
  const { devInfo } = $drawerElements;
  if (!devInfo) return;

  const isTeacher = user?.user_type === 'teacher';
  if (isTeacher) {
    devInfo.replaceChildren(
      createInfoRow('fa-id-badge', `ID: ${user.id || '—'}`),
      createInfoRow('fa-user-tie', 'الدور: معلم / مدير')
    );
  }
  setVisible(devInfo, isTeacher);
}

function renderAvatar(user) {
  const { avatarContainer } = $drawerElements;
  if (!avatarContainer) return;

  const avatar = createAvatarElement(user, 'lg', {
    showFrame: true,
    showBadge: Boolean(user),
    clickable: Boolean(user),
    showPulse: Boolean(user),
    showShimmer: true,
    onClick: (userId) => window.router?.navigateTo?.('profile', { path: { id: userId } })
  });
  avatarContainer.replaceChildren(avatar);
}

function renderGuestState() {
  const el = $drawerElements;

  setVisible(el.guestSection, true);
  el.guestSection.setAttribute('aria-hidden', 'false');
  setVisible(el.loggedSection, false);
  el.loggedSection.setAttribute('aria-hidden', 'true');

  if (el.userName) el.userName.textContent = 'الضيف';
  if (el.userRole) el.userRole.textContent = 'يرجى تسجيل الدخول';
  if (el.greeting) el.greeting.textContent = '';

  renderAvatar(null);
  updateRoleBasedElements(null);

  [el.stats, el.progress, el.roleBanner, el.devInfo, el.streak, el.lastActivity]
    .forEach(node => setVisible(node, false));
}

function renderUserState(user) {
  const el = $drawerElements;

  setVisible(el.guestSection, false);
  el.guestSection.setAttribute('aria-hidden', 'true');
  setVisible(el.loggedSection, true);
  el.loggedSection.setAttribute('aria-hidden', 'false');

  if (el.userName) el.userName.textContent = user.full_name || user.username || 'المستخدم';
  if (el.userRole) el.userRole.textContent = getUserRoleArabic(user.user_type);

  renderAvatar(user);
  updateStreakDisplay(user);
  updateRoleBasedElements(user);
  updateGreeting();
  updateQuickStats(user);
  updateProgressBar(user);
  updateLastActivityDisplay(user);
  updateRoleBanner(user);
  updateDevInfo(user);
  syncThemeToggleState();
  syncActiveLink();
}

function updateDrawerContent(user = null) {
  if (!$drawerElements.guestSection || !$drawerElements.loggedSection) {
    console.warn('⚠️ عناصر المحتوى الرئيسية غير موجودة');
    return;
  }

  try {
    if (user) renderUserState(user);
    else renderGuestState();
  } catch (error) {
    console.error('❌ خطأ في تحديث محتوى القائمة:', error);
  }
}

// ==== 18. ربط الأحداث ====
function bindDrawerEvents() {
  const { openBtn, closeBtn, overlay, logoutBtn, themeToggle, addButton, shareBtn, copyLinkBtn, sidebar } = $drawerElements;

  openBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openDrawer();
  });

  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    closeDrawer(true);
  });

  overlay.addEventListener('click', () => closeDrawer(true));

  logoutBtn?.addEventListener('click', handleLogout);
  themeToggle?.addEventListener('click', handleSidebarThemeToggle);
  addButton?.addEventListener('click', handleAddButtonClick);
  shareBtn?.addEventListener('click', handleSharePlatform);
  copyLinkBtn?.addEventListener('click', handleCopyCurrentLink);

  sidebar.addEventListener('click', (event) => {
    const link = event.target.closest('[data-nav-target]');
    const target = link?.dataset.navTarget;
    if (!target || !window.router?.navigateTo) return;

    window.router.navigateTo(target);
    closeDrawer();
  });
}

function bindEventBus() {
  const subscribe = (name, handler) => $drawerState.eventUnsubscribers.push(EventBus.on(name, handler));

  subscribe('pageChanged', (payload) => {
    closeDrawer(true);
    syncActiveLink(payload);
  });
  subscribe('navigationStart', () => closeDrawer(true));
  subscribe('theme:toggled', syncThemeToggleState);
  subscribe('userStateChanged', ({ action, user } = {}) => {
    if (action === 'login' || action === 'logout') updateDrawerContent(user || null);
  });

  const refreshIfCurrentUser = (payload) => {
    const updated = payload?.user;
    const current = getCurrentUser();
    if (updated && current && updated.id === current.id) updateDrawerContent(updated);
  };

  subscribe('avatarUpdated', refreshIfCurrentUser);
  subscribe('profileUpdated', refreshIfCurrentUser);

  subscribe('streak:updated', ({ userId, streak } = {}) => {
    const current = getCurrentUser();
    if (current && current.id === userId) updateStreakDisplay({ ...current, streak });
  });
}

// ==== 19. التهيئة والتنظيف ====
function initializeDrawer() {
  if ($drawerState.isInitialized) return true;

  try {
    if (!initDrawerElements()) {
      console.error('❌ فشل تهيئة عناصر القائمة الجانبية');
      return false;
    }

    $drawerElements.sidebar.inert = true;

    bindDrawerEvents();
    initSwipeGestures();
    bindEventBus();

    updateDrawerContent(getCurrentUser());
    syncThemeToggleState();

    $drawerState.isInitialized = true;

    window.drawer = Object.assign(window.drawer || {}, {
      open: openDrawer,
      close: closeDrawer,
      toggle: toggleDrawer,
      updateContent: updateDrawerContent,
      isOpen: () => $drawerState.isOpen,
      initialized: true,
      refreshStats: () => updateDrawerContent(getCurrentUser()),
      sharePlatform: handleSharePlatform
    });

    return true;
  } catch (error) {
    console.error('❌ فشل تهيئة نظام القائمة:', error);
    return false;
  }
}

function destroyDrawer() {
  $drawerState.eventUnsubscribers.forEach(unsubscribe => {
    if (typeof unsubscribe === 'function') unsubscribe();
  });
  $drawerState.eventUnsubscribers = [];

  removeSwipeGestures();
  document.removeEventListener('keydown', handleDrawerKeydown);

  resetDragState();
  $drawerState.isInitialized = false;
  $drawerState.isOpen = false;
}

// ==== 20. التصدير ====
export {
  initializeDrawer,
  destroyDrawer,
  openDrawer,
  closeDrawer,
  toggleDrawer,
  updateDrawerContent,
  updateStreakDisplay
};
