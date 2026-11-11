/* صفحة الملف الشخصي - v5.0.0 */

import { getCurrentUser, updateSessionUser } from '../../js/core/session.js';

import {
  getUserProfile,
  getUserStats,
  getUserMedals,
  getLearningJourney,
  getUserActivity,
  getPerformanceBreakdown,
  getPlatformStats,
  updateUserPreferences,
  updateStudentAccount,
  deleteUserAccount,
  invalidateProfileCache
} from '../../js/core/api.js';

import { navigateTo } from '../../js/core/router.js';
import { EventBus } from '../../js/core/event-bus.js';

import {
  createAvatarElement,
  updateAvatarElement,
  getAvatarJobs,
  getAvatarJobSelection,
  getAvatarConfig
} from '../../js/utils/avatar.js';

// ==== 1. الثوابت ====
const PF = Object.freeze({
  ROLE_LABELS: { student: 'طالب', moderator: 'مشرف', teacher: 'معلم' },
  ROLE_PREFIX: { teacher: 'أستاذ', moderator: 'المشرف' },
  TIER_LABELS: { gold: 'ذهبية', silver: 'فضية', bronze: 'برونزية', other: 'ميدالية' },
  GRADE_ORDINALS: { 1: 'الأول', 2: 'الثاني', 3: 'الثالث' },
  SEMESTER_LABELS: { 'أول': 'الفصل الدراسي الأول', 'ثاني': 'الفصل الدراسي الثاني' },
  STAGE_MAP: { preparatory: 'إعدادي', secondary: 'ثانوي' },

  STREAK_MEDIUM: 7,
  STREAK_HIGH: 30,
  STREAK_LEGEND: 100,
  STREAK_TIER_TEXT: {
    low: 'استمرارية ناشئة',
    medium: 'استمرارية جيدة',
    high: 'استمرارية قوية',
    legend: 'استمرارية أسطورية'
  },

  HEAT_WEEKS: 20,
  FEED_PAGE: 12,
  MEDALS_PREVIEW: 8,
  STRONG_MIN: 70,
  WEAK_MAX: 60,
  LAZY_MARGIN: '240px 0px',
  EVENT_DEBOUNCE_MS: 350,

  SHOW_SENSITIVE_KEY: 'biologist_show_sensitive',

  NAV_TARGETS: ['home', 'settings', 'favorites', 'lessons', 'exams']
});

const SECTION_IDS = ['staff', 'journey', 'performance', 'activity', 'level', 'stats', 'medals', 'streak', 'account', 'platform', 'shortcuts'];

// ==== 2. الحالة الداخلية ====
function createInitialState() {
  return {
    container: null,
    root: null,
    mounted: false,
    token: 0,
    query: { id: null, edit: null },
    targetId: null,
    profile: null,
    stats: null,
    avatarEl: null,
    performanceData: null,
    activity: { items: [], cursor: null },
    revealSensitive: false,
    unsubs: [],
    observers: [],
    charts: [],
    timers: [],
    refreshTimer: null,
    rootClickHandler: null
  };
}

let $state = createInitialState();

// ==== 3. دوال مساعدة عامة ====
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.attrs) {
    Object.entries(options.attrs).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== false) {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    });
  }
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([key, value]) => { node.dataset[key] = String(value); });
  }
  (Array.isArray(children) ? children : [children]).forEach((child) => {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return node;
}

function icon(name, extraClass = '') {
  return el('i', { className: `fas ${name} ${extraClass}`.trim(), attrs: { 'aria-hidden': 'true' } });
}

function actionButton({ label, iconName, className = 'pf-btn pf-btn--ghost', onClick, attrs = {} }) {
  const node = el('button', { className, attrs: { type: 'button', ...attrs } }, [
    iconName ? icon(iconName) : null,
    el('span', { text: label })
  ]);
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function safeToast(message, type = 'info') {
  if (window.modals?.toast) window.modals.toast(message, type);
  else console.log(`[${type}] ${message}`);
}

// مؤشر تحميل (لوجو زجاجي) داخل الأزرار أثناء العمليات غير المتزامنة
function setButtonLoader(button, on) {
  if (!button) return;
  const current = button.querySelector(':scope > .pf-btn-loader');
  if (!on) { current?.remove(); return; }
  if (current) return;
  const node = document.createElement('span');
  node.className = 'bio-loader bio-loader--auto pf-btn-loader';
  node.setAttribute('aria-hidden', 'true');
  button.prepend(node);
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isCurrent(token) {
  return $state.mounted && token === $state.token;
}

function queue(callback, delay) {
  const id = window.setTimeout(callback, delay);
  $state.timers.push(id);
  return id;
}

function $(selector) {
  return $state.root ? $state.root.querySelector(selector) : null;
}

const NUMBER_FORMAT = new Intl.NumberFormat('ar-u-nu-latn', { useGrouping: false });
const RELATIVE_FORMAT = typeof Intl.RelativeTimeFormat === 'function'
  ? new Intl.RelativeTimeFormat('ar-u-nu-latn', { numeric: 'auto' })
  : null;

function fmtNumber(value) {
  const number = Number(value);
  return NUMBER_FORMAT.format(Number.isFinite(number) ? number : 0);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function fmtDate(value, options = { day: 'numeric', month: 'long', year: 'numeric' }) {
  const date = toDate(value);
  return date ? date.toLocaleDateString('ar-u-nu-latn', options) : '';
}

function fmtRelative(value) {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const steps = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60]
  ];
  if (!RELATIVE_FORMAT || abs < 45) return 'الآن';
  for (const [unit, size] of steps) {
    if (abs >= size) return RELATIVE_FORMAT.format(Math.round(seconds / size), unit);
  }
  return RELATIVE_FORMAT.format(Math.round(seconds / 60), 'minute');
}

function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function normalizeStage(stage) {
  if (!stage) return '';
  return PF.STAGE_MAP[stage] || stage;
}

function stageName(stage) {
  const normalized = normalizeStage(stage);
  if (normalized === 'إعدادي') return 'المرحلة الإعدادية';
  if (normalized === 'ثانوي') return 'المرحلة الثانوية';
  return '';
}

function gradeName(stage, grade) {
  const normalized = normalizeStage(stage);
  const ordinal = PF.GRADE_ORDINALS[Number(grade)];
  if (!ordinal) return '';
  const suffix = normalized === 'إعدادي' ? ' الإعدادي' : (normalized === 'ثانوي' ? ' الثانوي' : '');
  return `الصف ${ordinal}${suffix}`;
}

function displayName(profile) {
  const name = (profile.full_name || '').trim() || 'مستخدم';
  const prefix = PF.ROLE_PREFIX[profile.subject];
  if (!prefix || name.startsWith(prefix)) return name;
  return `${prefix} ${name}`;
}

function resolveTier(profile) {
  if (profile.subject === 'teacher') return 'teacher';
  if (profile.subject === 'moderator') return 'moderator';
  const thresholds = getAvatarConfig().SCORE_THRESHOLDS;
  const score = Number(profile.total_score) || 0;
  if (score >= thresholds.GOLD) return 'gold';
  if (score >= thresholds.SILVER) return 'silver';
  return 'bronze';
}

function streakTier(count) {
  if (count < PF.STREAK_MEDIUM) return 'low';
  if (count < PF.STREAK_HIGH) return 'medium';
  if (count < PF.STREAK_LEGEND) return 'high';
  return 'legend';
}

function maskPhone(value) {
  const text = String(value || '');
  if (text.length < 6) return '•'.repeat(text.length);
  return `${text.slice(0, 3)}${'•'.repeat(text.length - 5)}${text.slice(-2)}`;
}

function maskEmail(value) {
  const text = String(value || '');
  const at = text.indexOf('@');
  if (at < 1) return '•'.repeat(Math.min(text.length, 8));
  return `${text[0]}${'•'.repeat(Math.max(2, at - 1))}${text.slice(at)}`;
}

// ==== 4. إدارة الأقسام والحالات ====
function getSection(id) { return $(`#pf-${id}`); }
function getBody(id) { return $(`#pf-${id} [data-pf-body]`); }

function setSectionVisible(id, visible) {
  const section = getSection(id);
  if (section) section.hidden = !visible;
}

function setRootState(state) {
  if ($state.root) $state.root.setAttribute('data-pf-state', state);
}

function showSkeleton(body, kind) {
  if (!body) return;
  const template = $(`#pf-tpl-skel-${kind}`);
  body.replaceChildren();
  body.setAttribute('aria-busy', 'true');
  if (template?.content) body.appendChild(template.content.cloneNode(true));
}

function renderEmpty(body, { iconName = 'fa-inbox', text, actionLabel, onAction }) {
  body.replaceChildren(
    el('div', { className: 'pf-empty' }, [
      el('div', { className: 'pf-empty__icon' }, icon(iconName)),
      el('p', { className: 'pf-empty__text', text }),
      actionLabel && onAction ? actionButton({ label: actionLabel, className: 'pf-btn pf-btn--primary pf-btn--sm', onClick: onAction }) : null
    ])
  );
}

function renderSectionError(body, error, retry) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const message = offline
    ? 'لا يوجد اتصال بالإنترنت. تحقق من الشبكة ثم أعد المحاولة.'
    : (error?.message && /مصرّح|تسجيل الدخول/.test(error.message) ? error.message : 'تعذّر تحميل هذا القسم.');

  body.replaceChildren(
    el('div', { className: 'pf-inline-error', attrs: { role: 'alert' } }, [
      icon('fa-exclamation-triangle'),
      el('p', { text: message }),
      retry ? actionButton({ label: 'إعادة المحاولة', iconName: 'fa-redo', className: 'pf-btn pf-btn--ghost pf-btn--sm', onClick: retry }) : null
    ])
  );
}

function renderGlobalState(kind, { message = '', retry = false } = {}) {
  const config = {
    unavailable: { iconName: 'fa-user-slash', title: 'الملف غير متاح', text: 'هذا الحساب غير موجود أو لم يعد متاحًا.' },
    invalid: { iconName: 'fa-link', title: 'رابط غير صالح', text: 'معرّف الملف الشخصي في الرابط غير صحيح.' },
    error: { iconName: 'fa-exclamation-triangle', title: 'تعذّر تحميل الملف الشخصي', text: message || 'حدث خطأ غير متوقع أثناء تحميل البيانات.' }
  }[kind] || { iconName: 'fa-user-slash', title: 'الملف غير متاح', text: '' };

  const state = $('#pf-state');
  if (!state) return;

  const iconBox = $('#pf-state-icon');
  iconBox.replaceChildren(icon(config.iconName));
  $('#pf-state-title').textContent = config.title;
  $('#pf-state-text').textContent = config.text;
  $('#pf-state-retry').hidden = !retry;

  const header = $('#pf-header');
  const grid = $('#pf-grid');
  if (header) header.hidden = true;
  if (grid) grid.hidden = true;
  state.hidden = false;
  setRootState(kind === 'error' ? 'error' : 'unavailable');
}

function hideGlobalState() {
  const state = $('#pf-state');
  const header = $('#pf-header');
  if (state) state.hidden = true;
  if (header) header.hidden = false;
}

function goBack() {
  if (window.history.length > 1) window.history.back();
  else navigateTo('home');
}

async function copyProfileLink() {
  const profile = $state.profile;
  if (!profile) return;

  const url = `${window.location.origin}/profile?id=${encodeURIComponent(profile.id)}`;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const field = el('textarea', { attrs: { readonly: true, 'aria-hidden': 'true' } });
      field.value = url;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    safeToast('تم نسخ رابط الملف الشخصي', 'success');
  } catch (error) {
    console.warn('⚠️ تعذّر نسخ الرابط:', error);
    safeToast('تعذّر نسخ الرابط', 'error');
  }
}

