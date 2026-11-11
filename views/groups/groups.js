/**
 * 👥 views/groups/groups.js - نظام المجموعات (الإصدار 5.0.0)
 * ============================================================================
 * المسؤولية: قائمة المجموعات + صفحة عرض المجموعة (محادثة، دروس، امتحانات، أعضاء).
 * الوصول للبيانات عبر api.js فقط، والتواصل مع باقي النظام عبر Event Bus.
 * ============================================================================
 */

import { getCurrentUser, isTeacher, isModerator } from '../../js/core/session.js';
import {
  GROUPS_LIMITS,
  getUserGroups,
  subscribeToGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  addGroupMembers,
  removeGroupMember,
  addContentToGroup,
  removeContentFromGroup,
  subscribeToGroupMessages,
  getGroupMessagesBefore,
  sendGroupMessage,
  deleteGroupMessage,
  getUsersByIds,
  getLessonsByIds,
  getExamsByIds,
  getGroupContentCatalog,
  searchUsers,
  sendBulkNotifications
} from '../../js/core/api.js';
import { EventBus } from '../../js/core/event-bus.js';
import { createAvatarElement } from '../../js/utils/avatar.js';

// ==== الثوابت ====
const DEBOUNCE_DELAY = 300;
const FOLLOW_WINDOW_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 90;
const STAGE_ALIASES = { preparatory: 'إعدادي', secondary: 'ثانوي' };
const ROLE_LABELS = { student: 'طالب', moderator: 'مشرف', teacher: 'معلم' };
const ROLE_ORDER = { teacher: 0, moderator: 1, student: 2 };

// ==== الحالة ====
let list = null;
let view = null;

// ==== دوال مساعدة عامة ====
const sameId = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function toMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

const timeFormat = new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDateFormat = new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'short' });

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ms) {
  const now = Date.now();
  if (dayKey(ms) === dayKey(now)) return 'اليوم';
  if (dayKey(ms) === dayKey(now - 86400000)) return 'أمس';
  return dateFormat.format(ms);
}

function relativeTime(ms) {
  if (!ms) return '';
  const now = Date.now();
  if (dayKey(ms) === dayKey(now)) return timeFormat.format(ms);
  if (dayKey(ms) === dayKey(now - 86400000)) return 'أمس';
  return shortDateFormat.format(ms);
}

function normalizeArabic(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

function avatarHtml(user) {
  return createAvatarElement(user || { user_type: 'student' }, 'sm', { clickable: false }).outerHTML;
}

const normalizeStage = (stage) => STAGE_ALIASES[stage] || stage || '';

function canUserOpen(type, item, user) {
  if (!user || user.user_type !== 'student') return true;
  const stageOk = (type === 'exam' && !item.stage) || normalizeStage(user.stage) === normalizeStage(item.stage);
  const gradeOk = (type === 'exam' && !item.grade) || Number(user.grade) === Number(item.grade);
  return stageOk && gradeOk;
}

function countBlockedMembers(type, item) {
  return (view.group?.members || []).reduce((total, id) => {
    const member = getUser(id);
    return member?.user_type === 'student' && !canUserOpen(type, item, member) ? total + 1 : total;
  }, 0);
}

function roleLabel(type) {
  return ROLE_LABELS[type] || 'مستخدم';
}

function friendlyError(error, fallback) {
  const message = error?.message || '';
  return /[\u0600-\u06FF]/.test(message) ? message : fallback;
}

function showToast(message, type = 'info') {
  window.modals?.toast?.(message, type);
}

function safeNavigate(route, params = {}) {
  if (window.router?.navigateTo) window.router.navigateTo(route, params);
}

async function askConfirm(options) {
  if (window.modals?.confirm) return Boolean(await window.modals.confirm(options));
  return window.confirm(options.message);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('is-loading', busy);
  button.setAttribute('aria-busy', String(busy));
}

function canCreateGroups(user) {
  return Boolean(user) && (isTeacher(user) || isModerator(user));
}

function canManageGroup(group, user) {
  return Boolean(group && user) && (isTeacher(user) || sameId(group.created_by, user.id));
}

function activityMs(group) {
  return toMs(group.last_message?.at) || toMs(group.updated_at) || toMs(group.created_at);
}

function htmlToElement(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function reconcile(container, items, registry) {
  const seen = new Set();
  let prev = null;
  items.forEach((item) => {
    seen.add(item.key);
    let rec = registry.get(item.key);
    if (!rec || rec.sig !== item.html) {
      const el = htmlToElement(item.html);
      if (rec) rec.el.replaceWith(el);
      rec = { el, sig: item.html };
      registry.set(item.key, rec);
    }
    const expected = prev ? prev.nextSibling : container.firstChild;
    if (rec.el !== expected) container.insertBefore(rec.el, expected);
    prev = rec.el;
  });
  registry.forEach((rec, key) => {
    if (!seen.has(key)) {
      rec.el.remove();
      registry.delete(key);
    }
  });
}

async function notifyAddedMembers(userIds, groupName, groupId, currentUser) {
  const targets = userIds.filter((id) => !sameId(id, currentUser.id));
  if (!targets.length) return;
  try {
    await sendBulkNotifications(targets, {
      title: 'تمت إضافتك إلى مجموعة',
      message: `تمت إضافتك إلى مجموعة «${groupName}»`,
      type: 'info',
      relatedId: String(groupId)
    });
  } catch (error) {
    console.warn('⚠️ [groups] تعذر إرسال إشعار الإضافة:', error.message);
  }
}

// ==== متحكم النوافذ ====
function createModal(el, { signal, isDirty, onClose } = {}) {
  let lastFocus = null;

  const focusables = () => [...el.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  )].filter((node) => !node.closest('[hidden]'));

  function open() {
    lastFocus = document.activeElement;
    el.hidden = false;
    document.body.classList.add('grp-scroll-lock');
    (el.querySelector('[data-autofocus]') || focusables()[0])?.focus();
  }

  function close() {
    if (el.hidden) return;
    el.hidden = true;
    if (!document.querySelector('.grp-modal:not([hidden])')) document.body.classList.remove('grp-scroll-lock');
    lastFocus?.focus?.();
    onClose?.();
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-modal-close]')) close();
    else if (e.target === el && !isDirty?.()) close();
  }, { signal });

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, { signal });

  return { open, close, get isOpen() { return !el.hidden; } };
}

function bindCounter(input, counter, signal) {
  const update = () => { counter.textContent = `${input.value.length}/${input.maxLength}`; };
  input.addEventListener('input', update, { signal });
  update();
  return update;
}

