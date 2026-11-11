/* نظام الإشعارات المتكامل - v5.0.0 */

// ==== 1. الاستيراد ====
import { getCurrentUser } from '../core/session.js';
import { EventBus }        from '../core/event-bus.js';

// ==== 2. الثوابت والتكوين ====
const CONFIG = Object.freeze({
  PANEL_ID:           'notifications-panel',
  BADGE_ID:           'notification-badge',
  TRIGGER_BTN_ID:     'notification-btn',
  CONTENT_ID:         'notifications-content',
  TABS_SELECTOR:      '.notifications-tabs',
  SEARCH_INPUT_ID:    'notifications-search-input',
  SELECT_ALL_ID:      'notifications-select-all',
  DELETE_SELECTED_ID: 'notifications-delete-selected',
  MARK_ALL_READ_ID:   'notifications-mark-all-read',
  CLOSE_BTN_ID:       'notifications-close-btn',
  CLEAR_ALL_BTN_ID:   'clear-notifications-btn',
  PAGE_SIZE:          12,
  THREE_MONTHS_MS:    7_776_000_000,
  SWIPE_THRESHOLD:    80,
  KEYBOARD_SHORTCUT:  'n',
  AUDIO_SETTING_KEY:  'notif_sound_enabled',
  FALLBACK_POLL_MS:   60_000,   // يعمل فقط لو فشل الاشتراك اللحظي
  MOBILE_QUERY:       '(max-width: 768px)',
});

// ==== 3. أنواع الإشعارات ====
const NOTIF_TYPES = Object.freeze({
  success:   { icon: 'fa-check-circle',        color: 'var(--success)' },
  info:      { icon: 'fa-info-circle',          color: 'var(--info)' },
  warning:   { icon: 'fa-exclamation-triangle', color: 'var(--warning)' },
  alert:     { icon: 'fa-exclamation-circle',   color: 'var(--error)' },
  exam:      { icon: 'fa-graduation-cap',       color: 'var(--secondary)' },
  lesson:    { icon: 'fa-book-open',            color: '#06b6d4' },
  comment:   { icon: 'fa-comment',              color: '#84cc16' },
  like:      { icon: 'fa-heart',                color: '#ec4899' },
  complaint: { icon: 'fa-flag',                 color: '#f97316' },
  system:    { icon: 'fa-cog',                  color: 'var(--text-secondary-light)' },
  default:   { icon: 'fa-bell',                 color: 'var(--text-tertiary-light)' },
});

// ==== 4. تعريف التبويبات ====
const TABS_CONFIG = Object.freeze({
  all:         { label: 'الكل',     roles: ['student','teacher','moderator'], filter: ()  => true },
  general:     { label: 'عامة',     roles: ['student','teacher','moderator'], filter: (n) => !n.sender || n.sender === 'system' },
  supervisors: { label: 'المشرفين', roles: ['moderator','teacher'],           filter: (n) => n.sender === 'moderator' },
  teachers:    { label: 'المعلمين', roles: ['teacher'],                       filter: (n) => n.sender === 'teacher' },
  complaints:  { label: 'الشكاوي', roles: ['teacher'],                       filter: (n) => n.type === 'complaint' },
});

// ==== 5. الحالة المركزية ====
const state = {
  initialized:    false,
  notifications:  [],        // كل إشعار = وثيقة Firestore واحدة
  filteredList:   [],        // عناصر العرض (قد يمثّل العنصر الواحد مجموعة وثائق: _docIds)
  selectedIds:    new Set(), // docId الممثِّل لكل عنصر عرض محدَّد
  currentTab:     'all',
  searchTerm:     '',
  visibleCount:   CONFIG.PAGE_SIZE,
  userRole:       null,
  userId:         null,
  hasLoaded:      false,     // وصلت أول دفعة بيانات؟
  loadError:      null,
};

// ==== 6. مراجع عناصر DOM ====
const elems = {
  panel: null, badge: null, trigger: null, content: null, tabsContainer: null,
  searchInput: null, selectAllChk: null, deleteSel: null, markAllRead: null,
  closeBtn: null, clearAllBtn: null,
};

// ==== 7. إدارة المستمعين (AbortController بدل مراجع يدوية) ====
let _staticAbort = null;   // مستمعو العناصر الثابتة + document (طوال عمر المكوّن)
let _panelAbort  = null;   // مستمعو اللوحة وهي مفتوحة فقط

// ==== 8. الاشتراكات ====
const _eventUnsubs = [];
let _dataUnsub    = null;  // إلغاء اشتراك Firestore اللحظي
let _pollTimer    = null;  // احتياطي فقط
let _connectedFor = null;  // المستخدم المتصل حالياً (يمنع إعادة الاتصال عند كل userStateChanged — T6)
let _connectToken = 0;

// ==== 9. مرجع api.js ====
let _apiRef = null;

