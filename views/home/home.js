/* الصفحة الرئيسية - v5.0.0 */

// ==== 1. استيراد التبعيات ====
import {
  getPlatformStats,
  getTopStudents,
  getComments,
  getPinnedComment,
  getRootCommentsCount,
  getCommentReplies,
  addComment,
  updateComment,
  softDeleteComment,
  pinComment,
  toggleCommentLike,
  canEditComment,
  getLessonById,
  updateUserPreferences,
  getAllLessons,
  getUserProgress,
  getUserExamStats,
  getModeratorsList,
  getPendingComplaintsCount,
  getActiveSemesterFor
} from '../../js/core/api.js';
import { EventBus } from '../../js/core/event-bus.js';
import { getCurrentUser, isAuthenticated, isTeacher, isModerator } from '../../js/core/session.js';
import { showDirectingMessage } from '../../js/ui/directing.js';
import { getCurrentRoute } from '../../js/core/router.js';
import {
  createAvatarElement,
  updateAvatarElement,
  getFrameClass,
  shouldShowVerificationBadge
} from '../../js/utils/avatar.js';

// ==== 2. الثوابت والتكوين ====

const ROLE_KEYS = {
  GUEST: 'guest',
  STUDENT: 'student',
  MODERATOR: 'moderator',
  TEACHER: 'teacher'
};

const ROLE_GATE_VISIBILITY = {
  [ROLE_KEYS.GUEST]: ['guest'],
  [ROLE_KEYS.STUDENT]: ['student', 'member'],
  [ROLE_KEYS.MODERATOR]: ['moderator', 'member', 'staff'],
  [ROLE_KEYS.TEACHER]: ['teacher', 'member', 'staff']
};

const HOME_CONFIG = {
  SELECTORS: {
    STATS: '[data-stat]',
    STAFF_STATS: '[data-staff-stat]',
    STUDENT_STATS: '[data-student-stat]',
    CHAMPIONS_GRID: '.champions-grid',
    REVEAL_ITEMS: '.reveal',
    TESTIMONIALS_SECTION: '.testimonials-section',
    TESTIMONIALS_CONTAINER: '.testimonials-container',
    RECOMMENDED_GRID: '#home-recommended',
    RECOMMENDED_TITLE_TEXT: '#recommended-title-text',
    USER_STREAK_BADGE: '#user-streak-badge',
    MEMBER_AVATAR: '#home-member-avatar',
    MEMBER_NAME: '#home-member-name',
    MEMBER_GREETING: '#home-member-greeting',
    MEMBER_ROLE_PILL: '#home-member-role-pill',
    MEMBER_SUBTITLE: '#home-member-subtitle',
    CONTINUE_LEARNING: '#home-continue-learning',
    WELCOME_BTN_START: '[data-action="start-learning"]',
    WELCOME_BTN_EXPLORE: '[data-action="explore-lessons"]',
    WELCOME_BTN_EXAMS: '[data-action="explore-exams"]',
    WELCOME_BTN_DASHBOARD: '[data-action="goto-dashboard"]',
    WELCOME_BTN_GROUPS: '[data-action="goto-groups"]',
    ADD_TESTIMONIAL_BTN: '[data-action="add-testimonial"]',
    VIEW_ALL_CHAMPIONS_BTN: '[data-action="view-all-champions"]',
    CAROUSEL_PREV: '.carousel-prev',
    CAROUSEL_NEXT: '.carousel-next',
    ABOUT_CAROUSEL: '#about-carousel',
    FEATURES_CAROUSEL: '#featuresCarousel',
    FEATURES_SECTION: '.features-section'
  },
  DEFAULTS: {
    STATS: { students: 0, lessons: 0, exams: 0 },
    CHAMPIONS_LIMIT: 6,
    TESTIMONIALS_LIMIT: 10,
    RECOMMENDED_LIMIT: 4,
    CAROUSEL_INTERVAL: 5000,
    CACHE_TTL: 5 * 60 * 1000,
    STREAK_CACHE_KEY: 'biologist_streak_data',
    MAX_MODERATORS: 5
  },
  FEATURES_CAROUSEL: {
    HOLD_MS: 3400,
    TRANSITION_MS: 900,
    SWIPE_THRESHOLD_PX: 50,
    SWIPE_VELOCITY: 0.5
  },
  CACHE_KEYS: {
    STATS: 'home_stats_cache',
    CHAMPIONS: 'home_champions_cache',
    TESTIMONIALS: 'home_testimonials_cache',
    RECOMMENDED: 'home_recommended_cache'
  },
  COMMENTS: {
    PER_PAGE: 5,
    LOAD_MORE_STEP: 10,
    REPLIES_PER_PAGE: 5,
    MAX_LENGTH: 500,
    EDIT_TIMEOUT_MINUTES: 5,
    BANNED_WORDS: ['سباب', 'شتيمة', 'بذيء']
  }
};

// ==== 3. الحالة الداخلية ====
let $homeState = {
  isInitialized: false,
  container: null,
  roleKey: ROLE_KEYS.GUEST,
  isLoading: {
    stats: false,
    champions: false,
    testimonials: false,
    recommended: false,
    studentPanel: false,
    staffPanel: false
  },
  cache: {
    stats: null,
    champions: null,
    testimonials: null,
    recommended: null
  },
  carousels: {
    about: null,
    features: null
  },
  intervals: {
    about: null,
    features: null
  },
  cleanupFns: [],
  eventUnsubscribers: [],
  revealObserver: null,
  currentUser: null,
  comments: {
    list: [],
    total: null,
    sort: 'newest',
    lastDoc: null,
    hasMore: false,
    isLoading: false,
    selectedId: null,
    repliesCache: new Map(),
    expandedReplies: new Set(),
    elements: {
      section: null,
      list: null,
      textarea: null,
      counter: null,
      submitBtn: null,
      cancelReplyBtn: null,
      loadMoreBtn: null,
      sortSelect: null,
      replyParentId: null
    },
    boundHandlers: new Map()
  }
};

// ==== 4. دوال مساعدة عامة ====
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function formatNumber(num) {
  if (num === undefined || num === null) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
  if (window.modals?.toast) {
    window.modals.toast(message, type);
  } else {
  }
}

function markLoaded(el) {
  if (el) el.removeAttribute('aria-busy');
}