// ==== منتقي المستخدمين ====
function createUserPicker({ input, results, chips, signal, getExcluded, getRemaining, onChange }) {
  const selected = new Map();
  let timer = null;
  let token = 0;
  let users = [];

  const setOpen = (open) => {
    results.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
  };

  const options = () => [...results.querySelectorAll('.suggestion-item:not([disabled])')];

  function renderChips() {
    chips.innerHTML = [...selected.values()].map((u) => `
      <span class="member-tag">
        <span>${escapeHtml(u.full_name)}</span>
        <button type="button" class="remove-member" data-user-id="${escapeHtml(u.id)}" aria-label="إزالة ${escapeHtml(u.full_name)}">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </span>`).join('');
    onChange?.(selected.size);
  }

  function renderMessage(text) {
    results.innerHTML = `<div class="suggestions-message">${escapeHtml(text)}</div>`;
    setOpen(true);
  }

  function renderResults() {
    if (!users.length) {
      renderMessage('لا توجد نتائج مطابقة');
      return;
    }
    const excluded = getExcluded();
    results.innerHTML = users.map((u) => {
      const isMember = excluded.has(String(u.id));
      const isPicked = selected.has(String(u.id));
      const meta = [roleLabel(u.user_type), u.stage, u.grade ? `الصف ${u.grade}` : '', u.phone]
        .filter(Boolean).map(escapeHtml).join(' · ');
      return `
        <button type="button" role="option" class="suggestion-item" data-user-id="${escapeHtml(u.id)}"
          aria-selected="${isPicked}" ${isMember || isPicked ? 'disabled' : ''}>
          <span class="suggestion-avatar">${avatarHtml(u)}</span>
          <span class="suggestion-text">
            <strong>${escapeHtml(u.full_name)}</strong>
            <small>${meta}</small>
          </span>
          ${isMember ? '<span class="suggestion-tag">عضو بالفعل</span>' : ''}
          ${isPicked ? '<span class="suggestion-tag suggestion-tag--picked">تمت الإضافة</span>' : ''}
        </button>`;
    }).join('');
    setOpen(true);
  }

  function pick(userId) {
    const user = users.find((u) => sameId(u.id, userId));
    if (!user || selected.has(String(user.id))) return;
    if (selected.size >= getRemaining()) {
      showToast(`الحد الأقصى ${GROUPS_LIMITS.MAX_MEMBERS} عضوًا في المجموعة`, 'warning');
      return;
    }
    selected.set(String(user.id), user);
    renderChips();
    input.value = '';
    setOpen(false);
    input.focus();
  }

  async function search(query) {
    const current = ++token;
    renderMessage('جاري البحث...');
    try {
      const found = await searchUsers(query, { limit: 15, throwOnError: true });
      if (current !== token) return;
      users = found || [];
      renderResults();
    } catch (error) {
      if (current !== token) return;
      renderMessage('تعذر البحث، حاول مرة أخرى');
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) {
      token += 1;
      setOpen(false);
      return;
    }
    timer = setTimeout(() => search(query), DEBOUNCE_DELAY);
  }, { signal });

  input.addEventListener('keydown', (e) => {
    const nodes = options();
    const idx = nodes.indexOf(results.querySelector('.is-active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (results.hidden || !nodes.length) return;
      e.preventDefault();
      nodes[idx]?.classList.remove('is-active');
      const next = e.key === 'ArrowDown' ? (idx + 1) % nodes.length : (idx - 1 + nodes.length) % nodes.length;
      nodes[next].classList.add('is-active');
      nodes[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = nodes[idx] || (nodes.length === 1 ? nodes[0] : null);
      if (target) pick(target.dataset.userId);
    } else if (e.key === 'Escape' && !results.hidden) {
      e.stopPropagation();
      setOpen(false);
    }
  }, { signal });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (item && !item.disabled) pick(item.dataset.userId);
  }, { signal });

  chips.addEventListener('click', (e) => {
    const btn = e.target.closest('.remove-member');
    if (!btn) return;
    selected.delete(String(btn.dataset.userId));
    renderChips();
  }, { signal });

  renderChips();

  return {
    getSelectedIds: () => [...selected.values()].map((u) => Number(u.id)),
    get count() { return selected.size; },
    reset() {
      clearTimeout(timer);
      token += 1;
      selected.clear();
      users = [];
      input.value = '';
      results.innerHTML = '';
      setOpen(false);
      renderChips();
    }
  };
}

// ==== صفحة قائمة المجموعات ====
export async function initGroupsPage(container) {
  cleanupGroupsPage();

  const user = getCurrentUser();
  if (!user) {
    safeNavigate('login');
    return;
  }

  const ac = new AbortController();
  list = { container, user, ac, groups: [], filter: '', loading: false, els: {}, picker: null, modal: null, saving: false };

  cacheListElements();
  setupListUI();
  bindListEvents();
  await loadGroupsList();

  if (!ac.signal.aborted) EventBus.emit('page:ready', { page: 'groups' });
}

export function cleanupGroupsPage() {
  if (!list) return;
  list.ac.abort();
  document.body.classList.remove('grp-scroll-lock');
  list = null;
}

function cacheListElements() {
  const q = (sel) => list.container.querySelector(sel);
  list.els = {
    subtitle: q('#groups-subtitle'),
    createBtn: q('#create-group-btn'),
    emptyCreateBtn: q('#empty-create-btn'),
    toolbar: q('#groups-toolbar'),
    search: q('#groups-search'),
    count: q('#groups-count'),
    skeleton: q('#groups-skeleton'),
    grid: q('#groups-grid'),
    noResults: q('#groups-no-results'),
    empty: q('#groups-empty'),
    emptyMessage: q('#groups-empty-message'),
    error: q('#groups-error'),
    retryBtn: q('#groups-retry-btn'),
    modal: q('#group-modal'),
    form: q('#group-form'),
    modalTitle: q('#group-modal-title'),
    nameInput: q('#group-name-input'),
    nameError: q('#group-name-error'),
    descInput: q('#group-description-input'),
    memberSearch: q('#member-search'),
    memberResults: q('#member-suggestions'),
    memberChips: q('#selected-members'),
    memberLabel: q('#selected-members-label'),
    saveBtn: q('#save-group-btn')
  };
}

function setupListUI() {
  const { els, user } = list;
  const staff = canCreateGroups(user);
  els.createBtn.hidden = !staff;
  els.emptyCreateBtn.hidden = !staff;
  els.subtitle.textContent = isTeacher(user)
    ? 'كل مجموعات المنصة — أنشئ مجموعات وأضف لها محتوى مخصصًا'
    : staff
      ? 'مجموعاتك التعليمية وما تنتمي إليه منها'
      : 'المجموعات التي تنتمي إليها';
  els.emptyMessage.textContent = staff
    ? 'ابدأ بإنشاء مجموعة وأضف إليها الطلاب والمحتوى.'
    : 'لم تنضم إلى أي مجموعة بعد. سيضيفك المعلم أو المشرف عند إنشاء مجموعة جديدة.';
}

function bindListEvents() {
  const { els, ac } = list;
  const { signal } = ac;

  els.createBtn.addEventListener('click', openGroupModal, { signal });
  els.emptyCreateBtn.addEventListener('click', openGroupModal, { signal });
  els.retryBtn.addEventListener('click', loadGroupsList, { signal });

  els.search.addEventListener('input', () => {
    list.filter = els.search.value;
    renderGroupsGrid();
  }, { signal });

  const openCard = (card) => {
    if (card) safeNavigate('group-view', { path: { id: card.dataset.groupId } });
  };
  els.grid.addEventListener('click', (e) => openCard(e.target.closest('.group-card')), { signal });
  els.grid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('.group-card');
      if (card && e.target === card) {
        e.preventDefault();
        openCard(card);
      }
    }
  }, { signal });

  list.modal = createModal(els.modal, {
    signal,
    isDirty: () => Boolean(els.nameInput.value.trim() || els.descInput.value.trim() || list.picker?.count),
    onClose: () => list.picker?.reset()
  });

  const updateName = bindCounter(els.nameInput, list.container.querySelector('#group-name-counter'), signal);
  const updateDesc = bindCounter(els.descInput, list.container.querySelector('#group-description-counter'), signal);
  list.updateCounters = () => { updateName(); updateDesc(); };

  els.nameInput.addEventListener('input', () => { els.nameError.hidden = true; }, { signal });

  list.picker = createUserPicker({
    input: els.memberSearch,
    results: els.memberResults,
    chips: els.memberChips,
    signal,
    getExcluded: () => new Set([String(list.user.id)]),
    getRemaining: () => GROUPS_LIMITS.MAX_MEMBERS - 1,
    onChange: (count) => {
      els.memberLabel.textContent = count
        ? `${count} عضو مختار (بالإضافة إليك)`
        : 'لم تتم إضافة أعضاء بعد — يمكنك إضافتهم لاحقًا';
    }
  });

  els.form.addEventListener('submit', submitGroupForm, { signal });
}