function updateConnectionBanner() {
  const banner = $('#pf-conn');
  if (banner) banner.hidden = navigator.onLine !== false;
}

// ==== 5. تحديد الهدف والوضع ====
function resolveQuery(params) {
  const query = params?.query || {};
  return { id: query.id ?? null, edit: query.edit ?? null };
}

function resolveTargetId(viewer, query) {
  const raw = query.id === null || query.id === undefined ? '' : String(query.id).trim();
  if (!raw || raw === String(viewer.id)) return String(viewer.id);
  return /^\d+$/.test(raw) ? raw : null;
}

function planSections(profile) {
  const plan = new Set();
  const { mode, subject } = profile;

  if (subject === 'student') {
    ['level', 'stats', 'medals'].forEach((id) => plan.add(id));
    if (profile.streak !== undefined) plan.add('streak');

    if (mode !== 'public') {
      ['journey', 'performance', 'activity'].forEach((id) => plan.add(id));
    }
    if (mode === 'own') {
      plan.add('account');
      plan.add('shortcuts');
    }
    if (mode === 'staff-view') {
      plan.add('staff');
      plan.add('account');
    }
  } else if (mode === 'own') {
    plan.add('platform');
    plan.add('account');
    plan.add('shortcuts');
  }

  return plan;
}

// ==== 6. الهيدر ====
function setHeaderLoading() {
  const slot = $('#pf-avatar-slot');
  const name = $('#pf-name');
  const header = $('#pf-header');
  if (header) header.setAttribute('aria-busy', 'true');
  if (slot) slot.replaceChildren(el('div', { className: 'pf-skel pf-skel--avatar skeleton' }));
  if (name) name.replaceChildren(el('span', { className: 'pf-skel pf-skel--title skeleton' }));
  ['#pf-chips', '#pf-meta', '#pf-header-actions', '#pf-cover-actions'].forEach((selector) => {
    const node = $(selector);
    if (node) node.replaceChildren();
  });
}

function renderHeader(profile) {
  const own = profile.mode === 'own';
  const perms = profile.permissions || {};

  const avatar = createAvatarElement(profile, 'xl', {
    clickable: false,
    showPulse: own,
    showShimmer: own,
    editable: Boolean(perms.can_edit_avatar),
    onEdit: openJobPicker
  });
  $state.avatarEl = avatar;
  $('#pf-avatar-slot').replaceChildren(avatar);

  const nameNode = $('#pf-name');
  nameNode.textContent = displayName(profile);
  if (!own) document.title = `بيولوجست | ${displayName(profile)}`;

  const chips = $('#pf-chips');
  chips.replaceChildren();

  const tier = resolveTier(profile);
  chips.appendChild(el('span', { className: 'pf-chip pf-chip--role', dataset: { tier } }, [
    icon(profile.subject === 'teacher' ? 'fa-chalkboard-teacher' : (profile.subject === 'moderator' ? 'fa-user-shield' : 'fa-user-graduate')),
    el('span', { text: PF.ROLE_LABELS[profile.subject] || PF.ROLE_LABELS.student })
  ]));

  if (profile.subject === 'student' && profile.level) {
    chips.appendChild(el('span', { className: 'pf-chip pf-chip--level' }, [
      icon('fa-bolt'),
      el('span', { text: profile.level.name })
    ]));
  }

  const stageText = profile.grade ? gradeName(profile.stage, profile.grade) : stageName(profile.stage);
  if (profile.subject === 'student' && stageText) {
    chips.appendChild(el('span', { className: 'pf-chip' }, [icon('fa-graduation-cap'), el('span', { text: stageText })]));
  }

  const meta = $('#pf-meta');
  meta.replaceChildren();
  const created = fmtDate(profile.created_at, { month: 'long', year: 'numeric' });
  if (created) {
    meta.appendChild(el('li', { className: 'pf-meta__item' }, [icon('fa-calendar-alt'), el('span', { text: `عضو منذ ${created}` })]));
  }
  const lastActivity = profile.last_activity ? fmtRelative(profile.last_activity) : '';
  if (lastActivity && profile.mode !== 'public') {
    meta.appendChild(el('li', { className: 'pf-meta__item' }, [icon('fa-clock'), el('span', { text: `آخر نشاط ${lastActivity}` })]));
  }

  const coverActions = $('#pf-cover-actions');
  coverActions.replaceChildren();
  if (!own) {
    coverActions.appendChild(el('button', {
      className: 'pf-icon-btn pf-icon-btn--cover',
      attrs: { type: 'button', 'aria-label': 'رجوع', 'data-pf-back': 'true' }
    }, icon('fa-arrow-right')));
  }
  coverActions.appendChild(el('button', {
    className: 'pf-icon-btn pf-icon-btn--cover',
    attrs: { type: 'button', 'aria-label': 'نسخ رابط الملف الشخصي', title: 'نسخ الرابط', 'data-action': 'copy-current-link' }
  }, icon('fa-link')));

  const actions = $('#pf-header-actions');
  actions.replaceChildren();
  if (own) {
    actions.appendChild(actionButton({ label: 'الإعدادات', iconName: 'fa-cog', className: 'pf-btn pf-btn--primary', onClick: () => navigateTo('settings') }));
    if (perms.can_edit_avatar) {
      actions.appendChild(actionButton({ label: 'تغيير الصورة', iconName: 'fa-camera', className: 'pf-btn pf-btn--ghost', onClick: openJobPicker }));
    }
  } else if (perms.can_manage_student) {
    actions.appendChild(actionButton({ label: 'إجراءات الطاقم', iconName: 'fa-user-shield', className: 'pf-btn pf-btn--primary', onClick: () => setStaffExpanded(true, true) }));
  }

  $('#pf-header').removeAttribute('aria-busy');
}