// ==== 10. دوال مساعدة ====

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

function toMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.toDate   === 'function') return ts.toDate().getTime();
  if (ts.seconds) return ts.seconds * 1000;
  const n = new Date(ts).getTime();
  return Number.isNaN(n) ? 0 : n;
}

function formatTime(ts) {
  const ms = toMs(ts);
  if (!ms) return 'الآن';           // serverTimestamp لم يتأكد بعد
  const diff  = Date.now() - ms;
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);

  if (mins  <  1) return 'الآن';
  if (mins  < 60) return `منذ ${mins} د`;
  if (hours < 24) return `منذ ${hours} س`;
  if (days  <  7) return `منذ ${days} ي`;
  return new Date(ms).toLocaleDateString('ar-EG');
}

function normalizeRole(type) {
  return type === 'teacher' || type === 'moderator' ? type : 'student';
}

function filterOldNotifications(list) {
  const cutoff = Date.now() - CONFIG.THREE_MONTHS_MS;
  // إشعار بلا تاريخ (قيد الكتابة) يُعتبر جديداً ولا يُحذف من العرض
  return list.filter(n => { const ms = toMs(n.created_at); return ms === 0 || ms >= cutoff; });
}

// دمج الإعجابات/التعليقات المتشابهة على الدرس نفسه.
// كل عنصر عرض يحمل _docIds (كل الوثائق التي يمثلها) كي تعمل
// عمليات «مقروء» و«حذف» على المجموعة كاملة وليس على وثيقة واحدة.
function groupSimilarNotifications(list) {
  const groups = new Map();
  const out    = [];

  for (const n of list) {
    const groupable = (n.type === 'like' || n.type === 'comment') && n.related_lesson;
    if (!groupable) { out.push({ ...n, _docIds: [n.docId] }); continue; }

    const key = `${n.type}_${n.related_lesson}`;
    const g   = groups.get(key);
    if (!g) {
      const item = { ...n, _docIds: [n.docId], _groupCount: 1, _allRead: n.read === true };
      groups.set(key, item);
      out.push(item);
    } else {
      g._docIds.push(n.docId);
      g._groupCount++;
      g._allRead = g._allRead && n.read === true;
      if (toMs(n.created_at) > toMs(g.created_at)) g.created_at = n.created_at;
    }
  }

  out.forEach(item => { if (item._groupCount > 1) item.read = item._allRead; });
  return out;
}

let _audioCtx = null;
function playNotificationSound() {
  try {
    if (localStorage.getItem(CONFIG.AUDIO_SETTING_KEY) !== 'true') return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!_audioCtx) _audioCtx = new Ctx();       // سياق واحد مُعاد استخدامه (المتصفحات تحدّد عدد السياقات)
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});

    const osc  = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.4);
    osc.start();
    osc.stop(_audioCtx.currentTime + 0.4);
  } catch (_e) { /* الصوت اختياري */ }
}

function showToast(msg, type = 'info') {
  if (window.modals?.toast) window.modals.toast(msg, type);
  else console.log(`[Notifications] ${type}: ${msg}`);
}

function confirmDialog(msg, { danger = false } = {}) {
  if (window.modals?.confirm) {
    // modals.confirm يُرجع Promise بنفسه
    return window.modals.confirm({
      title: 'تأكيد',
      message: msg,
      type: danger ? 'danger' : 'default',
    });
  }
  return Promise.resolve(window.confirm(msg));
}

function unreadCount() {
  return state.notifications.filter(n => !n.read).length;
}

function describeError(err) {
  switch (err?.code) {
    case 'permission-denied':   return 'لا تملك صلاحية قراءة الإشعارات (راجع قواعد Firestore)';
    case 'failed-precondition': return 'الاستعلام يحتاج فهرساً في Firestore';
    case 'unavailable':         return 'لا يوجد اتصال بالخادم حالياً';
    default:                    return 'تعذّر تحميل الإشعارات';
  }
}