async function loadGroupsList() {
  if (!list || list.loading) return;
  const { els, user } = list;
  list.loading = true;
  els.error.hidden = true;
  els.skeleton.hidden = false;
  els.grid.hidden = true;
  els.empty.hidden = true;
  els.noResults.hidden = true;

  try {
    const groups = await getUserGroups(user.id, { all: isTeacher(user) });
    if (!list) return;
    list.groups = groups.sort((a, b) => activityMs(b) - activityMs(a));
    renderGroupsGrid();
  } catch (error) {
    console.error('❌ [groups] فشل جلب المجموعات:', error);
    if (!list) return;
    els.toolbar.hidden = true;
    els.error.hidden = false;
  } finally {
    if (list) {
      list.loading = false;
      els.skeleton.hidden = true;
    }
  }
}

function groupCardHtml(group) {
  const own = sameId(group.created_by, list.user.id);
  const last = group.last_message;
  const when = relativeTime(activityMs(group));
  return `
    <article class="group-card" role="listitem" tabindex="0" data-group-id="${escapeHtml(group.id)}" aria-label="فتح مجموعة ${escapeHtml(group.name)}">
      <div class="group-card-header">
        <h3>${escapeHtml(group.name)}</h3>
        ${own ? '<span class="group-owner-badge">المالك</span>' : ''}
      </div>
      <div class="group-card-body">
        <p class="group-description">${escapeHtml(group.description || 'لا يوجد وصف')}</p>
        <div class="group-stats">
          <span><i class="fas fa-users" aria-hidden="true"></i> ${group.members.length} عضو</span>
          <span><i class="fas fa-book" aria-hidden="true"></i> ${group.lessons.length} درس</span>
          <span><i class="fas fa-graduation-cap" aria-hidden="true"></i> ${group.exams.length} امتحان</span>
        </div>
        <p class="group-card-preview">
          <i class="fas fa-comment-dots" aria-hidden="true"></i>
          <span>${last?.text ? escapeHtml(last.text) : 'لا توجد رسائل بعد'}</span>
        </p>
      </div>
      <div class="group-card-footer">
        <span class="group-card-time">${escapeHtml(when)}</span>
        <span class="group-card-cta">فتح المجموعة <i class="fas fa-arrow-left" aria-hidden="true"></i></span>
      </div>
    </article>`;
}

function renderGroupsGrid() {
  const { els, groups, filter } = list;
  const needle = normalizeArabic(filter);
  const shown = needle
    ? groups.filter((g) => normalizeArabic(`${g.name} ${g.description}`).includes(needle))
    : groups;

  els.toolbar.hidden = groups.length < 4;
  els.count.textContent = groups.length ? `${shown.length} من ${groups.length}` : '';
  els.empty.hidden = groups.length > 0;
  els.noResults.hidden = !(groups.length && !shown.length);
  els.grid.hidden = !shown.length;
  els.grid.innerHTML = shown.map(groupCardHtml).join('');
}

// ==== نافذة إنشاء مجموعة ====
function openGroupModal() {
  const { els } = list;
  els.form.reset();
  els.nameError.hidden = true;
  list.updateCounters();
  list.picker.reset();
  list.modal.open();
}

async function submitGroupForm(e) {
  e.preventDefault();
  const { els, user } = list;
  if (list.saving) return;

  const name = els.nameInput.value.trim();
  if (!name) {
    els.nameError.textContent = 'اسم المجموعة مطلوب';
    els.nameError.hidden = false;
    els.nameInput.focus();
    return;
  }

  list.saving = true;
  setBusy(els.saveBtn, true);
  try {
    const memberIds = list.picker.getSelectedIds();
    const group = await createGroup({ name, description: els.descInput.value.trim(), members: memberIds });
    showToast('تم إنشاء المجموعة', 'success');
    notifyAddedMembers(memberIds, group.name, group.id, user);
    list.modal.close();
    safeNavigate('group-view', { path: { id: group.id } });
  } catch (error) {
    showToast(friendlyError(error, 'فشل إنشاء المجموعة'), 'error');
  } finally {
    if (list) {
      list.saving = false;
      setBusy(els.saveBtn, false);
    }
  }
}

// ==== صفحة عرض المجموعة ====
export async function initGroupViewPage(container, params) {
  cleanupGroupViewPage();

  const groupId = params?.path?.id;
  const user = getCurrentUser();
  if (!user) {
    safeNavigate('login');
    return;
  }

  const ac = new AbortController();
  view = {
    container, user, groupId, ac, els: {},
    group: null, sig: '', ready: false, applyToken: 0,
    usersById: new Map(), requestedUsers: new Set(),
    lessons: [], exams: [], contentKey: '',
    tab: 'chat', unread: 0,
    live: [], older: [], seen: new Set(), messagesReady: false,
    hasOlder: false, loadingOlder: false, sending: false,
    chatRegistry: new Map(), unsubGroup: null, unsubMessages: null,
    catalogs: {}, modals: {}, pickers: {}, contentType: null, contentSelected: new Set(), contentQuery: ''
  };
  view.usersById.set(String(user.id), user);

  cacheViewElements();
  bindViewEvents();

  if (!groupId) {
    showViewError('معرّف المجموعة غير صالح', 'الرابط الذي فتحته غير صحيح.');
    return;
  }

  startGroupSubscription();
}

export function cleanupGroupViewPage() {
  if (!view) return;
  view.ac.abort();
  view.unsubGroup?.();
  view.unsubMessages?.();
  document.body.classList.remove('grp-scroll-lock');
  view = null;
}