function getCachedData(key, ttl = HOME_CONFIG.DEFAULTS.CACHE_TTL) {
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return null;
    const { data, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp > ttl) {
      localStorage.removeItem(key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function setCachedData(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
  } catch (e) {
    console.warn('⚠️ فشل تخزين البيانات في cache', e);
  }
}

// ==== 5. بوابات الأدوار ====

function resolveUserRole(user) {
  if (!user) return ROLE_KEYS.GUEST;
  if (isTeacher(user)) return ROLE_KEYS.TEACHER;
  if (isModerator(user)) return ROLE_KEYS.MODERATOR;
  return ROLE_KEYS.STUDENT;
}

function applyRoleGates(container, roleKey) {
  if (!container) return;
  const activeKeys = new Set(ROLE_GATE_VISIBILITY[roleKey] || ROLE_GATE_VISIBILITY[ROLE_KEYS.GUEST]);
  container.setAttribute('data-role', roleKey);
  container.querySelectorAll('[data-role-gate]').forEach(el => {
    const keys = el.getAttribute('data-role-gate').split(/\s+/).filter(Boolean);
    const shouldShow = keys.some(k => activeKeys.has(k));
    el.classList.toggle('is-visible', shouldShow);
  });
}

function getRolePillLabel(roleKey) {
  const labels = {
    [ROLE_KEYS.STUDENT]: 'طالب',
    [ROLE_KEYS.MODERATOR]: 'مشرف',
    [ROLE_KEYS.TEACHER]: 'معلم'
  };
  return labels[roleKey] || '';
}

function getMemberSubtitle(roleKey) {
  const subtitles = {
    [ROLE_KEYS.STUDENT]: 'استمر في رحلتك التعليمية اليوم 🌱',
    [ROLE_KEYS.MODERATOR]: 'نتمنى لك يوم إشراف موفّق',
    [ROLE_KEYS.TEACHER]: 'نظرة سريعة على منصتك قبل البدء'
  };
  return subtitles[roleKey] || '';
}

function getGreetingByHour(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'صباح الخير ☀️';
  if (hour >= 12 && hour < 18) return 'مساء النور 🌤️';
  return 'مساء الخير 🌙';
}

function renderMemberHeader(container, user, roleKey) {
  if (roleKey === ROLE_KEYS.GUEST || !user) return;

  const avatarContainer = container.querySelector(HOME_CONFIG.SELECTORS.MEMBER_AVATAR);
  if (avatarContainer) {
    const avatarEl = createAvatarElement(user, 'lg', {
      showFrame: true,
      showBadge: shouldShowVerificationBadge(user),
      clickable: false,
      showPulse: false,
      showShimmer: false
    });
    avatarContainer.innerHTML = '';
    avatarContainer.appendChild(avatarEl);
  }

  const greetingEl = container.querySelector(HOME_CONFIG.SELECTORS.MEMBER_GREETING);
  if (greetingEl) greetingEl.textContent = getGreetingByHour();

  const nameEl = container.querySelector(HOME_CONFIG.SELECTORS.MEMBER_NAME);
  if (nameEl) nameEl.textContent = user.full_name || user.username || 'مستخدم بيولوجست';

  const pillEl = container.querySelector(HOME_CONFIG.SELECTORS.MEMBER_ROLE_PILL);
  if (pillEl) {
    pillEl.textContent = getRolePillLabel(roleKey);
    pillEl.className = `role-pill role-pill--${roleKey}`;
  }

  const subtitleEl = container.querySelector(HOME_CONFIG.SELECTORS.MEMBER_SUBTITLE);
  if (subtitleEl) subtitleEl.textContent = getMemberSubtitle(roleKey);
}

// ==== 6. دوال مساعدة للتعليقات ====

function formatCommentDate(timestamp) {
  if (!timestamp) return '';
  let date;
  if (timestamp?.toDate) date = timestamp.toDate();
  else if (timestamp?.seconds) date = new Date(timestamp.seconds * 1000);
  else date = new Date(timestamp);
  if (isNaN(date)) return '';
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'الآن';
  if (diffMins < 60) return `منذ ${diffMins} دقيقة`;
  if (diffHours < 24) return `منذ ${diffHours} ساعة`;
  if (diffDays < 7) return `منذ ${diffDays} يوم`;
  return date.toLocaleDateString('ar-EG');
}

function getCommentDateObj(timestamp) {
  if (!timestamp) return null;
  let date;
  if (timestamp?.toDate) date = timestamp.toDate();
  else if (timestamp?.seconds) date = new Date(timestamp.seconds * 1000);
  else date = new Date(timestamp);
  return isNaN(date) ? null : date;
}

function formatCommentFullDate(timestamp) {
  const date = getCommentDateObj(timestamp);
  return date ? date.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function getUserTypeLabel(type) {
  const reverseMap = { 'طالب': 'طالب', 'معلم': 'معلم', 'مشرف': 'مشرف' };
  if (reverseMap[type]) return reverseMap[type];
  
  const map = { student: 'طالب', teacher: 'معلم', moderator: 'مشرف' };
  return map[type] || 'مستخدم';
}

function containsBannedContent(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return HOME_CONFIG.COMMENTS.BANNED_WORDS.some(w => lower.includes(w));
}

function updateCommentsCountDisplay() {
  const cs = $homeState.comments;
  const countEl = cs.elements.section?.querySelector('.testimonials-count');
  if (countEl) {
    countEl.textContent = cs.total ?? cs.list.length;
  }
}

function updateLoadMoreUI() {
  const cs = $homeState.comments;
  const btn = cs.elements.loadMoreBtn;
  if (!btn) return;

  const wrap = btn.parentElement;
  if (wrap) wrap.hidden = !cs.hasMore;

  const loaded = cs.list.filter(c => !c.pinned).length;
  const pinnedCount = cs.list.length - loaded;
  const remaining = cs.total == null ? null : Math.max(cs.total - pinnedCount - loaded, 0);

  const label = btn.querySelector('.load-more-label');
  if (label) {
    label.textContent = remaining
      ? `عرض المزيد من التعليقات (${remaining})`
      : 'عرض المزيد من التعليقات';
  }
}

// ==== 7. دوال تحديث واجهة المستخدم ====

function updateStats(stats) {
  const statElements = $homeState.container.querySelectorAll(HOME_CONFIG.SELECTORS.STATS);
  if (!statElements.length) return;

  const targets = {
    students: stats.students || 0,
    lessons: stats.lessons || 0,
    exams: stats.exams || 0
  };

  statElements.forEach(el => {
    const statName = el.getAttribute('data-stat');
    if (statName && targets[statName] !== undefined) {
      const target = targets[statName];
      if (prefersReducedMotion()) {
        el.textContent = formatNumber(target);
        return;
      }
      const duration = 800;
      const stepTime = 20;
      const steps = duration / stepTime;
      const increment = target / steps;
      let current = 0;
      clearInterval(el._counterTimer);
      const timer = setInterval(() => {
        current += increment;
        if (!el.isConnected || current >= target) {
          el.textContent = formatNumber(target);
          clearInterval(timer);
        } else {
          el.textContent = formatNumber(Math.floor(current));
        }
      }, stepTime);
      el._counterTimer = timer;
    }
  });
}

function updateStaffKpis(stats) {
  const kpiElements = $homeState.container.querySelectorAll(HOME_CONFIG.SELECTORS.STAFF_STATS);
  if (!kpiElements.length) return;

  const targets = {
    students: stats.students || 0,
    lessons: stats.lessons || 0,
    exams: stats.exams || 0,
    comments: stats.comments || 0
  };

  kpiElements.forEach(el => {
    const statName = el.getAttribute('data-staff-stat');
    if (statName && targets[statName] !== undefined) {
      el.textContent = formatNumber(targets[statName]);
    }
  });
}

function updateChampionsGrid(students) {
  const grid = $homeState.container.querySelector(HOME_CONFIG.SELECTORS.CHAMPIONS_GRID);
  if (!grid) return;

  if (!students || students.length === 0) {
    grid.innerHTML = `<div class="empty-state"><i class="fas fa-trophy empty-icon"></i><h3>لا يوجد أبطال بعد</h3><p>كن أول من يحقق إنجازاً!</p></div>`;
    return;
  }

  const championsHtml = students.map((student, index) => {
    const rank = index + 1;
    let rankClass = '';
    if (rank === 1) rankClass = 'first-place';
    else if (rank === 2) rankClass = 'second-place';
    else if (rank === 3) rankClass = 'third-place';

    const avatarUrl = student.avatar_url || (student.gender === 'female' ? 'assets/images/G.png' : 'assets/images/M.png');
    const badgesHtml = (student.badges || []).slice(0, 2).map(badge => `<span class="badge-item">${escapeHtml(badge)}</span>`).join('');

    return `
      <div class="champion-card ${rankClass}" data-user-id="${student.id}">
        <div class="champion-rank">
          <span class="rank-icon">${rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank}</span>
        </div>
        <div class="champion-avatar">
          <img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(student.full_name)}" class="avatar-image" loading="lazy">
        </div>
        <div class="champion-info">
          <h3 class="champion-name">${escapeHtml(student.full_name)}</h3>
          <div class="champion-score">
            <i class="fas fa-star score-icon"></i>
            <span>${student.total_score || 0} نقطة</span>
          </div>
          <div class="champion-badges">${badgesHtml}</div>
        </div>
      </div>
    `;
  }).join('');

  grid.innerHTML = championsHtml;

  grid.querySelectorAll('.champion-card').forEach(card => {
    card.addEventListener('click', () => {
      const userId = card.dataset.userId;
      if (userId && window.router?.navigateTo) {
        window.router.navigateTo('profile', { path: { id: userId } });
      }
    });
  });
}

function updateRecommendedLessons(lessons) {
  const grid = $homeState.container.querySelector(HOME_CONFIG.SELECTORS.RECOMMENDED_GRID);
  if (!grid) return;

  if (!lessons || lessons.length === 0) {
    grid.innerHTML = `<div class="empty-state"><i class="fas fa-book-open empty-icon"></i><h3>لا توجد دروس مقترحة</h3><p>قم بزيارة قسم الدروس لبدء التعلم</p></div>`;
    return;
  }

  const lessonsHtml = lessons.map(lesson => `
    <div class="recommended-card" data-lesson-id="${lesson.id}">
      <div class="recommended-image">
        <img src="${escapeHtml(lesson.cover_image_url || 'assets/images/biologist1.png')}" alt="${escapeHtml(lesson.title)}" loading="lazy">
      </div>
      <div class="recommended-info">
        <h3 class="recommended-title">${escapeHtml(lesson.title)}</h3>
        <p class="recommended-description">${escapeHtml(lesson.description || '')}</p>
        <button class="btn btn-sm btn-primary view-lesson-btn" data-lesson-id="${lesson.id}"><i class="fas fa-play"></i> مشاهدة</button>
      </div>
    </div>
  `).join('');

  grid.innerHTML = lessonsHtml;

  grid.querySelectorAll('.view-lesson-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lessonId = btn.dataset.lessonId;
      if (lessonId && window.router?.navigateTo) {
        window.router.navigateTo('lesson-view', { path: { id: lessonId } });
      }
    });
  });
}

function updateUserStreak(user) {
  const badge = $homeState.container.querySelector(HOME_CONFIG.SELECTORS.USER_STREAK_BADGE);
  if (!badge) return;

  const hasStreak = !!(user && user.user_type === 'student' && user.streak && user.streak > 0);
  badge.classList.toggle('is-active', hasStreak);
  if (hasStreak) {
    badge.innerHTML = `<i class="fas fa-fire" aria-hidden="true"></i> ${user.streak} يوم متواصل 🔥`;
  }
}

// ==== 8. آراء الطلاب ====

function buildTestimonialsUI() {
  const section = $homeState.container.querySelector(HOME_CONFIG.SELECTORS.TESTIMONIALS_SECTION);
  if (!section) return;

  const user = getCurrentUser();
  const isAuth = isAuthenticated();
  const canModerate = isTeacher() || isModerator();
  const cfg = HOME_CONFIG.COMMENTS;
  const cs = $homeState.comments;

  const addFormHtml = isAuth
    ? `
      <div class="testimonials-add-form">
        <div class="add-form-avatar" id="home-comment-author-avatar"></div>
        <div class="add-form-input-wrap">
          <textarea id="home-comment-textarea" rows="2" maxlength="${cfg.MAX_LENGTH}"
                    placeholder="اكتب تعليقك هنا..." aria-label="اكتب تعليقك"></textarea>
          <div class="add-form-actions">
            <span class="add-form-counter" id="home-comment-counter" aria-live="polite">0 / ${cfg.MAX_LENGTH}</span>
            <button class="comment-submit-btn" id="home-comment-submit-btn" type="button">
              <i class="fas fa-paper-plane"></i> إرسال
            </button>
          </div>
        </div>
      </div>
    `
    : `
      <div class="testimonials-login-prompt">
        <i class="fas fa-comment-dots"></i>
        <p>سجّل دخولك لمشاركة رأيك مع المجتمع</p>
        <button class="btn btn-primary btn-sm" data-nav-target="login" type="button">
          <i class="fas fa-sign-in-alt"></i> تسجيل الدخول
        </button>
      </div>
    `;

  const container = section.querySelector(HOME_CONFIG.SELECTORS.TESTIMONIALS_CONTAINER)
    || section.querySelector('.testimonials-inner')
    || section;

  container.innerHTML = `
    ${canModerate ? `
    <div class="testimonials-header">
      <span class="mod-badge"><i class="fas fa-shield-alt"></i> وضع الإشراف</span>
    </div>` : ''}

    ${addFormHtml}

    <div class="testimonials-list-bar">
      <span class="testimonials-count-wrap">
        <i class="fas fa-comment-dots" aria-hidden="true"></i>
        إجمالي التعليقات: <span class="testimonials-count">0</span>
      </span>
      <label class="testimonials-sort">
        <i class="fas fa-sort-amount-down" aria-hidden="true"></i>
        <select id="home-testimonials-sort" aria-label="ترتيب التعليقات">
          <option value="newest">الأحدث</option>
          <option value="oldest">الأقدم</option>
        </select>
      </label>
    </div>

    <div class="testimonials-list" id="home-testimonials-list">
      <div class="testimonials-loading">
        <div class="spinner"></div>
        <p>جاري تحميل الآراء...</p>
      </div>
    </div>

    <div class="testimonials-load-more" id="home-testimonials-load-more" hidden>
      <button class="btn btn-outline load-more-testimonials" type="button">
        <i class="fas fa-chevron-down"></i>
        <span class="load-more-label">عرض المزيد من التعليقات</span>
      </button>
    </div>
  `;

  const els = cs.elements;
  els.section        = container;
  els.list           = container.querySelector('#home-testimonials-list');
  els.textarea       = container.querySelector('#home-comment-textarea');
  els.counter        = container.querySelector('#home-comment-counter');
  els.submitBtn      = container.querySelector('#home-comment-submit-btn');
  els.cancelReplyBtn = null;
  els.loadMoreBtn    = container.querySelector('.load-more-testimonials');
  els.sortSelect     = container.querySelector('#home-testimonials-sort');

  if (els.sortSelect) els.sortSelect.value = cs.sort;

  if (isAuth && user) {
    const authorAvatarContainer = container.querySelector('#home-comment-author-avatar');
    if (authorAvatarContainer) {
      const avatarEl = createAvatarElement(user, 'sm', {
        showFrame:   true,
        showBadge:   false,
        clickable:   false,
        showPulse:   false,
        showShimmer: false
      });
      authorAvatarContainer.innerHTML = '';
      authorAvatarContainer.appendChild(avatarEl);
    }
  }

  if (els.submitBtn) {
    const boundSubmit = handleAddTestimonialComment.bind(null);
    els.submitBtn.addEventListener('click', boundSubmit);
    cs.boundHandlers.set('submit', boundSubmit);
  }

  if (els.textarea && els.counter) {
    const boundInput = () => {
      els.counter.textContent = `${els.textarea.value.length} / ${cfg.MAX_LENGTH}`;
    };
    els.textarea.addEventListener('input', boundInput);
    cs.boundHandlers.set('input', boundInput);
  }

  if (els.loadMoreBtn) {
    const boundLoadMore = () => loadTestimonialsComments(true);
    els.loadMoreBtn.addEventListener('click', boundLoadMore);
    cs.boundHandlers.set('loadMore', boundLoadMore);
  }

  if (els.sortSelect) {
    const boundSort = () => {
      cs.sort = els.sortSelect.value === 'oldest' ? 'oldest' : 'newest';
      loadTestimonialsComments(false);
    };
    els.sortSelect.addEventListener('change', boundSort);
    cs.boundHandlers.set('sort', boundSort);
  }

  const loginPromptBtn = container.querySelector('[data-nav-target="login"]');
  if (loginPromptBtn) {
    loginPromptBtn.addEventListener('click', () => {
      if (window.router?.navigateTo) window.router.navigateTo('login');
    });
  }
}

