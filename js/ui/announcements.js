/* الإعلانات المنبثقة بملء الشاشة - v5.0.0 */

// ==== 1. الاستيراد ====
import { EventBus } from '../core/event-bus.js';
import { getActiveAnnouncements, ANNOUNCEMENT_ACTION_ROUTES } from '../core/api.js';
import { getCurrentUser } from '../core/session.js';

// ==== 2. الثوابت ====
const CLOSE_LOCK_SECONDS = 3;
const SHOW_DELAY_MS = 500;
const DEBOUNCE_MS = 250;
const SEEN_KEY_PREFIX = 'biologist_announcements_seen_v1';
const HOME_PATHS = ['/', '/home', '/index.html'];
const INERT_SELECTORS = ['#navbar-top', '#bottom-navigation', '#main-content', '.main-footer'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 20;

// ==== 3. الحالة ====
let initialized = false;
let running = false;
let shownThisLoad = false;
let debounceTimer = null;

// ==== 4. مفتاح التخزين ====
function getSeenKey(user) {
  return `${SEEN_KEY_PREFIX}:${user?.id ?? 'guest'}`;
}

function readSeen(user) {
  try {
    const raw = localStorage.getItem(getSeenKey(user));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function getVersion(announcement) {
  return announcement.updated_at?.toMillis?.() || announcement.created_at?.toMillis?.() || 0;
}

// ==== 5. حفظ الإعلان كمغلق ====
function markSeen(user, announcement) {
  try {
    const seen = readSeen(user);
    seen[announcement.id] = getVersion(announcement);
    localStorage.setItem(getSeenKey(user), JSON.stringify(seen));
  } catch (err) {
    console.warn('[Announcements] تعذّر حفظ حالة الإغلاق:', err);
  }
}

function isSeen(seen, announcement) {
  return seen[announcement.id] !== undefined && seen[announcement.id] >= getVersion(announcement);
}

// ==== 6. تطبيع المرحلة ====
function normalizeStage(stage) {
  const map = { preparatory: 'إعدادي', secondary: 'ثانوي' };
  return map[stage] || stage || '';
}

// ==== 7. تحديد الجمهور ====
function matchesAudience(announcement, user) {
  const audience = announcement.audience || {};
  if (!user) return !!audience.guests;

  const type = user.user_type;
  if (type === 'teacher' || type === 'moderator') return !!audience.staff;

  if (audience.students) return true;
  const stage = normalizeStage(user.stage);
  const grade = parseInt(user.grade, 10);
  if ((audience.stages || []).includes(stage)) return true;
  return (audience.grades || []).some(g => g.stage === stage && g.grade === grade);
}

// ==== 8. التحقق من الصور ====
function isSafeImageUrl(url) {
  const value = String(url || '').trim();
  return /^https?:\/\//i.test(value) || (value.startsWith('/') && !value.startsWith('//'));
}

// ==== 9. جاهزية الرئيسية ====
function isHomeReady() {
  const preloader = document.getElementById('app-preloader');
  if (preloader && preloader.getAttribute('data-preloader-state') !== 'hidden') return false;

  const view = document.getElementById('app-router-view');
  if (!view || view.childElementCount === 0) return false;
  if (view.querySelector('.page-loader')) return false;

  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (!HOME_PATHS.includes(path)) return false;
  const route = view.getAttribute('data-route');
  return !route || route === 'home';
}

// ==== 10. حلقة العدّاد ====
function buildRing() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ann-ring');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');

  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'ann-ring-track');
  track.setAttribute('cx', '24');
  track.setAttribute('cy', '24');
  track.setAttribute('r', String(RING_RADIUS));

  const fill = document.createElementNS(SVG_NS, 'circle');
  fill.setAttribute('class', 'ann-ring-fill');
  fill.setAttribute('cx', '24');
  fill.setAttribute('cy', '24');
  fill.setAttribute('r', String(RING_RADIUS));

  svg.append(track, fill);
  return svg;
}

// ==== 11. تعطيل الخلفية ====
function setBackgroundInert(isInert) {
  INERT_SELECTORS.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => {
      if (isInert) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
  });
}