// ==== 7. المستوى ====
function renderLevel(profile, { celebrate = false } = {}) {
  const body = getBody('level');
  const level = profile.level;
  if (!body || !level) return;

  const total = level.total || 5;
  const hint = level.next === null
    ? 'بلغ أعلى مستوى في المنصة'
    : `باقي ${fmtNumber(level.next - level.score)} نقطة للوصول إلى «${level.next_name}»`;

  const badge = el('div', { className: 'pf-level__badge', attrs: { 'aria-hidden': 'true' } }, el('span', { text: fmtNumber(level.index + 1) }));
  const fill = el('div', { className: 'pf-progress__fill' });
  fill.style.setProperty('--pf-progress', String(level.progress));

  const bar = el('div', {
    className: 'pf-progress',
    attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(level.progress), 'aria-label': 'التقدم نحو المستوى التالي' }
  }, fill);

  const steps = el('ol', { className: 'pf-level__steps' });
  for (let i = 0; i < total; i += 1) {
    steps.appendChild(el('li', {
      className: 'pf-level__step',
      dataset: { state: i < level.index ? 'done' : (i === level.index ? 'current' : 'todo') },
      attrs: { 'aria-label': `المستوى ${fmtNumber(i + 1)}${i === level.index ? ' (الحالي)' : ''}` }
    }));
  }

  body.replaceChildren(
    el('div', { className: 'pf-level__top' }, [
      badge,
      el('div', { className: 'pf-level__info' }, [
        el('strong', { className: 'pf-level__name', text: level.name }),
        el('span', { className: 'pf-level__score', text: `${fmtNumber(level.score)} نقطة` })
      ])
    ]),
    bar,
    el('p', { className: 'pf-level__hint', text: hint }),
    steps
  );

  if (celebrate && !prefersReducedMotion()) {
    badge.classList.add('level-up');
    queue(() => badge.classList.remove('level-up'), 1200);
  }
}

// ==== 8. الإحصاءات ====
function statTile({ iconName, value, label, tone, suffix = '', animate = true }) {
  const valueNode = el('strong', { className: 'pf-stat__value', text: `${fmtNumber(value)}${suffix}` });
  const tile = el('div', { className: 'pf-stat', dataset: { tone } }, [
    el('span', { className: 'pf-stat__icon', attrs: { 'aria-hidden': 'true' } }, icon(iconName)),
    el('div', { className: 'pf-stat__content' }, [valueNode, el('span', { className: 'pf-stat__label', text: label })])
  ]);

  if (animate && !suffix && !prefersReducedMotion() && typeof window.animations?.animateCountUp === 'function') {
    try { window.animations.animateCountUp(valueNode, 0, Number(value) || 0, 900); } catch (error) { console.warn(error); }
  }
  return tile;
}

function renderStats(stats, body) {
  $state.stats = stats;
  const detailed = stats.average_accuracy !== undefined;

  const grid = el('div', { className: 'pf-stats' }, [
    statTile({ iconName: 'fa-book-open', value: stats.completed_lessons, label: 'دروس مكتملة', tone: 'lessons' }),
    statTile({ iconName: 'fa-clipboard-check', value: stats.exams_taken, label: 'امتحانات مُنجزة', tone: 'exams' }),
    statTile({ iconName: 'fa-medal', value: stats.medals_count, label: 'ميداليات', tone: 'medals' }),
    statTile({ iconName: 'fa-star', value: stats.total_score, label: 'نقطة', tone: 'score' })
  ]);

  if (detailed && stats.exams_taken > 0) {
    grid.appendChild(statTile({ iconName: 'fa-bullseye', value: stats.average_accuracy, label: 'متوسط الدقة', tone: 'accuracy', suffix: '%', animate: false }));
    grid.appendChild(statTile({ iconName: 'fa-trophy', value: stats.best_accuracy, label: 'أفضل نتيجة', tone: 'best', suffix: '%', animate: false }));
  }
  if (detailed && stats.in_progress_lessons > 0) {
    grid.appendChild(statTile({ iconName: 'fa-hourglass-half', value: stats.in_progress_lessons, label: 'دروس قيد التقدم', tone: 'progress' }));
  }

  body.replaceChildren(grid);
}

// ==== 9. الميداليات ====
function renderMedals(data, body) {
  const own = $state.profile?.mode === 'own';

  if (!data.items.length) {
    renderEmpty(body, {
      iconName: 'fa-medal',
      text: own ? 'لم تحصل على ميداليات بعد. أنهِ امتحانات التحدي لتجمع أولى ميدالياتك.' : 'لا توجد ميداليات بعد.',
      actionLabel: own ? 'استعرض الامتحانات' : '',
      onAction: own ? () => navigateTo('exams') : null
    });
    return;
  }

  const counts = el('ul', { className: 'pf-medals__counts' });
  ['gold', 'silver', 'bronze'].forEach((tier) => {
    counts.appendChild(el('li', { className: 'pf-medal-count', dataset: { tier } }, [
      icon('fa-medal'),
      el('strong', { text: fmtNumber(data.counts[tier]) }),
      el('span', { text: PF.TIER_LABELS[tier] })
    ]));
  });

  const grid = el('ul', { className: 'pf-medals__grid' });
  const renderItems = (limit) => {
    grid.replaceChildren();
    data.items.slice(0, limit).forEach((medal) => {
      const label = medal.name && medal.name.toLowerCase() !== medal.tier ? `${PF.TIER_LABELS[medal.tier]} — ${medal.name}` : PF.TIER_LABELS[medal.tier];
      const when = medal.earned_at ? fmtDate(medal.earned_at) : '';
      grid.appendChild(el('li', { className: 'pf-medal', dataset: { tier: medal.tier }, attrs: { title: when ? `${label} • ${when}` : label } }, [
        el('span', { className: 'pf-medal__icon', attrs: { 'aria-hidden': 'true' } }, icon('fa-medal')),
        el('span', { className: 'pf-medal__name', text: label })
      ]));
    });
  };

  const hasMore = data.items.length > PF.MEDALS_PREVIEW;
  renderItems(PF.MEDALS_PREVIEW);

  const children = [counts, grid];
  if (hasMore) {
    let expanded = false;
    const toggle = actionButton({ label: `عرض الكل (${fmtNumber(data.items.length)})`, className: 'pf-btn pf-btn--ghost pf-btn--sm', attrs: { 'aria-expanded': 'false' } });
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      renderItems(expanded ? data.items.length : PF.MEDALS_PREVIEW);
      toggle.querySelector('span').textContent = expanded ? 'عرض أقل' : `عرض الكل (${fmtNumber(data.items.length)})`;
      toggle.setAttribute('aria-expanded', String(expanded));
    });
    children.push(toggle);
  }

  body.replaceChildren(...children);
}

// ==== 10. الاستمرارية ====
function renderStreak(profile) {
  const body = getBody('streak');
  if (!body) return;

  const count = Math.max(0, Number(profile.streak) || 0);
  const tier = streakTier(count);

  const children = [
    el('div', { className: 'pf-streak', dataset: { tier } }, [
      el('span', { className: 'pf-streak__flame', attrs: { 'aria-hidden': 'true' } }, icon('fa-fire')),
      el('div', { className: 'pf-streak__info' }, [
        el('strong', { className: 'pf-streak__value', text: `${fmtNumber(count)} يوم متواصل` }),
        el('span', { className: 'pf-streak__tier', text: PF.STREAK_TIER_TEXT[tier] })
      ])
    ])
  ];

  if (profile.mode !== 'public') {
    children.push(el('div', { className: 'pf-week', attrs: { 'data-pf-week': 'true', 'aria-label': 'نشاط آخر سبعة أيام' } }));
  }

  body.replaceChildren(...children);
  body.removeAttribute('aria-busy');
}

function renderStreakWeek(daily) {
  const week = $('[data-pf-week]');
  if (!week) return;

  week.replaceChildren();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const count = daily?.[localDateKey(day)] || 0;
    week.appendChild(el('div', {
      className: 'pf-week__day',
      dataset: { active: count > 0 ? 'true' : 'false' },
      attrs: { title: `${fmtDate(day)}: ${fmtNumber(count)} نشاط` }
    }, [
      el('span', { className: 'pf-week__dot', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'pf-week__label', text: day.toLocaleDateString('ar-u-nu-latn', { weekday: 'narrow' }) })
    ]));
  }
}

