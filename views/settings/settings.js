/**
 * ⚙️ views/settings/settings.js - نظام الإعدادات v5.0.0
 * ============================================================================
 * 📝 المسؤولية: إدارة إعدادات المستخدم (الملف الشخصي، الصورة الشخصية،
 *               المظهر والإشعارات، الأمان، الإعدادات المتقدمة للمعلم/المشرف)
 * ✅ التكامل:
 *   - settings.html: كل العناصر تُجلب بمعرّفات st-* وبشكل آمن (لا انهيار عند غياب عنصر)
 *   - api.js: getUserById, updateUserProfile, updateUserPreferences,
 *             updateUserPassword, deleteUserAccount
 *   - session.js: getCurrentUser, setSession, clearSession
 *   - theme.js: setTheme, setColorTheme, getCurrentTheme, getCurrentColorTheme
 *   - avatar.js: createAvatarElement, canChooseJobAvatar, getAvatarJobName
 *   - modals.js: toast, confirm, avatarPicker (المحدد الموحّد للصور)
 *   - event-bus.js: profile:updated, avatar:updated (+ الأسماء القديمة للتوافق)
 *   - router.js: initializePage(container, params) / cleanupPage()
 * ============================================================================
 */

import {
  getCurrentUser,
  setSession,
  clearSession
} from '../../js/core/session.js';

import {
  getUserById,
  updateUserProfile,
  updateUserPreferences,
  updateUserPassword,
  deleteUserAccount
} from '../../js/core/api.js';

// ==== استيراد كامل: غياب دالة في theme.js لا يكسر تحميل الصفحة ====
import * as themeApi from '../../js/core/theme.js';
import { EventBus } from '../../js/core/event-bus.js';

import {
  createAvatarElement,
  canChooseJobAvatar,
  getAvatarJobName
} from '../../js/utils/avatar.js';

// ====== 1. الثوابت والتكوين ======
const SETTINGS_CONFIG = {
  STORAGE_KEYS: {
    NOTIFICATIONS: 'biologist_notifications',
    SHOW_SENSITIVE: 'biologist_show_sensitive',
    THEME_MODE: 'biologist_theme_mode'
  },
  TABS: ['profile', 'avatar', 'appearance', 'security', 'advanced'],
  LIMITS: {
    NAME_MIN: 2,
    NAME_MAX: 60,
    AGE_MIN: 10,
    AGE_MAX: 80,
    PASS_MIN: 6,
    PASS_MAX: 10
  },
  STAGE_MAP: { preparatory: 'إعدادي', secondary: 'ثانوي' },
  EMAIL_PATTERN: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  PREFS_SAVE_DELAY: 600
};

// ====== 2. الحالة الداخلية ======
function createInitialState() {
  return {
    root: null,
    user: null,
    abort: null,
    prefsTimer: null,
    themeMode: 'light',
    formDirty: false,
    busy: { profile: false, security: false, remove: false }
  };
}

let $settingsState = createInitialState();
let $navToken = 0;

// ====== 3. دوال مساعدة ======
function byId(id) {
  return $settingsState.root?.querySelector(`#${id}`) ?? null;
}

function queryAll(selector) {
  return Array.from($settingsState.root?.querySelectorAll(selector) ?? []);
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (_e) { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_e) { /* التخزين غير متاح */ }
}

function safeToast(message, type = 'info') {
  if (window.modals?.toast) window.modals.toast(message, type);
  else console.log(`[${type}] ${message}`);
}

function safeNavigate(route, params = {}, options = {}) {
  if (window.router?.navigateTo) window.router.navigateTo(route, params, options);
  else console.error('Router غير متاح');
}

async function showConfirm(options) {
  if (window.modals?.confirm) {
    const result = await window.modals.confirm({
      title: options.title,
      message: options.message,
      confirmText: options.confirmText || 'نعم',
      cancelText: options.cancelText || 'إلغاء',
      type: options.type || 'default'
    });
    return result === true;
  }
  return window.confirm(options.message);
}

function setValue(el, value) {
  if (el) el.value = value ?? '';
}

function setButtonBusy(btn, busy, busyText) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = busyText;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.removeAttribute('aria-busy');
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    delete btn.dataset.label;
  }
}

