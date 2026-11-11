/**
 * 📊 views/dashboard/dashboard.js — لوحة التحكم v5.0.0
 */

import { getCurrentUser, isTeacher, isModerator } from '../../js/core/session.js';
import { navigateTo } from '../../js/core/router.js';

import {
  getPlatformStats,
  getTopStudents,
  getAllStudents,
  getComments,
  getPinnedComment,
  addComment,
  softDeleteComment,
  pinComment,
  getModeratorsList,
  updateModeratorLevel,
  deleteModerator,
  addModerator,
  getUserByPhone,
  getTrashItems,
  restoreTrashItem,
  permanentlyDeleteTrashItem,
  getSemesterSettings,
  setActiveSemester,
  getComplaints,
  getPendingComplaintsCount,
  updateComplaintStatus,
  replyToComplaint,
  getWeeklyActivityStats,
  getExamPerformanceStats,
  createNotification
} from '../../js/core/api.js';

import { EventBus } from '../../js/core/event-bus.js';
import { createAvatarElement } from '../../js/utils/avatar.js';

import * as directing from '../../js/ui/directing.js';

// ====== 1. الثوابت ======
const DB = Object.freeze({
  CACHE_TTL: 2 * 60 * 1000,
  AUTO_REFRESH_MS: 5 * 60 * 1000,
  SEARCH_DEBOUNCE_MS: 250,
  EVENT_DEBOUNCE_MS: 350,
  CHART_REDRAW_MS: 150,

  TOP_LIMIT: 5,
  RECENT_COMMENTS: 5,
  RECENT_COMPLAINTS: 5,
  COMPLAINTS_LIMIT: 50,
  EXAM_BARS: 6,
  STUDENTS_PAGE_SIZE: 20,
  COMMENTS_PAGE_SIZE: 15,

  MAX_MODERATORS: 5,
  COMMENT_MAX_LENGTH: 500,
  REPLY_MAX_LENGTH: 500,

  GREET_KEY: 'biologist_dashboard_greeted',

  STAGE_MAP: { preparatory: 'إعدادي', secondary: 'ثانوي' },
  STAGES: [
    { value: 'إعدادي', label: 'الإعدادية' },
    { value: 'ثانوي', label: 'الثانوية' }
  ],
  GRADE_ORDINALS: { 1: 'الأول', 2: 'الثاني', 3: 'الثالث' },
  SEMESTERS: [
    { value: 'أول', label: 'الأول' },
    { value: 'ثاني', label: 'الثاني' }
  ],
  ROLE_LABELS: { teacher: 'معلم', moderator: 'مشرف' },
  TRASH_TYPE_LABELS: { lesson: 'درس', exam: 'امتحان', comment: 'تعليق' },
  COMPLAINT_STATUS: {
    pending: { label: 'قيد المعالجة', tone: 'warning' },
    resolved: { label: 'تم الرد', tone: 'success' },
    closed: { label: 'مغلقة', tone: 'muted' }
  }
});

const TABS = Object.freeze({
  overview: { teacherOnly: false },
  students: { teacherOnly: false },
  comments: { teacherOnly: false },
  moderators: { teacherOnly: true },
  trash: { teacherOnly: true },
  complaints: { teacherOnly: true }
});

// ====== 2. الحالة الداخلية ======
function createInitialState() {
  return {
    root: null,
    mounted: false,
    token: 0,
    user: null,
    isTeacher: false,
    isModerator: false,
    activeTab: 'overview',
    abort: null,
    group: null,

    cache: new Map(),
    inflight: new Map(),
    loaded: new Set(),
    dirty: new Set(),
    refreshing: false,

    charts: new Map(),
    chartData: null,
    chartsStale: false,

    timers: [],
    autoTimer: null,
    searchTimer: null,
    redrawTimer: null,
    eventTimer: null,

    students: { all: [], filtered: [], query: '', stage: '', grade: '', page: 1 },
    comments: { items: [], cursor: null, hasMore: false, filter: 'all', seq: 0 },
    moderators: [],
    trash: { type: 'lessons', items: [] },
    complaints: { items: [], filter: 'all' }
  };
}

let $state = createInitialState();
let $lastInit = null;

// ====== 3. دوال مساعدة عامة ======
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

function icon(name) {
  return el('i', { className: `fas ${name}`, attrs: { 'aria-hidden': 'true' } });
}

function $(selector) {
  return $state.root ? $state.root.querySelector(selector) : null;
}

function $$(selector) {
  return $state.root ? Array.from($state.root.querySelectorAll(selector)) : [];
}

function safeToast(message, type = 'info') {
  if (window.modals?.toast) window.modals.toast(message, type);
  else console.log(`[${type}] ${message}`);
}

async function confirmAction({ title, message, confirmText = 'تأكيد', type = 'default' }) {
  if (window.modals?.confirm) {
    const result = await window.modals.confirm({ title, message, confirmText, cancelText: 'إلغاء', type });
    return result === true;
  }
  return window.confirm(message);
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

const BUSY_STORE = new WeakMap();

function setBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyText && !BUSY_STORE.has(button)) {
      BUSY_STORE.set(button, Array.from(button.childNodes));
      button.replaceChildren(document.createTextNode(busyText));
    }
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    const saved = BUSY_STORE.get(button);
    if (saved) {
      button.replaceChildren(...saved);
      BUSY_STORE.delete(button);
    }
  }
}

// ====== 4. التنسيق (أرقام لاتينية كبقية المنصة) ======
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

function fmtDate(value) {
  const date = toDate(value);
  return date ? date.toLocaleDateString('ar-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
}

function fmtRelative(value) {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const steps = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  if (!RELATIVE_FORMAT || abs < 45) return 'الآن';
  for (const [unit, size] of steps) {
    if (abs >= size) return RELATIVE_FORMAT.format(Math.round(seconds / size), unit);
  }
  return RELATIVE_FORMAT.format(Math.round(seconds / 60), 'minute');
}

function toLatinDigits(value) {
  return String(value ?? '').replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });
}