async function loadTestimonialsComments(append = false) {
  const cs = $homeState.comments;
  if (cs.isLoading) return;

  const listEl = cs.elements.list;
  if (!listEl) return;

  cs.isLoading = true;
  if (cs.elements.loadMoreBtn) cs.elements.loadMoreBtn.disabled = true;

  if (!append) {
    listEl.innerHTML = `
      <div class="testimonials-loading">
        <div class="spinner"></div>
        <p>جاري تحميل الآراء...</p>
      </div>`;
  }

  try {
    const cfg = HOME_CONFIG.COMMENTS;
    const limit = append ? cfg.LOAD_MORE_STEP : cfg.PER_PAGE;
    const pageRequest = getComments(limit, append ? cs.lastDoc : null, {
      sort: cs.sort,
      excludePinned: true
    });

    if (append) {
      const result = await pageRequest;
      cs.list = [...cs.list, ...(result.comments || [])];
      cs.lastDoc = result.lastDoc;
      cs.hasMore = !!result.hasMore;
    } else {
      const [result, pinned, total] = await Promise.all([
        pageRequest,
        getPinnedComment(),
        getRootCommentsCount()
      ]);
      cs.list = [...(pinned ? [pinned] : []), ...(result.comments || [])];
      cs.lastDoc = result.lastDoc;
      cs.hasMore = !!result.hasMore;
      cs.total = total;
      cs.repliesCache.clear();
      cs.expandedReplies.clear();
      cs.selectedId = null;
    }

    renderTestimonialsComments();
    updateCommentsCountDisplay();
    updateLoadMoreUI();

  } catch (error) {
    console.error('❌ فشل تحميل آراء الطلاب:', error);
    if (listEl) {
      listEl.innerHTML = `
        <div class="testimonials-empty">
          <i class="fas fa-exclamation-triangle"></i>
          <p>حدث خطأ في تحميل الآراء</p>
          <button class="btn btn-sm btn-outline retry-testimonials" type="button">إعادة المحاولة</button>
        </div>`;
      listEl.querySelector('.retry-testimonials')
        ?.addEventListener('click', () => loadTestimonialsComments(false));
    }
  } finally {
    cs.isLoading = false;
    if (cs.elements.loadMoreBtn) cs.elements.loadMoreBtn.disabled = false;
  }
}

function renderTestimonialsComments() {
  const listEl = $homeState.comments.elements.list;
  if (!listEl) return;

  const cs = $homeState.comments;

  if (!cs.list || cs.list.length === 0) {
    listEl.innerHTML = `
      <div class="testimonials-empty">
        <i class="fas fa-comment-slash"></i>
        <p>لا توجد آراء بعد. كن أول من يشارك!</p>
      </div>`;
    return;
  }

  cs.selectedId = null;
  listEl.innerHTML = cs.list.map(comment => renderSingleCommentCard(comment, false)).join('');

  initTestimonialAvatars(listEl);
  attachTestimonialsCardEvents(listEl);
}

function renderSingleCommentCard(comment, isReply = false) {
  const user = getCurrentUser();
  const cs = $homeState.comments;
  const isAuth = isAuthenticated();
  const isStaff = isTeacher() || isModerator();
  const isOwner = !!user && String(user.id) === String(comment.user_id);

  const canEdit = isOwner;
  const canPin = isStaff && !isReply;
  const canDelete = isOwner || isStaff;
  const canReply = isAuth && !isReply;
  const hasTools = canReply || canEdit || canPin || canDelete;
  const editStillAllowed = canEdit && canEditComment(comment, user?.id);

  const isPinned = comment.pinned === true;
  const isLiked = !!user && (comment.liked_by || []).some(id => String(id) === String(user.id));

  const cached = cs.repliesCache.get(comment.id);
  const replies = cached?.replies || [];
  const hasMoreReplies = cached?.hasMore || false;
  const repliesCount = Math.max(comment.replies_count || 0, replies.length);
  const repliesExpanded = cs.expandedReplies.has(comment.id);

  let repliesToggleHtml = '';
  let repliesHtml = '';
  if (!isReply && repliesCount > 0) {
    repliesToggleHtml = `
      <button class="taction-btn replies-toggle-btn" type="button"
              data-action="toggle-replies"
              data-comment-id="${comment.id}"
              aria-expanded="${repliesExpanded}">
        <i class="fas fa-comments" aria-hidden="true"></i>
        <span class="replies-toggle-label">${repliesExpanded ? 'إخفاء الردود' : `عرض الردود (${repliesCount})`}</span>
      </button>`;

    repliesHtml = `
      <div class="testimonial-replies" data-comment-id="${comment.id}" ${repliesExpanded ? '' : 'hidden'}>
        ${replies.map(r => renderSingleCommentCard(r, true)).join('')}
        ${hasMoreReplies ? `
          <div class="load-more-replies-wrap">
            <button class="load-replies-btn" type="button" data-comment-id="${comment.id}">
              <i class="fas fa-arrow-down"></i> عرض المزيد من الردود
            </button>
          </div>` : ''}
      </div>`;
  }

  const avatarUser = {
    id: comment.user_id,
    gender: comment.gender,
    user_type: comment.commenter_user_type || comment.user_type,
    total_score: comment.commenter_total_score,
    avatar_job_index: comment.commenter_avatar_job_index,
    is_verified: comment.commenter_is_verified,
  };

  const typeKey = comment.commenter_user_type || comment.user_type;
  const userTypeLabel = getUserTypeLabel(typeKey);
  const isFeatured = ['teacher', 'moderator'].includes(typeKey);
  const pinnedBadge = isPinned
    ? `<span class="comment-pin-badge"><i class="fas fa-thumbtack"></i> مثبّت</span>`
    : '';
  const editedMark = comment.is_edited ? `<span class="tcard-edited">(معدّل)</span>` : '';

  const dateObj = getCommentDateObj(comment.date);
  const dateIso = dateObj ? dateObj.toISOString() : '';

  return `
    <div class="testimonial-comment-card ${isPinned ? 'pinned' : ''} ${isReply ? 'is-reply' : ''} ${isFeatured ? 'featured-comment' : ''} ${hasTools ? 'has-tools' : ''}"
         data-comment-id="${comment.id}"
         data-parent-id="${comment.parent_id || ''}">

      <div class="tcard-header">
        <div class="tcard-avatar"
             data-user-id="${comment.user_id}"
             data-avatar-data='${escapeHtml(JSON.stringify(avatarUser))}'></div>
        <div class="tcard-meta">
          <div class="tcard-author-row">
            <span class="tcard-author-name">${escapeHtml(comment.full_name)}</span>
            <span class="tcard-type-badge ${typeKey}">${userTypeLabel}</span>
            ${pinnedBadge}
          </div>
          <div class="tcard-date">
            <i class="fas fa-clock" aria-hidden="true"></i>
            <time datetime="${dateIso}" title="${escapeHtml(formatCommentFullDate(comment.date))}">${formatCommentDate(comment.date)}</time>
            ${editedMark}
          </div>
        </div>
      </div>

      <div class="tcard-body">
        <p class="tcard-text">${escapeHtml(comment.comment)}</p>
      </div>

      <div class="tcard-footer">
        <button class="taction-btn like-btn ${isLiked ? 'active-like' : ''}" type="button"
                data-action="like"
                data-comment-id="${comment.id}"
                aria-pressed="${isLiked}"
                title="إعجاب">
          <i class="fas fa-heart" aria-hidden="true"></i>
          <span class="taction-count">${comment.likes || 0}</span>
        </button>
        ${repliesToggleHtml}
        ${hasTools ? `
        <button class="taction-btn tcard-more-btn" type="button"
                data-action="toggle-tools"
                data-comment-id="${comment.id}"
                aria-expanded="false"
                aria-label="خيارات التعليق">
          <i class="fas fa-ellipsis-v" aria-hidden="true"></i>
        </button>` : ''}
      </div>

      ${hasTools ? `
      <div class="tcard-actions tcard-tools" hidden>
        ${canReply ? `
        <button class="taction-btn reply-btn" type="button" data-action="reply" data-comment-id="${comment.id}">
          <i class="fas fa-reply" aria-hidden="true"></i><span>رد</span>
        </button>` : ''}
        ${canEdit ? `
        <button class="taction-btn edit-btn" type="button" data-action="edit" data-comment-id="${comment.id}" ${editStillAllowed ? '' : 'hidden'}>
          <i class="fas fa-pen" aria-hidden="true"></i><span>تعديل</span>
        </button>` : ''}
        ${canPin ? `
        <button class="taction-btn pin-btn ${isPinned ? 'pin-active' : ''}" type="button" data-action="pin" data-comment-id="${comment.id}">
          <i class="fas fa-thumbtack" aria-hidden="true"></i><span>${isPinned ? 'إلغاء التثبيت' : 'تثبيت'}</span>
        </button>` : ''}
        ${canDelete ? `
        <button class="taction-btn delete-btn" type="button" data-action="delete" data-comment-id="${comment.id}">
          <i class="fas fa-trash-alt" aria-hidden="true"></i><span>حذف</span>
        </button>` : ''}
      </div>` : ''}

      ${canReply ? `
      <div class="tcard-reply-form" data-parent-id="${comment.id}" hidden>
        <label class="tcard-reply-label">الرد على ${escapeHtml(comment.full_name)}</label>
        <textarea rows="2" maxlength="${HOME_CONFIG.COMMENTS.MAX_LENGTH}" placeholder="اكتب ردك هنا..."></textarea>
        <div class="tcard-reply-actions">
          <button class="btn-sm cancel-reply-inner" type="button">إلغاء</button>
          <button class="btn-sm btn-primary submit-reply-inner" type="button">إرسال الرد</button>
        </div>
      </div>` : ''}

      ${repliesHtml}
    </div>
  `;
}