function normalizeStage(stage) {
  return SETTINGS_CONFIG.STAGE_MAP[stage] || stage || '';
}

function isStudent(user) {
  return (user?.user_type || 'student') === 'student';
}

function isStaff(user) {
  return user?.user_type === 'teacher' || user?.user_type === 'moderator';
}

// ====== 4. الجلسة والأحداث ======
async function persistSession(user) {
  try {
    await setSession(user);
  } catch (error) {
    console.warn('⚠️ تعذّر تحديث الجلسة المحلية:', error);
  }
  window.$currentUser = user;
}

function broadcastUserChange(kind, user) {
  const isAvatar = kind === 'avatar';
  const detail = { user };
  const names = isAvatar
    ? ['avatar:updated', 'avatarUpdated']
    : ['profile:updated', 'profileUpdated'];

  // ==== الاسم الجديد + الاسم القديم للتوافق مع المستمعين الحاليين ====
  names.forEach((name) => {
    try { EventBus.emit(name, detail); } catch (_e) { /* ناقل الأحداث غير جاهز */ }
  });
  try {
    document.dispatchEvent(new CustomEvent(names[1], { detail }));
  } catch (_e) { /* تجاهل */ }
}

function hasProfileDiff(a, b) {
  const keys = ['full_name', 'email', 'age', 'stage', 'grade', 'gender', 'phone', 'avatar_job_index', 'user_type'];
  return keys.some((key) => String(a?.[key] ?? '') !== String(b?.[key] ?? ''));
}