// ==== 11. رحلة التعلم ====
function renderJourney(data, body) {
  const own = $state.profile?.mode === 'own';
  const sub = $('#pf-journey-sub');

  if (!data.applicable) {
    setSectionVisible('journey', false);
    return;
  }

  if (data.needs_setup) {
    if (sub) sub.textContent = '';
    renderEmpty(body, {
      iconName: 'fa-map-signs',
      text: own ? 'حدّد مرحلتك وصفك الدراسي من الإعدادات لتظهر لك رحلة التعلم.' : 'لم تُحدَّد المرحلة والصف لهذا الطالب بعد.',
      actionLabel: own ? 'فتح الإعدادات' : '',
      onAction: own ? () => navigateTo('settings') : null
    });
    return;
  }

  if (sub) {
    sub.textContent = [gradeName(data.stage, data.grade), PF.SEMESTER_LABELS[data.semester]].filter(Boolean).join(' • ');
  }

  if (!data.overall.total) {
    renderEmpty(body, {
      iconName: 'fa-book',
      text: 'لا توجد دروس منشورة للفصل الدراسي الحالي بعد.',
      actionLabel: own ? 'تصفح الدروس' : '',
      onAction: own ? () => navigateTo('lessons') : null
    });
    return;
  }

  const ring = el('div', { className: 'pf-ring', attrs: { role: 'img', 'aria-label': `${fmtNumber(data.overall.percent)}% من دروس الفصل مكتملة` } }, [
    el('span', { className: 'pf-ring__value', text: `${fmtNumber(data.overall.percent)}%` })
  ]);
  ring.style.setProperty('--pf-ring', String(data.overall.percent));

  const summary = el('div', { className: 'pf-journey__summary' }, [
    ring,
    el('div', { className: 'pf-journey__text' }, [
      el('strong', { text: `${fmtNumber(data.overall.completed)} من ${fmtNumber(data.overall.total)} درسًا مكتملًا` }),
      el('span', { text: 'في الفصل الدراسي الحالي' })
    ])
  ]);

  const list = el('div', { className: 'pf-units' });
  const firstOpen = data.units.findIndex((unit) => unit.lessons_total > 0 && unit.lessons_completed < unit.lessons_total);

  data.units.forEach((unit, index) => {
    const panelId = `pf-unit-panel-${index}`;
    const expanded = index === (firstOpen >= 0 ? firstOpen : 0);

    const bar = el('div', { className: 'pf-bar__track', attrs: { 'aria-hidden': 'true' } }, el('div', { className: 'pf-bar__fill' }));
    bar.firstChild.style.setProperty('--pf-progress', String(unit.percent));

    const head = el('button', {
      className: 'pf-unit__head',
      attrs: { type: 'button', 'aria-expanded': String(expanded), 'aria-controls': panelId }
    }, [
      el('span', { className: 'pf-unit__title' }, [icon('fa-layer-group'), el('span', { text: unit.name })]),
      el('span', { className: 'pf-unit__count', text: `${fmtNumber(unit.lessons_completed)}/${fmtNumber(unit.lessons_total)}` }),
      icon('fa-chevron-down', 'pf-unit__chevron'),
      bar
    ]);

    const panel = el('ul', { className: 'pf-lessons', attrs: { id: panelId } });
    panel.hidden = !expanded;

    if (!unit.lessons.length) {
      panel.appendChild(el('li', { className: 'pf-lessons__empty', text: 'لا توجد دروس في هذه الوحدة بعد.' }));
    }

    unit.lessons.forEach((lesson) => {
      const state = lesson.completed ? 'done' : (lesson.progress > 0 ? 'progress' : 'todo');
      const statusText = { done: 'مكتمل', progress: `${fmtNumber(lesson.progress)}%`, todo: 'لم يبدأ' }[state];
      const row = el('button', { className: 'pf-lesson', dataset: { state }, attrs: { type: 'button' } }, [
        el('span', { className: 'pf-lesson__status', attrs: { 'aria-hidden': 'true' } }, icon(state === 'done' ? 'fa-check' : (state === 'progress' ? 'fa-play' : 'fa-circle'))),
        el('span', { className: 'pf-lesson__title', text: lesson.title || `درس #${lesson.id}` }),
        lesson.exam_score > 0 ? el('span', { className: 'pf-lesson__score', text: `${fmtNumber(lesson.exam_score)} نقطة` }) : null,
        el('span', { className: 'pf-lesson__state', text: statusText })
      ]);
      row.addEventListener('click', () => navigateTo('lesson-view', { path: { id: lesson.id } }));
      panel.appendChild(el('li', {}, row));
    });

    head.addEventListener('click', () => {
      const isOpen = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!isOpen));
      panel.hidden = isOpen;
    });

    list.appendChild(el('div', { className: 'pf-unit', dataset: { complete: unit.percent === 100 ? 'true' : 'false' } }, [head, panel]));
  });

  body.replaceChildren(summary, list);
}

// ==== 12. تحليل الأداء ====
function readChartPalette() {
  const styles = getComputedStyle($state.root);
  const read = (name) => styles.getPropertyValue(name).trim();
  const rgb = read('--primary-rgb').split(/[\s,]+/).filter(Boolean).join(', ');
  return {
    line: read('--primary') || styles.color,
    fill: rgb ? `rgba(${rgb}, 0.16)` : 'transparent',
    grid: read('--border-color-light') || styles.color,
    text: read('--text-secondary-light') || styles.color,
    font: getComputedStyle(document.body).fontFamily
  };
}

function destroyCharts() {
  $state.charts.forEach((chart) => { try { chart.destroy(); } catch (error) { console.warn(error); } });
  $state.charts = [];
}

function drawTrendChart(canvas, trend) {
  if (typeof window.Chart === 'undefined' || !canvas) return false;

  const palette = readChartPalette();
  const rtl = document.documentElement.dir !== 'ltr';

  const chart = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels: trend.map((point) => fmtDate(point.at, { day: 'numeric', month: 'numeric' })),
      datasets: [{
        data: trend.map((point) => point.accuracy),
        borderColor: palette.line,
        backgroundColor: palette.fill,
        pointBackgroundColor: palette.line,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2.5,
        tension: 0.35,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: prefersReducedMotion() ? false : { duration: 600 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          rtl,
          textDirection: rtl ? 'rtl' : 'ltr',
          titleFont: { family: palette.font },
          bodyFont: { family: palette.font },
          callbacks: {
            title: (items) => trend[items[0].dataIndex]?.title || '',
            label: (item) => `الدقة: ${fmtNumber(item.parsed.y)}%`
          }
        }
      },
      scales: {
        x: { reverse: rtl, grid: { display: false }, ticks: { color: palette.text, font: { family: palette.font } } },
        y: {
          min: 0,
          max: 100,
          position: rtl ? 'right' : 'left',
          grid: { color: palette.grid },
          ticks: { color: palette.text, stepSize: 25, callback: (value) => `${value}%`, font: { family: palette.font } }
        }
      }
    }
  });

  $state.charts.push(chart);
  return true;
}

function renderTrendFallback(trend) {
  const list = el('ul', { className: 'pf-trend-list' });
  trend.forEach((point) => {
    list.appendChild(el('li', {}, [
      el('span', { text: fmtDate(point.at, { day: 'numeric', month: 'numeric' }) }),
      el('strong', { text: `${fmtNumber(point.accuracy)}%` })
    ]));
  });
  return list;
}

function accuracyTone(value) {
  if (value >= PF.STRONG_MIN) return 'good';
  if (value >= PF.WEAK_MAX) return 'mid';
  return 'low';
}

function focusColumn({ title, iconName, tone, items, emptyText }) {
  const list = el('ul', { className: 'pf-focus__list' });
  if (!items.length) {
    list.appendChild(el('li', { className: 'pf-focus__empty', text: emptyText }));
  }
  items.forEach((unit) => {
    list.appendChild(el('li', { className: 'pf-focus__item' }, [
      el('span', { className: 'pf-focus__name', text: unit.name }),
      el('strong', { className: 'pf-focus__value', text: `${fmtNumber(unit.average_accuracy)}%` })
    ]));
  });
  return el('div', { className: 'pf-focus__col', dataset: { tone } }, [
    el('h4', { className: 'pf-focus__title' }, [icon(iconName), el('span', { text: title })]),
    list
  ]);
}