// ==== 11. طبقة البيانات ====
const NotificationsData = (() => {

  // ملاحظة: لا نُخفي فشل الاستيراد خلف دوال وهمية (كان يُظهر «لا توجد إشعارات» بدل الخطأ الحقيقي).
  async function _getApi() {
    if (!_apiRef) _apiRef = await import('../core/api.js');
    return _apiRef;
  }

  function _applyData(rawList, { silent = false } = {}) {
    const list    = filterOldNotifications(rawList || []);
    const prevIds = new Set(state.notifications.map(n => n.docId));
    const newOnes = state.hasLoaded
      ? list.filter(n => !n.read && !prevIds.has(n.docId))
      : [];                                   // أول دفعة = ليست «جديدة» (لا صوت ولا أحداث)

    state.notifications = list;
    state.hasLoaded     = true;
    state.loadError     = null;

    // أزل من التحديد ما لم يعد موجوداً
    const existing = new Set(list.map(n => n.docId));
    [...state.selectedIds].forEach(id => { if (!existing.has(id)) state.selectedIds.delete(id); });

    NotificationsFilter.buildFiltered();
    NotificationsBadge.update();
    NotificationsFilter.updateTabBadges();

    if (NotificationsPanel.isOpen() || !elems.content?.children.length) NotificationsView.render();

    if (newOnes.length && !silent) {
      playNotificationSound();
      const count = unreadCount();
      newOnes.forEach(n => EventBus.emit('newNotification', { ...n, count, _local: true }));
    }
  }

  function _handleError(err) {
    console.error('[Notifications] خطأ في الجلب:', err?.code || '', err?.message || err);
    state.loadError = err;
    if (!state.hasLoaded) NotificationsView.renderError(describeError(err));
    // الاشتراك اللحظي توقّف عند الخطأ ← احتياطي بالاستعلام الدوري (إلا لو كان الخطأ صلاحيات)
    if (err?.code !== 'permission-denied') _startFallbackPolling();
  }

  async function _fetchOnce() {
    if (!state.userId) return;
    try {
      const api = await _getApi();
      _applyData(await api.getUserNotifications(state.userId));
    } catch (err) {
      _handleError(err);
    }
  }

  function _startFallbackPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(_fetchOnce, CONFIG.FALLBACK_POLL_MS);
    _fetchOnce();
  }

  function _stopFallbackPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  async function connect(userId) {
    if (_connectedFor === userId && (_dataUnsub || _pollTimer)) return;   // لا إعادة اتصال بلا داعٍ (T6)
    disconnect();
    _connectedFor = userId;
    const token = ++_connectToken;

    try {
      const api = await _getApi();
      if (token !== _connectToken) return;                                // تغيّر المستخدم أثناء التحميل
      if (typeof api.subscribeToUserNotifications === 'function') {
        _dataUnsub = api.subscribeToUserNotifications(
          userId,
          (list) => { if (token === _connectToken) _applyData(list); },
          (err)  => { if (token === _connectToken) _handleError(err); }
        );
      } else {
        _startFallbackPolling();
      }
    } catch (err) {
      _handleError(err);
    }
  }

  function disconnect() {
    _connectToken++;
    if (_dataUnsub) { try { _dataUnsub(); } catch (_e) { /* ignore */ } _dataUnsub = null; }
    _stopFallbackPolling();
    _connectedFor = null;
  }

  // ---- عمليات تعديل: تتحدّث الواجهة تلقائياً من الاشتراك اللحظي، ونحدّث الحالة محلياً للسرعة ----

  function _patchLocal(docIds, patch) {
    const set = new Set(docIds);
    state.notifications.forEach(n => { if (set.has(n.docId)) Object.assign(n, patch); });
    NotificationsFilter.buildFiltered();
    NotificationsBadge.update();
    NotificationsFilter.updateTabBadges();
    NotificationsView.render();
  }

  async function markRead(docIds) {
    const ids = [...new Set(docIds)].filter(id => state.notifications.some(n => n.docId === id && !n.read));
    if (!ids.length) return;
    const api = await _getApi();
    if (ids.length === 1) await api.markNotificationRead(ids[0]);
    else await api.markNotificationsRead(ids);
    _patchLocal(ids, { read: true });
  }

  async function markAllRead() {
    if (!unreadCount()) return;
    const api = await _getApi();
    await api.markAllNotificationsRead(state.userId);
    _patchLocal(state.notifications.map(n => n.docId), { read: true });
  }

  async function remove(docIds) {
    const ids = [...new Set(docIds)];
    if (!ids.length) return;
    const api = await _getApi();
    if (ids.length === 1) await api.deleteNotification(ids[0]);
    else await api.deleteNotifications(ids);
    const gone = new Set(ids);
    state.notifications = state.notifications.filter(n => !gone.has(n.docId));
    state.selectedIds.clear();
    NotificationsFilter.buildFiltered();
    NotificationsBadge.update();
    NotificationsFilter.updateTabBadges();
    NotificationsView.render();
  }

  async function clearAll() {
    const api = await _getApi();
    await api.clearAllUserNotifications(state.userId);
    state.notifications = [];
    state.selectedIds.clear();
    NotificationsFilter.buildFiltered();
    NotificationsBadge.update();
    NotificationsFilter.updateTabBadges();
    NotificationsView.render();
  }

  // إضافة إشعار وصل من خارج الاشتراك (مثلاً Push من sw.js عبر EventBus)
  function addExternal(n) {
    if (!n || state.notifications.some(x => (n.docId && x.docId === n.docId) || (n.id && x.id === n.id))) return;
    state.notifications.unshift({ ...n, read: n.read === true });
    NotificationsFilter.buildFiltered();
    NotificationsBadge.update();
    NotificationsFilter.updateTabBadges();
    if (NotificationsPanel.isOpen()) NotificationsView.render();
    if (!n.read) playNotificationSound();
  }

  function reset() {
    state.notifications = [];
    state.filteredList  = [];
    state.selectedIds.clear();
    state.hasLoaded     = false;
    state.loadError     = null;
    state.currentTab    = 'all';
    state.searchTerm    = '';
    state.visibleCount  = CONFIG.PAGE_SIZE;
    if (elems.searchInput) elems.searchInput.value = '';
  }

  return { connect, disconnect, refresh: _fetchOnce, markRead, markAllRead, remove, clearAll, addExternal, reset };
})();