function normalizeSearch(value) {
  return toLatinDigits(value)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStage(stage) {
  if (!stage) return '';
  return DB.STAGE_MAP[stage] || stage;
}

function gradeLabel(grade) {
  return DB.GRADE_ORDINALS[Number(grade)] || '—';
}

function gradeFull(stage, grade) {
  const ordinal = DB.GRADE_ORDINALS[Number(grade)];
  if (!ordinal) return '';
  return `${ordinal} ${normalizeStage(stage) === 'ثانوي' ? 'الثانوي' : 'الإعدادي'}`;
}

function phoneCandidates(input) {
  const digits = toLatinDigits(input).replace(/[^\d]/g, '');
  if (!digits) return [];
  let local = digits.replace(/^00/, '');
  if (local.startsWith('20') && local.length >= 12) local = local.slice(2);
  if (!local.startsWith('0')) local = `0${local}`;
  return Array.from(new Set([digits, local]));
}

// ====== 5. الكاش (ذاكرة فقط — لا تخزين على القرص) ======
async function cached(key, loader, force = false) {
  const hit = $state.cache.get(key);
  if (!force && hit && Date.now() - hit.at < DB.CACHE_TTL) return hit.data;
  if ($state.inflight.has(key)) return $state.inflight.get(key);

  const promise = (async () => {
    try {
      const data = await loader();
      $state.cache.set(key, { at: Date.now(), data });
      return data;
    } finally {
      $state.inflight.delete(key);
    }
  })();
  $state.inflight.set(key, promise);
  return promise;
}

function invalidate(...keys) {
  keys.forEach((key) => $state.cache.delete(key));
}

function markDirty(...tabs) {
  tabs.forEach((id) => { if ($state.loaded.has(id) && id !== $state.activeTab) $state.dirty.add(id); });
}

// ====== 6. الصور الرمزية (النظام الموحّد) ======
function avatarFor(user, size = 'sm') {
  const slot = el('span', { className: 'db-avatar' });
  try {
    slot.appendChild(createAvatarElement(user, size, { clickable: false }));
  } catch (error) {
    try {
      slot.appendChild(createAvatarElement(user, 'md', { clickable: false }));
    } catch (_inner) {
      slot.appendChild(el('span', { className: 'db-avatar-fallback', text: (user?.full_name || '?').trim().charAt(0) || '?' }));
    }
  }
  return slot;
}

function commentAvatarUser(comment) {
  return {
    id: comment.user_id,
    full_name: comment.full_name,
    avatar_url: comment.avatar_url,
    gender: comment.gender,
    user_type: comment.commenter_user_type,
    avatar_job_index: comment.commenter_avatar_job_index,
    is_verified: comment.commenter_is_verified
  };
}

// ====== 7. التنقل ======
function openProfile(id, edit = false) {
  if (id === undefined || id === null || id === '') return;
  const query = edit ? { id: String(id), edit: 'true' } : { id: String(id) };
  navigateTo('profile', { query });
}

// ====== 8. رسم الواجهة: الرأس والمؤشرات ======
function renderHeader() {
  const name = $('#db-user-name');
  if (name) name.textContent = $state.user?.full_name || $state.user?.username || '';
  const badge = $('#db-role-badge');
  if (badge) badge.textContent = $state.isTeacher ? DB.ROLE_LABELS.teacher : DB.ROLE_LABELS.moderator;
}

function applyRoleGates() {
  $$('[data-role="teacher"]').forEach((node) => { node.hidden = !$state.isTeacher; });
}

function setKpi(name, value) {
  const node = $(`[data-kpi="${name}"]`);
  if (node) node.textContent = fmtNumber(value);
}

function renderKpis({ stats, moderators, pending }) {
  const s = stats || {};
  setKpi('students', s.students);
  setKpi('teachers', s.teachers);
  setKpi('lessons', s.lessons);
  setKpi('exams', s.exams);
  setKpi('exam_results', s.exam_results);
  setKpi('comments', s.comments);
  setKpi('moderators', countNormalModerators(moderators));
  if ($state.isTeacher && pending !== null && pending !== undefined) {
    setKpi('pending', pending);
    updateComplaintsBadge(pending);
  }
}

function updateComplaintsBadge(count) {
  const badge = $('#db-complaints-badge');
  if (!badge) return;
  const value = Number(count) || 0;
  badge.hidden = value <= 0;
  badge.textContent = fmtNumber(value);
}

function countNormalModerators(list) {
  return (list || []).filter((mod) => mod.level !== 'senior').length;
}

function updateConnection() {
  const banner = $('#db-offline');
  if (banner) banner.hidden = navigator.onLine !== false;
}

function showInitError(message) {
  const state = $('#db-state');
  const content = $('#db-content');
  if (content) content.hidden = true;
  if (!state) return;
  state.hidden = false;
  const text = $('#db-state-text');
  if (text) text.textContent = message;
  const spinner = state.querySelector('.db-spinner');
  if (spinner) spinner.hidden = true;
  const retry = $('#db-state-retry');
  if (retry) {
    retry.hidden = false;
    retry.addEventListener('click', () => {
      if ($lastInit) initializePage($lastInit.container, $lastInit.params);
    }, { once: true });
  }
}

// ====== 9. رسم الواجهة: القوائم ======
function emptyNote(text) {
  return el('li', { className: 'db-note', text });
}

function renderTopStudents(students) {
  const list = $('#db-top-list');
  if (!list) return;
  if (!students || !students.length) {
    list.replaceChildren(emptyNote('لا يوجد طلاب متصدّرون بعد'));
    return;
  }
  list.replaceChildren(...students.map((student, index) => el('li', {}, [
    el('button', {
      className: 'db-person',
      attrs: { type: 'button', 'data-db-action': 'open-profile', 'aria-label': `عرض ملف ${student.full_name || 'الطالب'}` },
      dataset: { id: student.id }
    }, [
      el('span', { className: 'db-rank', text: fmtNumber(index + 1), dataset: { rank: index + 1 } }),
      avatarFor({ ...student, user_type: 'student' }),
      el('span', { className: 'db-person__info' }, [
        el('span', { className: 'db-person__name', text: student.full_name || 'بدون اسم' }),
        el('span', { className: 'db-person__meta', text: `${fmtNumber(student.total_score)} نقطة` })
      ])
    ])
  ])));
}

function renderRecentComments(comments) {
  const list = $('#db-recent-comments');
  if (!list) return;
  if (!comments || !comments.length) {
    list.replaceChildren(emptyNote('لا توجد تعليقات بعد'));
    return;
  }
  list.replaceChildren(...comments.map((comment) => el('li', { className: 'db-snippet' }, [
    avatarFor(commentAvatarUser(comment)),
    el('span', { className: 'db-person__info' }, [
      el('span', { className: 'db-person__name', text: comment.full_name || 'مستخدم' }),
      el('span', { className: 'db-snippet__text', text: comment.comment || '' }),
      el('span', { className: 'db-person__meta', text: fmtRelative(comment.date) })
    ])
  ])));
}

function renderPendingComplaints(complaints) {
  const list = $('#db-pending-complaints');
  if (!list) return;
  const pending = (complaints || []).filter((c) => (c.status || 'pending') === 'pending').slice(0, DB.RECENT_COMPLAINTS);
  if (!pending.length) {
    list.replaceChildren(emptyNote('لا توجد شكاوى تنتظر الرد 🎉'));
    return;
  }
  list.replaceChildren(...pending.map((complaint) => el('li', {}, [
    el('button', {
      className: 'db-person',
      attrs: { type: 'button', 'data-db-action': 'goto-complaints' }
    }, [
      el('span', { className: 'db-person__info' }, [
        el('span', { className: 'db-person__name', text: complaint.full_name || 'طالب' }),
        el('span', { className: 'db-snippet__text', text: complaint.comment || '' }),
        el('span', { className: 'db-person__meta', text: fmtRelative(complaint.date) })
      ])
    ])
  ])));
}

// ====== 10. الرسوم البيانية ======
function readPalette() {
  const styles = getComputedStyle($state.root);
  const read = (name, fallback = '') => styles.getPropertyValue(name).trim() || fallback;
  const rgb = read('--db-primary-rgb', '33, 150, 243').split(/[\s,]+/).filter(Boolean).join(', ');
  return {
    primary: read('--db-primary', '#2196f3'),
    fill: `rgba(${rgb}, 0.16)`,
    accent: read('--db-accent', '#7c4dff'),
    success: read('--db-success', '#4caf50'),
    warning: read('--db-warning', '#ff9800'),
    danger: read('--db-danger', '#f44336'),
    grid: read('--db-border', '#dbe4ee'),
    text: read('--db-text-2', '#556070'),
    surface: read('--db-surface', '#ffffff'),
    font: getComputedStyle(document.body).fontFamily
  };
}

function destroyChart(id) {
  const chart = $state.charts.get(id);
  if (chart) {
    try { chart.destroy(); } catch (error) { console.warn(error); }
    $state.charts.delete(id);
  }
}

function destroyCharts() {
  Array.from($state.charts.keys()).forEach(destroyChart);
}

function chartBase(palette, rtl) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: prefersReducedMotion() ? false : { duration: 500 },
    plugins: {
      legend: { display: false, rtl, labels: { color: palette.text, font: { family: palette.font } } },
      tooltip: { rtl, textDirection: rtl ? 'rtl' : 'ltr', titleFont: { family: palette.font }, bodyFont: { family: palette.font } }
    }
  };
}

function chartScales(palette, rtl, { max } = {}) {
  return {
    x: { reverse: rtl, grid: { display: false }, ticks: { color: palette.text, font: { family: palette.font } } },
    y: {
      beginAtZero: true,
      max,
      position: rtl ? 'right' : 'left',
      grid: { color: palette.grid },
      ticks: { color: palette.text, precision: 0, font: { family: palette.font } }
    }
  };
}

