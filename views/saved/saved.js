/**
 * 🔖 views/saved/saved.js - مدير صفحة الدروس المحفوظة v5.0.0
 * ============================================================================
 * 📝 المسؤولية: عرض الدروس التي حفظها المستخدم (المفضلة) في صفحة مستقلة.
 * ✅ متوافق مع router (initializePage / cleanupPage)
 * ✅ يقرأ المفضلة من نفس مصدر lessons.js (الجلسة ثم localStorage) ويزامنها عبر api.js
 * ✅ جلب الدروس دفعة واحدة (getLessonsByIds) مع استبعاد المهملات والامتحانات
 * ✅ RTL كامل، بحث فوري، ترتيب، إزالة من المحفوظات بحركة سلسة
 * ============================================================================
 */

import * as Session from '../../js/core/session.js';
import { getLessonsByIds, getUserProgress, syncUserFavorites } from '../../js/core/api.js';
import { EventBus } from '../../js/core/event-bus.js';

// ==== الثوابت ====
const CONFIG = {
    FAVORITES_KEY: 'biologist_favorites',
    SEARCH_DEBOUNCE_MS: 250,
    SKELETON_COUNT: 6,
    REMOVE_ANIMATION_MS: 320,
    MAX_STAGGER_INDEX: 8
};

const STAGE_ALIASES = { preparatory: 'إعدادي', secondary: 'ثانوي' };
const STAGE_LABELS = { 'إعدادي': 'الإعدادي', 'ثانوي': 'الثانوي' };

const INITIAL_STATE = () => ({
    initialized: false,
    container: null,
    currentUser: null,
    items: [],
    progressMap: new Map(),
    sortMode: 'recent',
    searchTerm: '',
    animateNext: true,
    searchTimer: null,
    removeTimers: new Set(),
    elements: {}
});

let state = INITIAL_STATE();

// ==== أدوات مساعدة ====
const isStudentUser = (user) => user?.user_type === 'student';
const normalizeStage = (stage) => STAGE_ALIASES[stage] || stage || '';
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

// ==== البحث العربي: تجاهل التشكيل وتوحيد الهمزات والتاء المربوطة والأرقام ====
function normalizeArabic(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
        .trim();
}

// ==== صيغ العدد بالعربية ====
function formatLessonsCount(n) {
    if (n === 1) return 'درس واحد';
    if (n === 2) return 'درسان';
    return n >= 3 && n <= 10 ? `${n} دروس` : `${n} درساً`;
}

function formatSavedSummary(n) {
    if (n === 1) return 'لديك درس محفوظ واحد';
    if (n === 2) return 'لديك درسان محفوظان';
    return n >= 3 && n <= 10 ? `لديك ${n} دروس محفوظة` : `لديك ${n} درساً محفوظاً`;
}

function showToast(message, type = 'info') {
    if (window.modals?.toast) {
        window.modals.toast(message, type);
    }
}

function canAccessLesson(lesson) {
    const user = state.currentUser;
    if (!isStudentUser(user)) return true;
    return normalizeStage(user.stage) === normalizeStage(lesson.stage)
        && Number(user.grade) === Number(lesson.grade);
}

// ==== التهيئة والتنظيف ====
export async function initializePage(container) {
    // الـ router يعيد استخدام نفس الحاوية، لذا ننظّف أي حالة سابقة دائماً
    if (state.initialized || state.container) cleanupPage();

    const self = state;
    state.container = container;
    state.currentUser = Session.getCurrentUser();

    try {
        cacheElements(container);
        bindEvents();
        await loadSavedLessons();
        if (state === self) state.initialized = true;
    } catch (error) {
        if (state !== self) return;
        console.error('❌ [saved] فشل تهيئة الصفحة:', error);
        showToast('حدث خطأ أثناء تحميل المحفوظات', 'error');
        renderEmptyState('error');
    }
}