// ====== 5. أخطاء الحقول ======
function setFieldError(inputId, message) {
  const input = byId(inputId);
  const errorEl = $settingsState.root?.querySelector(`[data-error-for="${inputId}"]`);
  if (errorEl) errorEl.textContent = message || '';
  if (input) {
    input.classList.toggle('is-invalid', Boolean(message));
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function clearFieldErrors(inputIds) {
  inputIds.forEach((id) => setFieldError(id, ''));
}

function focusFirstInvalid(inputIds, errors) {
  const firstId = inputIds.find((id) => errors[id]);
  byId(firstId)?.focus();
}

// ====== 6. ملء البيانات وبوابات الأدوار ======
function applyRoleGates(user) {
  const student = isStudent(user);
  const staff = isStaff(user);

  queryAll('[data-student-only]').forEach((el) => { el.hidden = !student; });

  const advancedTab = byId('st-tab-advanced');
  if (advancedTab) advancedTab.hidden = !staff;

  // ==== حذف الحساب للطالب فقط (المعلم والمشرف يُداران من لوحة التحكم) ====
  const dangerZone = byId('st-danger-zone');
  if (dangerZone) dangerZone.hidden = !student;
}

function fillProfileForm(user) {
  if (!user) return;

  setValue(byId('st-fullname'), user.full_name);
  setValue(byId('st-email'), user.email);
  setValue(byId('st-phone'), user.phone);
  setValue(byId('st-age'), user.age ? user.age : '');
  setValue(byId('st-gender'), user.gender || 'male');

  if (isStudent(user)) {
    setValue(byId('st-stage'), normalizeStage(user.stage));
    setValue(byId('st-grade'), user.grade ? String(user.grade) : '');
  }
}

function fillAdvancedForm() {
  const sensitive = byId('st-show-sensitive');
  if (sensitive) sensitive.checked = storageGet(SETTINGS_CONFIG.STORAGE_KEYS.SHOW_SENSITIVE) === 'true';
}

// ====== 7. الصورة الشخصية ======
function renderAvatarTab() {
  const user = $settingsState.user;
  const slot = byId('st-avatar-slot');
  if (!user || !slot) return;

  const avatar = createAvatarElement(user, 'xl', {
    showFrame: true,
    showBadge: true,
    clickable: false
  });
  slot.replaceChildren(avatar);

  const canChoose = canChooseJobAvatar(user);

  const nameEl = byId('st-avatar-name');
  if (nameEl) nameEl.textContent = user.full_name || '';

  const jobEl = byId('st-avatar-job');
  if (jobEl) jobEl.textContent = canChoose ? getAvatarJobName(user) : '';

  const changeBtn = byId('st-avatar-change');
  if (changeBtn) changeBtn.hidden = !canChoose;

  const hintEl = byId('st-avatar-hint');
  if (hintEl) {
    hintEl.textContent = canChoose
      ? 'تظهر صورتك في ملفك الشخصي وفي تعليقاتك'
      : 'صورة هذا الحساب ثابتة ولا يمكن تغييرها';
  }
}

async function openAvatarPicker() {
  const user = $settingsState.user;
  if (!user) return;

  if (!window.modals?.avatarPicker) {
    safeToast('نظام النوافذ غير متاح حالياً', 'error');
    return;
  }

  try {
    await window.modals.avatarPicker({
      user,
      onSave: async (jobIndex) => {
        await updateUserProfile(user.id, { avatar_job_index: jobIndex });
        const updated = { ...$settingsState.user, avatar_job_index: jobIndex };
        $settingsState.user = updated;
        await persistSession(updated);
        broadcastUserChange('avatar', updated);
        renderAvatarTab();
        return true;
      }
    });
  } catch (error) {
    console.error('❌ فشل فتح محدد الصورة:', error);
    safeToast('حدث خطأ أثناء تغيير الصورة', 'error');
  }
}

// ====== 8. حفظ الملف الشخصي ======
const PROFILE_FIELD_IDS = ['st-fullname', 'st-email', 'st-age'];

function collectProfileValues() {
  const ageRaw = byId('st-age')?.value.trim() ?? '';
  return {
    fullName: (byId('st-fullname')?.value ?? '').replace(/\s+/g, ' ').trim(),
    email: (byId('st-email')?.value ?? '').trim(),
    age: ageRaw === '' ? null : Number(ageRaw),
    stage: byId('st-stage')?.value || '',
    grade: parseInt(byId('st-grade')?.value, 10) || 0
  };
}

function validateProfile(values) {
  const { NAME_MIN, NAME_MAX, AGE_MIN, AGE_MAX } = SETTINGS_CONFIG.LIMITS;
  const errors = {};

  if (values.fullName.length < NAME_MIN) {
    errors['st-fullname'] = 'الاسم الكامل مطلوب';
  } else if (values.fullName.length > NAME_MAX) {
    errors['st-fullname'] = `الاسم لا يزيد عن ${NAME_MAX} حرفاً`;
  }

  if (values.email && !SETTINGS_CONFIG.EMAIL_PATTERN.test(values.email)) {
    errors['st-email'] = 'صيغة البريد الإلكتروني غير صحيحة';
  }

  if (values.age !== null && (!Number.isInteger(values.age) || values.age < AGE_MIN || values.age > AGE_MAX)) {
    errors['st-age'] = `العمر يجب أن يكون بين ${AGE_MIN} و${AGE_MAX}`;
  }

  return errors;
}

function buildProfileUpdates(values, user) {
  const updates = {};

  if (values.fullName !== (user.full_name || '')) updates.full_name = values.fullName;
  if (values.email !== (user.email || '')) updates.email = values.email;
  if (values.age !== null && values.age !== Number(user.age || 0)) updates.age = values.age;

  if (isStudent(user)) {
    if (values.stage && values.stage !== normalizeStage(user.stage)) updates.stage = values.stage;
    if (values.grade && values.grade !== Number(user.grade || 0)) updates.grade = values.grade;
  }

  return updates;
}

async function handleProfileSubmit(event) {
  event.preventDefault();
  const state = $settingsState;
  const user = state.user;
  if (!user || state.busy.profile) return;

  const values = collectProfileValues();
  const errors = validateProfile(values);
  PROFILE_FIELD_IDS.forEach((id) => setFieldError(id, errors[id] || ''));

  if (Object.keys(errors).length) {
    focusFirstInvalid(PROFILE_FIELD_IDS, errors);
    return;
  }

  const updates = buildProfileUpdates(values, user);
  if (!Object.keys(updates).length) {
    safeToast('لا توجد تغييرات لحفظها', 'info');
    return;
  }

  const saveBtn = byId('st-profile-save');
  state.busy.profile = true;
  setButtonBusy(saveBtn, true, 'جاري الحفظ...');

  try {
    await updateUserProfile(user.id, updates);

    const updated = { ...user, ...updates };
    if (state.user === user) state.user = updated;
    state.formDirty = false;

    await persistSession(updated);
    broadcastUserChange('profile', updated);
    renderAvatarTab();

    safeToast('تم تحديث الملف الشخصي بنجاح', 'success');
  } catch (error) {
    console.error('❌ فشل تحديث الملف الشخصي:', error);
    safeToast(error?.message || 'فشل تحديث الملف الشخصي', 'error');
  } finally {
    state.busy.profile = false;
    setButtonBusy(saveBtn, false);
  }
}

// ====== 9. المظهر والإشعارات ======
function resolveSystemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readThemeMode() {
  const current = themeApi.getCurrentTheme?.() === 'dark' ? 'dark' : 'light';
  const saved = storageGet(SETTINGS_CONFIG.STORAGE_KEYS.THEME_MODE);
  // ==== الوضع التلقائي يبقى فعّالاً فقط ما دام يطابق ثيم النظام ====
  if (saved === 'system' && current === resolveSystemTheme()) return 'system';
  return current;
}

function readColorTheme() {
  return themeApi.getCurrentColorTheme?.() || 'blue';
}

function setRadioState(group, itemSelector, isChecked) {
  if (!group) return;
  const items = Array.from(group.querySelectorAll(itemSelector));
  const hasChecked = items.some(isChecked);
  items.forEach((item, index) => {
    const on = isChecked(item);
    item.setAttribute('aria-checked', String(on));
    item.classList.toggle('is-active', on);
    item.tabIndex = on || (!hasChecked && index === 0) ? 0 : -1;
  });
}

function renderThemeControls() {
  setRadioState(byId('st-mode-group'), '[data-mode]', (btn) => btn.dataset.mode === $settingsState.themeMode);
  const color = readColorTheme();
  setRadioState(byId('st-color-group'), '[data-color]', (btn) => btn.dataset.color === color);
}

function renderAppearanceForm() {
  $settingsState.themeMode = readThemeMode();
  renderThemeControls();

  const notifications = byId('st-notifications');
  if (notifications) {
    notifications.checked = storageGet(SETTINGS_CONFIG.STORAGE_KEYS.NOTIFICATIONS) !== 'disabled';
  }
}

async function savePreferences(user) {
  if (!user?.id) return;

  const preferences = {};
  const theme = themeApi.getCurrentTheme?.();
  const color = themeApi.getCurrentColorTheme?.();
  if (theme) preferences.preferred_theme = theme;
  if (color) preferences.preferred_color_theme = color;
  if (!Object.keys(preferences).length) return;

  try {
    await updateUserPreferences(user.id, preferences);
  } catch (error) {
    // ==== المظهر محفوظ محلياً؛ فشل المزامنة غير حرج ====
    console.warn('⚠️ تعذّرت مزامنة تفضيلات المظهر:', error);
  }
}

function schedulePreferencesSave() {
  const state = $settingsState;
  clearTimeout(state.prefsTimer);
  const user = state.user;
  state.prefsTimer = setTimeout(() => {
    state.prefsTimer = null;
    savePreferences(user);
  }, SETTINGS_CONFIG.PREFS_SAVE_DELAY);
}

function flushPendingPreferences() {
  const state = $settingsState;
  if (!state.prefsTimer) return;
  clearTimeout(state.prefsTimer);
  state.prefsTimer = null;
  savePreferences(state.user);
}

function applyThemeMode(mode) {
  const resolved = mode === 'system' ? resolveSystemTheme() : mode;
  themeApi.setTheme?.(resolved, true);
  storageSet(SETTINGS_CONFIG.STORAGE_KEYS.THEME_MODE, mode);
  $settingsState.themeMode = mode;
  renderThemeControls();
  schedulePreferencesSave();
}

function applyColorTheme(color) {
  themeApi.setColorTheme?.(color, true);
  renderThemeControls();
  schedulePreferencesSave();
}

function handleNotificationsChange(event) {
  const enabled = Boolean(event.target.checked);
  storageSet(SETTINGS_CONFIG.STORAGE_KEYS.NOTIFICATIONS, enabled ? 'enabled' : 'disabled');
  safeToast(enabled ? 'تم تفعيل إشعارات المنصة' : 'تم إيقاف إشعارات المنصة', 'success');
}

function handleSensitiveChange(event) {
  const enabled = Boolean(event.target.checked);
  storageSet(SETTINGS_CONFIG.STORAGE_KEYS.SHOW_SENSITIVE, enabled ? 'true' : 'false');
  safeToast(enabled ? 'سيتم عرض البيانات الكاملة' : 'سيتم إخفاء جزء من البيانات الحساسة', 'success');
}

// ====== 10. الأمان وكلمة المرور ======
const SECURITY_FIELD_IDS = ['st-current-password', 'st-new-password', 'st-confirm-password'];

function validatePasswords(current, next, confirm) {
  const { PASS_MIN, PASS_MAX } = SETTINGS_CONFIG.LIMITS;
  const errors = {};

  if (!current) errors['st-current-password'] = 'أدخل كلمة المرور الحالية';

  if (!next) {
    errors['st-new-password'] = 'أدخل كلمة المرور الجديدة';
  } else if (next.length < PASS_MIN || next.length > PASS_MAX) {
    errors['st-new-password'] = `كلمة المرور من ${PASS_MIN} إلى ${PASS_MAX} أحرف`;
  } else if (next === current) {
    errors['st-new-password'] = 'كلمة المرور الجديدة يجب أن تختلف عن الحالية';
  }

  if (!confirm) {
    errors['st-confirm-password'] = 'أكّد كلمة المرور الجديدة';
  } else if (next && confirm !== next) {
    errors['st-confirm-password'] = 'كلمتا المرور غير متطابقتين';
  }

  return errors;
}

function resetPasswordFields() {
  SECURITY_FIELD_IDS.forEach((id) => {
    const input = byId(id);
    if (input) {
      input.value = '';
      input.type = 'password';
    }
  });
  queryAll('[data-toggle-password]').forEach((btn) => syncPasswordToggle(btn, false));
}

function syncPasswordToggle(btn, visible) {
  btn.setAttribute('aria-pressed', String(visible));
  btn.setAttribute('aria-label', visible ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
  const icon = btn.querySelector('i');
  if (icon) {
    icon.classList.toggle('fa-eye', !visible);
    icon.classList.toggle('fa-eye-slash', visible);
  }
}

function handlePasswordToggle(btn) {
  const input = byId(btn.dataset.togglePassword);
  if (!input) return;
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  syncPasswordToggle(btn, visible);
}

async function handleSecuritySubmit(event) {
  event.preventDefault();
  const state = $settingsState;
  const user = state.user;
  if (!user || state.busy.security) return;

  const current = byId('st-current-password')?.value ?? '';
  const next = byId('st-new-password')?.value ?? '';
  const confirm = byId('st-confirm-password')?.value ?? '';

  const errors = validatePasswords(current, next, confirm);
  SECURITY_FIELD_IDS.forEach((id) => setFieldError(id, errors[id] || ''));

  if (Object.keys(errors).length) {
    focusFirstInvalid(SECURITY_FIELD_IDS, errors);
    return;
  }

  const saveBtn = byId('st-security-save');
  state.busy.security = true;
  setButtonBusy(saveBtn, true, 'جاري التغيير...');

  try {
    await updateUserPassword(user.id, current, next);
    resetPasswordFields();
    clearFieldErrors(SECURITY_FIELD_IDS);
    safeToast('تم تغيير كلمة المرور بنجاح', 'success');
  } catch (error) {
    console.error('❌ فشل تغيير كلمة المرور:', error);
    const message = error?.message || 'فشل تغيير كلمة المرور';
    if (message.includes('الحالية')) {
      setFieldError('st-current-password', message);
      byId('st-current-password')?.focus();
    } else {
      safeToast(message, 'error');
    }
  } finally {
    state.busy.security = false;
    setButtonBusy(saveBtn, false);
  }
}

async function handleDeleteAccount() {
  const state = $settingsState;
  const user = state.user;
  if (!user || state.busy.remove || !isStudent(user)) return;

  const confirmed = await showConfirm({
    title: 'تأكيد حذف الحساب',
    message: 'هل أنت متأكد من حذف حسابك؟ سيتم حذف نتائجك وتقدّمك وتعليقاتك وإشعاراتك نهائياً ولا يمكن التراجع عن ذلك.',
    confirmText: 'حذف حسابي نهائياً',
    cancelText: 'إلغاء',
    type: 'danger'
  });
  if (!confirmed || $settingsState !== state) return;

  const deleteBtn = byId('st-delete-account');
  state.busy.remove = true;
  setButtonBusy(deleteBtn, true, 'جاري الحذف...');

  try {
    await deleteUserAccount(user.id);
    await clearSession();
    safeToast('تم حذف حسابك بنجاح', 'success');
    safeNavigate('home', {}, { replace: true });
  } catch (error) {
    console.error('❌ فشل حذف الحساب:', error);
    safeToast(error?.message || 'حدث خطأ أثناء حذف الحساب', 'error');
  } finally {
    state.busy.remove = false;
    setButtonBusy(deleteBtn, false);
  }
}

// ====== 11. التبويبات ======
function visibleTabs() {
  return queryAll('.st-tab').filter((tab) => !tab.hidden);
}

function activateTab(tabName, { focus = false } = {}) {
  const tabs = visibleTabs();
  const target = tabs.find((tab) => tab.dataset.tab === tabName) || tabs[0];
  if (!target) return;

  tabs.forEach((tab) => {
    const active = tab === target;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });

  queryAll('.st-pane').forEach((pane) => {
    pane.hidden = pane.dataset.pane !== target.dataset.tab;
  });

  target.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  if (focus) target.focus();
}

function handleTabsKeydown(event) {
  const tabs = visibleTabs();
  const index = tabs.indexOf(event.target.closest('.st-tab'));
  if (index < 0) return;

  const rtl = getComputedStyle($settingsState.root).direction === 'rtl';
  const nextKey = rtl ? 'ArrowLeft' : 'ArrowRight';
  const prevKey = rtl ? 'ArrowRight' : 'ArrowLeft';

  let nextIndex = null;
  if (event.key === nextKey || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
  else if (event.key === prevKey || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;

  if (nextIndex === null) return;
  event.preventDefault();
  activateTab(tabs[nextIndex].dataset.tab, { focus: true });
}

// ====== 12. مجموعات الاختيار (Radio) ======
function bindRadioGroup(group, itemSelector, onSelect, signal) {
  if (!group) return;

  group.addEventListener('click', (event) => {
    const item = event.target.closest(itemSelector);
    if (item && group.contains(item)) onSelect(item);
  }, { signal });

  group.addEventListener('keydown', (event) => {
    const items = Array.from(group.querySelectorAll(itemSelector));
    const index = items.indexOf(event.target.closest(itemSelector));
    if (index < 0) return;

    const rtl = getComputedStyle(group).direction === 'rtl';
    const nextKey = rtl ? 'ArrowLeft' : 'ArrowRight';
    const prevKey = rtl ? 'ArrowRight' : 'ArrowLeft';

    let nextIndex = null;
    if (event.key === nextKey || event.key === 'ArrowDown') nextIndex = (index + 1) % items.length;
    else if (event.key === prevKey || event.key === 'ArrowUp') nextIndex = (index - 1 + items.length) % items.length;

    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex].focus();
    onSelect(items[nextIndex]);
  }, { signal });
}

// ====== 13. ربط الأحداث ======
function bindEvents(signal) {
  const root = $settingsState.root;

  // ==== التبويبات ====
  const tabList = root.querySelector('.st-tabs');
  tabList?.addEventListener('click', (event) => {
    const tab = event.target.closest('.st-tab');
    if (tab && !tab.hidden) activateTab(tab.dataset.tab);
  }, { signal });
  tabList?.addEventListener('keydown', handleTabsKeydown, { signal });

  // ==== الملف الشخصي ====
  const profileForm = byId('st-profile-form');
  profileForm?.addEventListener('submit', handleProfileSubmit, { signal });
  profileForm?.addEventListener('input', (event) => {
    $settingsState.formDirty = true;
    if (event.target?.id) setFieldError(event.target.id, '');
  }, { signal });

  // ==== الصورة الشخصية ====
  byId('st-avatar-change')?.addEventListener('click', openAvatarPicker, { signal });

  // ==== المظهر ====
  bindRadioGroup(byId('st-mode-group'), '[data-mode]', (btn) => applyThemeMode(btn.dataset.mode), signal);
  bindRadioGroup(byId('st-color-group'), '[data-color]', (btn) => applyColorTheme(btn.dataset.color), signal);
  byId('st-notifications')?.addEventListener('change', handleNotificationsChange, { signal });

  // ==== الوضع التلقائي يتبع تغيّر إعداد الجهاز أثناء فتح الصفحة ====
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', () => {
    if ($settingsState.themeMode === 'system') themeApi.setTheme?.(resolveSystemTheme(), true);
  }, { signal });

  // ==== الأمان ====
  const securityForm = byId('st-security-form');
  securityForm?.addEventListener('submit', handleSecuritySubmit, { signal });
  securityForm?.addEventListener('input', (event) => {
    if (event.target?.id) setFieldError(event.target.id, '');
  }, { signal });
  securityForm?.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-toggle-password]');
    if (toggle) handlePasswordToggle(toggle);
  }, { signal });
  byId('st-delete-account')?.addEventListener('click', handleDeleteAccount, { signal });

  // ==== المتقدم ====
  byId('st-show-sensitive')?.addEventListener('change', handleSensitiveChange, { signal });
}

