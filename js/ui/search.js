/* البحث المدمج في الشريط العلوي - v5.0.0 */

// ==== 1. الاستيراد ====
import { getCurrentUser } from '../core/session.js';
import { EventBus } from '../core/event-bus.js';
import { createAvatarElement, shouldShowVerificationBadge } from '../utils/avatar.js';

// ==== 2. الثوابت ====
const SEARCH_CONFIG = Object.freeze({
  debounceDelay: 350,
  minQueryLength: 2,
  maxResults: 20,
  skeletonCount: 3,
  highlightClass: 'search-highlight',
  avatarSize: 'sm',
  scrollCloseDistance: 24,
  scrollArmExtraMs: 150,
  fallbackAnimationMs: 250,
  mobileGutter: 5,
  mobileVerticalGutter: 15,
  desktopMinWidth: 240,
  desktopEdgeGap: 16
});

const MOBILE_QUERY = '(max-width: 767.98px)';

const SELECTORS = Object.freeze({
  wrap: '#navbar-search',
  triggerBtn: '#global-search-btn',
  panel: '#search-panel',
  input: '#search-input',
  results: '#search-results',
  closeBtn: '#close-search',
  navbarTopRight: '.navbar-top-right',
  navbarTop: '#navbar-top',
  navbarTopContent: '.navbar-top-content'
});

const USER_TYPE_LABELS = Object.freeze({ student: 'طالب', moderator: 'مشرف', teacher: 'معلم' });

const HL_CHAR_MAP = Object.freeze({ 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ئ': 'ي', 'ؤ': 'و', 'ة': 'ه' });
const HL_IGNORABLE = /[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\uFEFF]/;

// ==== 3. الحالة ====
const searchState = {
  initialized: false,
  isOpen: false,
  currentQuery: '',
  currentResults: [],
  debounceTimer: null,
  closeTimer: null,
  armScrollCloseTimer: null,
  scrollYAtOpen: 0,
  abortController: null,
  eventUnsubscribers: []
};

const dom = {
  wrap: null,
  triggerBtn: null,
  panel: null,
  input: null,
  resultsContainer: null,
  closeBtn: null,
  navbarTopRight: null,
  navbarTop: null,
  navbarTopContent: null
};

// ==== 4. دوال مساعدة ====
function escapeHtml(value) {
  if (!value) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
  if (window.modals?.toast) window.modals.toast(message, type);
}

function isSearchAllowed() {
  const user = getCurrentUser();
  return Boolean(user) && (user.user_type === 'teacher' || user.user_type === 'moderator');
}

function getUserTypeArabic(type) {
  return USER_TYPE_LABELS[type] || 'مستخدم';
}

function isMobileViewport() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getAnimationMs() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--navbar-duration').trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return SEARCH_CONFIG.fallbackAnimationMs;
  return raw.endsWith('ms') ? value : value * 1000;
}

function clearTimer(name) {
  if (!searchState[name]) return;
  clearTimeout(searchState[name]);
  searchState[name] = null;
}

function abortPendingRequest() {
  if (!searchState.abortController) return;
  searchState.abortController.abort();
  searchState.abortController = null;
}

// ==== 5. تمييز الكلمات المطابقة ====
function normalizeWithMap(input) {
  const source = String(input ?? '');
  const map = [];
  let text = '';

  for (let i = 0; i < source.length; i++) {
    let ch = source[i];
    if (HL_IGNORABLE.test(ch)) continue;

    const code = ch.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) ch = String(code - 0x0660);
    else if (code >= 0x06F0 && code <= 0x06F9) ch = String(code - 0x06F0);

    ch = HL_CHAR_MAP[ch] || ch;
    if (/\s/.test(ch)) ch = ' ';
    ch = ch.toLowerCase();

    for (let k = 0; k < ch.length; k++) {
      text += ch[k];
      map.push(i);
    }
  }

  return { text, map };
}

function findMatchIndex(normalized, needle) {
  let from = 0;

  while (from <= normalized.length - needle.length) {
    const found = normalized.indexOf(needle, from);
    if (found === -1) break;
    if (found === 0 || normalized[found - 1] === ' ' || normalized[found - 1] === '_') return found;
    from = found + 1;
  }

  return needle.length >= 3 ? normalized.indexOf(needle) : -1;
}