// ==== 12. الفلترة والتبويبات ====
const NotificationsFilter = (() => {

  function getVisibleTabs(role) {
    return Object.entries(TABS_CONFIG).filter(([, cfg]) => cfg.roles.includes(role));
  }

  function buildFiltered() {
    const tabCfg = TABS_CONFIG[state.currentTab] || TABS_CONFIG.all;
    let list = state.notifications.filter(tabCfg.filter);

    const term = state.searchTerm.trim().toLowerCase();
    if (term) {
      list = list.filter(n =>
        (n.title   || '').toLowerCase().includes(term) ||
        (n.message || '').toLowerCase().includes(term)
      );
    }

    list = groupSimilarNotifications(list);

    list.sort((a, b) => {
      if (!!a.read !== !!b.read) return a.read ? 1 : -1;
      return toMs(b.created_at) - toMs(a.created_at);
    });

    state.filteredList = list;
  }

  function getTabUnreadCount(tabKey) {
    const cfg = TABS_CONFIG[tabKey];
    if (!cfg) return 0;
    return state.notifications.filter(n => cfg.filter(n) && !n.read).length;
  }

  function _setBadge(btn, unread) {
    let badge = btn.querySelector('.tab-unread-badge');
    if (unread > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'tab-unread-badge';
        btn.appendChild(badge);
      }
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.setAttribute('aria-label', `${unread} غير مقروء`);
    } else if (badge) {
      badge.remove();
    }
  }

  function _buildTabBtn(key, cfg) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.notifTab = key;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(key === state.currentTab));
    btn.className = 'notif-tab' + (key === state.currentTab ? ' active' : '');   // نفس أسماء CSS الموجودة

    const label = document.createElement('span');
    label.textContent = cfg.label;
    btn.appendChild(label);
    _setBadge(btn, getTabUnreadCount(key));
    return btn;
  }

  function renderTabs() {
    if (!elems.tabsContainer) return;
    const role = state.userRole;
    const fragment = document.createDocumentFragment();
    if (role) getVisibleTabs(role).forEach(([key, cfg]) => fragment.appendChild(_buildTabBtn(key, cfg)));
    elems.tabsContainer.innerHTML = '';
    elems.tabsContainer.appendChild(fragment);
    elems.tabsContainer.setAttribute('role', 'tablist');
  }

  function updateTabBadges() {
    elems.tabsContainer?.querySelectorAll('[data-notif-tab]').forEach(btn => {
      _setBadge(btn, getTabUnreadCount(btn.dataset.notifTab));
    });
  }

  function switchTab(key) {
    if (!TABS_CONFIG[key]) return;
    state.currentTab   = key;
    state.visibleCount = CONFIG.PAGE_SIZE;
    state.selectedIds.clear();

    elems.tabsContainer?.querySelectorAll('[data-notif-tab]').forEach(btn => {
      const active = btn.dataset.notifTab === key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    buildFiltered();
    NotificationsView.render();
  }

  return { getVisibleTabs, buildFiltered, getTabUnreadCount, renderTabs, updateTabBadges, switchTab };
})();