function initTestimonialAvatars(root) {
  if (!root) return;

  root.querySelectorAll('.tcard-avatar[data-user-id]').forEach(avatarDiv => {
    if (avatarDiv.hasAttribute('data-avatar-initialized')) return;
    try {
      const userData = JSON.parse(avatarDiv.dataset.avatarData);

      const avatarEl = createAvatarElement(userData, 'sm', {
        showFrame:   true,
        showBadge:   shouldShowVerificationBadge(userData),
        clickable:   false,
        showPulse:   false,
        showShimmer: false
      });

      avatarDiv.innerHTML = '';
      avatarDiv.appendChild(avatarEl);

      avatarDiv.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.router?.navigateTo) {
          window.router.navigateTo('profile', { path: { id: userData.id } });
        }
      });

      avatarDiv.setAttribute('data-avatar-initialized', 'true');
    } catch (err) {
      console.warn('⚠️ فشل إنشاء الأفاتار:', err);
    }
  });
}

function closeCardTools(card) {
  if (!card) return;
  card.querySelector(':scope > .tcard-tools')?.setAttribute('hidden', '');
  card.classList.remove('is-selected');
  card.querySelector(':scope > .tcard-footer [data-action="toggle-tools"]')?.setAttribute('aria-expanded', 'false');
}

function toggleTestimonialTools(commentId) {
  const cs = $homeState.comments;
  const listEl = cs.elements.list;
  if (!listEl) return;

  const card = listEl.querySelector(`.testimonial-comment-card[data-comment-id="${commentId}"]`);
  const tools = card?.querySelector(':scope > .tcard-tools');
  if (!card || !tools) return;

  const willOpen = tools.hasAttribute('hidden');

  listEl.querySelectorAll('.testimonial-comment-card.is-selected').forEach(c => {
    if (c !== card) closeCardTools(c);
  });

  if (!willOpen) {
    closeCardTools(card);
    cs.selectedId = null;
    return;
  }

  const user = getCurrentUser();
  const editBtn = tools.querySelector('[data-action="edit"]');
  if (editBtn) {
    const stillAllowed = canEditComment(findCommentById(commentId), user?.id);
    if (stillAllowed) editBtn.removeAttribute('hidden');
    else editBtn.setAttribute('hidden', '');
  }

  tools.removeAttribute('hidden');
  card.classList.add('is-selected');
  card.querySelector(':scope > .tcard-footer [data-action="toggle-tools"]')?.setAttribute('aria-expanded', 'true');
  cs.selectedId = commentId;
}

function handleToggleReplies(commentId, btn) {
  const cs = $homeState.comments;
  const card = btn.closest('.testimonial-comment-card');
  const box = card?.querySelector(':scope > .testimonial-replies');
  if (!box) return;

  const willOpen = box.hasAttribute('hidden');
  const label = btn.querySelector('.replies-toggle-label');
  const count = findCommentById(commentId)?.replies_count || 0;

  if (willOpen) {
    box.removeAttribute('hidden');
    cs.expandedReplies.add(commentId);
    const cached = cs.repliesCache.get(commentId);
    if (!cached || (!cached.replies.length && !cached.isLoading)) {
      loadTestimonialReplies(commentId, true);
    }
    if (label) label.textContent = 'إخفاء الردود';
  } else {
    box.setAttribute('hidden', '');
    cs.expandedReplies.delete(commentId);
    if (label) label.textContent = `عرض الردود (${count})`;
  }
  btn.setAttribute('aria-expanded', String(willOpen));
}

function attachTestimonialsCardEvents(root) {
  if (!root || root._testimonialDelegationAttached) return;
  root._testimonialDelegationAttached = true;

  root.addEventListener('click', (e) => {

    const btn = e.target.closest('[data-action]');
    if (btn && root.contains(btn)) {
      const action = btn.dataset.action;
      const commentId = parseInt(btn.dataset.commentId, 10);
      if (!commentId) return;

      switch (action) {
        case 'like':           handleTestimonialLike(commentId);              break;
        case 'toggle-tools':   toggleTestimonialTools(commentId);             break;
        case 'toggle-replies': handleToggleReplies(commentId, btn);           break;
        case 'reply':          handleTestimonialReplyClick(commentId, btn);   break;
        case 'edit':           handleTestimonialEdit(commentId);              break;
        case 'delete':         handleTestimonialDelete(commentId);            break;
        case 'pin':            handleTestimonialPin(commentId, btn);          break;
      }
      return;
    }

    const loadBtn = e.target.closest('.load-replies-btn');
    if (loadBtn) {
      e.preventDefault();
      const commentId = parseInt(loadBtn.dataset.commentId, 10);
      if (commentId) loadTestimonialReplies(commentId, false);
      return;
    }

    const submitBtn = e.target.closest('.submit-reply-inner');
    if (submitBtn) {
      e.preventDefault();
      const form = submitBtn.closest('.tcard-reply-form');
      if (form) handleSubmitTestimonialReply(form);
      return;
    }

    const cancelBtn = e.target.closest('.cancel-reply-inner');
    if (cancelBtn) {
      e.preventDefault();
      const form = cancelBtn.closest('.tcard-reply-form');
      if (form) form.hidden = true;
      return;
    }

    const card = e.target.closest('.testimonial-comment-card');
    if (!card || !root.contains(card)) return;
    if (e.target.closest('button, a, textarea, input, select, .tcard-avatar, .tcard-reply-form, .tcard-tools')) return;
    const commentId = parseInt(card.dataset.commentId, 10);
    if (commentId) toggleTestimonialTools(commentId);
  });
}

function renderTestimonialReplies(commentId, replies, hasMore) {
  const listEl = $homeState.comments.elements.list;
  if (!listEl) return;

  const commentCard = listEl.querySelector(`.testimonial-comment-card[data-comment-id="${commentId}"]`);
  if (!commentCard) return;

  let repliesContainer = commentCard.querySelector(':scope > .testimonial-replies');
  if (!repliesContainer) {
    repliesContainer = document.createElement('div');
    repliesContainer.className = 'testimonial-replies';
    repliesContainer.dataset.commentId = commentId;
    commentCard.appendChild(repliesContainer);
  }
  repliesContainer.removeAttribute('hidden');

  const loadMoreHtml = hasMore
    ? `<div class="load-more-replies-wrap">
         <button class="load-replies-btn" type="button" data-comment-id="${commentId}">
           <i class="fas fa-arrow-down"></i> عرض المزيد من الردود
         </button>
       </div>`
    : '';

  repliesContainer.innerHTML = replies.map(r => renderSingleCommentCard(r, true)).join('') + loadMoreHtml;
  initTestimonialAvatars(repliesContainer);
}

async function loadTestimonialReplies(commentId, refresh = false) {
  const cs = $homeState.comments;
  const cached = cs.repliesCache.get(commentId);
  if (!refresh && cached && !cached.hasMore && cached.replies.length > 0) return;

  const currentReplies = refresh ? [] : (cached?.replies || []);
  const lastDoc = refresh ? null : (cached?.lastDoc || null);

  cs.repliesCache.set(commentId, { replies: currentReplies, lastDoc, hasMore: false, isLoading: true });

  const listEl = cs.elements.list;
  const commentCard = listEl?.querySelector(`.testimonial-comment-card[data-comment-id="${commentId}"]`);
  let repliesContainer = commentCard?.querySelector('.testimonial-replies');
  if (!repliesContainer) {
    repliesContainer = document.createElement('div');
    repliesContainer.className = 'testimonial-replies';
    repliesContainer.dataset.commentId = commentId;
    commentCard?.appendChild(repliesContainer);
  }
  if (!refresh) {
    repliesContainer.innerHTML = `
      <div class="testimonials-loading" style="padding:var(--space-2);">
        <div class="spinner" style="width:20px;height:20px;"></div>
      </div>`;
  }

  try {
    const result = await getCommentReplies(
      commentId,
      HOME_CONFIG.COMMENTS.REPLIES_PER_PAGE,
      lastDoc
    );
    const newReplies = result.replies || [];
    const allReplies = refresh ? newReplies : [...currentReplies, ...newReplies];
    cs.repliesCache.set(commentId, {
      replies: allReplies,
      lastDoc: result.lastDoc,
      hasMore: result.hasMore || false,
      isLoading: false
    });
    renderTestimonialReplies(commentId, allReplies, result.hasMore || false);
  } catch (err) {
    console.error('❌ فشل تحميل الردود:', err);
    repliesContainer.innerHTML = `<div class="testimonials-error">حدث خطأ في تحميل الردود</div>`;
    cs.repliesCache.set(commentId, { ...(cached || {}), isLoading: false });
  }
}

function findCommentById(commentId) {
  const cs = $homeState.comments;
  for (const c of cs.list) {
    if (c.id === commentId) return c;
    const cached = cs.repliesCache.get(c.id);
    if (cached) {
      const reply = cached.replies.find(r => r.id === commentId);
      if (reply) return reply;
    }
  }
  return null;
}

// ==== 9. معالجات أحداث التعليقات ====