function buildChartConfigs(data, palette) {
  const rtl = document.documentElement.dir !== 'ltr';
  const base = chartBase(palette, rtl);
  const students = data.students || [];
  const configs = {};

  // ==== توزيع المرحلة ====
  const stageCounts = DB.STAGES.map((stage) => students.filter((s) => normalizeStage(s.stage) === stage.value).length);
  configs['db-chart-stage'] = stageCounts.some((n) => n > 0) ? {
    type: 'doughnut',
    data: {
      labels: DB.STAGES.map((stage, i) => `${stage.label} (${fmtNumber(stageCounts[i])})`),
      datasets: [{ data: stageCounts, backgroundColor: [palette.primary, palette.accent], borderColor: palette.surface, borderWidth: 3 }]
    },
    options: { ...base, cutout: '58%', plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true, position: 'bottom' } } }
  } : null;

  // ==== توزيع الصف (٦ مجموعات: مرحلة × صف) ====
  const gradeKeys = DB.STAGES.flatMap((stage) => [1, 2, 3].map((grade) => ({ stage: stage.value, grade })));
  const gradeCounts = gradeKeys.map(({ stage, grade }) =>
    students.filter((s) => normalizeStage(s.stage) === stage && Number(s.grade) === grade).length);
  configs['db-chart-grade'] = gradeCounts.some((n) => n > 0) ? {
    type: 'bar',
    data: {
      labels: gradeKeys.map(({ stage, grade }) => gradeFull(stage, grade)),
      datasets: [{ data: gradeCounts, backgroundColor: gradeKeys.map(({ stage }) => (stage === 'إعدادي' ? palette.primary : palette.accent)), borderRadius: 6 }]
    },
    options: { ...base, scales: chartScales(palette, rtl) }
  } : null;

  // ==== النشاط الأسبوعي ====
  const weekly = data.weekly || [];
  configs['db-chart-weekly'] = weekly.some((d) => d.count > 0) ? {
    type: 'line',
    data: {
      labels: weekly.map((d) => d.label),
      datasets: [{
        data: weekly.map((d) => d.count),
        borderColor: palette.primary,
        backgroundColor: palette.fill,
        pointBackgroundColor: palette.primary,
        pointRadius: 4,
        borderWidth: 2.5,
        tension: 0.35,
        fill: true
      }]
    },
    options: { ...base, interaction: { mode: 'index', intersect: false }, scales: chartScales(palette, rtl) }
  } : null;

  // ==== أداء الامتحانات ====
  const exams = data.exams || [];
  configs['db-chart-exams'] = exams.length ? {
    type: 'bar',
    data: {
      labels: exams.map((e) => (e.title && e.title.length > 20 ? `${e.title.slice(0, 20)}…` : (e.title || `#${e.examId}`))),
      datasets: [{ data: exams.map((e) => e.averageAccuracy), backgroundColor: palette.success, borderRadius: 6 }]
    },
    options: {
      ...base,
      plugins: {
        ...base.plugins,
        tooltip: {
          ...base.plugins.tooltip,
          callbacks: {
            label: (ctx) => `متوسط الإجابات الصحيحة: ${fmtNumber(ctx.parsed.y)}%`,
            afterLabel: (ctx) => `عدد المحاولات: ${fmtNumber(exams[ctx.dataIndex]?.attempts)}`
          }
        }
      },
      scales: chartScales(palette, rtl, { max: 100 })
    }
  } : null;

  return configs;
}

const CHART_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js';
let chartLoader = null;

function ensureChartLibrary() {
  if (typeof window.Chart !== 'undefined') return Promise.resolve(true);
  if (chartLoader) return chartLoader;
  chartLoader = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = CHART_SRC;
    script.async = true;
    script.onload = () => resolve(typeof window.Chart !== 'undefined');
    script.onerror = () => { script.remove(); resolve(false); };
    document.head.appendChild(script);
  }).then((ok) => {
    if (!ok) chartLoader = null;
    return ok;
  });
  return chartLoader;
}

let chartRetried = false;

function drawCharts() {
  if (!$state.chartData || !$state.root) return;
  if (typeof window.Chart === 'undefined' && !chartRetried) {
    chartRetried = true;
    const token = $state.token;
    ensureChartLibrary().then(() => {
      if (isCurrent(token) && $state.activeTab === 'overview') drawCharts();
    });
    return;
  }
  renderCharts();
}

function renderCharts() {
  if (!$state.chartData || !$state.root) return;
  const palette = readPalette();
  const configs = buildChartConfigs($state.chartData, palette);

  Object.entries(configs).forEach(([id, config]) => {
    const canvas = $(`#${id}`);
    const empty = $(`[data-empty-for="${id}"]`);
    destroyChart(id);
    if (!canvas) return;

    if (!config || typeof window.Chart === 'undefined') {
      canvas.hidden = true;
      if (empty) {
        empty.hidden = false;
        if (config && typeof window.Chart === 'undefined') empty.textContent = 'تعذّر تحميل مكتبة الرسوم البيانية';
      }
      return;
    }

    canvas.hidden = false;
    if (empty) empty.hidden = true;
    $state.charts.set(id, new window.Chart(canvas, config));
  });
  $state.chartsStale = false;
}

function scheduleChartsRedraw() {
  if ($state.redrawTimer) window.clearTimeout($state.redrawTimer);
  $state.redrawTimer = queue(() => {
    $state.redrawTimer = null;
    if ($state.activeTab === 'overview') drawCharts();
    else $state.chartsStale = true;
  }, DB.CHART_REDRAW_MS);
}

// ====== 11. تحميل التبويبات ======
async function loadTab(id, { force = false } = {}) {
  const token = $state.token;
  try {
    switch (id) {
      case 'overview': await loadOverview(token, force); break;
      case 'students': await loadStudents(token, force); break;
      case 'comments': await loadComments(token); break;
      case 'moderators': await loadModerators(token, force); break;
      case 'trash': await loadTrash(token); break;
      case 'complaints': await loadComplaints(token, force); break;
      default: break;
    }
    if (isCurrent(token)) {
      $state.loaded.add(id);
      $state.dirty.delete(id);
    }
  } catch (error) {
    if (!isCurrent(token)) return;
    console.error(`❌ فشل تحميل تبويب ${id}:`, error);
    safeToast(navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : 'تعذّر تحميل البيانات، حاول مرة أخرى', 'error');
  }
}

async function loadOverview(token, force) {
  const teacher = $state.isTeacher;
  const results = await Promise.allSettled([
    cached('stats', getPlatformStats, force),
    cached('top', () => getTopStudents(DB.TOP_LIMIT), force),
    cached('students', getAllStudents, force),
    cached('moderators', getModeratorsList, force),
    cached('weekly', getWeeklyActivityStats, force),
    cached('examPerf', () => getExamPerformanceStats(DB.EXAM_BARS), force),
    cached('recentComments', () => getComments(DB.RECENT_COMMENTS), force),
    teacher ? cached('pending', getPendingComplaintsCount, force) : Promise.resolve(null),
    teacher ? cached('complaints', () => getComplaints({ limitCount: DB.COMPLAINTS_LIMIT }), force) : Promise.resolve([])
  ]);
  if (!isCurrent(token)) return;

  const value = (index, fallback) => (results[index].status === 'fulfilled' && results[index].value != null ? results[index].value : fallback);
  const stats = value(0, null);
  const top = value(1, []);
  const students = value(2, []);
  const moderators = value(3, []);
  const weekly = value(4, []);
  const exams = value(5, []);
  const recent = value(6, { comments: [] });
  const pending = value(7, null);
  const complaints = value(8, []);

  renderKpis({ stats, moderators, pending });
  renderTopStudents(top);
  renderRecentComments(recent.comments || []);
  if (teacher) renderPendingComplaints(complaints);

  $state.chartData = { students, weekly, exams };
  drawCharts();

  if (results.every((r) => r.status === 'rejected')) {
    safeToast(navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : 'تعذّر تحميل بيانات النظرة العامة', 'error');
  }
}

// ====== 12. تبويب الطلاب ======
async function loadStudents(token, force) {
  const students = await cached('students', getAllStudents, force);
  if (!isCurrent(token)) return;
  $state.students.all = students || [];
  applyStudentFilters();
}

function applyStudentFilters() {
  const s = $state.students;
  const rawQuery = toLatinDigits(s.query).trim();
  const textQuery = normalizeSearch(s.query);
  const digits = rawQuery.replace(/\D/g, '');

  s.filtered = s.all.filter((student) => {
    if (s.stage && normalizeStage(student.stage) !== s.stage) return false;
    if (s.grade && Number(student.grade) !== Number(s.grade)) return false;
    if (!textQuery) return true;
    if (normalizeSearch(student.full_name).includes(textQuery)) return true;
    if (String(student.id) === rawQuery) return true;
    return digits.length >= 3 && toLatinDigits(student.phone).replace(/\D/g, '').includes(digits);
  });

  const pages = Math.max(1, Math.ceil(s.filtered.length / DB.STUDENTS_PAGE_SIZE));
  s.page = Math.min(Math.max(1, s.page), pages);
  renderStudents();
}