export function cleanupPage() {
    clearTimeout(state.searchTimer);
    state.removeTimers.forEach(timer => clearTimeout(timer));
    state = INITIAL_STATE();
}

function cacheElements(container) {
    state.elements = {
        subtitle: container.querySelector('#saved-subtitle'),
        searchInput: container.querySelector('#saved-search-input'),
        clearSearchBtn: container.querySelector('#saved-clear-search'),
        toolbar: container.querySelector('#saved-toolbar'),
        sortChips: container.querySelectorAll('.saved-sort-chip'),
        count: container.querySelector('#saved-count'),
        grid: container.querySelector('#saved-grid'),
        empty: container.querySelector('#saved-empty'),
        emptyIcon: container.querySelector('#saved-empty-icon'),
        emptyTitle: container.querySelector('#saved-empty-title'),
        emptyText: container.querySelector('#saved-empty-text'),
        emptyBtn: container.querySelector('#saved-empty-btn')
    };
}

// ==== المفضلة (نفس مصدر lessons.js) ====
function getFavorites() {
    if (Array.isArray(state.currentUser?.favorites)) {
        return state.currentUser.favorites.map(String);
    }
    try {
        return JSON.parse(localStorage.getItem(CONFIG.FAVORITES_KEY) || '[]').map(String);
    } catch {
        return [];
    }
}

function setFavorites(favorites) {
    try {
        localStorage.setItem(CONFIG.FAVORITES_KEY, JSON.stringify(favorites));
    } catch (error) {
        console.warn('⚠️ [saved] تعذّر الكتابة في localStorage:', error);
    }
    try {
        if (state.currentUser) state.currentUser.favorites = favorites;
    } catch {
        // كائن الجلسة للقراءة فقط — يُحدَّث عبر updateSessionUser
    }
}

// ==== جلب البيانات ====
async function loadSavedLessons() {
    const { grid } = state.elements;
    if (!state.currentUser) {
        renderEmptyState('guest');
        return;
    }

    const favorites = getFavorites();
    if (favorites.length === 0) {
        renderEmptyState('none');
        return;
    }

    showSkeleton(Math.min(favorites.length, CONFIG.SKELETON_COUNT));

    const self = state;
    const [fetched, progressMap] = await Promise.all([
        getLessonsByIds(favorites),
        loadProgressMap()
    ]);
    if (state !== self) return;

    const lessonsById = new Map(fetched.map(lesson => [String(lesson.id), lesson]));
    const lessons = favorites.map(id => lessonsById.get(id) || null);

    state.progressMap = progressMap;
    state.items = lessons
        .map((lesson, index) => lesson && canAccessLesson(lesson) ? { lesson, savedIndex: index } : null)
        .filter(Boolean)
        .map(item => {
            const progress = progressMap.get(String(item.lesson.id));
            item.lesson.completed = progress?.completed || false;
            item.lesson.progress = progress?.progress || 0;
            return item;
        });

    grid.setAttribute('aria-busy', 'false');
    render();
}

async function loadProgressMap() {
    const user = state.currentUser;
    if (!isStudentUser(user) || !user.id) return new Map();
    try {
        const list = await getUserProgress(user.id);
        return new Map((list || []).map(item => [String(item.lesson_id), item]));
    } catch {
        return new Map();
    }
}

// ==== العرض ====
function getVisibleItems() {
    const tokens = normalizeArabic(state.searchTerm).split(/\s+/).filter(Boolean);
    let items = state.items.filter(({ lesson }) => {
        if (tokens.length === 0) return true;
        const haystack = normalizeArabic(`${lesson.title || ''} ${lesson.description || ''}`);
        return tokens.every(token => haystack.includes(token));
    });

    switch (state.sortMode) {
        case 'oldest':
            items = items.sort((a, b) => a.savedIndex - b.savedIndex);
            break;
        case 'title':
            items = items.sort((a, b) => String(a.lesson.title || '').localeCompare(String(b.lesson.title || ''), 'ar'));
            break;
        default:
            items = items.sort((a, b) => b.savedIndex - a.savedIndex);
    }
    return items;
}