async function handleAddTestimonialComment() {
  const cs = $homeState.comments.elements;
  const cfg = HOME_CONFIG.COMMENTS;
  if (!cs.textarea) return;

  const content = cs.textarea.value.trim();
  if (!content) {
    showToast('يرجى كتابة رأيك أولاً', 'warning');
    return;
  }
  if (content.length > cfg.MAX_LENGTH) {
    showToast(`الحد الأقصى ${cfg.MAX_LENGTH} حرف`, 'warning');
    return;
  }
  if (containsBannedContent(content)) {
    showToast('يحتوي النص على محتوى غير لائق', 'warning');
    return;
  }

  const user = getCurrentUser();
  if (!user) {
    showToast('يجب تسجيل الدخول أولاً', 'warning');
    if (window.router?.navigateTo) window.router.navigateTo('login');
    return;
  }

  if (cs.submitBtn) cs.submitBtn.disabled = true;

  try {
    await addComment({ parentId: null, comment: content });
    cs.textarea.value = '';
    if (cs.counter) cs.counter.textContent = `0 / ${cfg.MAX_LENGTH}`;
    cancelTestimonialReply();
    showToast('شكراً! تمت إضافة رأيك بنجاح', 'success');
    EventBus.emit('comment:added');
  } catch (err) {
    console.error('❌ فشل إضافة الرأي:', err);
    showToast('حدث خطأ أثناء إضافة رأيك', 'error');
  } finally {
    if (cs.submitBtn) cs.submitBtn.disabled = false;
  }
}

function cancelTestimonialReply() {
  document.querySelectorAll('.tcard-reply-form').forEach(f => { f.hidden = true; });
  $homeState.comments.elements.replyParentId = null;
}

function handleTestimonialReplyClick(commentId, btn) {
  if (!isAuthenticated()) {
    showToast('يجب تسجيل الدخول للرد', 'warning');
    return;
  }
  const card = btn.closest('.testimonial-comment-card');
  if (!card) return;

  document.querySelectorAll('.tcard-reply-form').forEach(f => { f.hidden = true; });

  const replyForm = card.querySelector(':scope > .tcard-reply-form');
  if (replyForm) {
    replyForm.hidden = false;
    replyForm.querySelector('textarea')?.focus();
    $homeState.comments.elements.replyParentId = commentId;
  }
}

async function handleSubmitTestimonialReply(form) {
  const cfg = HOME_CONFIG.COMMENTS;
  const parentId = parseInt(form.dataset.parentId, 10);
  const textarea = form.querySelector('textarea');
  const content = textarea?.value.trim();

  if (!content) {
    showToast('يرجى كتابة الرد', 'warning');
    return;
  }
  if (content.length > cfg.MAX_LENGTH) {
    showToast(`الحد الأقصى ${cfg.MAX_LENGTH} حرف`, 'warning');
    return;
  }
  if (containsBannedContent(content)) {
    showToast('يحتوي الرد على محتوى غير لائق', 'warning');
    return;
  }

  const user = getCurrentUser();
  if (!user) {
    showToast('يجب تسجيل الدخول أولاً', 'warning');
    return;
  }

  const submitBtn = form.querySelector('.submit-reply-inner');
  if (submitBtn) submitBtn.disabled = true;

  try {
    await addComment({ parentId, comment: content });
    if (textarea) textarea.value = '';
    form.hidden = true;

    const cs = $homeState.comments;
    const parent = findCommentById(parentId);
    if (parent) parent.replies_count = (parent.replies_count || 0) + 1;
    cs.expandedReplies.add(parentId);
    await loadTestimonialReplies(parentId, true);
    renderTestimonialsComments();

    showToast('تمت إضافة ردك', 'success');
    EventBus.emit('comment:added', { parentId });
  } catch (err) {
    console.error('❌ فشل إضافة الرد:', err);
    showToast('حدث خطأ أثناء إضافة الرد', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function handleTestimonialLike(commentId) {
  const user = getCurrentUser();
  if (!user) {
    showToast('يجب تسجيل الدخول', 'warning');
    return;
  }

  try {
    await toggleCommentLike(commentId, user.id);

    const updateLocally = (commentsArray) => {
      for (const c of commentsArray) {
        if (c.id === commentId) {
          const wasLiked = (c.liked_by || []).some(id => String(id) === String(user.id));
          if (wasLiked) {
            c.likes = Math.max(0, (c.likes || 0) - 1);
            c.liked_by = (c.liked_by || []).filter(id => String(id) !== String(user.id));
          } else {
            c.likes = (c.likes || 0) + 1;
            c.liked_by = [...(c.liked_by || []), user.id];
          }
          const card = document.querySelector(`.testimonial-comment-card[data-comment-id="${commentId}"]`);
          if (card) {
            const likeBtn = card.querySelector('.like-btn');
            likeBtn?.querySelector('.taction-count') && (likeBtn.querySelector('.taction-count').textContent = c.likes);
            likeBtn?.classList.toggle('active-like', !wasLiked);
            likeBtn?.setAttribute('aria-pressed', String(!wasLiked));
          }
          return true;
        }
        const cs = $homeState.comments;
        const cached = cs.repliesCache.get(c.id);
        if (cached?.replies?.length && updateLocally(cached.replies)) return true;
      }
      return false;
    };
    updateLocally($homeState.comments.list);
    EventBus.emit('comment:liked', { commentId, userId: user.id });
  } catch (err) {
    showToast('فشل تسجيل الإعجاب', 'error');
  }
}

async function handleTestimonialEdit(commentId) {
  const comment = findCommentById(commentId);
  if (!comment) return;
  const user = getCurrentUser();
  const cfg = HOME_CONFIG.COMMENTS;

  if (!canEditComment(comment, user?.id)) {
    showToast('انتهت مدة تعديل هذا التعليق', 'warning');
    renderTestimonialsComments();
    return;
  }

  if (!window.modals?.prompt) {
    showToast('نظام التعديل غير متاح', 'error');
    return;
  }

  const newText = await window.modals.prompt({
    title: 'تعديل التعليق',
    message: `يمكنك التعديل خلال ${cfg.EDIT_TIMEOUT_MINUTES} دقائق من النشر`,
    defaultValue: comment.comment,
    confirmText: 'حفظ',
    cancelText: 'إلغاء',
    validate: (value) => {
      const t = (value || '').trim();
      if (!t) return 'لا يمكن ترك التعليق فارغًا';
      if (t.length > cfg.MAX_LENGTH) return `الحد الأقصى ${cfg.MAX_LENGTH} حرف`;
      if (containsBannedContent(t)) return 'يحتوي النص على محتوى غير لائق';
      return '';
    }
  });

  if (newText === null || newText === undefined) return;
  const trimmed = newText.trim();
  if (!trimmed || trimmed === comment.comment) return;

  try {
    await updateComment(commentId, trimmed);
    comment.comment = trimmed;
    comment.is_edited = true;
    renderTestimonialsComments();
    showToast('تم تعديل التعليق', 'success');
    EventBus.emit('comment:updated', { commentId });
  } catch (err) {
    showToast('فشل التعديل — قد تكون المدة انتهت', 'error');
  }
}

async function handleTestimonialDelete(commentId) {
  const confirmed = window.modals?.confirm
    ? await window.modals.confirm({
        title: 'تأكيد الحذف',
        message: 'هل أنت متأكد من حذف هذا التعليق؟',
        confirmText: 'حذف',
        cancelText: 'إلغاء',
        type: 'danger'
      })
    : window.confirm('هل تريد حذف هذا التعليق؟');

  if (!confirmed) return;

  try {
    await softDeleteComment(commentId);
    showToast('تم حذف التعليق', 'success');

    const cs = $homeState.comments;
    const idx = cs.list.findIndex(c => c.id === commentId);
    if (idx !== -1) {
      cs.list.splice(idx, 1);
      cs.repliesCache.delete(commentId);
      cs.expandedReplies.delete(commentId);
      if (cs.total != null) cs.total = Math.max(0, cs.total - 1);
    } else {
      for (const c of cs.list) {
        const cached = cs.repliesCache.get(c.id);
        const rIdx = cached ? cached.replies.findIndex(r => r.id === commentId) : -1;
        if (rIdx !== -1) {
          cached.replies.splice(rIdx, 1);
          c.replies_count = Math.max(0, (c.replies_count || 0) - 1);
          break;
        }
      }
    }

    renderTestimonialsComments();
    updateCommentsCountDisplay();
    updateLoadMoreUI();
    EventBus.emit('comment:deleted', { commentId });

    if (!cs.list.length && cs.hasMore) loadTestimonialsComments(false);
  } catch (err) {
    showToast('فشل الحذف', 'error');
  }
}

async function handleTestimonialPin(commentId, btn) {
  const cs = $homeState.comments;
  const card = btn.closest('.testimonial-comment-card');
  const currentlyPinned = card?.classList.contains('pinned');

  if (!currentlyPinned) {
    const existing = cs.list.find(c => c.pinned && c.id !== commentId);
    if (existing && window.modals?.confirm) {
      const ok = await window.modals.confirm({
        title: 'استبدال التعليق المثبّت',
        message: 'يوجد تعليق مثبّت بالفعل. تثبيت هذا التعليق سيُلغي تثبيت السابق. هل تريد المتابعة؟',
        confirmText: 'استبدال',
        cancelText: 'إلغاء'
      });
      if (!ok) return;
    }
  }

  try {
    await pinComment(commentId, !currentlyPinned);
    showToast(currentlyPinned ? 'تم إلغاء التثبيت' : 'تم تثبيت التعليق', 'success');
    await loadTestimonialsComments(false);
    EventBus.emit('comment:pinned', { commentId, pinned: !currentlyPinned });
  } catch (err) {
    showToast('فشل تغيير حالة التثبيت', 'error');
  }
}

// ==== 10. جلب البيانات (Cache-first) ====

async function loadPlatformStats(forceRefresh = false) {
  if ($homeState.isLoading.stats) return;
  $homeState.isLoading.stats = true;
  try {
    let stats = forceRefresh ? null : getCachedData(HOME_CONFIG.CACHE_KEYS.STATS);
    if (!stats) {
      stats = await getPlatformStats();
      setCachedData(HOME_CONFIG.CACHE_KEYS.STATS, stats);
    }
    updateStats(stats);
    if ($homeState.roleKey === ROLE_KEYS.MODERATOR || $homeState.roleKey === ROLE_KEYS.TEACHER) {
      updateStaffKpis(stats);
    }
  } catch (error) {
    console.error('❌ فشل تحميل الإحصائيات:', error);
    showToast('تعذر تحميل إحصائيات المنصة', 'error');
  } finally {
    $homeState.isLoading.stats = false;
  }
}

async function loadTopChampions(forceRefresh = false) {
  if ($homeState.isLoading.champions) return;
  $homeState.isLoading.champions = true;
  try {
    let champions = forceRefresh ? null : getCachedData(HOME_CONFIG.CACHE_KEYS.CHAMPIONS);
    if (!champions) {
      champions = await getTopStudents(HOME_CONFIG.DEFAULTS.CHAMPIONS_LIMIT);
      setCachedData(HOME_CONFIG.CACHE_KEYS.CHAMPIONS, champions);
    }
    updateChampionsGrid(champions);
  } catch (error) {
    console.error('❌ فشل تحميل أبطال الأسبوع:', error);
    showToast('تعذر تحميل قائمة الأبطال', 'error');
  } finally {
    $homeState.isLoading.champions = false;
  }
}

async function loadRecommendedLessons(forceRefresh = false) {
  if ($homeState.roleKey === ROLE_KEYS.MODERATOR || $homeState.roleKey === ROLE_KEYS.TEACHER) return;
  if ($homeState.isLoading.recommended) return;
  $homeState.isLoading.recommended = true;

  const isStudent = $homeState.roleKey === ROLE_KEYS.STUDENT;
  const user = isStudent ? $homeState.currentUser : null;
  const cacheKey = isStudent
    ? `${HOME_CONFIG.CACHE_KEYS.RECOMMENDED}_${user?.stage || 'na'}_${user?.grade || 'na'}`
    : HOME_CONFIG.CACHE_KEYS.RECOMMENDED;

  try {
    let lessons = forceRefresh ? null : getCachedData(cacheKey);
    if (!lessons) {
      const options = { limit: HOME_CONFIG.DEFAULTS.RECOMMENDED_LIMIT };
      if (isStudent && user?.stage) options.stage = user.stage;
      if (isStudent && user?.grade !== undefined) options.grade = user.grade;
      if (isStudent && user?.stage && user?.grade !== undefined) {
        try {
          options.semester = await getActiveSemesterFor(user.stage, user.grade);
        } catch (err) {
          console.warn('⚠️ تعذّر جلب الفصل الدراسي النشط، سيتم عرض كل الدروس:', err);
        }
      }
      lessons = await getAllLessons(options);
      setCachedData(cacheKey, lessons);
    }

    const titleEl = $homeState.container.querySelector(HOME_CONFIG.SELECTORS.RECOMMENDED_TITLE_TEXT);
    if (titleEl) titleEl.textContent = isStudent ? 'دروس مقترحة لمرحلتك' : 'دروس مقترحة لك';

    updateRecommendedLessons(lessons);
  } catch (error) {
    console.error('❌ فشل تحميل الدروس المقترحة:', error);
    showToast('تعذر تحميل الدروس المقترحة', 'error');
  } finally {
    $homeState.isLoading.recommended = false;
  }
}

// ==== 11. لوحة الطالب ====

function toMillis(timestamp) {
  if (!timestamp) return 0;
  if (timestamp?.toDate) return timestamp.toDate().getTime();
  if (timestamp?.seconds) return timestamp.seconds * 1000;
  const d = new Date(timestamp);
  return isNaN(d) ? 0 : d.getTime();
}

function bindContinueLearningEmptyActions(card) {
  card.querySelectorAll('[data-action]').forEach(btn => {
    const target = btn.dataset.action === 'explore-exams' ? 'exams' : 'lessons';
    btn.addEventListener('click', () => handleNavigation(target));
  });
}

async function renderContinueLearningCard(progressList) {
  const card = $homeState.container.querySelector(HOME_CONFIG.SELECTORS.CONTINUE_LEARNING);
  if (!card) return;

  if (!progressList || progressList.length === 0) {
    card.innerHTML = `
      <div class="clc-empty">
        <i class="fas fa-rocket" aria-hidden="true"></i>
        <h3>لم تبدأ رحلتك بعد!</h3>
        <p>اختر أول درس لك وابدأ التعلم الآن</p>
        <button class="btn btn-primary" data-action="explore-lessons" type="button">
          <i class="fas fa-book-open" aria-hidden="true"></i> تصفح الدروس
        </button>
      </div>
    `;
    bindContinueLearningEmptyActions(card);
    return;
  }

  const inProgress = progressList
    .filter(p => !p.completed && (p.progress || 0) < 100)
    .sort((a, b) => toMillis(b.last_accessed) - toMillis(a.last_accessed));

  if (inProgress.length === 0) {
    card.innerHTML = `
      <div class="clc-empty">
        <i class="fas fa-medal" aria-hidden="true"></i>
        <h3>أحسنت! أكملت كل دروسك المتاحة 🎉</h3>
        <p>جرّب الآن امتحاناً جديداً لاختبار مستواك</p>
        <button class="btn btn-primary" data-action="explore-exams" type="button">
          <i class="fas fa-pen-to-square" aria-hidden="true"></i> الامتحانات
        </button>
      </div>
    `;
    bindContinueLearningEmptyActions(card);
    return;
  }

  const latest = inProgress[0];
  let lesson = null;
  try {
    lesson = await getLessonById(latest.lesson_id);
  } catch (e) {
    console.warn('⚠️ فشل جلب بيانات الدرس الحالي', e);
  }

  if (!lesson) {
    card.innerHTML = `
      <div class="clc-empty">
        <i class="fas fa-book-open" aria-hidden="true"></i>
        <h3>تابع دروسك</h3>
        <button class="btn btn-primary" data-action="explore-lessons" type="button">تصفح الدروس</button>
      </div>
    `;
    bindContinueLearningEmptyActions(card);
    return;
  }

  const progressPercent = Math.max(0, Math.min(100, Math.round(latest.progress || 0)));
  card.innerHTML = `
    <span class="clc-eyebrow"><i class="fas fa-play-circle" aria-hidden="true"></i> استكمل من حيث توقفت</span>
    <div class="clc-body">
      <div class="clc-ring" role="img" aria-label="نسبة إكمال الدرس ${progressPercent}%">
        <span class="clc-ring-value">${progressPercent}%</span>
      </div>
      <div class="clc-info">
        <h3 class="clc-title">${escapeHtml(lesson.title)}</h3>
        <p class="clc-desc">تابع دراستك في آخر درس كنت تدرسه واستكمل نحو أهدافك</p>
        <div class="clc-actions">
          <button class="btn btn-primary btn-sm clc-cta" data-action="continue-lesson" type="button">
            <i class="fas fa-play" aria-hidden="true"></i> متابعة التعلم
          </button>
        </div>
      </div>
    </div>
  `;

  const ringEl = card.querySelector('.clc-ring');
  if (ringEl) ringEl.style.setProperty('--clc-progress', progressPercent);

  const continueBtn = card.querySelector('[data-action="continue-lesson"]');
  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      handleNavigation('lesson-view', { path: { id: lesson.id } });
    });
  }
}