// ==== 13. العرض ====
const NotificationsView = (() => {

  function _groupedTitle(notif, count) {
    if (notif.type === 'like')    return `${count} إعجاب جديد على درسك`;
    if (notif.type === 'comment') return `${count} تعليق جديد على درسك`;
    return notif.title || 'إشعارات متعددة';
  }

  function _actionBtn(iconClass, label, extraClass) {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = `notif-action-btn ${extraClass}`;
    btn.title     = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<i class="fas ${escapeHtml(iconClass)}" aria-hidden="true"></i>`;
    return btn;
  }

  function _buildItem(notif) {
    const { icon, color } = NOTIF_TYPES[notif.type] || NOTIF_TYPES.default;
    const isRead     = notif.read === true;
    const isSelected = state.selectedIds.has(notif.docId);
    const count      = notif._groupCount || 1;

    const article = document.createElement('article');
    article.className = 'notification-item' + (isRead ? ' read' : ' unread') + (isSelected ? ' selected' : '');
    article.dataset.docId = notif.docId;
    article.setAttribute('tabindex', '0');
    article.setAttribute('aria-label', notif.title || 'إشعار');

    const chk = document.createElement('input');
    chk.type      = 'checkbox';
    chk.className = 'notif-select-chk';
    chk.checked   = isSelected;
    chk.setAttribute('aria-label', 'تحديد الإشعار');
    article.appendChild(chk);

    const iconWrap = document.createElement('div');
    iconWrap.className = 'notification-icon';
    iconWrap.style.cssText = `background:color-mix(in srgb, ${color} 14%, transparent);color:${color};`;
    iconWrap.innerHTML = `<i class="fas ${escapeHtml(icon)}" aria-hidden="true"></i>`;
    article.appendChild(iconWrap);

    const body = document.createElement('div');
    body.className = 'notification-content';          // اسم CSS الموجود (كان JS يستخدم notification-body بلا أي تنسيق)

    const header = document.createElement('div');
    header.className = 'notification-header';

    const title = document.createElement('h4');
    title.className   = 'notification-title';
    title.textContent = count > 1 ? _groupedTitle(notif, count) : (notif.title || 'إشعار');
    header.appendChild(title);

    const timeEl = document.createElement('time');
    timeEl.className   = 'notification-time';
    timeEl.textContent = formatTime(notif.created_at);
    header.appendChild(timeEl);
    body.appendChild(header);

    if (count <= 1 && notif.message) {
      const msg = document.createElement('p');
      msg.className   = 'notification-message';
      msg.textContent = notif.message;
      body.appendChild(msg);
    }

    const actions = document.createElement('div');
    actions.className = 'notification-actions';
    if (!isRead) actions.appendChild(_actionBtn('fa-check', 'تعليم كمقروء', 'mark-read-btn'));
    actions.appendChild(_actionBtn('fa-trash-alt', 'حذف', 'delete-btn'));
    body.appendChild(actions);

    article.appendChild(body);
    return article;
  }

  function _setContent(node) {
    elems.content.innerHTML = '';
    elems.content.appendChild(node);
  }

  function render() {
    if (!elems.content) return;

    if (!state.userId)                         { renderGuest(); _updateToolbar(); return; }
    if (!state.hasLoaded && !state.loadError)  { renderSkeleton(); _updateToolbar(); return; }
    if (!state.hasLoaded && state.loadError)   { return; }   // renderError ظاهرة بالفعل

    const list = state.filteredList;
    if (list.length === 0) { _renderEmpty(); _updateToolbar(); return; }

    const scrollTop = elems.content.scrollTop;
    const shown     = Math.min(state.visibleCount, list.length);
    const fragment  = document.createDocumentFragment();

    list.slice(0, shown).forEach(n => fragment.appendChild(_buildItem(n)));

    if (shown < list.length) {
      const more = document.createElement('button');
      more.type        = 'button';
      more.className   = 'notif-page-btn';
      more.dataset.notifMore = '1';
      more.textContent = `عرض المزيد (${list.length - shown} متبقٍ)`;
      fragment.appendChild(more);
    }

    _setContent(fragment);
    elems.content.scrollTop = scrollTop;
    _updateToolbar();
  }

  function _renderEmpty() {
    const msg  = state.searchTerm ? 'لا توجد نتائج مطابقة' : 'لا توجد إشعارات';
    const wrap = document.createElement('div');
    wrap.className = 'notifications-empty';
    wrap.setAttribute('role', 'status');
    wrap.innerHTML = `<div class="empty-icon"><i class="fas fa-bell-slash" aria-hidden="true"></i></div><h4>${escapeHtml(msg)}</h4>`;
    _setContent(wrap);
  }

  function renderGuest() {
    if (!elems.content) return;
    const wrap = document.createElement('div');
    wrap.className = 'notifications-empty';
    wrap.setAttribute('role', 'status');
    wrap.innerHTML = `<div class="empty-icon"><i class="fas fa-bell" aria-hidden="true"></i></div><h4>سجّل الدخول لعرض إشعاراتك</h4>`;
    _setContent(wrap);
  }

  function renderSkeleton() {
    if (!elems.content) return;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 5; i++) {
      const sk = document.createElement('div');
      sk.className = 'notification-skeleton-item';
      sk.setAttribute('aria-hidden', 'true');
      sk.innerHTML = `
        <div class="sk-avatar"></div>
        <div class="sk-lines">
          <div class="sk-line"></div>
          <div class="sk-line sk-short"></div>
        </div>`;
      fragment.appendChild(sk);
    }
    _setContent(fragment);
  }

  function renderError(msg) {
    if (!elems.content) return;
    const wrap = document.createElement('div');
    wrap.className = 'notifications-error';
    wrap.innerHTML = `<div class="error-icon"><i class="fas fa-exclamation-triangle" aria-hidden="true"></i></div><p>${escapeHtml(msg)}</p>`;
    const retry = document.createElement('button');
    retry.type        = 'button';
    retry.className   = 'retry-btn';
    retry.dataset.notifRetry = '1';
    retry.textContent = 'إعادة المحاولة';
    wrap.appendChild(retry);
    _setContent(wrap);
  }

  function _updateToolbar() {
    const total = state.filteredList.length;
    const count = state.filteredList.filter(n => state.selectedIds.has(n.docId)).length;

    if (elems.deleteSel) {
      elems.deleteSel.disabled    = count === 0;
      elems.deleteSel.textContent = count > 0 ? `حذف المحدد (${count})` : 'حذف المحدد';
    }
    if (elems.selectAllChk) {
      elems.selectAllChk.disabled      = total === 0;
      elems.selectAllChk.indeterminate = count > 0 && count < total;
      elems.selectAllChk.checked       = total > 0 && count === total;
    }
    if (elems.markAllRead) elems.markAllRead.disabled = unreadCount() === 0;
    if (elems.clearAllBtn) elems.clearAllBtn.disabled = state.notifications.length === 0;
  }

  return { render, renderSkeleton, renderError, renderGuest, updateToolbar: _updateToolbar };
})();

// ==== 14. شارة العداد ====
const NotificationsBadge = (() => {
  function update() {
    const count = unreadCount();

    // navbar.js يحدّث الشارة نفسها عبر الحدث؛ نكتب هنا فقط كاحتياط إن لم يكن navbar جاهزاً (تهيئة متوازية — T3)
    if (elems.badge) {
      if (count > 0) {
        elems.badge.textContent   = count > 99 ? '99+' : String(count);
        elems.badge.dataset.count = String(count);
        elems.badge.style.display = 'flex';
      } else {
        elems.badge.textContent   = '0';
        elems.badge.dataset.count = '0';
        elems.badge.style.display = 'none';
      }
    }
    elems.trigger?.setAttribute('aria-label', count > 0 ? `الإشعارات (${count} جديد)` : 'الإشعارات (0 جديد)');

    EventBus.emit('notifications:countChanged', { count });
  }
  return { update };
})();

// ==== 15. إدارة اللوحة ====
const NotificationsPanel = (() => {

  let _scrollLocked = false;
  let _swipe = { x: 0, y: 0, active: false };

  function isOpen() {
    return elems.panel?.classList.contains('open') ?? false;
  }

  function _focusables() {
    return Array.from(elems.panel.querySelectorAll(
      'button:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null);
  }

  function open() {
    if (!elems.panel || isOpen()) return;

    elems.panel.classList.add('open');
    elems.panel.setAttribute('aria-hidden', 'false');
    elems.trigger?.setAttribute('aria-expanded', 'true');

    // قفل تمرير الصفحة على الجوال فقط؛ على سطح المكتب اللوحة قائمة منبثقة صغيرة
    if (window.matchMedia(CONFIG.MOBILE_QUERY).matches) {
      document.body.style.overflow = 'hidden';
      _scrollLocked = true;
    }

    NotificationsFilter.buildFiltered();
    NotificationsView.render();

    _panelAbort = new AbortController();
    const { signal } = _panelAbort;

    setTimeout(() => {
      if (signal.aborted) return;
      document.addEventListener('click', e => {
        if (!elems.panel.contains(e.target) && !elems.trigger?.contains(e.target)) close();
      }, { signal });
    }, 0);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); elems.trigger?.focus(); return; }
      if (e.key !== 'Tab') return;
      const f = _focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first)  { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }, { signal });

    // السحب لإغلاق اللوحة: يبدأ من الترويسة/التبويبات فقط، حتى لا يُغلق عند تمرير القائمة نفسها
    elems.panel.addEventListener('touchstart', e => {
      const t = e.touches[0];
      _swipe = {
        x: t.clientX, y: t.clientY,
        active: !!e.target.closest('.notifications-header, .notifications-tabs'),
      };
    }, { passive: true, signal });
    elems.panel.addEventListener('touchend', e => {
      if (!_swipe.active) return;
      const t  = e.changedTouches[0];
      const dy = t.clientY - _swipe.y;
      const dx = t.clientX - _swipe.x;
      _swipe.active = false;
      if (Math.abs(dy) > CONFIG.SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx)) close();
      else if (dx < -CONFIG.SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) close();  // اللوحة تنزلق من اليسار
    }, { passive: true, signal });

    requestAnimationFrame(() => { _focusables()[0]?.focus(); });
  }

  function close() {
    if (!elems.panel || !isOpen()) return;

    elems.panel.classList.remove('open');
    elems.panel.setAttribute('aria-hidden', 'true');
    elems.trigger?.setAttribute('aria-expanded', 'false');

    if (_scrollLocked) { document.body.style.overflow = ''; _scrollLocked = false; }

    _panelAbort?.abort();
    _panelAbort = null;
  }

  function toggle() { isOpen() ? close() : open(); }

  return { isOpen, open, close, toggle };
})();

// ==== 16. ربط الأحداث ====

function _openRelated(notif) {
  let route = null;
  let params = {};
  // شكل params الصحيح للراوتر هو { path: { id } } (كان يُمرَّر { id } فيُبنى /lesson/:id بلا معرّف — B2)
  if (notif.related_lesson)    { route = 'lesson-view'; params = { path: { id: notif.related_lesson } }; }
  else if (notif.related_exam) { route = 'exam-view';   params = { path: { id: notif.related_exam } }; }

  if (route && window.router?.navigateTo) {
    NotificationsPanel.close();
    window.router.navigateTo(route, params);
  }
}

function _itemFromEvent(e) {
  const el = e.target.closest('.notification-item');
  if (!el) return null;
  const docId = el.dataset.docId;
  return state.filteredList.find(n => n.docId === docId) || null;
}

function _bindStaticEvents() {
  _staticAbort = new AbortController();
  const { signal } = _staticAbort;

  elems.trigger?.addEventListener('click', e => {
    e.stopPropagation();
    NotificationsPanel.toggle();
  }, { signal });

  elems.closeBtn?.addEventListener('click', () => NotificationsPanel.close(), { signal });

  elems.searchInput?.addEventListener('input', e => {
    state.searchTerm   = e.target.value;
    state.visibleCount = CONFIG.PAGE_SIZE;
    NotificationsFilter.buildFiltered();
    NotificationsView.render();
  }, { signal });

  elems.selectAllChk?.addEventListener('change', e => {
    if (e.target.checked) state.filteredList.forEach(n => state.selectedIds.add(n.docId));
    else state.selectedIds.clear();
    NotificationsView.render();
  }, { signal });

  elems.deleteSel?.addEventListener('click', async () => {
    const items = state.filteredList.filter(n => state.selectedIds.has(n.docId));
    if (!items.length) return;
    if (!(await confirmDialog(`حذف ${items.length} إشعار محدد؟`, { danger: true }))) return;
    try {
      await NotificationsData.remove(items.flatMap(n => n._docIds));
      showToast('تم حذف الإشعارات المحددة', 'success');
    } catch (err) { console.error(err); showToast('فشل الحذف', 'error'); }
  }, { signal });

  elems.markAllRead?.addEventListener('click', async () => {
    try {
      await NotificationsData.markAllRead();
      showToast('تم تعليم جميع الإشعارات كمقروءة', 'success');
    } catch (err) { console.error(err); showToast('فشل التعليم', 'error'); }
  }, { signal });

  elems.clearAllBtn?.addEventListener('click', () => notificationsAPI.clearAll(), { signal });

  // ---- تفويض الأحداث على القائمة (مرة واحدة، بدل إعادة الربط بعد كل render) ----
  elems.content?.addEventListener('click', async e => {
    if (e.target.closest('[data-notif-retry]')) {
      state.loadError = null;
      NotificationsView.renderSkeleton();
      NotificationsData.refresh();
      return;
    }
    if (e.target.closest('[data-notif-more]')) {
      state.visibleCount += CONFIG.PAGE_SIZE;
      NotificationsView.render();
      return;
    }

    const item = _itemFromEvent(e);
    if (!item) return;

    if (e.target.closest('.mark-read-btn')) {
      e.stopPropagation();
      try { await NotificationsData.markRead(item._docIds); }
      catch (err) { console.error(err); showToast('فشل تعليم الإشعار', 'error'); }
      return;
    }
    if (e.target.closest('.delete-btn')) {
      e.stopPropagation();
      try { await NotificationsData.remove(item._docIds); }
      catch (err) { console.error(err); showToast('فشل حذف الإشعار', 'error'); }
      return;
    }
    if (e.target.closest('input.notif-select-chk')) return;   // يعالجه حدث change

    NotificationsData.markRead(item._docIds).catch(() => {});
    _openRelated(item);
  }, { signal });

  elems.content?.addEventListener('change', e => {
    if (!e.target.matches('input.notif-select-chk')) return;
    const item = _itemFromEvent(e);
    if (!item) return;
    if (e.target.checked) state.selectedIds.add(item.docId);
    else state.selectedIds.delete(item.docId);
    e.target.closest('.notification-item')?.classList.toggle('selected', e.target.checked);
    NotificationsView.updateToolbar();
  }, { signal });

  elems.content?.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('notification-item')) {
      e.preventDefault();
      e.target.click();
    }
  }, { signal });

  elems.tabsContainer?.addEventListener('click', e => {
    const btn = e.target.closest('[data-notif-tab]');
    if (btn) NotificationsFilter.switchTab(btn.dataset.notifTab);
  }, { signal });

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === CONFIG.KEYBOARD_SHORTCUT) {
      e.preventDefault();
      NotificationsPanel.toggle();
    }
  }, { signal });
}

function _onLogin(user) {
  if (!user?.id) return;
  const sameUser = state.userId === user.id && _connectedFor === user.id;

  state.userId   = user.id;
  state.userRole = normalizeRole(user.user_type);

  if (sameUser) return;   // setSession يعيد بثّ login عند أي تحديث بيانات (T6) — لا نعيد الجلب ولا نُظهر skeleton

  NotificationsData.reset();
  NotificationsFilter.renderTabs();
  NotificationsFilter.buildFiltered();
  NotificationsView.render();                 // يعرض skeleton حتى تصل أول دفعة
  NotificationsData.connect(user.id);
}

function _onLogout() {
  NotificationsData.disconnect();
  NotificationsData.reset();
  state.userId   = null;
  state.userRole = null;
  NotificationsFilter.renderTabs();
  NotificationsBadge.update();
  NotificationsView.render();                 // حالة الزائر
  if (NotificationsPanel.isOpen()) NotificationsPanel.close();
}

function _bindEventBus() {
  _eventUnsubs.push(EventBus.on('userStateChanged', detail => {
    if (detail?.action === 'login')  _onLogin(detail.user || getCurrentUser());
    else if (detail?.action === 'logout') _onLogout();
  }));

  // إشعار وصل من خارج الاشتراك (مثل Push من sw.js). الأحداث التي نبثّها نحن تحمل _local ونتجاهلها.
  _eventUnsubs.push(EventBus.on('newNotification', n => {
    if (!n || n._local || !state.userId) return;
    NotificationsData.addExternal(n);
  }));
}

// ==== 17. الدوال المصدّرة ====

export function initializeNotifications() {
  if (state.initialized) return true;

  _cacheElements();

  if (!elems.panel || !elems.content) {
    console.warn('[Notifications] العناصر الأساسية (panel/content) غير موجودة في DOM');
    return false;
  }

  _bindStaticEvents();
  _bindEventBus();

  // T1: أول userStateChanged يضيع، لذا نقرأ المستخدم الحالي مباشرة
  const user = getCurrentUser();
  if (user?.id) _onLogin(user);
  else          { NotificationsFilter.renderTabs(); NotificationsBadge.update(); NotificationsView.render(); }

  state.initialized = true;
  console.log('[Notifications] ✅ v5.1.0 جاهز');
  return true;
}

function _cacheElements() {
  elems.panel         = document.getElementById(CONFIG.PANEL_ID);
  elems.badge         = document.getElementById(CONFIG.BADGE_ID);
  elems.trigger       = document.getElementById(CONFIG.TRIGGER_BTN_ID);
  elems.content       = document.getElementById(CONFIG.CONTENT_ID);
  elems.tabsContainer = document.querySelector(CONFIG.TABS_SELECTOR);
  elems.searchInput   = document.getElementById(CONFIG.SEARCH_INPUT_ID);
  elems.selectAllChk  = document.getElementById(CONFIG.SELECT_ALL_ID);
  elems.deleteSel     = document.getElementById(CONFIG.DELETE_SELECTED_ID);
  elems.markAllRead   = document.getElementById(CONFIG.MARK_ALL_READ_ID);
  elems.closeBtn      = document.getElementById(CONFIG.CLOSE_BTN_ID);
  elems.clearAllBtn   = document.getElementById(CONFIG.CLEAR_ALL_BTN_ID);
}

export function destroyNotifications() {
  NotificationsPanel.close();
  NotificationsData.disconnect();

  _eventUnsubs.forEach(fn => { if (typeof fn === 'function') fn(); });
  _eventUnsubs.length = 0;

  _staticAbort?.abort();  _staticAbort = null;
  _panelAbort?.abort();   _panelAbort  = null;

  if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }

  NotificationsData.reset();
  Object.keys(elems).forEach(k => { elems[k] = null; });

  state.userId      = null;
  state.userRole    = null;
  state.initialized = false;
  _apiRef           = null;
}

// ==== 18. الواجهة العامة ====
export const notificationsAPI = {
  open:           () => NotificationsPanel.open(),
  close:          () => NotificationsPanel.close(),
  toggle:         () => NotificationsPanel.toggle(),
  refresh:        () => NotificationsData.refresh(),
  getUnreadCount: () => unreadCount(),
  clearAll: async () => {
    if (!state.userId || !state.notifications.length) return;
    if (!(await confirmDialog('حذف جميع الإشعارات؟', { danger: true }))) return;
    try {
      await NotificationsData.clearAll();
      showToast('تم حذف جميع الإشعارات', 'success');
    } catch (err) { console.error(err); showToast('فشل الحذف', 'error'); }
  },
};

window.notificationsAPI = notificationsAPI;

export default {
  initialize: initializeNotifications,
  destroy:    destroyNotifications,
  ...notificationsAPI,
};