function renderPerformance(data, body) {
  const own = $state.profile?.mode === 'own';
  const sub = $('#pf-performance-sub');
  $state.performanceData = data;

  if (!data.applicable) {
    setSectionVisible('performance', false);
    return;
  }

  if (!data.has_data) {
    if (sub) sub.textContent = '';
    renderEmpty(body, {
      iconName: 'fa-chart-line',
      text: own ? 'لا توجد نتائج امتحانات بعد. أنهِ أول امتحان ليظهر تحليل أدائك هنا.' : 'لا توجد نتائج امتحانات لهذا الطالب بعد.',
      actionLabel: own ? 'ابدأ امتحانًا' : '',
      onAction: own ? () => navigateTo('exams') : null
    });
    return;
  }

  if (sub) sub.textContent = `${fmtNumber(data.attempts)} محاولة`;

  const kpis = el('div', { className: 'pf-kpis' }, [
    el('div', { className: 'pf-kpi' }, [el('strong', { text: `${fmtNumber(data.overall_accuracy)}%` }), el('span', { text: 'متوسط الدقة' })]),
    el('div', { className: 'pf-kpi' }, [el('strong', { text: fmtNumber(data.attempts) }), el('span', { text: 'محاولات' })]),
    el('div', { className: 'pf-kpi' }, [el('strong', { text: fmtNumber(data.units.length) }), el('span', { text: 'وحدات مُقيَّمة' })])
  ]);

  const children = [kpis];

  if (data.trend.length >= 2) {
    const canvas = el('canvas', { attrs: { role: 'img', 'aria-label': `اتجاه دقة آخر ${fmtNumber(data.trend.length)} محاولات` } });
    const wrap = el('div', { className: 'pf-chart' }, canvas);
    children.push(el('h4', { className: 'pf-subtitle', text: 'اتجاه الدقة في آخر المحاولات' }), wrap);
    if (!drawTrendChart(canvas, data.trend)) {
      wrap.replaceChildren(renderTrendFallback(data.trend));
      wrap.classList.add('pf-chart--fallback');
    }
  }

  if (data.units.length) {
    const bars = el('div', { className: 'pf-bars' });
    data.units.forEach((unit) => {
      const fill = el('div', { className: 'pf-bar__fill' });
      fill.style.setProperty('--pf-progress', String(unit.average_accuracy));
      bars.appendChild(el('div', { className: 'pf-bar', dataset: { tone: accuracyTone(unit.average_accuracy) } }, [
        el('div', { className: 'pf-bar__head' }, [
          el('span', { className: 'pf-bar__name', text: unit.name }),
          el('strong', { className: 'pf-bar__value', text: `${fmtNumber(unit.average_accuracy)}%` })
        ]),
        el('div', { className: 'pf-bar__track', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(unit.average_accuracy), 'aria-label': unit.name } }, fill)
      ]));
    });
    children.push(el('h4', { className: 'pf-subtitle', text: 'الدقة بحسب الوحدات' }), bars);

    children.push(el('div', { className: 'pf-focus' }, [
      focusColumn({ title: 'نقاط القوة', iconName: 'fa-thumbs-up', tone: 'good', items: data.strengths, emptyText: 'لم تتضح نقاط قوة بعد.' }),
      focusColumn({ title: 'تحتاج إلى مراجعة', iconName: 'fa-redo', tone: 'low', items: data.weaknesses, emptyText: 'لا توجد وحدات تحتاج إلى مراجعة.' })
    ]));
  } else {
    children.push(el('p', { className: 'pf-note', text: 'تظهر الدقة بحسب الوحدات عندما ترتبط الامتحانات بوحداتها.' }));
  }

  body.replaceChildren(...children);
}

function scheduleChartsRedraw() {
  queue(() => {
    if (!$state.mounted || !$state.performanceData?.has_data) return;
    const body = getBody('performance');
    if (!body) return;
    destroyCharts();
    renderPerformance($state.performanceData, body);
  }, 60);
}

// ==== 13. سجل النشاط ====
function buildHeatmap(daily) {
  const weeks = PF.HEAT_WEEKS;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayRow = (today.getDay() + 1) % 7;
  const start = new Date(today);
  start.setDate(today.getDate() - ((weeks - 1) * 7 + todayRow));

  const grid = el('div', { className: 'pf-heat__grid', attrs: { role: 'img', 'aria-label': `خريطة النشاط لآخر ${fmtNumber(weeks)} أسبوعًا` } });
  let total = 0;
  let activeDays = 0;
  let best = 0;

  for (let i = 0; i < weeks * 7; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const cell = el('div', { className: 'pf-heat__cell' });

    if (date > today) {
      cell.dataset.future = 'true';
    } else {
      const count = daily?.[localDateKey(date)] || 0;
      const level = count === 0 ? 0 : (count <= 1 ? 1 : (count <= 3 ? 2 : (count <= 5 ? 3 : 4)));
      cell.dataset.level = String(level);
      cell.title = `${fmtNumber(count)} نشاط — ${fmtDate(date)}`;
      total += count;
      if (count > 0) activeDays += 1;
      best = Math.max(best, count);
    }
    grid.appendChild(cell);
  }

  const legend = el('div', { className: 'pf-heat__legend', attrs: { 'aria-hidden': 'true' } }, [el('span', { text: 'أقل' })]);
  for (let level = 0; level <= 4; level += 1) {
    legend.appendChild(el('span', { className: 'pf-heat__cell', dataset: { level } }));
  }
  legend.appendChild(el('span', { text: 'أكثر' }));

  const summary = el('ul', { className: 'pf-heat__summary' }, [
    el('li', {}, [el('strong', { text: fmtNumber(total) }), el('span', { text: 'نشاطًا' })]),
    el('li', {}, [el('strong', { text: fmtNumber(activeDays) }), el('span', { text: 'يومًا نشطًا' })]),
    el('li', {}, [el('strong', { text: fmtNumber(best) }), el('span', { text: 'أعلى يوم' })])
  ]);

  return el('div', { className: 'pf-heat' }, [summary, grid, legend]);
}

function feedItem(item) {
  let iconName = 'fa-circle';
  let title = '';
  let meta = '';
  let tone = 'neutral';
  let linkId = null;

  if (item.type === 'exam') {
    iconName = item.passed ? 'fa-clipboard-check' : 'fa-clipboard-list';
    tone = item.passed ? 'good' : 'neutral';
    title = `${item.is_challenge ? 'امتحان تحدٍّ' : 'امتحان'} «${item.title}»`;
    meta = `${fmtNumber(item.accuracy)}% • ${fmtNumber(item.correct_answers)}/${fmtNumber(item.total_questions)} إجابة صحيحة`;
  } else if (item.type === 'lesson') {
    iconName = item.completed ? 'fa-check-circle' : 'fa-book-open';
    tone = item.completed ? 'good' : 'neutral';
    title = item.completed ? `إكمال درس «${item.title}»` : `متابعة درس «${item.title}»`;
    meta = item.completed ? '' : `${fmtNumber(item.progress)}% من الدرس`;
    linkId = item.ref_id;
  } else {
    iconName = 'fa-comment-dots';
    title = item.is_reply ? 'رد على رأي في المنصة' : 'مشاركة رأي في المنصة';
  }

  const content = [
    el('span', { className: 'pf-feed__icon', attrs: { 'aria-hidden': 'true' } }, icon(iconName)),
    el('div', { className: 'pf-feed__body' }, [
      el('span', { className: 'pf-feed__title', text: title }),
      el('span', { className: 'pf-feed__meta', text: [meta, fmtRelative(item.at)].filter(Boolean).join(' • ') })
    ])
  ];

  if (linkId) {
    const link = el('button', { className: 'pf-feed__item pf-feed__item--link', dataset: { tone }, attrs: { type: 'button' } }, content);
    link.addEventListener('click', () => navigateTo('lesson-view', { path: { id: linkId } }));
    return el('li', {}, link);
  }
  return el('li', {}, el('div', { className: 'pf-feed__item', dataset: { tone } }, content));
}

function renderActivity(data, body) {
  const own = $state.profile?.mode === 'own';
  const sub = $('#pf-activity-sub');
  $state.activity = { items: data.items.slice(), cursor: data.next_cursor };

  if (!data.total) {
    if (sub) sub.textContent = '';
    renderEmpty(body, {
      iconName: 'fa-history',
      text: own ? 'لا يوجد نشاط بعد. ابدأ أول درس لتظهر هنا إنجازاتك.' : 'لا يوجد نشاط مسجَّل لهذا الطالب بعد.',
      actionLabel: own ? 'ابدأ أول درس' : '',
      onAction: own ? () => navigateTo('lessons') : null
    });
    return;
  }

  if (sub) sub.textContent = `${fmtNumber(data.total)} نشاطًا`;

  const feed = el('ul', { className: 'pf-feed' });
  data.items.forEach((item) => feed.appendChild(feedItem(item)));

  const children = [buildHeatmap(data.daily), el('h4', { className: 'pf-subtitle', text: 'آخر الأنشطة' }), feed];

  if (data.next_cursor) {
    const moreButton = actionButton({ label: 'عرض المزيد', iconName: 'fa-chevron-down', className: 'pf-btn pf-btn--ghost pf-more' });
    moreButton.addEventListener('click', () => loadMoreActivity(moreButton, feed));
    children.push(moreButton);
  }

  body.replaceChildren(...children);
}

async function loadMoreActivity(button, feed) {
  const token = $state.token;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  setButtonLoader(button, true);

  try {
    const page = await getUserActivity($state.targetId, PF.FEED_PAGE, $state.activity.cursor);
    if (!isCurrent(token)) return;

    page.items.forEach((item) => feed.appendChild(feedItem(item)));
    $state.activity.cursor = page.next_cursor;
    if (!page.next_cursor) button.remove();
  } catch (error) {
    console.error('❌ فشل تحميل المزيد من النشاط:', error);
    safeToast('تعذّر تحميل المزيد من الأنشطة', 'error');
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      setButtonLoader(button, false);
    }
  }
}

// ==== 14. بيانات الحساب ====
function infoRow(label, value, { ltr = false } = {}) {
  return el('div', { className: 'pf-info__row' }, [
    el('dt', { text: label }),
    el('dd', { className: ltr ? 'pf-info__value pf-info__value--ltr' : 'pf-info__value', text: value })
  ]);
}