function cacheViewElements() {
  const q = (sel) => view.container.querySelector(sel);
  view.els = {
    breadcrumb: q('#group-breadcrumb'),
    skeleton: q('#group-skeleton'),
    error: q('#group-error'),
    errorTitle: q('#group-error-title'),
    errorMessage: q('#group-error-message'),
    retryBtn: q('#group-retry-btn'),
    backBtn: q('#group-back-btn'),
    content: q('#group-container'),
    name: q('#group-name'),
    desc: q('#group-description'),
    creator: q('#group-creator'),
    membersCount: q('#members-count'),
    lessonsCount: q('#lessons-count'),
    examsCount: q('#exams-count'),
    editBtn: q('#edit-group-btn'),
    addMembersBtn: q('#add-members-btn'),
    leaveBtn: q('#leave-group-btn'),
    deleteBtn: q('#delete-group-btn'),
    tabs: [...view.container.querySelectorAll('.tab-btn')],
    panels: [...view.container.querySelectorAll('.tab-content')],
    unreadDot: q('#chat-unread'),
    tabCounts: { lessons: q('#tab-lessons-count'), exams: q('#tab-exams-count'), members: q('#tab-members-count') },
    chatScroll: q('#chat-scroll'),
    chatOlder: q('#chat-older'),
    chatOlderBtn: q('#chat-older-btn'),
    chatMessages: q('#chat-messages'),
    chatState: q('#chat-state'),
    newPill: q('#chat-new-pill'),
    chatNotice: q('#chat-notice'),
    chatForm: q('#chat-form'),
    chatInput: q('#chat-input'),
    sendBtn: q('#send-message-btn'),
    chatCounter: q('#chat-counter'),
    addLessonBtn: q('#add-lesson-btn'),
    addExamBtn: q('#add-exam-btn'),
    lessonsGrid: q('#group-lessons-grid'),
    examsGrid: q('#group-exams-grid'),
    membersList: q('#members-list'),
    membersFilter: q('#members-filter'),
    membersFilterWrap: q('#members-filter-wrap'),
    editModal: q('#edit-group-modal'),
    editForm: q('#edit-group-form'),
    editName: q('#edit-name-input'),
    editNameError: q('#edit-name-error'),
    editDesc: q('#edit-description-input'),
    editSaveBtn: q('#edit-save-btn'),
    addMembersModal: q('#add-members-modal'),
    addMemberSearch: q('#add-member-search'),
    addMemberResults: q('#add-member-suggestions'),
    newMembersList: q('#new-members-list'),
    addMembersLabel: q('#add-members-label'),
    confirmAddMembers: q('#confirm-add-members'),
    contentModal: q('#add-content-modal'),
    contentTitle: q('#add-content-title'),
    contentSearch: q('#content-search'),
    contentList: q('#content-list'),
    confirmAddContent: q('#confirm-add-content')
  };
}

function bindViewEvents() {
  const { els, ac } = view;
  const { signal } = ac;

  els.backBtn.addEventListener('click', () => safeNavigate('groups'), { signal });
  els.retryBtn.addEventListener('click', () => {
    els.error.hidden = true;
    els.skeleton.hidden = false;
    view.unsubGroup?.();
    view.unsubGroup = null;
    view.sig = '';
    startGroupSubscription();
  }, { signal });

  els.tabs.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab), { signal }));
  els.tabs[0].parentElement.addEventListener('keydown', onTabsKeydown, { signal });

  bindChatEvents();

  els.editBtn.addEventListener('click', openEditModal, { signal });
  els.addMembersBtn.addEventListener('click', openAddMembersModal, { signal });
  els.leaveBtn.addEventListener('click', confirmLeaveGroup, { signal });
  els.deleteBtn.addEventListener('click', confirmDeleteGroup, { signal });
  els.addLessonBtn.addEventListener('click', () => openAddContentModal('lesson'), { signal });
  els.addExamBtn.addEventListener('click', () => openAddContentModal('exam'), { signal });

  [els.lessonsGrid, els.examsGrid].forEach((grid) => grid.addEventListener('click', onContentClick, { signal }));
  els.membersList.addEventListener('click', onMemberClick, { signal });
  els.membersFilter.addEventListener('input', renderMembers, { signal });

  view.modals.edit = createModal(els.editModal, { signal });
  view.modals.members = createModal(els.addMembersModal, { signal, isDirty: () => view.pickers.add?.count > 0, onClose: () => view.pickers.add?.reset() });
  view.modals.content = createModal(els.contentModal, { signal, isDirty: () => view.contentSelected.size > 0 });

  bindCounter(els.editName, view.container.querySelector('#edit-name-counter'), signal);
  bindCounter(els.editDesc, view.container.querySelector('#edit-description-counter'), signal);
  els.editName.addEventListener('input', () => { els.editNameError.hidden = true; }, { signal });
  els.editForm.addEventListener('submit', submitEditForm, { signal });

  view.pickers.add = createUserPicker({
    input: els.addMemberSearch,
    results: els.addMemberResults,
    chips: els.newMembersList,
    signal,
    getExcluded: () => new Set((view.group?.members || []).map(String)),
    getRemaining: () => GROUPS_LIMITS.MAX_MEMBERS - (view.group?.members.length || 0),
    onChange: updateAddMembersLabel
  });
  els.confirmAddMembers.addEventListener('click', confirmAddMembers, { signal });

  els.contentSearch.addEventListener('input', () => {
    view.contentQuery = els.contentSearch.value;
    renderContentList();
  }, { signal });
  els.contentList.addEventListener('change', onContentToggle, { signal });
  els.confirmAddContent.addEventListener('click', confirmAddContent, { signal });

  window.addEventListener('online', updateChatAvailability, { signal });
  window.addEventListener('offline', updateChatAvailability, { signal });
}

// ==== الاشتراك في بيانات المجموعة ====
function startGroupSubscription() {
  const local = view;
  subscribeToGroup(
    local.groupId,
    (group) => { if (view === local) applyGroup(group); },
    (error) => {
      console.error('❌ [group-view] فشل الاشتراك في المجموعة:', error);
      if (view === local && !local.ready) showViewError('تعذر تحميل المجموعة', 'تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.', true);
    }
  ).then((unsub) => {
    if (view === local) local.unsubGroup = unsub;
    else unsub();
  }).catch((error) => {
    console.error('❌ [group-view] تعذر بدء الاشتراك:', error);
    if (view === local) showViewError('تعذر تحميل المجموعة', 'تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.', true);
  });
}

async function applyGroup(group) {
  const local = view;
  const token = ++local.applyToken;
  const { user } = local;

  if (!group) {
    local.unsubMessages?.();
    local.unsubMessages = null;
    showViewError('المجموعة غير متاحة', 'ربما تم حذف هذه المجموعة أو لم تعد موجودة.');
    return;
  }

  const isMember = group.members.some((id) => sameId(id, user.id));
  if (!isMember && !isTeacher(user)) {
    if (local.ready) {
      showToast('تمت إزالتك من هذه المجموعة', 'warning');
      safeNavigate('groups');
    } else {
      showViewError('ليس لديك صلاحية الوصول', 'هذه المجموعة متاحة لأعضائها فقط.');
    }
    return;
  }

  local.group = group;
  const sig = [group.name, group.description, group.created_by, group.members.join(), group.lessons.join(), group.exams.join()].join('|');
  if (local.ready && sig === local.sig) return;
  local.sig = sig;

  try {
    await Promise.all([ensureUsers([...group.members, group.created_by]), resolveContent(group)]);
  } catch (error) {
    console.error('❌ [group-view] فشل جلب تفاصيل المجموعة:', error);
    if (!local.ready) showViewError('تعذر تحميل المجموعة', 'تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.', true);
    else showToast('تعذر تحديث بيانات المجموعة', 'error');
    return;
  }
  if (view !== local || token !== local.applyToken) return;

  renderAll();
  if (!local.ready) {
    local.ready = true;
    local.els.skeleton.hidden = true;
    local.els.error.hidden = true;
    local.els.content.hidden = false;
    startMessagesSubscription();
    EventBus.emit('page:ready', { page: 'group-view', groupId: local.groupId });
  }
}