function highlightMatch(text, query) {
  const source = String(text ?? '');
  if (!source) return '';

  const normalizedQuery = normalizeWithMap(query).text.trim();
  if (!normalizedQuery) return escapeHtml(source);

  const { text: normalized, map } = normalizeWithMap(source);
  const ranges = [];

  normalizedQuery.split(' ').filter(Boolean).forEach((token) => {
    const candidates = [token];

    if (/^\+?\d+$/.test(token)) {
      const digits = token.replace(/^\+/, '');
      candidates.push(digits);
      if (digits.startsWith('0020')) candidates.push('0' + digits.slice(4));
      else if (digits.startsWith('20') && digits.length >= 11) candidates.push('0' + digits.slice(2));
    }

    for (const candidate of candidates) {
      const index = findMatchIndex(normalized, candidate);
      if (index === -1) continue;

      let end = map[index + candidate.length - 1] + 1;
      while (end < source.length && HL_IGNORABLE.test(source[end])) end++;
      ranges.push([map[index], end]);
      break;
    }
  });

  if (!ranges.length) return escapeHtml(source);

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  ranges.forEach((range) => {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  });

  let html = '';
  let cursor = 0;
  merged.forEach(([start, end]) => {
    html += escapeHtml(source.slice(cursor, start));
    html += `<mark class="${SEARCH_CONFIG.highlightClass}">${escapeHtml(source.slice(start, end))}</mark>`;
    cursor = end;
  });

  return html + escapeHtml(source.slice(cursor));
}

// ==== 6. هندسة صندوق البحث ====
function setPanelFixedRect(rect) {
  if (!dom.panel) return;
  dom.panel.style.setProperty('--search-fixed-top', `${rect.top}px`);
  dom.panel.style.setProperty('--search-fixed-left', `${rect.left}px`);
  dom.panel.style.setProperty('--search-fixed-width', `${rect.width}px`);
  dom.panel.style.setProperty('--search-fixed-height', `${rect.height}px`);
}

function getNavbarFullRect() {
  const reference = dom.navbarTopContent || dom.navbarTopRight || dom.wrap;
  const rect = reference.getBoundingClientRect();
  const { mobileGutter, mobileVerticalGutter } = SEARCH_CONFIG;

  return {
    top: rect.top + mobileVerticalGutter / 2,
    left: rect.left + mobileGutter,
    width: Math.max(0, rect.width - mobileGutter * 2),
    height: rect.height - mobileVerticalGutter
  };
}

function updateDesktopSearchWidth() {
  if (!dom.panel || !dom.triggerBtn) return;

  const buttonRect = dom.triggerBtn.getBoundingClientRect();
  const rowRect = getNavbarFullRect();
  const available = Math.max(
    SEARCH_CONFIG.desktopMinWidth,
    buttonRect.right - rowRect.left - SEARCH_CONFIG.desktopEdgeGap
  );

  dom.panel.style.setProperty('--search-max-width', `${available}px`);
}

function handleSearchViewportChange() {
  if (!searchState.isOpen) return;

  if (isMobileViewport()) setPanelFixedRect(getNavbarFullRect());
  else updateDesktopSearchWidth();
}

// ==== 7. طلبات البحث ====
let apiModulePromise = null;

function getApiModule() {
  if (!apiModulePromise) {
    apiModulePromise = import('../core/api.js').catch((error) => {
      apiModulePromise = null;
      throw error;
    });
  }
  return apiModulePromise;
}