function renderAccount(profile) {
  const body = getBody('account');
  if (!body) return;

  const own = profile.mode === 'own';
  const mask = !own && localStorage.getItem(PF.SHOW_SENSITIVE_KEY) !== 'true' && !$state.revealSensitive;

  const list = el('dl', { className: 'pf-info' });
  if (profile.username) list.appendChild(infoRow('اسم المستخدم', profile.username, { ltr: true }));
  if (profile.phone) list.appendChild(infoRow('رقم الهاتف', mask ? maskPhone(profile.phone) : profile.phone, { ltr: true }));
  if (profile.email) list.appendChild(infoRow('البريد الإلكتروني', mask ? maskEmail(profile.email) : profile.email, { ltr: true }));
  if (profile.age) list.appendChild(infoRow('العمر', `${fmtNumber(profile.age)} سنة`));
  if (profile.last_login) list.appendChild(infoRow('آخر دخول', fmtDate(profile.last_login, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' })));
  if (profile.subject === 'student') {
    list.appendChild(infoRow('الإعجابات المُرسَلة', fmtNumber(profile.likes_given)));
    list.appendChild(infoRow('التعليقات', fmtNumber(profile.comments_count)));
  }

  const children = [list];

  if (mask) {
    children.push(actionButton({
      label: 'إظهار البيانات الحساسة',
      iconName: 'fa-eye',
      className: 'pf-btn pf-btn--ghost pf-btn--sm',
      onClick: () => { $state.revealSensitive = true; renderAccount(profile); }
    }));
  }
  if (own) {
    children.push(actionButton({ label: 'تعديل البيانات', iconName: 'fa-pen', className: 'pf-btn pf-btn--ghost pf-btn--sm', onClick: () => navigateTo('settings') }));
  }

  body.replaceChildren(...children);
}

// ==== 15. إجماليات المنصة ====
function renderPlatform(totals, body) {
  body.replaceChildren(el('div', { className: 'pf-stats pf-stats--compact' }, [
    statTile({ iconName: 'fa-user-graduate', value: totals.students, label: 'طالب', tone: 'lessons' }),
    statTile({ iconName: 'fa-chalkboard-teacher', value: totals.teachers, label: 'معلم', tone: 'medals' }),
    statTile({ iconName: 'fa-book-open', value: totals.lessons, label: 'درس', tone: 'exams' }),
    statTile({ iconName: 'fa-clipboard-check', value: totals.exams, label: 'امتحان', tone: 'score' }),
    statTile({ iconName: 'fa-poll', value: totals.exam_results, label: 'نتيجة امتحان', tone: 'accuracy' }),
    statTile({ iconName: 'fa-comments', value: totals.comments, label: 'رأي', tone: 'best' })
  ]));
}

// ==== 16. إجراءات الطاقم ====
function setStaffExpanded(expanded, scroll = false) {
  const toggle = $('#pf-staff-toggle');
  const body = $('#pf-staff-body');
  if (!toggle || !body) return;

  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', expanded ? 'إخفاء إجراءات الطاقم' : 'إظهار إجراءات الطاقم');
  toggle.classList.toggle('pf-icon-btn--open', expanded);
  body.hidden = !expanded;

  if (expanded && scroll) {
    const section = getSection('staff');
    if (section) section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }
}

function renderStaffActions(profile) {
  const body = $('#pf-staff-body');
  if (!body) return;

  body.replaceChildren(
    el('p', { className: 'pf-staff__hint', text: 'إجراءات مباشرة على حساب هذا الطالب. تُنفَّذ بنفس دوال لوحة التحكم.' }),
    el('div', { className: 'pf-staff__actions' }, [
      actionButton({ label: 'تعديل بيانات الطالب', iconName: 'fa-user-edit', className: 'pf-btn pf-btn--primary', onClick: () => openStudentEditor(profile) }),
      actionButton({ label: 'حذف الحساب', iconName: 'fa-trash-alt', className: 'pf-btn pf-btn--danger', onClick: () => confirmDeleteStudent(profile) })
    ])
  );
}

function resolveModalHost(instance) {
  const root = instance?.element;
  if (!root) return null;
  return root.querySelector('.pf-modal-host') || root.querySelector('.modals-dialog__body') || root;
}

function formField({ id, label, control, hint }) {
  return el('div', { className: 'pf-field' }, [
    el('label', { className: 'pf-field__label', attrs: { for: id }, text: label }),
    control,
    hint ? el('small', { className: 'pf-field__hint', text: hint }) : null,
    el('small', { className: 'pf-field__error', attrs: { role: 'alert', 'data-error-for': id }, text: '' })
  ]);
}

function openStudentEditor(profile) {
  if (!window.modals?.showModal) {
    safeToast('تعذّر فتح نافذة التعديل', 'error');
    return;
  }

  window.modals.showModal({
    title: 'تعديل بيانات الطالب',
    size: 'md',
    html: '<div class="pf-modal-host"></div>',
    buttons: [],
    onOpen: (instance) => {
      const host = resolveModalHost(instance);
      if (!host) return;

      const nameInput = el('input', { className: 'pf-input', attrs: { id: 'pf-edit-name', type: 'text', maxlength: '60', autocomplete: 'off', required: true, value: profile.full_name || '' } });
      nameInput.value = profile.full_name || '';

      const emailInput = el('input', { className: 'pf-input pf-input--ltr', attrs: { id: 'pf-edit-email', type: 'email', autocomplete: 'off', placeholder: 'example@domain.com' } });
      emailInput.value = profile.email || '';

      const stageSelect = el('select', { className: 'pf-input', attrs: { id: 'pf-edit-stage' } }, [
        el('option', { text: 'المرحلة الإعدادية', attrs: { value: 'إعدادي' } }),
        el('option', { text: 'المرحلة الثانوية', attrs: { value: 'ثانوي' } })
      ]);
      stageSelect.value = normalizeStage(profile.stage) || 'إعدادي';

      const gradeSelect = el('select', { className: 'pf-input', attrs: { id: 'pf-edit-grade' } }, [1, 2, 3].map((grade) =>
        el('option', { text: `الصف ${PF.GRADE_ORDINALS[grade]}`, attrs: { value: String(grade) } })
      ));
      gradeSelect.value = String(Number(profile.grade) || 1);

      const form = el('form', { className: 'pf-form', attrs: { novalidate: true } }, [
        formField({ id: 'pf-edit-name', label: 'الاسم الكامل', control: nameInput }),
        formField({ id: 'pf-edit-email', label: 'البريد الإلكتروني', control: emailInput, hint: 'اختياري' }),
        el('div', { className: 'pf-form__row' }, [
          formField({ id: 'pf-edit-stage', label: 'المرحلة', control: stageSelect }),
          formField({ id: 'pf-edit-grade', label: 'الصف', control: gradeSelect })
        ]),
        el('p', { className: 'pf-note', text: 'رقم الهاتف هو معرّف الدخول ولا يُعدَّل من هنا.' })
      ]);

      const submit = el('button', { className: 'modals-btn modals-btn--primary', attrs: { type: 'submit' }, text: 'حفظ التغييرات' });
      const cancel = el('button', { className: 'modals-btn modals-btn--secondary', attrs: { type: 'button' }, text: 'إلغاء' });
      form.appendChild(el('div', { className: 'pf-form__actions' }, [submit, cancel]));

      const setError = (id, message) => {
        const node = form.querySelector(`[data-error-for="${id}"]`);
        if (node) node.textContent = message;
      };

      cancel.addEventListener('click', () => instance.close(false));

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        ['pf-edit-name', 'pf-edit-email'].forEach((id) => setError(id, ''));

        const fullName = nameInput.value.trim().replace(/\s+/g, ' ');
        const email = emailInput.value.trim();
        let valid = true;

        if (fullName.length < 3) { setError('pf-edit-name', 'الاسم يجب ألا يقل عن ثلاثة أحرف'); valid = false; }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('pf-edit-email', 'صيغة البريد الإلكتروني غير صحيحة'); valid = false; }
        if (!valid) return;

        const updates = {};
        if (fullName !== (profile.full_name || '')) updates.full_name = fullName;
        if (email !== (profile.email || '')) updates.email = email;
        if (stageSelect.value !== normalizeStage(profile.stage)) updates.stage = stageSelect.value;
        if (Number(gradeSelect.value) !== Number(profile.grade)) updates.grade = Number(gradeSelect.value);

        if (!Object.keys(updates).length) {
          safeToast('لا توجد تغييرات للحفظ', 'info');
          instance.close(false);
          return;
        }

        submit.disabled = true;
        submit.textContent = 'جارٍ الحفظ...';
        setButtonLoader(submit, true);

        try {
          await updateStudentAccount(profile.id, updates);
          invalidateProfileCache(profile.id);
          instance.close(true);
          safeToast('تم تحديث بيانات الطالب', 'success');
          await loadProfile({ fresh: true });
        } catch (error) {
          console.error('❌ فشل تعديل بيانات الطالب:', error);
          safeToast(error?.message || 'تعذّر حفظ التغييرات', 'error');
          submit.disabled = false;
          submit.textContent = 'حفظ التغييرات';
        }
      });

      host.replaceChildren(form);
      nameInput.focus();
    }
  });
}