async function ensureUsers(ids) {
  const missing = [...new Set(ids.map(String))].filter((id) => !view.usersById.has(id) && !view.requestedUsers.has(id));
  if (!missing.length) return false;
  missing.forEach((id) => view.requestedUsers.add(id));
  const users = await getUsersByIds(missing);
  users.forEach((u) => view.usersById.set(String(u.id), u));
  return users.length > 0;
}

async function resolveContent(group) {
  const key = `${group.lessons.join()}|${group.exams.join()}`;
  if (key === view.contentKey) return;
  const [lessons, exams] = await Promise.all([getLessonsByIds(group.lessons), getExamsByIds(group.exams)]);
  view.lessons = lessons;
  view.exams = exams;
  view.contentKey = key;
}

function getUser(id) {
  return view.usersById.get(String(id)) || null;
}

function showViewError(title, message, retryable = false) {
  const { els } = view;
  view.unsubMessages?.();
  view.unsubMessages = null;
  els.skeleton.hidden = true;
  els.content.hidden = true;
  els.error.hidden = false;
  els.errorTitle.textContent = title;
  els.errorMessage.textContent = message;
  els.retryBtn.hidden = !retryable;
  els.breadcrumb.textContent = 'غير متاحة';
}

// ==== العرض العام ====
function renderAll() {
  renderHeader();
  applyPermissions();
  renderLessons();
  renderExams();
  renderMembers();
  updateChatAvailability();
  if (view.messagesReady) renderChat({ stick: false });
}

function renderHeader() {
  const { els, group } = view;
  const creator = getUser(group.created_by);
  els.breadcrumb.textContent = group.name;
  els.name.textContent = group.name;
  els.desc.textContent = group.description;
  els.desc.hidden = !group.description;
  els.creator.textContent = creator?.full_name || 'غير معروف';
  els.membersCount.textContent = group.members.length;
  els.lessonsCount.textContent = group.lessons.length;
  els.examsCount.textContent = group.exams.length;
  els.tabCounts.lessons.textContent = group.lessons.length;
  els.tabCounts.exams.textContent = group.exams.length;
  els.tabCounts.members.textContent = group.members.length;
}

function applyPermissions() {
  const { els, group, user } = view;
  const manage = canManageGroup(group, user);
  const owner = sameId(group.created_by, user.id);
  const member = group.members.some((id) => sameId(id, user.id));

  els.editBtn.hidden = !manage;
  els.addMembersBtn.hidden = !manage;
  els.deleteBtn.hidden = !manage;
  els.leaveBtn.hidden = !(member && !owner);
  els.addLessonBtn.hidden = !manage;
  els.addExamBtn.hidden = !manage;
}

function switchTab(tabId, { focus = false } = {}) {
  const { els } = view;
  view.tab = tabId;
  els.tabs.forEach((btn) => {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
    if (active && focus) btn.focus();
  });
  els.panels.forEach((panel) => { panel.hidden = panel.dataset.tabContent !== tabId; });

  if (tabId === 'chat') {
    view.unread = 0;
    els.unreadDot.hidden = true;
    scrollChatToBottom();
  }
}

function onTabsKeydown(e) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  const { tabs } = view.els;
  const idx = tabs.findIndex((btn) => btn.dataset.tab === view.tab);
  let next = idx;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  else next = (idx + (e.key === 'ArrowLeft' ? 1 : -1) + tabs.length) % tabs.length;
  switchTab(tabs[next].dataset.tab, { focus: true });
}

// ==== المحادثة ====
function bindChatEvents() {
  const { els, ac } = view;
  const { signal } = ac;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;

  els.chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); }, { signal });

  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) {
      e.preventDefault();
      sendMessage();
    }
  }, { signal });

  els.chatInput.addEventListener('input', () => {
    autosizeChatInput();
    const len = els.chatInput.value.length;
    const near = len >= GROUPS_LIMITS.MAX_MESSAGE * 0.8;
    els.chatCounter.hidden = !near;
    els.chatCounter.textContent = `${len}/${GROUPS_LIMITS.MAX_MESSAGE}`;
  }, { signal });

  els.chatScroll.addEventListener('scroll', () => {
    if (isNearBottom()) els.newPill.hidden = true;
  }, { signal, passive: true });

  els.newPill.addEventListener('click', () => {
    scrollChatToBottom(true);
    els.newPill.hidden = true;
  }, { signal });

  els.chatOlderBtn.addEventListener('click', loadOlderMessages, { signal });

  els.chatMessages.addEventListener('click', async (e) => {
    const btn = e.target.closest('.message-delete');
    if (!btn) return;
    const ok = await askConfirm({
      title: 'حذف الرسالة',
      message: 'سيتم حذف هذه الرسالة لدى جميع أعضاء المجموعة.',
      confirmText: 'حذف',
      type: 'danger'
    });
    if (!ok || !view) return;
    try {
      await deleteGroupMessage(view.groupId, btn.dataset.docId);
    } catch (error) {
      showToast(friendlyError(error, 'تعذر حذف الرسالة'), 'error');
    }
  }, { signal });
}