// ==== 12. عرض إعلان واحد ====
function showOne(announcement, index, total, user) {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    let unlocked = false;
    let remaining = CLOSE_LOCK_SECONDS;
    let tickTimer = null;

    const titleId = `ann-title-${announcement.id}`;
    const overlay = document.createElement('div');
    overlay.className = 'ann-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', titleId);

    const card = document.createElement('div');
    card.className = 'ann-card';
    card.tabIndex = -1;

    const topbar = document.createElement('div');
    topbar.className = 'ann-topbar';

    const counter = document.createElement('span');
    counter.className = 'ann-counter';
    if (total > 1) counter.textContent = `${index} من ${total}`;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ann-close';
    closeBtn.disabled = true;
    closeBtn.setAttribute('aria-label', `الإغلاق متاح بعد ${remaining} ثوانٍ`);

    const countText = document.createElement('span');
    countText.className = 'ann-close-count';
    countText.textContent = String(remaining);

    const closeIcon = document.createElement('i');
    closeIcon.className = 'fas fa-times ann-close-icon';
    closeIcon.setAttribute('aria-hidden', 'true');

    closeBtn.append(buildRing(), countText, closeIcon);
    topbar.append(counter, closeBtn);
    card.appendChild(topbar);

    if (isSafeImageUrl(announcement.image_url)) {
      const media = document.createElement('div');
      media.className = 'ann-media';
      const img = document.createElement('img');
      img.className = 'ann-image';
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => media.remove(), { once: true });
      img.src = announcement.image_url;
      media.appendChild(img);
      card.appendChild(media);
    }

    const body = document.createElement('div');
    body.className = 'ann-body';

    const title = document.createElement('h2');
    title.className = 'ann-title';
    title.id = titleId;
    title.setAttribute('dir', 'auto');
    title.textContent = announcement.title;

    const text = document.createElement('p');
    text.className = 'ann-text';
    text.setAttribute('dir', 'auto');
    text.textContent = announcement.text;

    body.append(title, text);
    card.appendChild(body);

    let actionBtn = null;
    if (announcement.action_label && ANNOUNCEMENT_ACTION_ROUTES.includes(announcement.action_route)) {
      const actions = document.createElement('div');
      actions.className = 'ann-actions';
      actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'ann-action';
      actionBtn.textContent = announcement.action_label;
      actions.appendChild(actionBtn);
      card.appendChild(actions);
    }

    overlay.appendChild(card);

    const finish = (reason) => {
      clearInterval(tickTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.classList.add('ann-overlay--leaving');
      const remove = () => {
        overlay.remove();
        document.body.classList.remove('ann-open');
        setBackgroundInert(false);
        if (previousFocus && typeof previousFocus.focus === 'function' && document.contains(previousFocus)) {
          try { previousFocus.focus({ preventScroll: true }); } catch { }
        }
        resolve(reason);
      };
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reduce) remove();
      else setTimeout(remove, 220);
    };

    const closeAnnouncement = () => {
      if (!unlocked) return;
      markSeen(user, announcement);
      EventBus.emit('announcements:closed', { id: announcement.id });
      finish('closed');
    };

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeAnnouncement();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...card.querySelectorAll('button:not([disabled])')];
      if (!focusable.length) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === card)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    overlay.addEventListener('click', event => event.stopPropagation());
    closeBtn.addEventListener('click', closeAnnouncement);

    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        markSeen(user, announcement);
        EventBus.emit('announcements:action', { id: announcement.id, route: announcement.action_route });
        finish('action');
        if (window.router?.navigateTo) window.router.navigateTo(announcement.action_route);
      });
    }

    const unlock = () => {
      unlocked = true;
      closeBtn.disabled = false;
      closeBtn.classList.add('ann-close--ready');
      closeBtn.setAttribute('aria-label', 'إغلاق الإعلان');
      countText.remove();
    };
    tickTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(tickTimer);
        unlock();
        return;
      }
      countText.textContent = String(remaining);
      closeBtn.setAttribute('aria-label', `الإغلاق متاح بعد ${remaining} ثوانٍ`);
    }, 1000);
    overlay.style.setProperty('--ann-lock', `${CLOSE_LOCK_SECONDS}s`);

    document.body.appendChild(overlay);
    document.body.classList.add('ann-open');
    setBackgroundInert(true);
    document.addEventListener('keydown', onKeyDown, true);
    requestAnimationFrame(() => {
      overlay.classList.add('ann-overlay--visible');
      card.focus({ preventScroll: true });
    });
    EventBus.emit('announcements:shown', { id: announcement.id });
  });
}

// ==== 13. تشغيل الإعلانات ====
async function runAnnouncements() {
  if (running) return;
  running = true;
  try {
    const user = getCurrentUser();
    const all = await getActiveAnnouncements();
    const seen = readSeen(user);
    const queue = all.filter(a => matchesAudience(a, user) && !isSeen(seen, a));
    if (!queue.length) return;

    await new Promise(r => setTimeout(r, SHOW_DELAY_MS));
    if (!isHomeReady()) {
      shownThisLoad = false;
      return;
    }

    for (let i = 0; i < queue.length; i += 1) {
      const result = await showOne(queue[i], i + 1, queue.length, user);
      if (result === 'action') break;
    }
  } catch (err) {
    console.error('[Announcements] فشل عرض الإعلانات:', err);
  } finally {
    running = false;
  }
}

// ==== 14. فحص الجاهزية والبدء ====
function checkAndStart() {
  if (running || shownThisLoad) return;
  if (!isHomeReady()) return;
  shownThisLoad = true;
  runAnnouncements();
}

function scheduleCheck() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkAndStart, DEBOUNCE_MS);
}

// ==== 15. التهيئة ====
export function initAnnouncements() {
  if (initialized) return;
  initialized = true;

  const preloader = document.getElementById('app-preloader');
  const view = document.getElementById('app-router-view');
  const observer = new MutationObserver(scheduleCheck);
  if (preloader) observer.observe(preloader, { attributes: true, attributeFilter: ['data-preloader-state'] });
  if (view) observer.observe(view, { childList: true, attributes: true, attributeFilter: ['data-route'] });

  window.addEventListener('popstate', scheduleCheck);

  EventBus.on('userStateChanged', () => {
    shownThisLoad = false;
    scheduleCheck();
  });

  scheduleCheck();
}