async function confirmDeleteStudent(profile) {
  try {
    if (!window.modals?.confirm) {
      safeToast('تعذّر فتح نافذة التأكيد', 'error');
      return;
    }

    const confirmed = await window.modals.confirm({
      title: 'تأكيد حذف الحساب',
      message: `سيُحذف حساب «${profile.full_name || 'الطالب'}» مع نتائجه وتقدّمه وتعليقاته وإشعاراته نهائيًا ولا يمكن التراجع.`,
      confirmText: 'حذف الحساب',
      cancelText: 'إلغاء',
      type: 'danger'
    });
    if (!confirmed) return;

    await deleteUserAccount(profile.id);
    invalidateProfileCache(profile.id);
    safeToast('تم حذف الحساب', 'success');
    await navigateTo('modDashboard');
  } catch (error) {
    console.error('❌ فشل حذف الحساب:', error);
    safeToast(error?.message || 'تعذّر حذف الحساب', 'error');
  }
}

// ==== 17. اختيار صورة المهنة ====
function openJobPicker() {
  const profile = $state.profile;
  if (!profile?.permissions?.can_edit_avatar) return;

  if (!window.modals?.showModal) {
    safeToast('تعذّر فتح نافذة الاختيار', 'error');
    return;
  }

  window.modals.showModal({
    title: 'اختر صورتك الشخصية',
    size: 'md',
    html: '<div class="pf-modal-host"></div>',
    buttons: [],
    onOpen: (instance) => {
      const host = resolveModalHost(instance);
      if (!host) return;

      const current = getAvatarJobSelection(profile);
      let selected = current;

      const options = [{ index: -1, name: 'الصورة الافتراضية' }, ...getAvatarJobs(profile)];
      const grid = el('div', { className: 'pf-jobs', attrs: { role: 'group', 'aria-label': 'الصور المتاحة' } });

      const paint = () => {
        grid.querySelectorAll('.pf-job').forEach((node) => {
          const index = Number(node.dataset.index);
          const active = index === selected;
          node.setAttribute('aria-pressed', String(active));
          node.setAttribute('aria-label', `${node.dataset.name}${active ? ' — محدد' : ''}`);
        });
      };

      options.forEach((option) => {
        const preview = createAvatarElement({ ...profile, avatar_job_index: option.index }, 'md', { showFrame: false, showBadge: false, clickable: false });
        preview.setAttribute('aria-hidden', 'true');
        preview.removeAttribute('role');
        preview.removeAttribute('aria-label');

        const cell = el('button', { className: 'pf-job', dataset: { index: option.index, name: option.name }, attrs: { type: 'button', 'aria-pressed': 'false' } }, [
          preview,
          el('span', { className: 'pf-job__name', text: option.name })
        ]);
        cell.addEventListener('click', () => { selected = option.index; paint(); });
        grid.appendChild(cell);
      });

      const save = el('button', { className: 'modals-btn modals-btn--primary', attrs: { type: 'button' }, text: 'حفظ الصورة' });
      const cancel = el('button', { className: 'modals-btn modals-btn--secondary', attrs: { type: 'button' }, text: 'إلغاء' });
      cancel.addEventListener('click', () => instance.close(false));

      save.addEventListener('click', async () => {
        if (selected === current) { instance.close(false); return; }
        save.disabled = true;
        save.textContent = 'جارٍ الحفظ...';
        setButtonLoader(save, true);
        const ok = await saveAvatarJob(selected);
        if (ok) instance.close(true);
        else { save.disabled = false; save.textContent = 'حفظ الصورة'; }
      });

      host.replaceChildren(grid, el('div', { className: 'pf-form__actions' }, [save, cancel]));
      paint();
    }
  });
}

function buildFullSessionUser(extra = {}) {
  const sessionUser = getCurrentUser() || {};
  const profile = $state.profile || {};
  const stats = $state.stats;
  return {
    ...sessionUser,
    total_score: profile.total_score ?? sessionUser.total_score,
    ...(stats ? { completed_lessons: stats.completed_lessons, exams_taken: stats.exams_taken } : {}),
    ...extra
  };
}

function publishUserEvent(name, user) {
  const current = getCurrentUser();
  if (!user || !current || String(user.id) !== String(current.id)) return;
  EventBus.emit(name, { user });
  document.dispatchEvent(new CustomEvent(name, { detail: { user } }));
}

async function saveAvatarJob(index) {
  const profile = $state.profile;
  if (!profile) return false;

  try {
    await updateUserPreferences(profile.id, { avatar_job_index: index });
    invalidateProfileCache(profile.id);

    const updated = { ...profile, avatar_job_index: index };
    $state.profile = updated;

    if ($state.avatarEl) {
      updateAvatarElement($state.avatarEl, updated);
      if (typeof window.animations?.animateAvatarChange === 'function') window.animations.animateAvatarChange($state.avatarEl);
    }

    await updateSessionUser({ avatar_job_index: index });
    publishUserEvent('avatarUpdated', buildFullSessionUser({ avatar_job_index: index }));

    safeToast('تم تحديث صورتك الشخصية', 'success');
    return true;
  } catch (error) {
    console.error('❌ فشل حفظ الصورة الشخصية:', error);
    safeToast(error?.message || 'تعذّر حفظ الصورة', 'error');
    return false;
  }
}

async function syncSessionFromProfile(profile) {
  if (profile.mode !== 'own') return;

  try {
    const session = getCurrentUser();
    if (!session) return;

    const normJob = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : -1);
    const partial = {};

    if (profile.avatar_job_index !== undefined && normJob(session.avatar_job_index) !== normJob(profile.avatar_job_index)) {
      partial.avatar_job_index = profile.avatar_job_index;
    }
    if (profile.stage && session.stage !== profile.stage) partial.stage = profile.stage;
    if (profile.grade && String(session.grade) !== String(profile.grade)) partial.grade = profile.grade;
    if (profile.total_score !== undefined && Number(session.total_score) !== Number(profile.total_score)) partial.total_score = profile.total_score;

    if (!Object.keys(partial).length) return;

    await updateSessionUser(partial);
    if ('avatar_job_index' in partial) publishUserEvent('avatarUpdated', buildFullSessionUser(partial));
  } catch (error) {
    console.warn('⚠️ تعذّرت مزامنة الجلسة مع الملف الشخصي:', error);
  }
}

// ==== 18. تحميل الأقسام ====
async function runSection({ id, skeleton, token, load, render, retry }) {
  const body = getBody(id);
  if (!body) return null;

  showSkeleton(body, skeleton);

  try {
    const data = await load();
    if (!isCurrent(token)) return null;

    body.replaceChildren();
    if (data === null || data === undefined) {
      setSectionVisible(id, false);
      return null;
    }
    render(data, body);
    return data;
  } catch (error) {
    if (!isCurrent(token)) return null;
    console.error(`❌ فشل تحميل قسم ${id}:`, error);
    renderSectionError(body, error, retry);
    return null;
  } finally {
    if (isCurrent(token)) body.removeAttribute('aria-busy');
  }
}

function whenVisible(node, callback) {
  if (!node) return;
  if (typeof IntersectionObserver === 'undefined') { callback(); return; }

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      observer.disconnect();
      $state.observers = $state.observers.filter((item) => item !== observer);
      callback();
    }
  }, { rootMargin: PF.LAZY_MARGIN });

  observer.observe(node);
  $state.observers.push(observer);
}

function loadStats(token, fresh = false) {
  return runSection({
    id: 'stats', skeleton: 'tiles', token,
    load: () => getUserStats($state.targetId, { fresh }),
    render: renderStats,
    retry: () => loadStats($state.token, true)
  });
}

function loadMedals(token, fresh = false) {
  return runSection({
    id: 'medals', skeleton: 'lines', token,
    load: () => getUserMedals($state.targetId, { fresh }),
    render: renderMedals,
    retry: () => loadMedals($state.token, true)
  });
}

function loadJourney(token, fresh = false) {
  return runSection({
    id: 'journey', skeleton: 'list', token,
    load: () => getLearningJourney($state.targetId, { fresh }),
    render: renderJourney,
    retry: () => loadJourney($state.token, true)
  });
}

function loadPerformance(token, fresh = false) {
  destroyCharts();
  return runSection({
    id: 'performance', skeleton: 'chart', token,
    load: () => getPerformanceBreakdown($state.targetId, { fresh }),
    render: renderPerformance,
    retry: () => loadPerformance($state.token, true)
  });
}