function autosizeChatInput() {
  const input = view.els.chatInput;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function canPost() {
  const { group, user } = view;
  return Boolean(group) && (group.members.some((id) => sameId(id, user.id)) || isTeacher(user));
}

function updateChatAvailability() {
  const { els } = view;
  const online = navigator.onLine !== false;
  const allowed = canPost();
  const disabled = !allowed || !online;

  els.chatInput.disabled = disabled;
  els.sendBtn.disabled = disabled;
  els.chatNotice.hidden = !disabled;
  els.chatNotice.textContent = !allowed
    ? 'المشاركة في المحادثة متاحة لأعضاء المجموعة فقط.'
    : 'أنت غير متصل بالإنترنت — ستتمكن من الإرسال عند عودة الاتصال.';
}

function startMessagesSubscription() {
  const local = view;
  const { els } = local;
  els.chatState.hidden = false;
  els.chatState.innerHTML = '<span class="grp-spinner" aria-hidden="true"></span><span>جاري تحميل الرسائل...</span>';

  subscribeToGroupMessages(
    local.groupId,
    { limit: GROUPS_LIMITS.MESSAGES_PAGE },
    (messages, meta) => { if (view === local) onMessages(messages, meta); },
    (error) => {
      console.error('❌ [group-view] فشل الاشتراك في الرسائل:', error);
      if (view !== local) return;
      els.chatState.hidden = false;
      els.chatState.innerHTML = '<span>تعذر تحميل الرسائل</span><button type="button" class="btn btn-outline btn-sm" id="chat-retry-btn">إعادة المحاولة</button>';
      els.chatState.querySelector('#chat-retry-btn').addEventListener('click', () => {
        local.unsubMessages?.();
        startMessagesSubscription();
      }, { once: true });
    }
  ).then((unsub) => {
    if (view === local) local.unsubMessages = unsub;
    else unsub();
  }).catch((error) => console.error('❌ [group-view] تعذر بدء اشتراك الرسائل:', error));
}

function allMessages() {
  const liveIds = new Set(view.live.map((m) => m.docId));
  return [...view.older.filter((m) => !liveIds.has(m.docId)), ...view.live];
}

function onMessages(messages, meta) {
  const first = !view.messagesReady;
  const fresh = messages.filter((m) => !view.seen.has(m.docId));
  fresh.forEach((m) => view.seen.add(m.docId));

  view.live = messages;
  if (first) {
    view.messagesReady = true;
    view.hasOlder = messages.length >= meta.size;
    view.els.chatState.hidden = true;
  }

  const incoming = fresh.filter((m) => !sameId(m.user_id, view.user.id) && !m.pending);
  const wasNear = isNearBottom();
  const lastOwn = fresh.some((m) => sameId(m.user_id, view.user.id));

  renderChat({ stick: first || wasNear || lastOwn });

  if (!first && incoming.length) {
    if (view.tab !== 'chat') {
      view.unread += incoming.length;
      view.els.unreadDot.hidden = false;
    } else if (!wasNear) {
      view.els.newPill.hidden = false;
    }
  }

  const unknown = messages.map((m) => m.user_id).filter((id) => !view.usersById.has(String(id)));
  if (unknown.length) {
    const local = view;
    ensureUsers(unknown).then((loaded) => { if (loaded && view === local) renderChat({ stick: false }); }).catch(() => {});
  }
}

function isNearBottom() {
  const el = view?.els.chatScroll;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
}

function scrollChatToBottom(smooth = false) {
  const el = view.els.chatScroll;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function messageHtml(msg, follow, canManage) {
  const own = sameId(msg.user_id, view.user.id);
  const sender = getUser(msg.user_id);
  const name = sender?.full_name || 'مستخدم';
  const time = timeFormat.format(toMs(msg.created_at) || Date.now());
  const canDelete = !msg.deleted && !msg.pending && (own || canManage);
  const classes = ['message-item', own ? 'message-own' : '', follow ? 'is-follow' : ''].filter(Boolean).join(' ');

  return `
    <div class="${classes}">
      <span class="message-avatar">${avatarHtml(sender)}</span>
      <div class="message-bubble ${msg.deleted ? 'is-deleted' : ''}">
        ${!own && !follow ? `<span class="message-sender">${escapeHtml(name)}${sender?.user_type && sender.user_type !== 'student' ? ` <em>${roleLabel(sender.user_type)}</em>` : ''}</span>` : ''}
        <span class="message-text">${msg.deleted ? 'تم حذف هذه الرسالة' : escapeHtml(msg.message)}</span>
        <span class="message-meta">
          ${msg.pending ? '<i class="far fa-clock" aria-label="جاري الإرسال"></i>' : ''}
          <time>${escapeHtml(time)}</time>
          ${canDelete ? `<button type="button" class="message-delete" data-doc-id="${escapeHtml(msg.docId)}" aria-label="حذف الرسالة"><i class="fas fa-trash-alt" aria-hidden="true"></i></button>` : ''}
        </span>
      </div>
    </div>`;
}

function renderChat({ stick }) {
  const { els } = view;
  const messages = allMessages();
  const canManage = canManageGroup(view.group, view.user);
  const items = [];
  let prevDay = '';
  let prev = null;

  messages.forEach((msg) => {
    const ms = toMs(msg.created_at) || Date.now();
    const key = dayKey(ms);
    if (key !== prevDay) {
      items.push({ key: `day-${key}`, html: `<div class="chat-day"><span>${escapeHtml(dayLabel(ms))}</span></div>` });
      prevDay = key;
      prev = null;
    }
    const follow = Boolean(prev) && sameId(prev.user_id, msg.user_id) && ms - prev.ms < FOLLOW_WINDOW_MS;
    items.push({ key: msg.docId, html: messageHtml(msg, follow, canManage) });
    prev = { user_id: msg.user_id, ms };
  });

  const scroller = els.chatScroll;
  const beforeHeight = scroller.scrollHeight;
  const beforeTop = scroller.scrollTop;

  if (!messages.length) {
    reconcile(els.chatMessages, [], view.chatRegistry);
    els.chatState.hidden = false;
    els.chatState.innerHTML = '<i class="fas fa-comments" aria-hidden="true"></i><span>لا توجد رسائل بعد. ابدأ المحادثة!</span>';
  } else {
    if (view.messagesReady) els.chatState.hidden = true;
    reconcile(els.chatMessages, items, view.chatRegistry);
  }

  els.chatOlder.hidden = !view.hasOlder;

  if (stick) scrollChatToBottom();
  else if (view.loadingOlder) scroller.scrollTop = beforeTop + (scroller.scrollHeight - beforeHeight);
}

async function loadOlderMessages() {
  if (view.loadingOlder || !view.hasOlder) return;
  const oldest = allMessages().find((m) => m.created_at && !m.pending);
  if (!oldest) return;

  const local = view;
  local.loadingOlder = true;
  setBusy(local.els.chatOlderBtn, true);
  try {
    const older = await getGroupMessagesBefore(local.groupId, oldest.created_at, GROUPS_LIMITS.MESSAGES_PAGE);
    if (view !== local) return;
    local.hasOlder = older.length >= GROUPS_LIMITS.MESSAGES_PAGE;
    local.older = [...older, ...local.older];
    older.forEach((m) => local.seen.add(m.docId));
    await ensureUsers(older.map((m) => m.user_id)).catch(() => {});
    if (view !== local) return;
    renderChat({ stick: false });
  } catch (error) {
    showToast('تعذر تحميل الرسائل الأقدم', 'error');
  } finally {
    if (view === local) {
      local.loadingOlder = false;
      setBusy(local.els.chatOlderBtn, false);
    }
  }
}

function sendMessage() {
  const { els, groupId, user } = view;
  const text = els.chatInput.value.trim();
  if (!text || !canPost() || navigator.onLine === false) return;
  if (text.length > GROUPS_LIMITS.MAX_MESSAGE) {
    showToast(`الرسالة أطول من ${GROUPS_LIMITS.MAX_MESSAGE} حرفًا`, 'warning');
    return;
  }

  els.chatInput.value = '';
  els.chatCounter.hidden = true;
  autosizeChatInput();
  els.chatInput.focus();

  sendGroupMessage(groupId, user.id, text).catch((error) => {
    showToast(friendlyError(error, 'فشل إرسال الرسالة'), 'error');
    if (view && !view.els.chatInput.value) {
      view.els.chatInput.value = text;
      autosizeChatInput();
    }
  });
}

// ==== الدروس والامتحانات ====
function missingCardHtml(type, id) {
  return `
    <div class="custom-card custom-card--missing">
      <h4>محتوى غير متاح</h4>
      <p>تم حذف هذا ${type === 'lesson' ? 'الدرس' : 'الامتحان'} من المنصة.</p>
      <div class="card-actions">
        <button type="button" class="btn btn-sm btn-danger remove-content-btn" data-type="${type}" data-id="${id}" aria-label="إزالة من المجموعة">
          <i class="fas fa-times" aria-hidden="true"></i><span>إزالة</span>
        </button>
      </div>
    </div>`;
}

function contentCardHtml(type, item, manage) {
  const meta = type === 'lesson'
    ? [item.stage, item.grade ? `الصف ${item.grade}` : ''].filter(Boolean)
    : [`${item.questions_count || 0} سؤال`, `${item.duration || 30} دقيقة`];
  const locked = !canUserOpen(type, item, view.user);
  const blocked = manage ? countBlockedMembers(type, item) : 0;
  const openLabel = type === 'lesson' ? 'عرض الدرس' : 'بدء الامتحان';

  return `
    <article class="custom-card ${locked ? 'is-locked' : ''}" data-type="${type}" data-id="${item.id}">
      <span class="custom-card-icon" aria-hidden="true"><i class="fas ${type === 'lesson' ? 'fa-book-open' : 'fa-file-signature'}"></i></span>
      <h4>${escapeHtml(item.title)}</h4>
      <p>${item.description ? escapeHtml(item.description) : ''}</p>
      <div class="custom-card-meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>
      ${blocked ? `<p class="custom-card-warning"><i class="fas fa-exclamation-circle" aria-hidden="true"></i> لن يتمكن ${blocked} طالب من فتحه بسبب اختلاف الصف</p>` : ''}
      <div class="card-actions">
        ${locked
          ? '<button type="button" class="btn btn-sm btn-secondary" disabled><i class="fas fa-lock" aria-hidden="true"></i><span>غير متاح لصفك</span></button>'
          : `<button type="button" class="btn btn-sm btn-primary open-content-btn" data-type="${type}" data-id="${item.id}">${openLabel}</button>`}
        ${manage ? `<button type="button" class="btn btn-sm btn-danger remove-content-btn" data-type="${type}" data-id="${item.id}" aria-label="إزالة ${escapeHtml(item.title)} من المجموعة"><i class="fas fa-times" aria-hidden="true"></i></button>` : ''}
      </div>
    </article>`;
}

function renderContentGrid(type) {
  const { group, user } = view;
  const manage = canManageGroup(group, user);
  const ids = type === 'lesson' ? group.lessons : group.exams;
  const data = type === 'lesson' ? view.lessons : view.exams;
  const grid = type === 'lesson' ? view.els.lessonsGrid : view.els.examsGrid;
  const byId = new Map(data.map((item) => [String(item.id), item]));

  if (!ids.length) {
    const noun = type === 'lesson' ? 'دروس' : 'امتحانات';
    grid.innerHTML = `
      <div class="grp-empty-inline">
        <i class="fas ${type === 'lesson' ? 'fa-book-open' : 'fa-file-signature'}" aria-hidden="true"></i>
        <p>لا توجد ${noun} مخصصة لهذه المجموعة بعد.</p>
        ${manage ? `<span>استخدم زر «إضافة ${noun}» لإضافة محتوى.</span>` : ''}
      </div>`;
    return;
  }

  grid.innerHTML = [...ids].reverse().map((id) => {
    const item = byId.get(String(id));
    if (item) return contentCardHtml(type, item, manage);
    return manage ? missingCardHtml(type, id) : '';
  }).join('');
}

const renderLessons = () => renderContentGrid('lesson');
const renderExams = () => renderContentGrid('exam');

async function onContentClick(e) {
  const removeBtn = e.target.closest('.remove-content-btn');
  if (removeBtn) {
    const { type, id } = removeBtn.dataset;
    const ok = await askConfirm({
      title: 'إزالة من المجموعة',
      message: `سيتم إزالة ${type === 'lesson' ? 'الدرس' : 'الامتحان'} من المجموعة فقط دون حذفه من المنصة.`,
      confirmText: 'إزالة',
      type: 'danger'
    });
    if (!ok || !view) return;
    setBusy(removeBtn, true);
    try {
      await removeContentFromGroup(view.groupId, type, id);
      showToast('تمت الإزالة', 'success');
    } catch (error) {
      showToast(friendlyError(error, 'فشلت الإزالة'), 'error');
      setBusy(removeBtn, false);
    }
    return;
  }

  const target = e.target.closest('.open-content-btn') || e.target.closest('.custom-card[data-id]');
  if (!target) return;
  if (target.closest('.custom-card')?.classList.contains('is-locked')) {
    showToast('هذا المحتوى غير متاح لمرحلتك أو صفك الدراسي', 'warning');
    return;
  }
  const { type, id } = target.dataset;
  safeNavigate(type === 'lesson' ? 'lesson-view' : 'exam-view', { path: { id } });
}

// ==== الأعضاء ====
function canRemoveMember(target) {
  const { group, user } = view;
  return canManageGroup(group, user)
    && !sameId(target.id, group.created_by)
    && !sameId(target.id, user.id)
    && (isTeacher(user) || target.user_type !== 'teacher');
}

function renderMembers() {
  const { els, group } = view;
  const members = group.members.map((id) => getUser(id) || { id, full_name: 'مستخدم محذوف', user_type: 'student', missing: true });

  els.membersFilterWrap.hidden = members.length <= 8;
  const needle = normalizeArabic(els.membersFilter.value);

  const sorted = members
    .filter((m) => !needle || normalizeArabic(m.full_name).includes(needle))
    .sort((a, b) => {
      if (sameId(a.id, group.created_by)) return -1;
      if (sameId(b.id, group.created_by)) return 1;
      return (ROLE_ORDER[a.user_type] ?? 3) - (ROLE_ORDER[b.user_type] ?? 3) || a.full_name.localeCompare(b.full_name, 'ar');
    });

  if (!sorted.length) {
    els.membersList.innerHTML = '<div class="grp-empty-inline"><i class="fas fa-user-slash" aria-hidden="true"></i><p>لا يوجد أعضاء مطابقون.</p></div>';
    return;
  }

  els.membersList.innerHTML = sorted.map((m) => `
    <div class="member-item">
      <span class="member-avatar">${avatarHtml(m)}</span>
      <div class="member-info">
        <span class="member-name">
          ${escapeHtml(m.full_name)}
          ${sameId(m.id, group.created_by) ? '<span class="owner-badge">المالك</span>' : ''}
          ${sameId(m.id, view.user.id) ? '<span class="you-badge">أنت</span>' : ''}
        </span>
        <span class="member-role">${roleLabel(m.user_type)}${m.user_type === 'student' && m.grade ? ` · ${escapeHtml(m.stage || '')} الصف ${escapeHtml(m.grade)}` : ''}</span>
      </div>
      ${canRemoveMember(m) ? `<button type="button" class="btn btn-sm btn-danger remove-member-btn" data-user-id="${escapeHtml(m.id)}" aria-label="إزالة ${escapeHtml(m.full_name)} من المجموعة"><i class="fas fa-user-minus" aria-hidden="true"></i></button>` : ''}
    </div>`).join('');
}

async function onMemberClick(e) {
  const btn = e.target.closest('.remove-member-btn');
  if (!btn) return;
  const target = getUser(btn.dataset.userId);
  const ok = await askConfirm({
    title: 'إزالة عضو',
    message: `هل تريد إزالة ${target?.full_name || 'هذا العضو'} من المجموعة؟`,
    confirmText: 'إزالة',
    type: 'danger'
  });
  if (!ok || !view) return;
  setBusy(btn, true);
  try {
    await removeGroupMember(view.groupId, btn.dataset.userId);
    showToast('تمت إزالة العضو', 'success');
  } catch (error) {
    showToast(friendlyError(error, 'فشلت الإزالة'), 'error');
    setBusy(btn, false);
  }
}

// ==== تعديل المجموعة ====
function openEditModal() {
  const { els, group } = view;
  els.editName.value = group.name;
  els.editDesc.value = group.description;
  els.editName.dispatchEvent(new Event('input'));
  els.editDesc.dispatchEvent(new Event('input'));
  els.editNameError.hidden = true;
  view.modals.edit.open();
}

async function submitEditForm(e) {
  e.preventDefault();
  const { els } = view;
  const name = els.editName.value.trim();
  if (!name) {
    els.editNameError.textContent = 'اسم المجموعة مطلوب';
    els.editNameError.hidden = false;
    els.editName.focus();
    return;
  }
  setBusy(els.editSaveBtn, true);
  try {
    await updateGroup(view.groupId, { name, description: els.editDesc.value.trim() });
    showToast('تم حفظ التعديلات', 'success');
    view.modals.edit.close();
  } catch (error) {
    showToast(friendlyError(error, 'فشل حفظ التعديلات'), 'error');
  } finally {
    if (view) setBusy(els.editSaveBtn, false);
  }
}

// ==== إضافة أعضاء ====
function updateAddMembersLabel(count = view.pickers.add?.count || 0) {
  const remaining = GROUPS_LIMITS.MAX_MEMBERS - (view.group?.members.length || 0);
  view.els.addMembersLabel.textContent = `${count ? `${count} مختار — ` : ''}يمكن إضافة ${Math.max(remaining - count, 0)} عضو إضافي`;
  view.els.confirmAddMembers.disabled = count === 0;
}

function openAddMembersModal() {
  view.pickers.add.reset();
  updateAddMembersLabel(0);
  view.modals.members.open();
}

async function confirmAddMembers() {
  const { els, groupId, user, group } = view;
  const ids = view.pickers.add.getSelectedIds();
  if (!ids.length) return;

  setBusy(els.confirmAddMembers, true);
  try {
    const { added } = await addGroupMembers(groupId, ids);
    showToast(added.length ? `تمت إضافة ${added.length} عضو` : 'جميع المختارين أعضاء بالفعل', added.length ? 'success' : 'info');
    notifyAddedMembers(added, group.name, groupId, user);
    view.modals.members.close();
  } catch (error) {
    showToast(friendlyError(error, 'فشلت الإضافة'), 'error');
  } finally {
    if (view) setBusy(els.confirmAddMembers, false);
  }
}

// ==== إضافة محتوى ====
async function openAddContentModal(type) {
  const { els } = view;
  view.contentType = type;
  view.contentSelected = new Set();
  view.contentQuery = '';
  els.contentSearch.value = '';
  els.contentTitle.textContent = type === 'lesson' ? 'إضافة دروس للمجموعة' : 'إضافة امتحانات للمجموعة';
  els.contentSearch.placeholder = type === 'lesson' ? 'ابحث في عناوين الدروس...' : 'ابحث في عناوين الامتحانات...';
  updateContentConfirm();
  els.contentList.innerHTML = '<div class="grp-list-state"><span class="grp-spinner" aria-hidden="true"></span><span>جاري تحميل المحتوى...</span></div>';
  view.modals.content.open();

  const local = view;
  try {
    if (!local.catalogs[type]) local.catalogs[type] = await getGroupContentCatalog(type);
    if (view !== local || local.contentType !== type) return;
    renderContentList();
  } catch (error) {
    console.error('❌ [group-view] فشل جلب المحتوى:', error);
    if (view !== local) return;
    els.contentList.innerHTML = '<div class="grp-list-state"><span>تعذر تحميل المحتوى، أغلق النافذة وحاول مرة أخرى.</span></div>';
  }
}

function renderContentList() {
  const { els, group, contentType: type } = view;
  const existing = new Set((type === 'lesson' ? group.lessons : group.exams).map(String));
  const needle = normalizeArabic(view.contentQuery);
  const items = (view.catalogs[type] || [])
    .filter((item) => !existing.has(String(item.id)))
    .filter((item) => !needle || normalizeArabic(item.title).includes(needle));

  if (!items.length) {
    const none = (view.catalogs[type] || []).every((item) => existing.has(String(item.id)));
    els.contentList.innerHTML = `<div class="grp-list-state"><span>${none ? 'تمت إضافة كل المحتوى المتاح إلى المجموعة.' : 'لا توجد نتائج مطابقة.'}</span></div>`;
    return;
  }

  els.contentList.innerHTML = items.map((item) => {
    const meta = [item.stage, item.grade ? `الصف ${item.grade}` : '', item.semester ? `الفصل ${item.semester}` : ''].filter(Boolean).join(' · ');
    const blocked = countBlockedMembers(type, item);
    return `
      <label class="grp-content-item">
        <input type="checkbox" value="${escapeHtml(item.id)}" ${view.contentSelected.has(String(item.id)) ? 'checked' : ''}>
        <span class="grp-content-text">
          <strong>${escapeHtml(item.title)}</strong>
          ${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
          ${blocked ? `<small class="grp-content-warn">لن يتمكن ${blocked} طالب من فتحه (صف مختلف)</small>` : ''}
        </span>
      </label>`;
  }).join('');
}

function onContentToggle(e) {
  const box = e.target.closest('input[type="checkbox"]');
  if (!box) return;
  if (box.checked) view.contentSelected.add(box.value);
  else view.contentSelected.delete(box.value);
  updateContentConfirm();
}

function updateContentConfirm() {
  const count = view.contentSelected.size;
  const { confirmAddContent } = view.els;
  confirmAddContent.disabled = count === 0;
  confirmAddContent.querySelector('.grp-btn-label').textContent = count ? `إضافة (${count})` : 'إضافة';
}

async function confirmAddContent() {
  const { els, groupId, contentType: type } = view;
  const ids = [...view.contentSelected].map(Number);
  if (!ids.length) return;

  setBusy(els.confirmAddContent, true);
  try {
    await addContentToGroup(groupId, type, ids);
    showToast(`تمت إضافة ${ids.length} ${type === 'lesson' ? 'درس' : 'امتحان'}`, 'success');
    view.modals.content.close();
  } catch (error) {
    showToast(friendlyError(error, 'فشلت الإضافة'), 'error');
  } finally {
    if (view) setBusy(els.confirmAddContent, false);
  }
}

// ==== المغادرة والحذف ====
async function confirmLeaveGroup() {
  const ok = await askConfirm({
    title: 'مغادرة المجموعة',
    message: 'لن تتمكن من العودة إلا بإضافتك من جديد بواسطة المعلم أو المشرف.',
    confirmText: 'مغادرة',
    type: 'danger'
  });
  if (!ok || !view) return;

  setBusy(view.els.leaveBtn, true);
  try {
    await removeGroupMember(view.groupId, view.user.id);
    showToast('تمت مغادرة المجموعة', 'success');
    view.unsubGroup?.();
    safeNavigate('groups');
  } catch (error) {
    showToast(friendlyError(error, 'فشلت المغادرة'), 'error');
    if (view) setBusy(view.els.leaveBtn, false);
  }
}

async function confirmDeleteGroup() {
  const ok = await askConfirm({
    title: 'حذف المجموعة',
    message: `سيتم حذف «${view.group.name}» وكل رسائلها نهائيًا ولا يمكن التراجع عن ذلك.`,
    confirmText: 'حذف نهائيًا',
    type: 'danger'
  });
  if (!ok || !view) return;

  setBusy(view.els.deleteBtn, true);
  try {
    view.unsubGroup?.();
    view.unsubGroup = null;
    view.unsubMessages?.();
    view.unsubMessages = null;
    await deleteGroup(view.groupId);
    showToast('تم حذف المجموعة', 'success');
    safeNavigate('groups');
  } catch (error) {
    showToast(friendlyError(error, 'فشل حذف المجموعة'), 'error');
    if (view) {
      setBusy(view.els.deleteBtn, false);
      view.sig = '';
      startGroupSubscription();
      startMessagesSubscription();
    }
  }
}