// ====== 14. تحديث البيانات من قاعدة البيانات ======
async function refreshUserFromServer(token) {
  const current = $settingsState.user;
  if (!current?.id) return;

  try {
    const fresh = await getUserById(current.id);
    if (token !== $navToken || !fresh) return;

    const merged = { ...current, ...fresh, stage: normalizeStage(fresh.stage) };
    const changed = hasProfileDiff(current, merged);
    $settingsState.user = merged;

    if (changed) await persistSession(merged);
    if (token !== $navToken) return;

    applyRoleGates(merged);
    // ==== لا نكتب فوق ما يكتبه المستخدم الآن ====
    if (!$settingsState.formDirty) fillProfileForm(merged);
    renderAvatarTab();
  } catch (error) {
    console.warn('⚠️ فشل جلب أحدث بيانات المستخدم:', error);
  }
}

// ====== 15. حالة "يلزم تسجيل الدخول" ======
function renderLoginRequired(root) {
  const box = document.createElement('div');
  box.className = 'st-login-required';

  const icon = document.createElement('i');
  icon.className = 'fas fa-exclamation-triangle';
  icon.setAttribute('aria-hidden', 'true');

  const text = document.createElement('p');
  text.textContent = 'يرجى تسجيل الدخول أولاً للوصول إلى الإعدادات';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'st-btn st-btn--primary';
  btn.dataset.navTarget = 'login';
  btn.textContent = 'تسجيل الدخول';

  box.append(icon, text, btn);
  root.replaceChildren(box);
}