function studentRow(student) {
  const profileButton = el('button', {
    className: 'db-person',
    attrs: { type: 'button', 'data-db-action': 'open-profile', 'aria-label': `عرض ملف ${student.full_name || 'الطالب'}` },
    dataset: { id: student.id }
  }, [
    avatarFor({ ...student, user_type: 'student' }),
    el('span', { className: 'db-person__info' }, [
      el('span', { className: 'db-person__name', text: student.full_name || 'بدون اسم' }),
      el('span', { className: 'db-person__meta', text: `المعرّف: ${student.id}` })
    ])
  ]);

  const actions = el('div', { className: 'db-cell-actions' }, [
    el('button', { className: 'db-btn db-btn--ghost db-btn--sm', attrs: { type: 'button', 'data-db-action': 'open-profile' }, dataset: { id: student.id } }, [icon('fa-eye'), el('span', { text: 'الملف' })]),
    el('button', { className: 'db-btn db-btn--secondary db-btn--sm', attrs: { type: 'button', 'data-db-action': 'edit-student' }, dataset: { id: student.id } }, [icon('fa-user-pen'), el('span', { text: 'تعديل' })])
  ]);

  return el('tr', {}, [
    el('td', { dataset: { label: 'الطالب' } }, [profileButton]),
    el('td', { dataset: { label: 'المرحلة' }, text: normalizeStage(student.stage) || '—' }),
    el('td', { dataset: { label: 'الصف' }, text: gradeLabel(student.grade) }),
    el('td', { dataset: { label: 'النقاط' }, text: fmtNumber(student.total_score) }),
    el('td', { dataset: { label: 'الإجراءات' } }, [actions])
  ]);
}

function renderStudents() {
  const s = $state.students;
  const body = $('#db-students-body');
  if (!body) return;

  const start = (s.page - 1) * DB.STUDENTS_PAGE_SIZE;
  const pageItems = s.filtered.slice(start, start + DB.STUDENTS_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(s.filtered.length / DB.STUDENTS_PAGE_SIZE));

  if (!pageItems.length) {
    body.replaceChildren(el('tr', { className: 'db-empty-row' }, [el('td', { attrs: { colspan: '5' }, text: 'لا يوجد طلاب مطابقون' })]));
  } else {
    body.replaceChildren(...pageItems.map(studentRow));
  }

  const count = $('#db-students-count');
  if (count) count.textContent = `عدد النتائج: ${fmtNumber(s.filtered.length)} من ${fmtNumber(s.all.length)}`;
  const info = $('#db-students-page');
  if (info) info.textContent = `صفحة ${fmtNumber(s.page)} من ${fmtNumber(pages)}`;
  const prev = $('#db-students-prev');
  const next = $('#db-students-next');
  if (prev) prev.disabled = s.page <= 1;
  if (next) next.disabled = s.page >= pages;
}

function resetStudentFilters() {
  const s = $state.students;
  s.query = ''; s.stage = ''; s.grade = ''; s.page = 1;
  const search = $('#db-student-search');
  const stage = $('#db-student-stage');
  const grade = $('#db-student-grade');
  if (search) search.value = '';
  if (stage) stage.value = '';
  if (grade) grade.value = '';
  applyStudentFilters();
}

// ====== 13. تبويب التعليقات ======
async function loadComments(token, { more = false } = {}) {
  const c = $state.comments;
  const seq = ++c.seq;
  const moreBtn = $('#db-comments-more');
  if (more) setBusy(moreBtn, true, 'جارٍ التحميل...');

  try {
    if (c.filter === 'pinned') {
      const pinned = await getPinnedComment();
      if (!isCurrent(token) || seq !== c.seq) return;
      c.items = pinned ? [pinned] : [];
      c.cursor = null;
      c.hasMore = false;
    } else {
      const result = await getComments(DB.COMMENTS_PAGE_SIZE, more ? c.cursor : null);
      if (!isCurrent(token) || seq !== c.seq) return;
      c.items = more ? c.items.concat(result.comments) : result.comments;
      c.cursor = result.lastDoc;
      c.hasMore = result.hasMore;
    }
    renderComments();
  } finally {
    if (more) setBusy(moreBtn, false);
  }
}

function commentItem(comment) {
  const staffBadge = comment.commenter_user_type === 'teacher' || comment.commenter_user_type === 'moderator'
    ? el('span', { className: 'db-badge db-badge--primary', text: DB.ROLE_LABELS[comment.commenter_user_type] })
    : null;
  const pinnedBadge = comment.pinned
    ? el('span', { className: 'db-badge db-badge--warning' }, [icon('fa-thumbtack'), el('span', { text: 'مثبّت' })])
    : null;

  const actions = el('div', { className: 'db-item__actions' }, [
    el('button', { className: 'db-btn db-btn--ghost db-btn--sm', attrs: { type: 'button', 'data-db-action': 'comment-reply' }, dataset: { id: comment.id } }, [icon('fa-reply'), el('span', { text: 'رد' })]),
    el('button', { className: `db-btn db-btn--sm ${comment.pinned ? 'db-btn--warning' : 'db-btn--ghost'}`, attrs: { type: 'button', 'data-db-action': 'comment-pin' }, dataset: { id: comment.id } }, [icon('fa-thumbtack'), el('span', { text: comment.pinned ? 'إلغاء التثبيت' : 'تثبيت' })]),
    el('button', { className: 'db-btn db-btn--danger db-btn--sm', attrs: { type: 'button', 'data-db-action': 'comment-delete' }, dataset: { id: comment.id } }, [icon('fa-trash-alt'), el('span', { text: 'حذف' })])
  ]);

  return el('article', { className: 'db-item', dataset: { pinned: comment.pinned ? 'true' : 'false' } }, [
    el('div', { className: 'db-item__head' }, [
      avatarFor(commentAvatarUser(comment)),
      el('span', { className: 'db-item__name', text: comment.full_name || 'مستخدم' }),
      staffBadge,
      pinnedBadge,
      el('span', { className: 'db-item__time', text: fmtRelative(comment.date) })
    ]),
    el('p', { className: 'db-item__text', text: comment.comment || '' }),
    el('div', { className: 'db-item__meta' }, [
      el('span', { text: `${fmtNumber(comment.likes)} إعجاب` }),
      el('span', { text: `${fmtNumber(comment.replies_count)} رد` })
    ]),
    actions
  ]);
}

function renderComments() {
  const list = $('#db-comments-list');
  if (!list) return;
  const c = $state.comments;
  if (!c.items.length) {
    list.replaceChildren(el('p', { className: 'db-note', text: c.filter === 'pinned' ? 'لا يوجد تعليق مثبّت' : 'لا توجد تعليقات' }));
  } else {
    list.replaceChildren(...c.items.map(commentItem));
  }
  const more = $('#db-comments-more');
  if (more) more.hidden = !c.hasMore;
}

function findComment(id) {
  return $state.comments.items.find((c) => String(c.id) === String(id));
}

// ====== 14. تبويب المشرفين ======
async function loadModerators(token, force) {
  const list = await cached('moderators', getModeratorsList, force);
  if (!isCurrent(token)) return;
  $state.moderators = list || [];
  renderModerators();
}

function moderatorCard(mod) {
  const senior = mod.level === 'senior';
  const isSelf = String(mod.id) === String($state.user?.id);

  const actions = [];
  if (!senior && !isSelf) {
    actions.push(el('button', { className: 'db-btn db-btn--secondary db-btn--sm', attrs: { type: 'button', 'data-db-action': 'mod-promote' }, dataset: { id: mod.id } }, [icon('fa-arrow-up'), el('span', { text: 'ترقية' })]));
    actions.push(el('button', { className: 'db-btn db-btn--danger db-btn--sm', attrs: { type: 'button', 'data-db-action': 'mod-remove', 'aria-label': `إزالة ${mod.full_name || 'المشرف'}` }, dataset: { id: mod.id } }, [icon('fa-user-minus'), el('span', { text: 'إزالة' })]));
  }

  return el('article', { className: 'db-mod' }, [
    avatarFor({ ...mod, user_type: senior ? 'teacher' : 'moderator' }, 'md'),
    el('div', { className: 'db-mod__info' }, [
      el('span', { className: 'db-mod__name', text: mod.full_name || 'بدون اسم' }),
      el('span', { className: 'db-mod__phone', text: mod.phone || '—' }),
      el('span', {}, [
        el('span', { className: `db-badge ${senior ? 'db-badge--primary' : 'db-badge--success'}`, text: senior ? 'مشرف ممتاز / معلم' : 'مشرف' }),
        isSelf ? el('span', { className: 'db-badge db-badge--muted', text: 'أنت' }) : null
      ])
    ]),
    actions.length ? el('div', { className: 'db-mod__actions' }, actions) : null
  ]);
}

function renderModerators() {
  const grid = $('#db-moderators-list');
  if (!grid) return;
  const list = $state.moderators;
  if (!list.length) {
    grid.replaceChildren(el('p', { className: 'db-note', text: 'لا يوجد مشرفون بعد' }));
  } else {
    grid.replaceChildren(...list.map(moderatorCard));
  }
  const count = $('#db-moderators-count');
  if (count) count.textContent = `المشرفون الحاليون: ${fmtNumber(countNormalModerators(list))} من ${fmtNumber(DB.MAX_MODERATORS)}`;
}