function render() {
    const { grid, toolbar, count, empty, subtitle } = state.elements;
    const total = state.items.length;

    if (subtitle) {
        subtitle.textContent = total > 0 ? formatSavedSummary(total) : 'دروسك المفضلة في مكان واحد';
    }

    if (total === 0) {
        renderEmptyState('none');
        return;
    }

    const visible = getVisibleItems();
    toolbar.hidden = false;
    count.textContent = formatLessonsCount(visible.length);

    if (visible.length === 0) {
        grid.innerHTML = '';
        renderEmptyState('search');
        return;
    }

    empty.hidden = true;
    grid.hidden = false;
    grid.classList.toggle('is-entering', state.animateNext);
    state.animateNext = false;
    grid.innerHTML = visible.map(({ lesson }) => createCard(lesson)).join('');
    decorateCards(grid);
    bindImageFallbacks(grid);
}

// ==== تمرير القيم الديناميكية عبر CSSOM (بدون style مضمّن في HTML) ====
function decorateCards(root) {
    root.querySelectorAll('.saved-card').forEach((card, index) => {
        card.style.setProperty('--saved-i', String(Math.min(index, CONFIG.MAX_STAGGER_INDEX)));
    });
    root.querySelectorAll('.saved-progress-fill').forEach(fill => {
        fill.style.setProperty('--saved-progress', fill.dataset.progress || '0');
    });
}

function createCard(lesson) {
    const isStaff = !isStudentUser(state.currentUser);
    const progress = Math.min(100, Math.max(0, Number(lesson.progress) || 0));
    const completed = !!lesson.completed;
    const inProgress = !completed && progress > 0;

    const coverHtml = lesson.cover_image_url
        ? `<img src="${escapeHtml(lesson.cover_image_url)}" alt="${escapeHtml(lesson.title)}" loading="lazy" decoding="async">`
        : `<div class="saved-cover-placeholder"><i class="fas fa-book-open" aria-hidden="true"></i></div>`;

    const statusHtml = completed
        ? `<span class="saved-status saved-status-completed"><i class="fas fa-check-circle" aria-hidden="true"></i> مكتمل</span>`
        : inProgress
            ? `<span class="saved-status saved-status-inprogress"><i class="fas fa-spinner" aria-hidden="true"></i> قيد التقدم</span>`
            : '';

    const tags = [];
    if (isStaff && lesson.stage) {
        tags.push(`<span class="saved-tag saved-tag-primary">${escapeHtml(STAGE_LABELS[normalizeStage(lesson.stage)] || lesson.stage)}</span>`);
    }
    if (lesson.grade) tags.push(`<span class="saved-tag saved-tag-secondary">الصف ${escapeHtml(String(lesson.grade))}</span>`);
    if (lesson.semester) {
        const semester = lesson.semester === 'أول' ? 'الفصل الأول' : lesson.semester === 'ثاني' ? 'الفصل الثاني' : escapeHtml(lesson.semester);
        tags.push(`<span class="saved-tag saved-tag-success">${semester}</span>`);
    }

    const progressHtml = progress > 0 ? `
        <div class="saved-progress">
            <div class="saved-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
                <div class="saved-progress-fill" data-progress="${progress}"></div>
            </div>
            <span class="saved-progress-text">${progress}%</span>
        </div>` : '';

    return `
        <article class="saved-card ${completed ? 'completed' : ''} ${inProgress ? 'in-progress' : ''}" tabindex="0" data-id="${escapeHtml(String(lesson.id))}" aria-label="${escapeHtml(lesson.title)}">
            <div class="saved-card-cover">
                ${coverHtml}
                <span class="saved-duration"><i class="fas fa-clock" aria-hidden="true"></i> ${Number(lesson.duration) || 0} دقيقة</span>
                ${statusHtml}
                <button type="button" class="saved-unsave-btn" data-id="${escapeHtml(String(lesson.id))}" title="إزالة من المحفوظات" aria-label="إزالة من المحفوظات">
                    <i class="fas fa-bookmark" aria-hidden="true"></i>
                </button>
            </div>
            <div class="saved-card-body">
                <h3 class="saved-card-title">${escapeHtml(lesson.title)}</h3>
                ${lesson.description ? `<p class="saved-card-description">${escapeHtml(lesson.description)}</p>` : ''}
                ${tags.length ? `<div class="saved-card-tags">${tags.join('')}</div>` : ''}
                ${progressHtml}
            </div>
            <div class="saved-card-footer">
                <button type="button" class="btn btn-primary btn-sm saved-start-btn" data-id="${escapeHtml(String(lesson.id))}">
                    <i class="fas fa-play" aria-hidden="true"></i>
                    ${completed ? 'مراجعة' : 'ابدأ الدرس'}
                </button>
            </div>
        </article>`;
}