// ====== 16. التهيئة والتنظيف ======
export function initializePage(container, params = {}) {
  // ==== إنهاء أي تهيئة سابقة قبل البدء ====
  cleanupPage();

  const token = ++$navToken;
  const root = container?.querySelector('.settings-page') || container;
  if (!root) {
    console.error('❌ حاوية صفحة الإعدادات غير موجودة');
    return;
  }

  const user = getCurrentUser();
  if (!user) {
    renderLoginRequired(root);
    return;
  }

  $settingsState = createInitialState();
  $settingsState.root = root;
  $settingsState.user = { ...user, stage: normalizeStage(user.stage) };
  $settingsState.abort = new AbortController();

  const state = $settingsState;

  applyRoleGates(state.user);
  fillProfileForm(state.user);
  fillAdvancedForm();
  renderAvatarTab();
  renderAppearanceForm();
  bindEvents(state.abort.signal);

  const requestedTab = params?.query?.tab;
  activateTab(SETTINGS_CONFIG.TABS.includes(requestedTab) ? requestedTab : 'profile');

  // ==== التحديث من الخادم لا يعطّل ظهور الصفحة ====
  refreshUserFromServer(token);
}

export function cleanupPage() {
  $navToken++;
  flushPendingPreferences();
  $settingsState.abort?.abort();
  $settingsState = createInitialState();
}