function findModerator(id) {
  return $state.moderators.find((m) => String(m.id) === String(id));
}

// ====== 15. تبويب المهملات ======
async function loadTrash(token) {
  const type = $state.trash.type;
  const items = await getTrashItems(type);
  if (!isCurrent(token) || type !== $state.trash.type) return;
  $state.trash.items = items || [];
  renderTrash();
}

function renderTrash() {
  const body = $('#db-trash-body');
  if (!body) return;
  $$('[data-db-action="trash-type"]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.type === $state.trash.type));
  });
  const items = $state.trash.items;
  if (!items.length) {
    body.replaceChildren(el('tr', { className: 'db-empty-row' }, [el('td', { attrs: { colspan: '4' }, text: 'المهملات فارغة' })]));
    return;
  }
  body.replaceChildren(...items.map((item) => el('tr', {}, [
    el('td', { dataset: { label: 'النوع' } }, [el('span', { className: 'db-badge db-badge--muted', text: DB.TRASH_TYPE_LABELS[item.type] || item.type })]),
    el('td', { dataset: { label: 'الاسم / العنوان' }, text: item.name || '—' }),
    el('td', { dataset: { label: 'تاريخ الحذف' }, text: fmtDate(item.deleted_at) }),
    el('td', { dataset: { label: 'الإجراءات' } }, [el('div', { className: 'db-cell-actions' }, [
      el('button', { className: 'db-btn db-btn--success db-btn--sm', attrs: { type: 'button', 'data-db-action': 'trash-restore' }, dataset: { id: item.id, type: item.type } }, [icon('fa-rotate-left'), el('span', { text: 'استعادة' })]),
      el('button', { className: 'db-btn db-btn--danger db-btn--sm', attrs: { type: 'button', 'data-db-action': 'trash-purge' }, dataset: { id: item.id, type: item.type } }, [icon('fa-trash-alt'), el('span', { text: 'حذف نهائي' })])
    ])])
  ])));
}

// ====== 16. تبويب الشكاوى ======
async function loadComplaints(token, force) {
  const items = await cached('complaints', () => getComplaints({ limitCount: DB.COMPLAINTS_LIMIT }), force);
  if (!isCurrent(token)) return;
  $state.complaints.items = items || [];
  const pending = $state.complaints.items.filter((c) => (c.status || 'pending') === 'pending').length;
  updateComplaintsBadge(pending);
  renderComplaints();
}

function complaintItem(complaint) {
  const status = complaint.status || 'pending';
  const meta = DB.COMPLAINT_STATUS[status] || DB.COMPLAINT_STATUS.pending;
  const buttons = [];
  if (status !== 'closed') {
    buttons.push(el('button', { className: 'db-btn db-btn--ghost db-btn--sm', attrs: { type: 'button', 'data-db-action': 'complaint-reply' }, dataset: { id: complaint.id } }, [icon('fa-reply'), el('span', { text: complaint.reply ? 'تعديل الرد' : 'رد' })]));
    if (status === 'pending') {
      buttons.push(el('button', { className: 'db-btn db-btn--success db-btn--sm', attrs: { type: 'button', 'data-db-action': 'complaint-resolve' }, dataset: { id: complaint.id } }, [icon('fa-check'), el('span', { text: 'تم الرد' })]));
    }
    buttons.push(el('button', { className: 'db-btn db-btn--ghost db-btn--sm', attrs: { type: 'button', 'data-db-action': 'complaint-close' }, dataset: { id: complaint.id } }, [icon('fa-xmark'), el('span', { text: 'إغلاق' })]));
  }

  return el('article', { className: 'db-item' }, [
    el('div', { className: 'db-item__head' }, [
      el('button', {
        className: 'db-btn db-btn--ghost db-btn--sm',
        attrs: { type: 'button', 'data-db-action': 'open-profile', disabled: complaint.user_id == null },
        dataset: complaint.user_id == null ? {} : { id: complaint.user_id },
        text: complaint.full_name || 'طالب'
      }),
      el('span', { className: `db-badge db-badge--${meta.tone}`, text: meta.label }),
      el('span', { className: 'db-item__time', text: fmtRelative(complaint.date) })
    ]),
    el('p', { className: 'db-item__text', text: complaint.comment || '' }),
    complaint.reply ? el('div', { className: 'db-reply' }, [el('span', { className: 'db-reply__label', text: 'ردّك' }), el('span', { text: complaint.reply })]) : null,
    buttons.length ? el('div', { className: 'db-item__actions' }, buttons) : null
  ]);
}

function renderComplaints() {
  const list = $('#db-complaints-list');
  if (!list) return;
  const filter = $state.complaints.filter;
  const items = filter === 'all'
    ? $state.complaints.items
    : $state.complaints.items.filter((c) => (c.status || 'pending') === filter);
  if (!items.length) {
    list.replaceChildren(el('p', { className: 'db-note', text: 'لا توجد شكاوى' }));
    return;
  }
  list.replaceChildren(...items.map(complaintItem));
}

function findComplaint(id) {
  return $state.complaints.items.find((c) => String(c.id) === String(id));
}

// ====== 17. النوافذ المنبثقة (modals.js) ======
function resolveModalHost(instance) {
  const root = instance?.element;
  if (!root) return null;
  return root.querySelector('.db-modal-host') || root.querySelector('.modals-dialog__body') || root;
}

function openModal({ title, onOpen }) {
  if (!window.modals?.showModal) {
    safeToast('تعذّر فتح النافذة', 'error');
    return;
  }
  window.modals.showModal({
    title,
    size: 'md',
    html: '<div class="db-modal-host"></div>',
    buttons: [],
    onOpen: (instance) => {
      const host = resolveModalHost(instance);
      if (!host) return;
      Promise.resolve(onOpen(instance, host)).catch((error) => {
        console.error('❌ فشل تجهيز النافذة:', error);
        safeToast('تعذّر تجهيز النافذة', 'error');
      });
    }
  });
}

function formField({ id, label, control, hint }) {
  return el('div', { className: 'db-form__field' }, [
    el('label', { className: 'db-form__label', attrs: { for: id }, text: label }),
    control,
    hint ? el('small', { className: 'db-form__hint', text: hint }) : null,
    el('small', { className: 'db-form__error', attrs: { role: 'alert', 'data-error-for': id } })
  ]);
}

function openTextModal({ title, label, placeholder, intro, initial = '', maxLength, submitText, onSubmit }) {
  openModal({
    title,
    onOpen: (instance, host) => {
      const area = el('textarea', { className: 'db-input', attrs: { id: 'db-modal-text', rows: '5', maxlength: maxLength, placeholder, required: true } });
      area.value = initial;
      const counter = el('small', { className: 'db-form__counter', text: `${initial.length} / ${maxLength}` });
      const submit = el('button', { className: 'db-btn db-btn--primary', attrs: { type: 'submit' }, text: submitText });
      const cancel = el('button', { className: 'db-btn db-btn--ghost', attrs: { type: 'button' }, text: 'إلغاء' });

      const form = el('form', { className: 'db-form', attrs: { novalidate: true } }, [
        intro ? el('p', { className: 'db-form__hint', text: intro }) : null,
        formField({ id: 'db-modal-text', label, control: area }),
        counter,
        el('div', { className: 'db-form__actions' }, [cancel, submit])
      ]);
      const setError = (message) => {
        const node = form.querySelector('[data-error-for="db-modal-text"]');
        if (node) node.textContent = message;
      };

      area.addEventListener('input', () => { counter.textContent = `${area.value.length} / ${maxLength}`; });
      cancel.addEventListener('click', () => instance.close(false));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = area.value.trim();
        if (!text) { setError('اكتب النص أولًا'); return; }
        setError('');
        setBusy(submit, true, 'جارٍ الإرسال...');
        try {
          await onSubmit(text);
          instance.close(true);
        } catch (error) {
          setError(error?.message || 'تعذّر الإرسال');
          setBusy(submit, false);
        }
      });

      host.replaceChildren(form);
      area.focus();
    }
  });
}