function showSkeleton(count) {
    const { grid, toolbar, empty } = state.elements;
    empty.hidden = true;
    toolbar.hidden = true;
    grid.hidden = false;
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = Array.from({ length: count }, () => `
        <div class="saved-skeleton" aria-hidden="true">
            <div class="saved-skeleton-block saved-skeleton-cover"></div>
            <div class="saved-skeleton-body">
                <div class="saved-skeleton-block saved-skeleton-line"></div>
                <div class="saved-skeleton-block saved-skeleton-line short"></div>
                <div class="saved-skeleton-block saved-skeleton-btn"></div>
            </div>
        </div>`).join('');
}

function renderEmptyState(type) {
    const { grid, toolbar, empty, emptyIcon, emptyTitle, emptyText, emptyBtn } = state.elements;
    if (!empty) return;

    const variants = {
        none: {
            icon: 'fas fa-bookmark',
            title: 'لا توجد دروس محفوظة',
            text: 'اضغط على أيقونة الحفظ في أي درس لتجده هنا لاحقاً.',
            action: 'lessons', label: 'تصفح الدروس', actionIcon: 'fas fa-book-open'
        },
        search: {
            icon: 'fas fa-search',
            title: 'لا توجد نتائج مطابقة',
            text: `لا يوجد درس محفوظ يطابق "${state.searchTerm}".`,
            action: null
        },
        guest: {
            icon: 'fas fa-user-lock',
            title: 'سجّل الدخول لعرض محفوظاتك',
            text: 'دروسك المحفوظة مرتبطة بحسابك وتظهر لك على كل أجهزتك.',
            action: 'login', label: 'تسجيل الدخول', actionIcon: 'fas fa-sign-in-alt'
        },
        error: {
            icon: 'fas fa-exclamation-triangle',
            title: 'تعذّر تحميل المحفوظات',
            text: 'تحقق من اتصالك بالإنترنت ثم أعد المحاولة.',
            action: 'reload', label: 'إعادة المحاولة', actionIcon: 'fas fa-redo'
        }
    };
    const variant = variants[type] || variants.none;

    grid.innerHTML = '';
    grid.hidden = type !== 'search' ? true : grid.hidden;
    grid.setAttribute('aria-busy', 'false');
    if (type === 'none' || type === 'guest' || type === 'error') toolbar.hidden = true;

    emptyIcon.className = variant.icon;
    emptyTitle.textContent = variant.title;
    emptyText.textContent = variant.text;
    emptyBtn.hidden = !variant.action;
    if (variant.action) {
        emptyBtn.dataset.action = variant.action;
        emptyBtn.innerHTML = `<i class="${variant.actionIcon}" aria-hidden="true"></i><span>${variant.label}</span>`;
    }
    empty.hidden = false;
}