function renderStudentStats(progressList, examStats, user) {
  const overallProgress = progressList.length
    ? Math.round(progressList.reduce((sum, p) => sum + (p.progress || 0), 0) / progressList.length)
    : 0;

  const values = {
    progress: `${overallProgress}%`,
    exams: formatNumber(examStats.completedExams || 0),
    average: `${Math.round(examStats.averageScore || 0)}%`,
    streak: formatNumber(user.streak || 0)
  };

  $homeState.container.querySelectorAll(HOME_CONFIG.SELECTORS.STUDENT_STATS).forEach(el => {
    const key = el.getAttribute('data-student-stat');
    if (values[key] !== undefined) el.textContent = values[key];
  });
}

async function loadStudentPanel(user) {
  if (!user || $homeState.isLoading.studentPanel) return;
  $homeState.isLoading.studentPanel = true;
  try {
    const [progressList, examStats] = await Promise.all([
      getUserProgress(user.id).catch(() => []),
      getUserExamStats(user.id).catch(() => ({ completedExams: 0, averageScore: 0 }))
    ]);

    await renderContinueLearningCard(progressList);
    renderStudentStats(progressList, examStats, user);
  } catch (error) {
    console.error('❌ فشل تحميل لوحة الطالب:', error);
  } finally {
    $homeState.isLoading.studentPanel = false;
  }
}

// ==== 12. لوحة طاقم العمل ====

async function loadStaffPanel(roleKey) {
  if (roleKey !== ROLE_KEYS.TEACHER) return;
  if ($homeState.isLoading.staffPanel) return;
  $homeState.isLoading.staffPanel = true;

  try {
    const [pendingComplaints, moderators] = await Promise.all([
      getPendingComplaintsCount().catch(() => 0),
      getModeratorsList().catch(() => [])
    ]);

    const moderatorsCount = moderators.filter(m => m.level !== 'senior').length;

    const values = {
      pendingComplaints: formatNumber(pendingComplaints),
      moderators: `${moderatorsCount}/${HOME_CONFIG.DEFAULTS.MAX_MODERATORS}`
    };

    $homeState.container.querySelectorAll(HOME_CONFIG.SELECTORS.STAFF_STATS).forEach(el => {
      const key = el.getAttribute('data-staff-stat');
      if (values[key] !== undefined) el.textContent = values[key];
    });
  } catch (error) {
    console.error('❌ فشل تحميل مؤشرات طاقم العمل الإضافية:', error);
  } finally {
    $homeState.isLoading.staffPanel = false;
  }
}

// ==== 13. معالجات الأحداث العامة ====

function handleNavigation(target, params = {}) {
  if (window.router?.navigateTo) {
    window.router.navigateTo(target, params);
  } else {
    console.warn('Router غير متاح');
  }
}

function handleViewAllChampions() {
  showAllChampionsModal();
}

async function showAllChampionsModal() {
  try {
    const allChampions = await getTopStudents(20);

    if (!allChampions || allChampions.length === 0) {
      window.modals?.toast('لا يوجد أبطال حالياً', 'info');
      return;
    }

    let championsHtml = `
  <div class="champions-modal-list">
    <div class="champions-modal-grid">
`;

allChampions.forEach((student, index) => {
  const rank = index + 1;
  let rankIcon = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
  const avatarUrl = student.avatar_url || (student.gender === 'female' ? 'assets/images/G.png' : 'assets/images/M.png');
  championsHtml += `
    <div class="champion-modal-card">
      <div class="champion-modal-rank">${rankIcon}</div>
      <div class="champion-modal-avatar">
        <img src="${avatarUrl}" alt="${escapeHtml(student.full_name)}">
      </div>
      <div class="champion-modal-info">
        <div class="champion-modal-name">${escapeHtml(student.full_name)}</div>
        <div class="champion-modal-score">⭐ ${student.total_score || 0} نقطة</div>
      </div>
    </div>
  `;
});

    championsHtml += `</div></div>`;

    if (window.modals?.showModal) {
      window.modals.showModal({
        title: '🏆 أبطال هذا الأسبوع',
        html: championsHtml,
        size: 'large',
        buttons: [{ text: 'إغلاق', role: 'cancel', type: 'secondary' }]
      });
    } else {
      alert('عذراً، نظام النوافذ غير متاح');
    }
  } catch (error) {
    console.error('فشل تحميل الأبطال:', error);
    window.modals?.toast('حدث خطأ أثناء تحميل قائمة الأبطال', 'error');
  }
}