async function loadActivity(token, fresh = false) {
  const data = await runSection({
    id: 'activity', skeleton: 'list', token,
    load: () => getUserActivity($state.targetId, PF.FEED_PAGE, null, { fresh }),
    render: renderActivity,
    retry: () => loadActivity($state.token, true)
  });
  if (data && isCurrent(token)) renderStreakWeek(data.daily);
  return data;
}

function loadPlatform(token) {
  return runSection({
    id: 'platform', skeleton: 'tiles', token,
    load: () => getPlatformStats(),
    render: renderPlatform,
    retry: () => loadPlatform($state.token)
  });
}

function loadSections(profile, token, { fresh = false, lazy = true } = {}) {
  const plan = planSections(profile);

  if (plan.has('level')) renderLevel(profile);
  if (plan.has('streak')) renderStreak(profile);
  if (plan.has('account')) renderAccount(profile);
  if (plan.has('staff')) renderStaffActions(profile);

  const tasks = [];
  if (plan.has('stats')) tasks.push(loadStats(token, fresh));
  if (plan.has('medals')) tasks.push(loadMedals(token, fresh));
  if (plan.has('journey')) tasks.push(loadJourney(token, fresh));
  if (plan.has('activity')) tasks.push(loadActivity(token, fresh));

  const deferred = (id, loader) => {
    if (!plan.has(id)) return;
    const body = getBody(id);
    showSkeleton(body, id === 'performance' ? 'chart' : 'tiles');
    if (lazy) whenVisible(getSection(id), () => { if (isCurrent(token)) loader(); });
    else tasks.push(loader());
  };

  deferred('performance', () => loadPerformance(token, fresh));
  deferred('platform', () => loadPlatform(token));

  return Promise.allSettled(tasks);
}

// ==== 19. تحميل الملف ====
function applySectionPlan(profile) {
  const plan = planSections(profile);
  SECTION_IDS.forEach((id) => setSectionVisible(id, plan.has(id)));

  $state.root.querySelectorAll('.pf-shortcut--student').forEach((node) => { node.hidden = profile.subject !== 'student'; });

  $state.root.setAttribute('data-pf-mode', profile.mode);
  $state.root.setAttribute('data-pf-subject', profile.subject);
  $('#pf-grid').hidden = false;
}

async function loadProfile({ fresh = false } = {}) {
  const token = ++$state.token;
  setRootState('loading');
  hideGlobalState();
  setHeaderLoading();

  try {
    if ($state.targetId === null) {
      renderGlobalState('invalid');
      return;
    }

    const profile = await getUserProfile($state.targetId, { fresh });
    if (!isCurrent(token)) return;

    if (!profile) {
      renderGlobalState('unavailable');
      return;
    }

    $state.profile = profile;
    destroyCharts();
    renderHeader(profile);
    applySectionPlan(profile);
    setRootState('ready');

    await loadSections(profile, token, { fresh });

    if (!isCurrent(token)) return;
    syncSessionFromProfile(profile);

    if (profile.permissions?.can_manage_student && String($state.query.edit) === 'true') {
      setStaffExpanded(true, true);
    }
  } catch (error) {
    if (!isCurrent(token)) return;
    console.error('❌ فشل تحميل الملف الشخصي:', error);
    const offline = navigator.onLine === false;
    renderGlobalState('error', {
      retry: true,
      message: offline ? 'لا يوجد اتصال بالإنترنت. تحقق من الشبكة ثم أعد المحاولة.' : ''
    });
  } finally {
    if (isCurrent(token)) {
      const header = $('#pf-header');
      if (header) header.removeAttribute('aria-busy');
    }
  }
}

async function refreshCore() {
  const token = $state.token;
  if (!$state.mounted || $state.profile?.mode !== 'own' || $state.profile.subject !== 'student') return;

  try {
    const profile = await getUserProfile($state.targetId, { fresh: true });
    if (!isCurrent(token) || !profile) return;

    const leveledUp = (profile.level?.index ?? 0) > ($state.profile.level?.index ?? 0);
    $state.profile = profile;
    renderLevel(profile, { celebrate: leveledUp });
    renderStreak(profile);

    await Promise.allSettled([
      loadStats(token, true),
      loadMedals(token, true),
      loadJourney(token, true),
      loadActivity(token, true),
      loadPerformance(token, true)
    ]);
  } catch (error) {
    console.warn('⚠️ تعذّر تحديث الملف الشخصي:', error);
  }
}

// ==== 20. الأحداث ====
function subscribe(name, handler) {
  try {
    const off = EventBus.on(name, handler);
    $state.unsubs.push(typeof off === 'function' ? off : () => EventBus.off(name, handler));
  } catch (error) {
    console.warn(`⚠️ تعذّر الاشتراك في ${name}:`, error);
  }
}

function debounceRefresh() {
  if ($state.refreshTimer) window.clearTimeout($state.refreshTimer);
  $state.refreshTimer = queue(() => { $state.refreshTimer = null; refreshCore(); }, PF.EVENT_DEBOUNCE_MS);
}

function bindEvents() {
  subscribe('theme:toggled', scheduleChartsRedraw);
  subscribe('theme:colorChanged', scheduleChartsRedraw);

  subscribe('medal:earned', () => { if ($state.profile?.mode === 'own') debounceRefresh(); });
  subscribe('level:up', () => { if ($state.profile?.mode === 'own') debounceRefresh(); });

  subscribe('streak:updated', (payload) => {
    const profile = $state.profile;
    if (!profile || profile.mode !== 'own' || String(payload?.userId) !== String(profile.id)) return;
    if (Number(profile.streak) === Number(payload.streak)) return;
    $state.profile = { ...profile, streak: payload.streak };
    renderStreak($state.profile);
  });

  const onUserEvent = (payload) => {
    const profile = $state.profile;
    const user = payload?.user;
    if (!profile || profile.mode !== 'own' || !user || String(user.id) !== String(profile.id)) return;
    if (user.avatar_job_index === undefined || Number(user.avatar_job_index) === Number(profile.avatar_job_index)) return;

    $state.profile = { ...profile, avatar_job_index: user.avatar_job_index };
    if ($state.avatarEl) updateAvatarElement($state.avatarEl, $state.profile);
  };
  subscribe('avatarUpdated', onUserEvent);
  subscribe('profileUpdated', onUserEvent);

  subscribe('app:online', updateConnectionBanner);
  subscribe('app:offline', updateConnectionBanner);

  subscribe('userStateChanged', (payload) => {
    if (payload?.action === 'logout') $state.token += 1;
  });
}

function bindRootClicks() {
  $state.rootClickHandler = (event) => {
    const nav = event.target.closest('[data-pf-nav]');
    if (nav && $state.root.contains(nav)) {
      const target = nav.getAttribute('data-pf-nav');
      if (PF.NAV_TARGETS.includes(target)) navigateTo(target);
      return;
    }

    if (event.target.closest('[data-pf-back]')) {
      goBack();
      return;
    }

    if (event.target.closest('[data-action="copy-current-link"]')) {
      copyProfileLink();
      return;
    }

    if (event.target.closest('#pf-state-retry')) {
      loadProfile({ fresh: true });
      return;
    }

    if (event.target.closest('#pf-staff-toggle')) {
      setStaffExpanded($('#pf-staff-toggle').getAttribute('aria-expanded') !== 'true');
      return;
    }

    if (event.target.closest('#pf-platform-refresh')) {
      loadPlatform($state.token);
    }
  };
  $state.root.addEventListener('click', $state.rootClickHandler);
}

// ==== 21. التهيئة والتنظيف ====
export async function initializePage(container, params = {}) {
  try {
    cleanupPage();
    $state = createInitialState();

    $state.container = container;
    $state.root = container.querySelector('.pf-root');
    if (!$state.root) throw new Error('عنصر الملف الشخصي غير موجود');
    $state.mounted = true;

    const viewer = getCurrentUser();
    if (!viewer) {
      renderGlobalState('unavailable');
      return;
    }

    $state.query = resolveQuery(params);
    $state.targetId = resolveTargetId(viewer, $state.query);

    bindRootClicks();
    bindEvents();
    updateConnectionBanner();

    loadProfile();
  } catch (error) {
    console.error('❌ فشل تهيئة الملف الشخصي:', error);
    if ($state.root) renderGlobalState('error', { retry: true });
  }
}

export function cleanupPage() {
  try {
    $state.mounted = false;
    $state.token += 1;

    $state.unsubs.forEach((off) => { try { off(); } catch (error) { console.warn(error); } });
    $state.observers.forEach((observer) => observer.disconnect());
    $state.timers.forEach((id) => window.clearTimeout(id));
    destroyCharts();

    if ($state.root && $state.rootClickHandler) {
      $state.root.removeEventListener('click', $state.rootClickHandler);
    }
  } catch (error) {
    console.warn('⚠️ خطأ أثناء تنظيف الملف الشخصي:', error);
  } finally {
    $state = createInitialState();
  }
}