function bindImageFallbacks(root) {
    root.querySelectorAll('.saved-card-cover img').forEach(img => {
        img.addEventListener('error', () => {
            const placeholder = document.createElement('div');
            placeholder.className = 'saved-cover-placeholder';
            placeholder.innerHTML = '<i class="fas fa-book-open" aria-hidden="true"></i>';
            img.replaceWith(placeholder);
        }, { once: true });
    });
}

// ==== الأحداث ====
function bindEvents() {
    const { grid, searchInput, clearSearchBtn, sortChips, emptyBtn } = state.elements;

    grid?.addEventListener('click', (e) => {
        const unsaveBtn = e.target.closest('.saved-unsave-btn');
        if (unsaveBtn) {
            e.stopPropagation();
            handleUnsave(unsaveBtn.dataset.id);
            return;
        }
        const card = e.target.closest('.saved-card');
        if (card) navigateToLesson(card.dataset.id);
    });

    grid?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList?.contains('saved-card')) {
            navigateToLesson(e.target.dataset.id);
        }
    });

    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && searchInput.value) {
            e.preventDefault();
            clearSearchBtn?.click();
        }
    });

    searchInput?.addEventListener('input', () => {
        const value = searchInput.value;
        clearSearchBtn.hidden = !value;
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
            state.searchTerm = value;
            render();
        }, CONFIG.SEARCH_DEBOUNCE_MS);
    });

    clearSearchBtn?.addEventListener('click', () => {
        searchInput.value = '';
        clearSearchBtn.hidden = true;
        state.searchTerm = '';
        render();
        searchInput.focus();
    });

    sortChips?.forEach(chip => {
        chip.addEventListener('click', () => {
            state.sortMode = chip.dataset.sort;
            sortChips.forEach(c => {
                const isActive = c === chip;
                c.classList.toggle('active', isActive);
                c.setAttribute('aria-pressed', String(isActive));
            });
            render();
        });
    });

    emptyBtn?.addEventListener('click', () => {
        const action = emptyBtn.dataset.action;
        if (action === 'reload') {
            window.location.reload();
        } else if (action) {
            window.router?.navigateTo(action);
        }
    });
}

function navigateToLesson(lessonId) {
    if (!state.currentUser) {
        window.router?.navigateTo('login');
        return;
    }
    window.router?.navigateTo('lesson-view', { path: { id: lessonId } });
}

// ==== إزالة درس من المحفوظات ====
async function handleUnsave(lessonId) {
    const id = String(lessonId);
    const favorites = getFavorites().filter(fav => fav !== id);
    setFavorites(favorites);

    const card = state.elements.grid.querySelector(`.saved-card[data-id="${CSS.escape(id)}"]`);
    state.items = state.items.filter(item => String(item.lesson.id) !== id);

    const finish = () => {
        card?.remove();
        render();
    };

    if (card && !prefersReducedMotion()) {
        card.classList.add('is-removing');
        const timer = setTimeout(() => {
            state.removeTimers.delete(timer);
            finish();
        }, CONFIG.REMOVE_ANIMATION_MS);
        state.removeTimers.add(timer);
    } else {
        finish();
    }

    EventBus.emit('lesson:unfavorited', {
        userId: state.currentUser?.id || null,
        lessonId: id,
        date: new Date().toISOString()
    });

    const message = 'تمت إزالة الدرس من المحفوظات';
    if (!state.currentUser?.id) {
        showToast(message, 'success');
        return;
    }

    try {
        await Session.updateSessionUser?.({ favorites });
    } catch (error) {
        console.warn('⚠️ [saved] تعذّر تحديث الجلسة:', error);
    }
    try {
        await syncUserFavorites(state.currentUser.id, favorites);
        showToast(message, 'success');
    } catch (error) {
        console.error('❌ [saved] فشل مزامنة المفضلة مع الخادم:', error);
        showToast('تمت الإزالة محلياً، لكن تعذّرت المزامنة مع حسابك', 'warning');
    }
}