// ==== 14. الكاروسيل ====

function initAboutCarousel() {
  if ($homeState.roleKey !== ROLE_KEYS.GUEST) return;

  const container = $homeState.container.querySelector(HOME_CONFIG.SELECTORS.ABOUT_CAROUSEL);
  if (!container) return;

  const slides = container.querySelectorAll('.carousel-slide');
  const prevBtn = container.querySelector(HOME_CONFIG.SELECTORS.CAROUSEL_PREV);
  const nextBtn = container.querySelector(HOME_CONFIG.SELECTORS.CAROUSEL_NEXT);
  if (!slides.length) return;

  let currentIndex = 0;
  let autoInterval = null;

  function showSlide(index) {
    slides.forEach((slide, i) => slide.classList.toggle('active', i === index));
    if (prevBtn) prevBtn.disabled = index === 0;
    if (nextBtn) nextBtn.disabled = index === slides.length - 1;
    currentIndex = index;
  }

  function nextSlide() {
    if (currentIndex < slides.length - 1) showSlide(currentIndex + 1);
  }

  function prevSlide() {
    if (currentIndex > 0) showSlide(currentIndex - 1);
  }

  function startAuto() {
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = setInterval(() => {
      if (currentIndex === slides.length - 1) showSlide(0);
      else nextSlide();
    }, HOME_CONFIG.DEFAULTS.CAROUSEL_INTERVAL);
  }

  function stopAuto() {
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = null;
  }

  if (prevBtn) prevBtn.addEventListener('click', () => { stopAuto(); prevSlide(); startAuto(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { stopAuto(); nextSlide(); startAuto(); });

  container.addEventListener('mouseenter', stopAuto);
  container.addEventListener('mouseleave', startAuto);

  showSlide(0);
  startAuto();

  $homeState.carousels.about = { showSlide, nextSlide, prevSlide, startAuto, stopAuto };
}

function stopAboutCarousel() {
  $homeState.carousels.about?.stopAuto();
  $homeState.intervals.about = null;
  $homeState.carousels.about = null;
}

// ==== 15. كاروسيل المزايا ====
function initFeaturesReveal(sectionEl) {
  if (!sectionEl) return null;
  if (sectionEl.classList.contains('is-revealed')) return null;

  if (!('IntersectionObserver' in window)) {
    sectionEl.classList.add('is-revealed');
    return null;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      sectionEl.classList.add('is-revealed');
      observer.disconnect();
    });
  }, { threshold: 0.2, rootMargin: '0px 0px -80px 0px' });

  observer.observe(sectionEl);
  return observer;
}

function initFeaturesCarousel() {
  if ($homeState.roleKey !== ROLE_KEYS.GUEST) return;

  const root = $homeState.container.querySelector(HOME_CONFIG.SELECTORS.FEATURES_CAROUSEL);
  if (!root) return;

  const sectionEl = $homeState.container.querySelector(HOME_CONFIG.SELECTORS.FEATURES_SECTION);
  const revealObserver = initFeaturesReveal(sectionEl);

  const viewport = root.querySelector('.fc-viewport');
  const track = root.querySelector('.fc-track');
  const prevBtn = root.querySelector('.fc-arrow-prev');
  const nextBtn = root.querySelector('.fc-arrow-next');
  const dotsWrap = root.querySelector('.fc-dots');
  const toggleBtn = root.querySelector('.fc-toggle-auto');
  if (!viewport || !track || !dotsWrap) {
    if (revealObserver) revealObserver.disconnect();
    return;
  }

  const originalSlides = Array.from(track.querySelectorAll('.fc-slide'));
  const count = originalSlides.length;
  if (count < 3) {
    if (revealObserver) revealObserver.disconnect();
    return;
  }

  const cfg = HOME_CONFIG.FEATURES_CAROUSEL;
  const ac = new AbortController();
  const { signal } = ac;

  function cloneSlideSet() {
    return originalSlides.map(slide => {
      const clone = slide.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      clone.querySelectorAll('a[href], button').forEach(el => el.setAttribute('tabindex', '-1'));
      return clone;
    });
  }

  const beforeClones = cloneSlideSet();
  const afterClones = cloneSlideSet();
  const fragBefore = document.createDocumentFragment();
  beforeClones.forEach(c => fragBefore.appendChild(c));
  track.insertBefore(fragBefore, track.firstChild);
  const fragAfter = document.createDocumentFragment();
  afterClones.forEach(c => fragAfter.appendChild(c));
  track.appendChild(fragAfter);

  const allSlides = Array.from(track.querySelectorAll('.fc-slide'));
  allSlides.forEach((s, i) => {
    s.setAttribute('role', 'group');
    s.setAttribute('aria-roledescription', 'slide');
    s.setAttribute('aria-label', `${(i % count) + 1} من ${count}`);
  });

  let position = count;
  let realIndex = 0;
  let autoTimer = null;
  let transitionSafetyTimer = null;
  let resizeObserver = null;
  let lastViewportWidth = 0;
  let isTransitioning = false;
  let isDragging = false;
  let dragStartX = 0;
  let dragDeltaX = 0;
  let dragStartTime = 0;
  let isHovering = false;
  let hasFocusInside = false;
  let sectionInView = true;
  let isManuallyPaused = false;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  dotsWrap.innerHTML = '';
  const dots = originalSlides.map((_, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'fc-dot';
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-label', `عرض الميزة رقم ${i + 1}`);
    dot.addEventListener('click', () => { goToRealIndex(i); restartAutoIfIdle(); }, { signal });
    dotsWrap.appendChild(dot);
    return dot;
  });

  function updateDots() {
    dots.forEach((d, i) => {
      const active = i === realIndex;
      d.classList.toggle('is-active', active);
      d.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function updateActiveClasses() {
    allSlides.forEach((s, i) => {
      const active = ((i % count) + count) % count === realIndex;
      s.classList.toggle('is-active', active);
      s.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
  }

  function slotStep() {
    const sample = allSlides[position] || allSlides[0];
    return sample.getBoundingClientRect().width;
  }

  function baseOffset(step) {
    const viewportWidth = viewport.getBoundingClientRect().width;
    return (viewportWidth - step) / 2 - position * step;
  }

  function render(withTransition) {
    const step = slotStep();
    if (!step) return;
    track.classList.toggle('fc-no-transition', !withTransition || prefersReducedMotion);
    track.style.transform = `translate3d(${baseOffset(step)}px, 0, 0)`;
    updateActiveClasses();
  }

  function goToPosition(newPosition) {
    if (isTransitioning) return;
    isTransitioning = true;
    position = newPosition;
    realIndex = ((position % count) + count) % count;
    render(true);
    updateDots();
    if (prefersReducedMotion) {
      isTransitioning = false;
      snapIfNeeded();
      return;
    }
    clearTimeout(transitionSafetyTimer);
    transitionSafetyTimer = setTimeout(() => {
      if (!isTransitioning) return;
      isTransitioning = false;
      snapIfNeeded();
    }, cfg.TRANSITION_MS + 150);
  }

  function snapIfNeeded() {
    if (position >= count * 2) {
      position -= count;
      render(false);
    } else if (position < count) {
      position += count;
      render(false);
    } else {
      return;
    }
    if (!prefersReducedMotion) {
      requestAnimationFrame(() => requestAnimationFrame(() => track.classList.remove('fc-no-transition')));
    }
  }

  function handleTransitionEnd(e) {
    if (e.target !== track) return;
    clearTimeout(transitionSafetyTimer);
    isTransitioning = false;
    snapIfNeeded();
  }

  function next() { goToPosition(position + 1); }
  function prev() { goToPosition(position - 1); }

  function goToRealIndex(targetRealIndex) {
    const delta = ((targetRealIndex - realIndex) % count + count) % count;
    if (delta === 0) return;
    if (delta <= count - delta) goToPosition(position + delta);
    else goToPosition(position - (count - delta));
  }

  function startAuto() {
    stopAutoTimerOnly();
    if (prefersReducedMotion || isManuallyPaused || isHovering || hasFocusInside) return;
    if (!sectionInView || document.hidden) return;
    autoTimer = setInterval(next, cfg.HOLD_MS);
    $homeState.intervals.features = autoTimer;
  }

  function stopAutoTimerOnly() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    $homeState.intervals.features = null;
  }

  function restartAutoIfIdle() {
    if (isManuallyPaused) return;
    startAuto();
  }

  function updateToggleBtnUI() {
    if (!toggleBtn) return;
    const playing = !!autoTimer;
    toggleBtn.classList.toggle('is-paused', !playing);
    toggleBtn.setAttribute('aria-label', playing ? 'إيقاف التبديل التلقائي للمزايا' : 'تشغيل التبديل التلقائي للمزايا');
    const icon = toggleBtn.querySelector('i');
    if (icon) icon.className = playing ? 'fas fa-pause' : 'fas fa-play';
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      isManuallyPaused = !isManuallyPaused;
      if (isManuallyPaused) stopAutoTimerOnly();
      else startAuto();
      updateToggleBtnUI();
    }, { signal });
  }

  if (prevBtn) prevBtn.addEventListener('click', () => { prev(); restartAutoIfIdle(); }, { signal });
  if (nextBtn) nextBtn.addEventListener('click', () => { next(); restartAutoIfIdle(); }, { signal });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); prev(); restartAutoIfIdle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); next(); restartAutoIfIdle(); }
  }, { signal });

  function pointerX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }

  function onPointerDown(e) {
    if (e.type === 'mousedown' && e.button !== 0) return;
    if (isTransitioning) return;
    isDragging = true;
    dragStartX = pointerX(e);
    dragDeltaX = 0;
    dragStartTime = performance.now();
    stopAutoTimerOnly();
    track.classList.add('fc-no-transition');
    viewport.classList.add('is-grabbing');
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const x = pointerX(e);
    dragDeltaX = x - dragStartX;
    const step = slotStep();
    track.style.transform = `translate3d(${baseOffset(step) + dragDeltaX}px, 0, 0)`;
  }

  function onPointerUp() {
    if (!isDragging) return;
    isDragging = false;
    track.classList.remove('fc-no-transition');
    viewport.classList.remove('is-grabbing');
    const elapsed = Math.max(performance.now() - dragStartTime, 1);
    const avgVelocity = dragDeltaX / elapsed;
    const distancePastThreshold = Math.abs(dragDeltaX) > cfg.SWIPE_THRESHOLD_PX;
    const fastFlick = Math.abs(dragDeltaX) > 12 && Math.abs(avgVelocity) > cfg.SWIPE_VELOCITY;
    if (distancePastThreshold || fastFlick) {
      if (dragDeltaX < 0) next(); else prev();
    } else {
      render(true);
    }
    restartAutoIfIdle();
  }

  viewport.addEventListener('touchstart', onPointerDown, { passive: true, signal });
  viewport.addEventListener('touchmove', onPointerMove, { passive: true, signal });
  viewport.addEventListener('touchend', onPointerUp, { signal });
  viewport.addEventListener('touchcancel', onPointerUp, { signal });
  viewport.addEventListener('mousedown', onPointerDown, { signal });
  window.addEventListener('mousemove', onPointerMove, { signal });
  window.addEventListener('mouseup', onPointerUp, { signal });

  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    root.addEventListener('mouseenter', () => { isHovering = true; stopAutoTimerOnly(); }, { signal });
    root.addEventListener('mouseleave', () => { isHovering = false; restartAutoIfIdle(); }, { signal });
  }

  root.addEventListener('focusin', () => { hasFocusInside = true; stopAutoTimerOnly(); }, { signal });
  root.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (!root.contains(document.activeElement)) {
        hasFocusInside = false;
        restartAutoIfIdle();
      }
    });
  }, { signal });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoTimerOnly();
    else restartAutoIfIdle();
  }, { signal });

  const playObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      sectionInView = entry.isIntersecting;
      if (sectionInView) restartAutoIfIdle();
      else stopAutoTimerOnly();
    });
  }, { threshold: 0.15 });
  if (sectionEl) playObserver.observe(sectionEl);

  track.addEventListener('transitionend', handleTransitionEnd, { signal });

  function handleResize(width) {
    if (Math.abs(width - lastViewportWidth) < 1) return;
    lastViewportWidth = width;
    render(false);
  }
  if (window.ResizeObserver) {
    resizeObserver = new ResizeObserver((entries) => handleResize(entries[0].contentRect.width));
    resizeObserver.observe(viewport);
  } else {
    window.addEventListener('resize', () => handleResize(viewport.getBoundingClientRect().width), { signal });
  }

  render(false);
  lastViewportWidth = viewport.getBoundingClientRect().width;
  updateDots();
  updateToggleBtnUI();
  startAuto();

  function destroy() {
    stopAutoTimerOnly();
    clearTimeout(transitionSafetyTimer);
    ac.abort();
    if (resizeObserver) resizeObserver.disconnect();
    if (revealObserver) revealObserver.disconnect();
    playObserver.disconnect();
    beforeClones.forEach(c => c.remove());
    afterClones.forEach(c => c.remove());
  }

  $homeState.carousels.features = { next, prev, goToRealIndex, startAuto, stopAuto: stopAutoTimerOnly, destroy };
}