// ---- نافذة إضافة مشرف (خطوتان: بحث ثم تأكيد) ----
function openAddModeratorModal() {
  if (!$state.isTeacher) return;
  openModal({
    title: 'إضافة مشرف جديد',
    onOpen: (instance, host) => {
      const phoneInput = el('input', { className: 'db-input db-input--ltr', attrs: { id: 'db-mod-phone', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '01xxxxxxxxx', required: true } });
      const submit = el('button', { className: 'db-btn db-btn--primary', attrs: { type: 'submit' }, text: 'بحث' });
      const cancel = el('button', { className: 'db-btn db-btn--ghost', attrs: { type: 'button' }, text: 'إلغاء' });
      const form = el('form', { className: 'db-form', attrs: { novalidate: true } }, [
        formField({ id: 'db-mod-phone', label: 'رقم هاتف المستخدم', control: phoneInput, hint: 'سيُبحث عن مستخدم مسجّل بهذا الرقم لترقيته إلى مشرف' }),
        el('div', { className: 'db-form__actions' }, [cancel, submit])
      ]);
      const setError = (message) => {
        const node = form.querySelector('[data-error-for="db-mod-phone"]');
        if (node) node.textContent = message;
      };

      cancel.addEventListener('click', () => instance.close(false));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const candidates = phoneCandidates(phoneInput.value);
        if (!candidates.length || candidates[candidates.length - 1].length < 8) { setError('أدخل رقم هاتف صحيحًا'); return; }
        setError('');
        setBusy(submit, true, 'جارٍ البحث...');
        try {
          let found = null;
          for (const phone of candidates) {
            found = await getUserByPhone(phone);
            if (found) break;
          }
          if (!found) { setError('لا يوجد مستخدم مسجّل بهذا الرقم'); return; }
          if (found.user_type === 'teacher' || found.user_type === 'moderator') { setError('هذا المستخدم معلم أو مشرف بالفعل'); return; }

          const current = await cached('moderators', getModeratorsList, true);
          if (countNormalModerators(current) >= DB.MAX_MODERATORS) {
            setError(`لا يمكن تعيين أكثر من ${fmtNumber(DB.MAX_MODERATORS)} مشرفين`);
            return;
          }
          showConfirmStep(found);
        } catch (error) {
          console.error('❌ فشل البحث عن المستخدم:', error);
          setError(error?.message || 'تعذّر البحث، حاول مرة أخرى');
        } finally {
          setBusy(submit, false);
        }
      });

      function showConfirmStep(user) {
        const confirmBtn = el('button', { className: 'db-btn db-btn--primary', attrs: { type: 'button' }, text: 'تأكيد الترقية' });
        const backBtn = el('button', { className: 'db-btn db-btn--ghost', attrs: { type: 'button' }, text: 'رجوع' });
        const error = el('small', { className: 'db-form__error', attrs: { role: 'alert' } });

        backBtn.addEventListener('click', () => host.replaceChildren(form));
        confirmBtn.addEventListener('click', async () => {
          error.textContent = '';
          setBusy(confirmBtn, true, 'جارٍ الترقية...');
          try {
            await addModerator(user.id);
            try {
              await createNotification(user.id, { title: 'تمت ترقيتك إلى مشرف', message: 'أصبح لديك حساب مشرف على منصة بيولوجست.', type: 'success', sender: 'system' });
            } catch (notifyError) {
              console.warn('⚠️ تعذّر إرسال إشعار الترقية:', notifyError);
            }
            invalidate('moderators');
            markDirty('overview');
            EventBus.emit('moderator:added', { userId: user.id });
            instance.close(true);
            safeToast(`تمت ترقية ${user.full_name} إلى مشرف`, 'success');
            if ($state.activeTab === 'moderators') await loadTab('moderators', { force: true });
          } catch (err) {
            console.error('❌ فشل إضافة المشرف:', err);
            error.textContent = err?.message || 'فشل إضافة المشرف';
            setBusy(confirmBtn, false);
          }
        });

        host.replaceChildren(el('div', { className: 'db-form' }, [
          el('p', { className: 'db-form__hint', text: 'هل تريد ترقية هذا المستخدم إلى مشرف؟' }),
          el('div', { className: 'db-preview' }, [
            avatarFor(user, 'md'),
            el('div', { className: 'db-person__info' }, [
              el('span', { className: 'db-person__name', text: user.full_name || 'بدون اسم' }),
              el('span', { className: 'db-mod__phone', text: user.phone || '' })
            ])
          ]),
          error,
          el('div', { className: 'db-form__actions' }, [backBtn, confirmBtn])
        ]));
        confirmBtn.focus();
      }

      host.replaceChildren(form);
      phoneInput.focus();
    }
  });
}

// ---- نافذة التحكم بالفصل الدراسي ----
function openSemesterModal() {
  if (!$state.isTeacher) return;
  openModal({
    title: 'التحكم بالفصل الدراسي الظاهر للطلاب',
    onOpen: async (instance, host) => {
      host.replaceChildren(el('p', { className: 'db-note', text: 'جاري التحميل...' }));
      const settings = await getSemesterSettings(true);

      const rows = DB.STAGES.flatMap((stage) => [1, 2, 3]
        .filter((grade) => !(stage.value === 'ثانوي' && grade === 3))
        .map((grade) => ({ stage, grade })));

      const list = el('div', { className: 'db-sem-list' });
      rows.forEach(({ stage, grade }) => list.appendChild(buildSemesterRow(stage, grade, settings)));

      host.replaceChildren(
        el('p', { className: 'db-form__hint', text: 'لكل صف إعداد مستقل، وأي تغيير يظهر فورًا لكل طلاب الصف المختار. الصف الثالث الثانوي بلا فصلين دراسيين.' }),
        list,
        el('div', { className: 'db-form__actions' }, [
          el('button', { className: 'db-btn db-btn--ghost', attrs: { type: 'button' }, text: 'إغلاق' })
        ])
      );
      host.querySelector('.db-form__actions .db-btn').addEventListener('click', () => instance.close(true));
    }
  });
}

function buildSemesterRow(stage, grade, settings) {
  const setting = settings.find((s) => normalizeStage(s.stage) === stage.value && Number(s.grade) === grade);
  let active = setting?.active_semester || 'أول';
  const auditParts = [];
  if (setting?.updated_by) auditParts.push(String(setting.updated_by) === String($state.user?.id) ? 'عدّلتَه أنت' : 'عدّله معلم آخر');
  if (setting?.updated_at) auditParts.push(fmtDate(setting.updated_at));

  const controls = el('div', { className: 'db-sem-row__controls' });
  const row = el('div', { className: 'db-sem-row' }, [
    el('div', { className: 'db-sem-row__info' }, [
      el('span', { className: 'db-sem-row__name', text: `الصف ${gradeFull(stage.value, grade)}` }),
      el('span', { className: 'db-sem-row__audit', text: auditParts.length ? `آخر تحديث: ${auditParts.join(' — ')}` : 'لم يُعدَّل بعد' })
    ]),
    controls
  ]);

  const renderControls = () => {
    controls.replaceChildren(...DB.SEMESTERS.map((semester) => {
      const button = el('button', {
        className: `db-btn db-btn--sm ${semester.value === active ? 'db-btn--primary' : 'db-btn--ghost'}`,
        attrs: { type: 'button', 'aria-pressed': String(semester.value === active) },
        text: `الفصل ${semester.label}`
      });
      button.addEventListener('click', () => { if (semester.value !== active) askConfirm(semester); });
      return button;
    }));
  };

  const askConfirm = (semester) => {
    const yes = el('button', { className: 'db-btn db-btn--primary db-btn--sm', attrs: { type: 'button' }, text: 'تأكيد' });
    const no = el('button', { className: 'db-btn db-btn--ghost db-btn--sm', attrs: { type: 'button' }, text: 'إلغاء' });
    no.addEventListener('click', renderControls);
    yes.addEventListener('click', async () => {
      setBusy(yes, true, 'جارٍ الحفظ...');
      no.disabled = true;
      try {
        await setActiveSemester(stage.value, grade, semester.value, $state.user?.id);
        active = semester.value;
        safeToast(`تم تعيين الفصل ${semester.label} للصف ${gradeFull(stage.value, grade)}`, 'success');
      } catch (error) {
        console.error('❌ فشل تغيير الفصل الدراسي:', error);
        safeToast(error?.message || 'فشل تغيير الفصل الدراسي', 'error');
      }
      renderControls();
    });
    controls.replaceChildren(
      el('span', { className: 'db-sem-row__ask', text: `تغيير إلى الفصل ${semester.label}؟` }),
      yes,
      no
    );
  };

  renderControls();
  return row;
}

// ====== 18. تنفيذ الإجراءات ======
async function runAction(button, task, failureMessage) {
  setBusy(button, true);
  try {
    await task();
  } catch (error) {
    console.error(`❌ ${failureMessage}:`, error);
    safeToast(error?.message || failureMessage, 'error');
  } finally {
    if (button?.isConnected) setBusy(button, false);
  }
}