function searchUsersAPI(searchQuery, signal) {
  const abortPromise = new Promise((_, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

  const request = getApiModule().then((api) => {
    if (typeof api.searchUsers !== 'function') throw new Error('searchUsers غير معرّفة في api.js');
    return api.searchUsers(searchQuery, { limit: SEARCH_CONFIG.maxResults, throwOnError: true });
  });

  return Promise.race([request, abortPromise]);
}

async function performSearch(query) {
  const trimmed = (query || '').trim();

  if (trimmed.length < SEARCH_CONFIG.minQueryLength) {
    searchState.currentResults = [];
    renderResults([]);
    return;
  }

  searchState.currentQuery = trimmed;

  if (searchState.abortController) searchState.abortController.abort();
  searchState.abortController = new AbortController();
  const { signal } = searchState.abortController;

  renderSkeleton();

  try {
    const results = await searchUsersAPI(trimmed, signal);
    if (signal.aborted) return;

    searchState.currentResults = (results || []).slice(0, SEARCH_CONFIG.maxResults);
    renderResults(searchState.currentResults);
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('❌ فشل البحث:', error);
    showToast('حدث خطأ أثناء البحث', 'error');
    renderError();
  }
}

// ==== 8. عرض النتائج ====
function renderSkeleton() {
  if (!dom.resultsContainer) return;

  const item = `
    <div class="search-result-item search-result-item--skeleton" aria-hidden="true">
      <div class="result-avatar skeleton-rect"></div>
      <div class="result-info">
        <div class="skeleton-text"></div>
        <div class="skeleton-text"></div>
      </div>
    </div>
  `;

  dom.resultsContainer.innerHTML = item.repeat(SEARCH_CONFIG.skeletonCount);
}

function renderError() {
  if (!dom.resultsContainer) return;

  const offline = navigator.onLine === false;
  dom.resultsContainer.innerHTML = `
    <div class="search-error">
      <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
      <p>${offline ? 'لا يوجد اتصال بالإنترنت' : 'حدث خطأ، حاول مرة أخرى'}</p>
    </div>
  `;
}

function buildResultItem(user) {
  const query = searchState.currentQuery;
  const userId = escapeHtml(user.id);
  const userType = escapeHtml(user.user_type);

  let showBadge = false;
  try { showBadge = shouldShowVerificationBadge(user); } catch (_) { showBadge = false; }

  return `
    <div class="search-result-item" data-user-id="${userId}" data-user-type="${userType}" role="option" tabindex="0">
      <div class="result-avatar"></div>
      <div class="result-info">
        <div class="result-name">
          ${highlightMatch(user.full_name || user.username, query)}
          ${showBadge ? '<i class="fas fa-check-circle verified-badge" aria-hidden="true"></i>' : ''}
          <span class="result-badge role-badge-${userType}">${getUserTypeArabic(user.user_type)}</span>
        </div>
        <div class="result-details">
          <span class="result-username"><i class="fas fa-at" aria-hidden="true"></i> ${highlightMatch(user.username, query)}</span>
          <span class="result-phone"><i class="fas fa-phone" aria-hidden="true"></i> ${highlightMatch(user.phone, query)}</span>
        </div>
      </div>
      <div class="result-actions">
        <button type="button" class="result-view-btn" data-user-id="${userId}" data-user-type="${userType}" aria-label="عرض الملف الشخصي">
          <i class="fas fa-eye" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `;
}

function mountResultAvatars(users) {
  const items = dom.resultsContainer.querySelectorAll('.search-result-item');

  users.forEach((user, index) => {
    const container = items[index]?.querySelector('.result-avatar');
    if (!container) return;

    try {
      container.appendChild(createAvatarElement(user, SEARCH_CONFIG.avatarSize, {
        showFrame: true,
        showBadge: true,
        clickable: false,
        showShimmer: false,
        showPulse: false
      }));
    } catch (error) {
      console.warn('⚠️ فشل إنشاء الصورة الرمزية:', user.id, error);
      const fallback = document.createElement('div');
      fallback.className = 'avatar-fallback';
      fallback.textContent = user.full_name?.[0] || '?';
      container.replaceChildren(fallback);
    }
  });
}

function renderResults(users) {
  if (!dom.resultsContainer) return;

  if (!users || users.length === 0) {
    dom.resultsContainer.innerHTML = searchState.currentQuery ? `
      <div class="search-empty">
        <i class="fas fa-user-slash" aria-hidden="true"></i>
        <p>لا توجد نتائج مطابقة</p>
        <small>جرب اسم أو رقم هاتف آخر</small>
      </div>
    ` : '';
    return;
  }

  dom.resultsContainer.innerHTML = users.map(buildResultItem).join('');
  mountResultAvatars(users);
}

function openUserProfile(userId) {
  if (!userId) return;
  closeSearch();

  const currentUser = getCurrentUser();
  if (!currentUser) {
    showToast('يجب تسجيل الدخول أولاً', 'warning');
    return;
  }

  const canEdit = currentUser.user_type === 'teacher' || currentUser.user_type === 'moderator';
  const shouldEdit = canEdit && String(userId) !== String(currentUser.id);

  if (window.router?.navigateTo) {
    const params = { query: { id: userId } };
    if (shouldEdit) params.query.edit = 'true';
    window.router.navigateTo('profile', params);
    return;
  }

  window.location.href = `/profile?id=${encodeURIComponent(userId)}${shouldEdit ? '&edit=true' : ''}`;
}

// ==== 9. فتح وإغلاق الصندوق ====
function openSearch(prefillQuery = '') {
  if (!isSearchAllowed()) {
    showToast('البحث متاح للمعلمين والمشرفين فقط', 'warning');
    return;
  }
  if (!dom.wrap || !dom.panel || !dom.input) {
    console.error('❌ عناصر البحث غير موجودة في index.html');
    return;
  }
  if (searchState.isOpen) return;

  clearTimer('closeTimer');

  const mobile = isMobileViewport();
  const animationMs = getAnimationMs();

  if (mobile && dom.triggerBtn) setPanelFixedRect(dom.triggerBtn.getBoundingClientRect());

  searchState.isOpen = true;
  dom.wrap.classList.add('is-open');
  dom.navbarTopRight?.classList.add('search-open');
  dom.panel.setAttribute('aria-hidden', 'false');
  dom.triggerBtn?.setAttribute('aria-expanded', 'true');
  dom.input.removeAttribute('tabindex');
  dom.closeBtn?.removeAttribute('tabindex');

  if (mobile) {
    dom.navbarTop?.classList.add('search-active');
    void dom.panel.offsetWidth;
    requestAnimationFrame(() => setPanelFixedRect(getNavbarFullRect()));
  } else {
    updateDesktopSearchWidth();
  }

  window.addEventListener('resize', handleSearchViewportChange);
  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('click', handleOutsideClick, true);

  setTimeout(() => {
    if (!searchState.isOpen) return;
    dom.input.focus();
    if (prefillQuery) {
      dom.input.value = prefillQuery;
      performSearch(prefillQuery);
    }
  }, animationMs);

  clearTimer('armScrollCloseTimer');
  searchState.armScrollCloseTimer = setTimeout(() => {
    searchState.scrollYAtOpen = window.scrollY;
    window.addEventListener('scroll', handleScrollClose, { passive: true });
  }, animationMs + SEARCH_CONFIG.scrollArmExtraMs);
}

function closeSearch(restoreFocus = false) {
  if (!dom.wrap || !searchState.isOpen) return;

  abortPendingRequest();

  if (isMobileViewport() && dom.triggerBtn) setPanelFixedRect(dom.triggerBtn.getBoundingClientRect());

  searchState.isOpen = false;
  dom.wrap.classList.remove('is-open');
  dom.navbarTopRight?.classList.remove('search-open');
  dom.navbarTop?.classList.remove('search-active');
  dom.panel?.setAttribute('aria-hidden', 'true');
  dom.triggerBtn?.setAttribute('aria-expanded', 'false');
  dom.input?.setAttribute('tabindex', '-1');
  dom.closeBtn?.setAttribute('tabindex', '-1');
  dom.input?.blur();

  window.removeEventListener('resize', handleSearchViewportChange);
  window.removeEventListener('scroll', handleScrollClose);
  document.removeEventListener('keydown', handleKeydown);
  document.removeEventListener('click', handleOutsideClick, true);
  clearTimer('armScrollCloseTimer');

  searchState.closeTimer = setTimeout(() => {
    if (dom.input) dom.input.value = '';
    if (dom.resultsContainer) dom.resultsContainer.innerHTML = '';
    searchState.currentQuery = '';
    searchState.currentResults = [];
    searchState.closeTimer = null;
  }, getAnimationMs());

  if (restoreFocus === true) dom.triggerBtn?.focus({ preventScroll: true });
}

// ==== 10. المعالجات ====
function handleScrollClose() {
  if (Math.abs(window.scrollY - searchState.scrollYAtOpen) < SEARCH_CONFIG.scrollCloseDistance) return;
  closeSearch();
}

function handleKeydown(event) {
  if (event.key !== 'Escape' || !searchState.isOpen) return;
  event.preventDefault();
  closeSearch(true);
}

function handleOutsideClick(event) {
  if (!searchState.isOpen || !dom.wrap) return;
  if (!dom.wrap.contains(event.target)) closeSearch();
}

function handleCloseClick(event) {
  closeSearch(event.detail === 0);
}

function handleTriggerClick() {
  openSearch();
}

function handleInput(event) {
  const raw = event.target.value;

  clearTimer('debounceTimer');

  if (raw.trim().length < SEARCH_CONFIG.minQueryLength) {
    abortPendingRequest();
    searchState.currentQuery = '';
    searchState.currentResults = [];
    if (dom.resultsContainer) renderResults([]);
    return;
  }

  searchState.debounceTimer = setTimeout(() => performSearch(raw), SEARCH_CONFIG.debounceDelay);
}

function handleInputKeydown(event) {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  clearTimer('debounceTimer');
  performSearch(dom.input.value);
}

function handleResultsClick(event) {
  const item = event.target.closest('.search-result-item[data-user-id]');
  if (item) openUserProfile(item.dataset.userId);
}

function handleResultsKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;

  const item = event.target.closest('.search-result-item[data-user-id]');
  if (!item || event.target !== item) return;

  event.preventDefault();
  openUserProfile(item.dataset.userId);
}

// ==== 11. ربط العناصر والأحداث ====
function bindSearchElements() {
  const $ = (selector) => document.querySelector(selector);

  dom.wrap = $(SELECTORS.wrap);
  dom.triggerBtn = $(SELECTORS.triggerBtn);
  dom.panel = $(SELECTORS.panel);
  dom.input = $(SELECTORS.input);
  dom.resultsContainer = $(SELECTORS.results);
  dom.closeBtn = $(SELECTORS.closeBtn);
  dom.navbarTopRight = $(SELECTORS.navbarTopRight);
  dom.navbarTop = $(SELECTORS.navbarTop);
  dom.navbarTopContent = $(SELECTORS.navbarTopContent);

  if (!dom.wrap || !dom.panel || !dom.input || !dom.resultsContainer || !dom.closeBtn) {
    console.error('❌ هيكل البحث ناقص في index.html');
    return false;
  }

  dom.input.addEventListener('input', handleInput);
  dom.input.addEventListener('keydown', handleInputKeydown);
  dom.closeBtn.addEventListener('click', handleCloseClick);
  dom.resultsContainer.addEventListener('click', handleResultsClick);
  dom.resultsContainer.addEventListener('keydown', handleResultsKeydown);
  dom.triggerBtn?.addEventListener('click', handleTriggerClick);

  return true;
}

function unbindSearchElements() {
  dom.input?.removeEventListener('input', handleInput);
  dom.input?.removeEventListener('keydown', handleInputKeydown);
  dom.closeBtn?.removeEventListener('click', handleCloseClick);
  dom.resultsContainer?.removeEventListener('click', handleResultsClick);
  dom.resultsContainer?.removeEventListener('keydown', handleResultsKeydown);
  dom.triggerBtn?.removeEventListener('click', handleTriggerClick);
}

function subscribeToEvents() {
  searchState.eventUnsubscribers = [
    EventBus.on('openSearch', (detail) => openSearch(detail?.query || '')),
    EventBus.on('userStateChanged', () => {
      if (searchState.isOpen && !isSearchAllowed()) closeSearch();
    }),
    EventBus.on('pageChanged', () => {
      if (searchState.isOpen) closeSearch();
    })
  ];
}

function unsubscribeFromEvents() {
  searchState.eventUnsubscribers.forEach((unsubscribe) => {
    if (typeof unsubscribe === 'function') unsubscribe();
  });
  searchState.eventUnsubscribers = [];
}

// ==== 12. التهيئة والتنظيف ====
export function initializeSearch() {
  if (searchState.initialized) return true;

  try {
    if (!bindSearchElements()) return false;

    subscribeToEvents();

    window.searchAPI = {
      open: openSearch,
      close: () => closeSearch(),
      isOpen: () => searchState.isOpen,
      search: performSearch
    };

    searchState.initialized = true;
    return true;
  } catch (error) {
    console.error('❌ فشل تهيئة البحث:', error);
    return false;
  }
}

export function destroySearch() {
  unbindSearchElements();

  document.removeEventListener('keydown', handleKeydown);
  document.removeEventListener('click', handleOutsideClick, true);
  window.removeEventListener('scroll', handleScrollClose);
  window.removeEventListener('resize', handleSearchViewportChange);

  unsubscribeFromEvents();
  clearTimer('debounceTimer');
  clearTimer('closeTimer');
  clearTimer('armScrollCloseTimer');
  abortPendingRequest();

  searchState.isOpen = false;
  dom.wrap?.classList.remove('is-open');
  dom.navbarTopRight?.classList.remove('search-open');
  dom.navbarTop?.classList.remove('search-active');

  searchState.initialized = false;
  delete window.searchAPI;
}

export default {
  initialize: initializeSearch,
  destroy: destroySearch,
  open: openSearch,
  close: () => closeSearch(),
  isOpen: () => searchState.isOpen
};