function stopFeaturesCarousel() {
  if ($homeState.carousels.features && typeof $homeState.carousels.features.destroy === 'function') {
    $homeState.carousels.features.destroy();
  }
  if ($homeState.intervals.features) {
    clearInterval($homeState.intervals.features);
    $homeState.intervals.features = null;
  }
  $homeState.carousels.features = null;
}


// ==== 16. التهيئة الرئيسية ====

function loadRoleDependentSections(forceRefresh = false) {
  loadPlatformStats(forceRefresh);
  loadRecommendedLessons(forceRefresh);

  if ($homeState.roleKey === ROLE_KEYS.STUDENT) {
    loadStudentPanel($homeState.currentUser);
  } else if ($homeState.roleKey === ROLE_KEYS.TEACHER) {
    loadStaffPanel($homeState.roleKey);
  }
}

export function initializePage(container, params = {}) {
  if ($homeState.isInitialized && $homeState.container === container) {
    return;
  }
  $homeState.container = container;
  $homeState.currentUser = getCurrentUser();
  $homeState.roleKey = resolveUserRole($homeState.currentUser);

  applyRoleGates(container, $homeState.roleKey);
  renderMemberHeader(container, $homeState.currentUser, $homeState.roleKey);

  updateUserStreak($homeState.currentUser);

  loadTopChampions();

  loadRoleDependentSections();

  initAboutCarousel();

  initFeaturesCarousel();

  if (getCurrentRoute()?.name === 'notifications') {
    window.notificationsAPI?.open?.();
  }

  buildTestimonialsUI();
  loadTestimonialsComments(false);

  const startBtns = container.querySelectorAll(HOME_CONFIG.SELECTORS.WELCOME_BTN_START);
  const exploreBtns = container.querySelectorAll(HOME_CONFIG.SELECTORS.WELCOME_BTN_EXPLORE);
  const viewAllChampionsBtn = container.querySelector(HOME_CONFIG.SELECTORS.VIEW_ALL_CHAMPIONS_BTN);

  startBtns.forEach(btn => btn.addEventListener('click', () => handleNavigation('lessons')));
  exploreBtns.forEach(btn => btn.addEventListener('click', () => handleNavigation('lessons')));
  const registerBtns = container.querySelectorAll('[data-action="register-now"]');
  registerBtns.forEach(btn => btn.addEventListener('click', () => handleNavigation('register')));
  if (viewAllChampionsBtn) viewAllChampionsBtn.addEventListener('click', handleViewAllChampions);

  container.querySelectorAll(HOME_CONFIG.SELECTORS.WELCOME_BTN_EXAMS).forEach(btn =>
    btn.addEventListener('click', () => handleNavigation('exams'))
  );
  container.querySelectorAll(HOME_CONFIG.SELECTORS.WELCOME_BTN_DASHBOARD).forEach(btn =>
    btn.addEventListener('click', () => handleNavigation('dashboard'))
  );
  container.querySelectorAll(HOME_CONFIG.SELECTORS.WELCOME_BTN_GROUPS).forEach(btn =>
    btn.addEventListener('click', () => handleNavigation('groups'))
  );

  const unsubUser = EventBus.on('userStateChanged', (detail) => {
    if (detail.action === 'login' || detail.action === 'logout') {
      $homeState.currentUser = getCurrentUser();
      $homeState.roleKey = resolveUserRole($homeState.currentUser);

      applyRoleGates($homeState.container, $homeState.roleKey);
      renderMemberHeader($homeState.container, $homeState.currentUser, $homeState.roleKey);
      updateUserStreak($homeState.currentUser);

      stopAboutCarousel();
      initAboutCarousel();
      stopFeaturesCarousel();
      initFeaturesCarousel();

      loadRoleDependentSections(true);

      $homeState.comments.list = [];
      $homeState.comments.repliesCache.clear();
      $homeState.comments.expandedReplies.clear();
      buildTestimonialsUI();
      loadTestimonialsComments(false);
    }
  });
  $homeState.eventUnsubscribers.push(unsubUser);

  const unsubExamComplete = EventBus.on('exam:complete', () => {
    loadTopChampions(true);
    if ($homeState.roleKey === ROLE_KEYS.STUDENT) {
      loadStudentPanel($homeState.currentUser);
    }
  });
  $homeState.eventUnsubscribers.push(unsubExamComplete);

  const unsubCommentAdded = EventBus.on('comment:added', (detail) => {
    if (detail?.parentId) return;
    loadTestimonialsComments(false);
  });
  $homeState.eventUnsubscribers.push(unsubCommentAdded);

  const unsubCommentDeleted = EventBus.on('comment:deleted', () => {
    updateCommentsCountDisplay();
  });
  $homeState.eventUnsubscribers.push(unsubCommentDeleted);

  const unsubSemesterChanged = EventBus.on('semester:active-changed', () => {
    if ($homeState.roleKey === ROLE_KEYS.STUDENT) {
      loadRecommendedLessons(true);
    }
  });
  $homeState.eventUnsubscribers.push(unsubSemesterChanged);

  $homeState.isInitialized = true;
}

// ==== 17. التنظيف ====

export function cleanupPage() {

  $homeState.eventUnsubscribers.forEach(unsub => unsub());
  $homeState.eventUnsubscribers = [];

  stopAboutCarousel();
  stopFeaturesCarousel();

  const cs = $homeState.comments;
  const handlers = cs.boundHandlers;
  const els = cs.elements;

  if (els.submitBtn && handlers.has('submit')) {
    els.submitBtn.removeEventListener('click', handlers.get('submit'));
  }
  if (els.textarea && handlers.has('input')) {
    els.textarea.removeEventListener('input', handlers.get('input'));
  }
  if (els.loadMoreBtn && handlers.has('loadMore')) {
    els.loadMoreBtn.removeEventListener('click', handlers.get('loadMore'));
  }
  if (els.sortSelect && handlers.has('sort')) {
    els.sortSelect.removeEventListener('change', handlers.get('sort'));
  }
  handlers.clear();

  $homeState.isInitialized = false;
  $homeState.container = null;
  $homeState.currentUser = null;
  $homeState.roleKey = ROLE_KEYS.GUEST;
  $homeState.cache = {
    stats: null, champions: null, testimonials: null,
    recommended: null
  };
  $homeState.carousels = { about: null, features: null };
  $homeState.intervals = { about: null, features: null };
  $homeState.cleanupFns = [];
  $homeState.isLoading = {
    stats: false, champions: false, testimonials: false,
    recommended: false,
    studentPanel: false, staffPanel: false
  };
  $homeState.comments = {
    list: [],
    total: null,
    sort: 'newest',
    lastDoc: null,
    hasMore: false,
    isLoading: false,
    selectedId: null,
    repliesCache: new Map(),
    expandedReplies: new Set(),
    elements: {
      section: null, list: null, textarea: null, counter: null,
      submitBtn: null, cancelReplyBtn: null, loadMoreBtn: null,
      sortSelect: null, replyParentId: null
    },
    boundHandlers: new Map()
  };
}

// ==== 18. تصدير الواجهة العامة ====
export default {
  initializePage,
  cleanupPage
};