const ACTIONS = {
  refresh: (btn) => refreshAll({ silent: false, button: btn }),

  'open-semester': () => openSemesterModal(),
  'add-moderator': () => openAddModeratorModal(),
  'goto-complaints': () => switchTab('complaints', { focus: true }),

  'open-profile': (btn) => openProfile(btn.dataset.id),
  'edit-student': (btn) => openProfile(btn.dataset.id, true),

  'students-reset': () => resetStudentFilters(),
  'students-prev': () => { $state.students.page -= 1; applyStudentFilters(); },
  'students-next': () => { $state.students.page += 1; applyStudentFilters(); },

  'comments-more': () => loadComments($state.token, { more: true }),

  'comment-reply': (btn) => {
    const comment = findComment(btn.dataset.id);
    if (!comment) return;
    openTextModal({
      title: `الرد على ${comment.full_name || 'التعليق'}`,
      label: 'نص الرد',
      placeholder: 'اكتب ردّك هنا...',
      intro: `«${(comment.comment || '').slice(0, 120)}»`,
      maxLength: DB.REPLY_MAX_LENGTH,
      submitText: 'إرسال الرد',
      onSubmit: async (text) => {
        await addComment({ comment: text, parentId: comment.id });
        comment.replies_count = (comment.replies_count || 0) + 1;
        invalidate('stats', 'recentComments');
        markDirty('overview');
        renderComments();
        EventBus.emit('comment:added', { parentId: comment.id });
        safeToast('تم إرسال الرد', 'success');
      }
    });
  },

  'comment-pin': (btn) => {
    const comment = findComment(btn.dataset.id);
    if (!comment) return;
    const next = !comment.pinned;
    return runAction(btn, async () => {
      await pinComment(comment.id, next);
      $state.comments.items.forEach((c) => {
        if (String(c.id) === String(comment.id)) c.pinned = next;
        else if (next) c.pinned = false;
      });
      if ($state.comments.filter === 'pinned' && !next) {
        $state.comments.items = $state.comments.items.filter((c) => String(c.id) !== String(comment.id));
      }
      invalidate('recentComments');
      markDirty('overview');
      renderComments();
      EventBus.emit('comment:pinned', { commentId: comment.id, pinned: next });
      safeToast(next ? 'تم تثبيت التعليق' : 'تم إلغاء تثبيت التعليق', 'success');
    }, 'فشل تغيير حالة التثبيت');
  },

  'comment-delete': async (btn) => {
    const comment = findComment(btn.dataset.id);
    if (!comment) return;
    const ok = await confirmAction({ title: 'حذف التعليق', message: 'سيُنقل التعليق إلى المهملات ويمكنك استعادته لاحقًا. هل تريد المتابعة؟', confirmText: 'حذف', type: 'danger' });
    if (!ok) return;
    return runAction(btn, async () => {
      await softDeleteComment(comment.id);
      $state.comments.items = $state.comments.items.filter((c) => String(c.id) !== String(comment.id));
      invalidate('stats', 'recentComments');
      markDirty('overview', 'trash');
      renderComments();
      EventBus.emit('comment:deleted', { commentId: comment.id });
      safeToast('تم حذف التعليق', 'success');
    }, 'فشل حذف التعليق');
  },

  'mod-promote': async (btn) => {
    const mod = findModerator(btn.dataset.id);
    if (!mod) return;
    const ok = await confirmAction({
      title: 'ترقية المشرف',
      message: `ستمنح «${mod.full_name}» صلاحيات المعلم الكاملة (إدارة المشرفين والحذف النهائي وغيرها)، ولا يمكن التراجع عن ذلك من هذه الصفحة. هل تريد المتابعة؟`,
      confirmText: 'ترقية',
      type: 'danger'
    });
    if (!ok) return;
    return runAction(btn, async () => {
      await updateModeratorLevel(mod.id, 'senior');
      try { await createNotification(mod.id, { title: 'تمت ترقيتك', message: 'تمت ترقيتك إلى مشرف ممتاز.', type: 'success', sender: 'system' }); } catch (e) { console.warn(e); }
      invalidate('moderators');
      markDirty('overview');
      EventBus.emit('moderator:promoted', { modId: mod.id });
      safeToast('تمت الترقية بنجاح', 'success');
      await loadTab('moderators', { force: true });
    }, 'فشلت الترقية');
  },

  'mod-remove': async (btn) => {
    const mod = findModerator(btn.dataset.id);
    if (!mod) return;
    const ok = await confirmAction({ title: 'إزالة المشرف', message: `سيعود «${mod.full_name}» إلى حساب طالب. هل أنت متأكد؟`, confirmText: 'إزالة', type: 'danger' });
    if (!ok) return;
    return runAction(btn, async () => {
      await deleteModerator(mod.id);
      invalidate('moderators');
      markDirty('overview');
      EventBus.emit('moderator:deleted', { modId: mod.id });
      safeToast('تمت إزالة المشرف', 'success');
      await loadTab('moderators', { force: true });
    }, 'فشلت الإزالة');
  },

  'trash-type': (btn) => {
    if ($state.trash.type === btn.dataset.type) return;
    $state.trash.type = btn.dataset.type;
    $state.trash.items = [];
    renderTrash();
    loadTab('trash');
  },

  'trash-restore': (btn) => runAction(btn, async () => {
    await restoreTrashItem(btn.dataset.type, btn.dataset.id);
    invalidate('stats', 'recentComments');
    markDirty('overview', 'comments');
    EventBus.emit('trash:restored', { type: btn.dataset.type, id: btn.dataset.id });
    safeToast('تمت الاستعادة بنجاح', 'success');
    await loadTab('trash');
  }, 'فشلت الاستعادة'),

  'trash-purge': async (btn) => {
    const ok = await confirmAction({ title: 'حذف نهائي', message: 'هذا الإجراء نهائي ولا يمكن التراجع عنه. هل أنت متأكد؟', confirmText: 'حذف نهائي', type: 'danger' });
    if (!ok) return;
    return runAction(btn, async () => {
      await permanentlyDeleteTrashItem(btn.dataset.type, btn.dataset.id);
      invalidate('stats');
      markDirty('overview');
      EventBus.emit('trash:permanently-deleted', { type: btn.dataset.type, id: btn.dataset.id });
      safeToast('تم الحذف النهائي', 'success');
      await loadTab('trash');
    }, 'فشل الحذف النهائي');
  },

  'complaint-reply': (btn) => {
    const complaint = findComplaint(btn.dataset.id);
    if (!complaint) return;
    openTextModal({
      title: `الرد على شكوى ${complaint.full_name || 'الطالب'}`,
      label: 'نص الرد',
      placeholder: 'اكتب ردّك هنا...',
      intro: `«${(complaint.comment || '').slice(0, 120)}»`,
      initial: complaint.reply || '',
      maxLength: DB.REPLY_MAX_LENGTH,
      submitText: 'إرسال الرد',
      onSubmit: async (text) => {
        await replyToComplaint(complaint.id, text);
        try {
          await createNotification(complaint.user_id, { title: 'تم الرد على شكواك', message: text, type: 'info', sender: 'system' });
        } catch (notifyError) {
          console.warn('⚠️ تعذّر إرسال إشعار الرد:', notifyError);
        }
        invalidate('complaints', 'pending');
        markDirty('overview');
        safeToast('تم إرسال الرد', 'success');
        await loadTab('complaints', { force: true });
      }
    });
  },

  'complaint-resolve': (btn) => runAction(btn, async () => {
    await updateComplaintStatus(btn.dataset.id, 'resolved');
    invalidate('complaints', 'pending');
    markDirty('overview');
    safeToast('تم تحديث الحالة إلى «تم الرد»', 'success');
    await loadTab('complaints', { force: true });
  }, 'فشل تحديث الحالة'),

  'complaint-close': (btn) => runAction(btn, async () => {
    await updateComplaintStatus(btn.dataset.id, 'closed');
    invalidate('complaints', 'pending');
    markDirty('overview');
    safeToast('تم إغلاق الشكوى', 'success');
    await loadTab('complaints', { force: true });
  }, 'فشل إغلاق الشكوى')
};

// ====== 19. التبويبات ======
function visibleTabs() {
  return $$('.db-tab').filter((tab) => !tab.hidden);
}

function switchTab(id, { focus = false, reveal = false } = {}) {
  const config = TABS[id];
  if (!config || (config.teacherOnly && !$state.isTeacher)) id = 'overview';
  $state.activeTab = id;

  $$('.db-tab').forEach((btn) => {
    const on = btn.dataset.tab === id;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    if (on && focus) btn.focus();
    if (on && reveal) btn.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  });
  $$('.db-panel').forEach((panel) => { panel.hidden = panel.id !== `db-panel-${id}`; });

  if (id === 'overview' && $state.chartsStale) drawCharts();
  if (!$state.loaded.has(id) || $state.dirty.has(id)) loadTab(id);
}

function onTabKeydown(event) {
  const tab = event.target.closest?.('.db-tab');
  if (!tab) return;
  const tabs = visibleTabs();
  const index = tabs.indexOf(tab);
  if (index === -1) return;

  const rtl = getComputedStyle(tab.parentElement).direction === 'rtl';
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
  let target = null;

  if (event.key === forward) target = tabs[(index + 1) % tabs.length];
  else if (event.key === backward) target = tabs[(index - 1 + tabs.length) % tabs.length];
  else if (event.key === 'Home') target = tabs[0];
  else if (event.key === 'End') target = tabs[tabs.length - 1];

  if (target) {
    event.preventDefault();
    switchTab(target.dataset.tab, { focus: true });
  }
}

// ====== 20. الأحداث ======
function onRootClick(event) {
  const tab = event.target.closest('.db-tab');
  if (tab && $state.root.contains(tab)) {
    switchTab(tab.dataset.tab, { reveal: true });
    return;
  }
  const trigger = event.target.closest('[data-db-action]');
  if (!trigger || !$state.root.contains(trigger) || trigger.disabled) return;
  const handler = ACTIONS[trigger.dataset.dbAction];
  if (!handler) return;
  try {
    const result = handler(trigger);
    if (result && typeof result.then === 'function') {
      result.catch((error) => console.error('❌ خطأ في إجراء لوحة التحكم:', error));
    }
  } catch (error) {
    console.error('❌ خطأ في إجراء لوحة التحكم:', error);
  }
}

function onRootInput(event) {
  if (event.target.id !== 'db-student-search') return;
  if ($state.searchTimer) window.clearTimeout($state.searchTimer);
  const value = event.target.value;
  $state.searchTimer = queue(() => {
    $state.searchTimer = null;
    $state.students.query = value;
    $state.students.page = 1;
    applyStudentFilters();
  }, DB.SEARCH_DEBOUNCE_MS);
}

function onRootChange(event) {
  const { id, value } = event.target;
  if (id === 'db-student-stage') { $state.students.stage = value; $state.students.page = 1; applyStudentFilters(); }
  else if (id === 'db-student-grade') { $state.students.grade = value; $state.students.page = 1; applyStudentFilters(); }
  else if (id === 'db-comments-filter') { $state.comments.filter = value; loadTab('comments'); }
  else if (id === 'db-complaints-filter') { $state.complaints.filter = value; renderComplaints(); }
}

function debounceContentRefresh() {
  if ($state.eventTimer) window.clearTimeout($state.eventTimer);
  $state.eventTimer = queue(() => {
    $state.eventTimer = null;
    invalidate('stats', 'recentComments', 'top', 'weekly', 'examPerf');
    markDirty('overview');
    if ($state.activeTab === 'overview') loadTab('overview');
  }, DB.EVENT_DEBOUNCE_MS);
}

function bindEvents() {
  const { signal } = $state.abort;
  const root = $state.root;
  root.addEventListener('click', onRootClick, { signal });
  root.addEventListener('keydown', onTabKeydown, { signal });
  root.addEventListener('input', onRootInput, { signal });
  root.addEventListener('change', onRootChange, { signal });

  window.addEventListener('online', () => { updateConnection(); refreshAll({ silent: true }); }, { signal });
  window.addEventListener('offline', updateConnection, { signal });

  $state.group.on('theme:toggled', scheduleChartsRedraw);
  $state.group.on('theme:colorChanged', scheduleChartsRedraw);
  $state.group.on('lesson:*', debounceContentRefresh);
  $state.group.on('exam:*', debounceContentRefresh);
  $state.group.on('userStateChanged', (payload) => {
    if (payload?.action === 'logout') $state.token += 1;
  });
}

// ====== 21. التحديث ======
async function refreshAll({ silent = false, button = null } = {}) {
  if ($state.refreshing || !$state.mounted) return;
  const token = $state.token;
  $state.refreshing = true;
  if (!silent) setBusy(button || $('#db-refresh-btn'), true, 'جارٍ التحديث...');

  try {
    $state.cache.clear();
    $state.loaded.forEach((id) => { if (id !== $state.activeTab) $state.dirty.add(id); });
    await loadTab($state.activeTab, { force: true });
    if (isCurrent(token) && !silent) safeToast('تم تحديث البيانات', 'success');
  } finally {
    $state.refreshing = false;
    if (isCurrent(token) && !silent) setBusy(button || $('#db-refresh-btn'), false);
  }
}

function startAutoRefresh() {
  $state.autoTimer = window.setInterval(() => {
    if (document.hidden || navigator.onLine === false) return;
    refreshAll({ silent: true });
  }, DB.AUTO_REFRESH_MS);
}

function greetOnce() {
  try {
    if (sessionStorage.getItem(DB.GREET_KEY)) return;
    sessionStorage.setItem(DB.GREET_KEY, '1');
    const show = directing.showDirectingMessage;
    if (typeof show !== 'function') return;
    const customMessage = $state.isTeacher
      ? 'مرحباً أيها المعلم 🧑‍🏫! لوحة التحكم جاهزة لإدارة المنصة.'
      : 'مرحباً أيها المشرف 🛠️! يمكنك إدارة الطلاب والتعليقات من هنا.';
    show('dashboard_welcome', { customMessage, duration: 4000 });
  } catch (error) {
    console.warn('⚠️ تعذّر عرض رسالة الترحيب:', error);
  }
}

// ====== 22. التهيئة والتنظيف ======
const VIEW_URL = new URL('dashboard.html', import.meta.url).href;

function findRoot(container) {
  return container?.querySelector('#db-root') || container?.querySelector('.db-root') || container?.querySelector('[data-page="dashboard"]') || null;
}

async function resolveRoot(container) {
  const found = findRoot(container);
  if (found || !container) return found;
  try {
    const response = await fetch(VIEW_URL, { cache: 'reload' });
    if (!response.ok) return null;
    container.innerHTML = await response.text();
  } catch (error) {
    console.warn('⚠️ تعذّر جلب واجهة لوحة التحكم:', error);
    return null;
  }
  return findRoot(container);
}

export async function initializePage(container, params = {}) {
  try {
    cleanupPage();
    $state = createInitialState();
    $lastInit = { container, params };

    const root = await resolveRoot(container);
    if (!root) throw new Error('عنصر لوحة التحكم غير موجود');

    const user = getCurrentUser();
    const teacher = Boolean(user) && isTeacher(user);
    const moderator = Boolean(user) && !teacher && isModerator(user);
    if (!teacher && !moderator) {
      console.warn('⛔ غير مصرّح بالوصول إلى لوحة التحكم');
      window.setTimeout(() => navigateTo('home', {}, { replace: true }), 0);
      return;
    }

    $state.root = root;
    $state.mounted = true;
    $state.user = user;
    $state.isTeacher = teacher;
    $state.isModerator = moderator;
    $state.abort = new AbortController();
    $state.group = EventBus.group();

    const stateBox = $('#db-state');
    if (stateBox) stateBox.hidden = true;
    const content = $('#db-content');
    if (content) content.hidden = false;

    applyRoleGates();
    renderHeader();
    updateConnection();
    bindEvents();
    startAutoRefresh();

    const requested = params?.query?.tab;
    switchTab(Object.prototype.hasOwnProperty.call(TABS, requested) ? requested : 'overview');
    greetOnce();
  } catch (error) {
    console.error('❌ فشل تهيئة لوحة التحكم:', error);
    if (!$state.root) throw error;
    showInitError('تعذّر تحميل لوحة التحكم، حاول مرة أخرى.');
  }
}

export function cleanupPage() {
  try {
    $state.mounted = false;
    $state.token += 1;

    $state.abort?.abort();
    $state.group?.dispose();
    $state.timers.forEach((id) => window.clearTimeout(id));
    if ($state.autoTimer) window.clearInterval($state.autoTimer);
    destroyCharts();
  } catch (error) {
    console.warn('⚠️ خطأ أثناء تنظيف لوحة التحكم:', error);
  } finally {
    $state = createInitialState();
  }
}

export default { initializePage, cleanupPage };
