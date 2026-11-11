/* مدير صفحتي قائمة الدروس وعرض الدرس - v5.0.0 */

import { getCurrentUser, isTeacher, isModerator, updateSessionUser } from '../../js/core/session.js';
import {
    getAllLessons,
    getLessonById,
    toggleLessonLike,
    getUserProgress,
    getUnits,
    updateUserProgress,
    getExamByLessonId,
    searchLessons,
    syncUserFavorites,
    getActiveSemesterFor
} from '../../js/core/api.js';
import { EventBus } from '../../js/core/event-bus.js';

// ==== 1. الثوابت والتكوين ====
// يجب أن تطابق STAGES/GRADES/SEMESTERS في lesson-manager.js (لم تُستورد حتى لا نفرض تحميله على كل مستخدم)
const HIERARCHY = {
    stages: [
        { value: 'إعدادي', label: 'الإعدادي' },
        { value: 'ثانوي', label: 'الثانوي' }
    ],
    grades: [
        { value: 1, label: 'الأول' },
        { value: 2, label: 'الثاني' },
        { value: 3, label: 'الثالث' }
    ],
    semesters: [
        { value: 'أول', label: 'الأول' },
        { value: 'ثاني', label: 'الثاني' }
    ]
};

const CONFIG = {
    LESSONS_PER_PAGE: 50,
    SKELETON_COUNT: 12,
    // عدد الصفحات المتتالية المجلوبة تلقائيًا ليعمل الفلتر والترتيب على مجموعة كاملة
    MAX_AUTO_PAGES: 6,
    // أقل نسبة مشاهدة لتفعيل "إنهاء الدرس" للطالب (0 لإلغاء الشرط)
    COMPLETE_MIN_PERCENT: 80,
    SEARCH_DEBOUNCE_MS: 300,
    SCROLL_THRESHOLD: 250,
    PROGRESS_SAVE_INTERVAL_SEC: 10,
    PROGRESS_SAVE_STEP_PERCENT: 10,
    FAVORITES_KEY: 'biologist_favorites',
    PAGE_TYPE_LIST: 'list',
    PAGE_TYPE_VIEW: 'view',
    RECOMMENDATIONS_COUNT: 4
};

// ==== 2. الحالة الداخلية الأولية ====
const INITIAL_STATE = () => ({
    initialized: false,
    container: null,
    pageType: null,
    lessonId: null,
    currentUser: null,
    lessons: [],
    units: [],
    filteredLessons: [],
    isLoading: false,
    isLoadingMore: false,
    activeCategory: 'all',
    searchTerm: '',
    activeUnitId: null,
    // سياق تصفح المعلم فقط، لا علاقة له بما يظهر فعليًا للطلاب
    activeStage: null,
    activeGrade: null,
    workingSemester: null,
    treeStageShown: null,
    treeGradeShown: null,
    liveSemesterCache: {},
    lastCreatedAt: null,
    lastId: null,
    hasMore: true,
    lessonData: null,
    examData: null,
    watchStartTime: null,
    watchInterval: null,
    watchProgress: 0,
    totalTimeSpent: 0,
    sessionActiveSec: 0,
    lastTickAt: 0,
    lastSavedPercent: 0,
    lastSaveTs: 0,
    progressMap: null,
    semesterPromise: null,
    semesterPromiseKey: null,
    pendingReload: false,
    visibilityHandler: null,
    isCompleting: false,
    isLiking: false,
    recommendedLessons: [],
    renderedCardIds: new Set(),
    elements: {},
    searchDebounceTimer: null,
    scrollHandler: null,
    eventUnsubscribers: []
});

let state = INITIAL_STATE();

const STAGE_ALIASES = { preparatory: 'إعدادي', secondary: 'ثانوي' };
const STAGE_LABELS = { 'إعدادي': 'المرحلة الإعدادية', 'ثانوي': 'المرحلة الثانوية' };

const isStaffUser = (user) => !!user && (isTeacher(user) || isModerator(user));

const isLatestMode = () => isStaffUser(state.currentUser) && (!state.activeStage || state.activeGrade === null);

function getCreatedMs(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    if (typeof value._seconds === 'number') return value._seconds * 1000;
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
}

function showElement(el, display = '') {
    if (!el) return;
    el.removeAttribute('data-ui-initial');
    el.style.display = display;
}

function isElementHidden(el) {
    return el.style.display === 'none' || (el.hasAttribute('data-ui-initial') && !el.style.display);
}

const isStudentUser = (user) => user?.user_type === 'student';
const normalizeStage = (stage) => STAGE_ALIASES[stage] || stage || '';

function canStudentAccessLesson(lesson) {
    const user = state.currentUser;
    if (!isStudentUser(user)) return true;
    return normalizeStage(user.stage) === normalizeStage(lesson.stage)
        && Number(user.grade) === Number(lesson.grade);
}

function getTotalElapsedSec() {
    return Math.floor(state.totalTimeSpent + state.sessionActiveSec);
}

// يقبل روابط http/https فقط (منع javascript: وغيرها)
function toSafeHttpUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(String(url).trim(), window.location.origin);
        return (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? parsed.href : '';
    } catch {
        return '';
    }
}

async function getProgressMap() {
    const self = state;
    const user = self.currentUser;
    if (!user?.id) return new Map();
    if (self.progressMap) return self.progressMap;
    const list = await getUserProgress(user.id);
    const map = new Map();
    (list || []).forEach(item => map.set(String(item.lesson_id), item));
    if (state === self) self.progressMap = map;
    return map;
}

function getStudentSemester(user = state.currentUser) {
    const key = `${user.stage}_${user.grade}`;
    if (!state.semesterPromise || state.semesterPromiseKey !== key) {
        const self = state;
        self.semesterPromiseKey = key;
        self.semesterPromise = getActiveSemesterFor(user.stage, user.grade).catch(error => {
            if (state === self) self.semesterPromise = null;
            throw error;
        });
    }
    return state.semesterPromise;
}

function bindImageFallbacks(root, selector, wrapperClass = '') {
    root.querySelectorAll(selector).forEach(img => {
        img.addEventListener('error', () => {
            const icon = document.createElement('i');
            icon.className = 'fas fa-book-open';
            icon.setAttribute('aria-hidden', 'true');
            if (!wrapperClass) {
                img.replaceWith(icon);
                return;
            }
            const placeholder = document.createElement('div');
            placeholder.className = wrapperClass;
            placeholder.appendChild(icon);
            img.replaceWith(placeholder);
        }, { once: true });
    });
}

// ==== 3. دوال التهيئة والتنظيف ====

export async function initializePage(container, params = {}) {
    if (state.initialized && state.container === container) return;
    await initCommon(container, CONFIG.PAGE_TYPE_LIST, params);
}

export async function initLessonViewPage(container, params = {}) {
    if (state.initialized && state.container === container) return;

    const lessonId = params.path?.id;
    if (!lessonId) {
        console.error('❌ [lessons] معرف الدرس مفقود');
        window.router?.navigateTo('not-found');
        return;
    }

    await initCommon(container, CONFIG.PAGE_TYPE_VIEW, { ...params, lessonId });
}

async function initCommon(container, pageType, params) {
    if (state.initialized) await _cleanup();

    state.container = container;
    state.pageType = pageType;
    state.currentUser = getCurrentUser();
    if (pageType === CONFIG.PAGE_TYPE_VIEW) {
        state.lessonId = params.lessonId;
    }

    try {
        cacheElements(container);

        if (pageType === CONFIG.PAGE_TYPE_LIST) {
            setupUIForList();
            bindListEvents();
            await loadInitialListData();
        } else {
            setupUIForView();
            bindViewEvents();
            await loadLessonData(state.lessonId);
        }

        state.initialized = true;
        EventBus.emit('page:ready', {
            page: pageType === CONFIG.PAGE_TYPE_LIST ? 'lessons' : 'lesson-view'
        });
    } catch (error) {
        console.error('❌ [lessons] فشل تهيئة الصفحة:', error);
        showToast('حدث خطأ أثناء تحميل الصفحة', 'error');
        showErrorState(container, error);
    }
}

export async function cleanupPage() {
    await _cleanup();
}

export async function cleanupLessonViewPage() {
    if (state.watchStartTime && isStudentUser(state.currentUser) && state.lessonId) {
        try {
            await updateUserProgress(
                state.currentUser.id,
                state.lessonId,
                state.watchProgress,
                getTotalElapsedSec()
            );
        } catch (_) { }
    }
    await _cleanup();
}

async function _cleanup() {
    if (state.watchInterval) {
        clearInterval(state.watchInterval);
    }
    if (state.searchDebounceTimer) {
        clearTimeout(state.searchDebounceTimer);
    }
    if (state.visibilityHandler) {
        document.removeEventListener('visibilitychange', state.visibilityHandler);
        window.removeEventListener('pagehide', state.visibilityHandler);
    }
    if (state.scrollHandler) {
        window.removeEventListener('scroll', state.scrollHandler);
    }
    state.eventUnsubscribers.forEach(fn => fn());

    document.querySelectorAll('.lesson-confetti').forEach(el => el.remove());

    state = INITIAL_STATE();
}

// ==== 4. دوال مساعدة DOM ====

function cacheElements(container) {
    const isList = state.pageType === CONFIG.PAGE_TYPE_LIST;
    state.elements = {
        loadingState: container.querySelector('.loading-state'),
        ...(isList ? {
            lessonsGrid: container.querySelector('#lessons-grid'),
            unitsContainer: container.querySelector('#units-container'),
            unitsTitleIcon: container.querySelector('#units-title-icon'),
            unitsTitleText: container.querySelector('#units-title-text'),
            sectionCount: container.querySelector('#section-count'),
            categoryBtns: container.querySelectorAll('.category-btn'),
            categoriesContainer: container.querySelector('.categories-container'),
            categoriesTitle: container.querySelector('#categories-title'),
            statsSummary: container.querySelector('.stats-summary'),
            emptyState: container.querySelector('#lessons-empty-state'),
            emptyStateMessage: container.querySelector('#empty-state-message'),
            clearFiltersBtn: container.querySelector('#clear-filters-btn'),
            loadMoreBtn: container.querySelector('#load-more-lessons'),
            loadMoreContainer: container.querySelector('.load-more-container'),
            searchInput: container.querySelector('#lessons-search-input'),
            clearSearchBtn: container.querySelector('#clear-search-btn'),
            totalLessonsEl: container.querySelector('[data-stat="total-lessons"]'),
            completedLessonsEl: container.querySelector('[data-stat="completed-lessons"]'),
            completionRateEl: container.querySelector('[data-stat="completion-rate"]'),
            favoriteLessonsEl: container.querySelector('[data-stat="favorite-lessons"]'),
            subtitleEl: container.querySelector('#lessons-subtitle'),
            addLessonBtn: container.querySelector('[data-action="add-lesson"]'),
            addUnitBtn: container.querySelector('[data-action="add-unit"]')
        } : {
            introSection: container.querySelector('#lesson-intro-section'),
            screenSection: container.querySelector('#lesson-screen-section'),
            resultsSection: container.querySelector('#lesson-results-section'),
            backToLessonsBtn: container.querySelector('[data-action="back-to-lessons"]'),
            breadcrumbTitle: container.querySelector('#breadcrumb-lesson-title'),
            lessonTitle: container.querySelector('#lesson-title'),
            lessonDescription: container.querySelector('#lesson-description'),
            stageBadge: container.querySelector('#lesson-stage-badge'),
            gradeBadge: container.querySelector('#lesson-grade-badge'),
            semesterBadge: container.querySelector('#lesson-semester-badge'),
            unitBadge: container.querySelector('#lesson-unit-badge'),
            durationEl: container.querySelector('#lesson-duration'),
            likesCountEl: container.querySelector('#likes-count'),
            videoContainer: container.querySelector('#video-container'),
            pdfContainer: container.querySelector('#pdf-container'),
            pdfBtn: container.querySelector('[data-action="download-pdf"]'),
            likeBtn: container.querySelector('#lesson-like-btn'),
            startBtn: container.querySelector('[data-action="start-lesson"]'),
            completeBtn: container.querySelector('[data-action="complete-lesson"]'),
            favoriteBtn: container.querySelector('[data-action="toggle-favorite"]'),
            editLessonBtn: container.querySelector('[data-action="edit-lesson"]'),
            deleteLessonBtn: container.querySelector('[data-action="delete-lesson"]'),
            examBtnContainer: container.querySelector('#exam-btn-container'),
            examCardContainer: container.querySelector('#exam-card-container'),
            startExamBtn: container.querySelector('#start-lesson-exam-btn'),
            timerValue: container.querySelector('#timer-value'),
            progressPercentage: container.querySelector('#lesson-progress-percentage'),
            progressBarFill: container.querySelector('#lesson-progress-bar'),
            timeSpent: container.querySelector('#time-spent'),
            lastWatched: container.querySelector('#last-watched'),
            teacherWidget: container.querySelector('.teacher-only'),
            recommendationsContainer: container.querySelector('#recommendations-container'),
            coverImage: container.querySelector('#lesson-cover-image'),
            coverWrapper: container.querySelector('#lesson-cover-wrapper'),
            introContent: container.querySelector('.intro-content'),
            screenTitleSpan: container.querySelector('#lesson-screen-title-span')
        })
    };
}

// ==== 5. إعداد واجهة القائمة حسب الصلاحيات ====
function setupUIForList() {
    const user = state.currentUser;
    const isAdmin = isStaffUser(user);

    if (state.elements.addLessonBtn) {
        state.elements.addLessonBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    if (state.elements.addUnitBtn) {
        state.elements.addUnitBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    if (state.elements.statsSummary) {
        state.elements.statsSummary.style.display = isStudentUser(user) ? 'block' : 'none';
    }

    if (state.elements.subtitleEl) {
        if (isAdmin) {
            state.elements.subtitleEl.textContent = 'إدارة جميع الدروس والوحدات';
        } else if (user) {
            renderStudentSubtitle();
        } else {
            state.elements.subtitleEl.textContent = 'سجّل الدخول لعرض دروسك';
        }
    }

    // الطالب يرى فصله الحالي فقط، فلا معنى لتصنيفَي الترم الأول/الثاني
    if (isStudentUser(user)) {
        state.elements.categoryBtns?.forEach(btn => {
            if (btn.dataset.category === 'first' || btn.dataset.category === 'second') {
                btn.style.display = 'none';
            }
        });
    }

    if (isAdmin) {
        if (state.elements.categoriesTitle) {
            state.elements.categoriesTitle.textContent = 'تصفح حسب المرحلة والصف';
        }
        renderTeacherCategoryTree();
    }
}

function renderStudentSubtitle(liveSemester = null) {
    const user = state.currentUser;
    const el = state.elements.subtitleEl;
    if (!user || !el) return;

    const stageMap = { 'إعدادي': 'المرحلة الإعدادية', 'ثانوي': 'المرحلة الثانوية' };
    const stage = normalizeStage(user.stage);
    const parts = [
        stageMap[stage] || stage,
        user.grade ? `الصف ${user.grade}` : '',
        liveSemester ? `الفصل ${liveSemester === 'أول' ? 'الأول' : 'الثاني'}` : ''
    ].filter(Boolean);
    el.textContent = parts.join(' – ') || 'حسب مرحلتك';

    if (liveSemester === null && user.stage && user.grade) {
        getStudentSemester(user)
            .then(semester => {
                if (state.currentUser?.id === user.id) renderStudentSubtitle(semester);
            })
            .catch(() => { });
    }
}

// ==== 6. إعداد واجهة عرض الدرس حسب الصلاحيات ====
function setupUIForView() {
    const user = state.currentUser;
    const isAdmin = isStaffUser(user);

    if (state.elements.teacherWidget) {
        state.elements.teacherWidget.style.display = isAdmin ? 'flex' : 'none';
    }
    if (state.elements.editLessonBtn) {
        state.elements.editLessonBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    if (state.elements.deleteLessonBtn) {
        state.elements.deleteLessonBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    if (state.elements.pdfBtn) {
        state.elements.pdfBtn.style.display = 'none';
    }
}

// ==== 7. جلب بيانات قائمة الدروس ====

async function loadInitialListData() {
    await loadListData(true);
}

async function loadListData(resetPagination = false) {
    if (state.isLoading) {
        // طلب إعادة تحميل أثناء تحميل جارٍ يُؤجَّل بدل أن يُتجاهل
        if (resetPagination) state.pendingReload = true;
        return;
    }
    const self = state;
    self.isLoading = true;
    showLoading(true);

    if (resetPagination) {
        self.lastCreatedAt = null;
        self.lastId = null;
        self.hasMore = true;
        self.lessons = [];
        showSkeletonGrid(CONFIG.SKELETON_COUNT);
    }

    try {
        // فشل جلب الوحدات لا يمنع عرض الدروس
        if (resetPagination) {
            const units = await fetchUnits().catch(error => {
                console.error('❌ [lessons] فشل جلب الوحدات:', error);
                return [];
            });
            if (state !== self) return;
            self.units = units;
            if (self.activeUnitId !== null && !self.units.some(u => u.id == self.activeUnitId)) {
                self.activeUnitId = null;
            }
            renderUnitsCarousel();
        }

        let pages = 0;
        do {
            const newLessons = await fetchLessons(
                self.lastCreatedAt ? { created_at: self.lastCreatedAt, id: self.lastId } : null
            );
            if (state !== self) return;

            self.lessons = [...self.lessons, ...newLessons];

            // نتائج البحث لا تدعم الترقيم، وأي صفحة ناقصة تعني نهاية البيانات
            if (self.searchTerm || newLessons.length < CONFIG.LESSONS_PER_PAGE) {
                self.hasMore = false;
            } else {
                const last = newLessons[newLessons.length - 1];
                self.lastCreatedAt = last.created_at;
                self.lastId = last.id;
            }
            pages++;
        } while (self.hasMore && pages < CONFIG.MAX_AUTO_PAGES);

        // ننهي حالة التحميل قبل الرسم لتظهر حالة "لا توجد دروس" عند الحاجة
        self.isLoading = false;
        applyFiltersAndRender({ keepAnimated: !resetPagination });
        renderUnitsCarousel();
        updateStatsSummary();
        updateLoadMoreButton();

        if (isStaffUser(self.currentUser)) {
            renderTeacherCategoryTree();
        }

    } catch (error) {
        if (state !== self) return;
        console.error('❌ [lessons] فشل جلب البيانات:', error);
        showToast('تعذر تحميل الدروس', 'error');
        if (resetPagination) renderEmptyState(true);
    } finally {
        if (state === self) {
            self.isLoading = false;
            self.isLoadingMore = false;
            showLoading(false);
            if (self.pendingReload) {
                self.pendingReload = false;
                loadListData(true);
            }
        }
    }
}

async function loadMoreLessons() {
    if (state.isLoadingMore || !state.hasMore || state.isLoading) return;
    state.isLoadingMore = true;
    updateLoadMoreButton();
    await loadListData(false);
}

async function fetchLessons(startAfter = null, filters = {}) {
    const user = state.currentUser;
    const searchTerm = filters.searchTerm !== undefined ? filters.searchTerm : state.searchTerm;
    const options = { limit: CONFIG.LESSONS_PER_PAGE };

    if (startAfter?.created_at) {
        options.startAfterCreatedAt = startAfter.created_at;
        options.lastId = startAfter.id;
    }

    // الطالب يرى دروس مرحلته فقط والفصل "حي" بقرار المعلم، والمعلم/المشرف يرى كل الدروس
    if (isStudentUser(user)) {
        if (!user.stage || !user.grade) return [];
        options.stage = user.stage;
        options.grade = user.grade;
        options.semester = await getStudentSemester(user);
    }

    let lessons;
    if (searchTerm) {
        try {
            lessons = await searchLessons(searchTerm, options);
        } catch (error) {
            console.error('❌ [lessons] فشل البحث على الخادم:', error);
            showToast('تعذر إتمام البحث، جرّب لاحقاً', 'error');
            lessons = [];
        }
    } else {
        lessons = await getAllLessons(options);
    }

    if (!Array.isArray(lessons)) lessons = [];

    if (isStudentUser(user)) {
        const progressMap = await getProgressMap();
        lessons.forEach(lesson => {
            const prog = progressMap.get(String(lesson.id));
            lesson.completed = prog?.completed || false;
            lesson.progress = prog?.progress || 0;
        });
    }

    const favorites = getFavorites();
    lessons.forEach(lesson => {
        lesson.is_favorite = favorites.includes(String(lesson.id));
    });

    return lessons;
}

async function fetchUnits(lessonScope = null) {
    const user = state.currentUser;
    if (lessonScope) {
        return await getUnits({ stage: lessonScope.stage, grade: lessonScope.grade });
    }
    if (isStudentUser(user)) {
        if (!user.stage || !user.grade) return [];
        return await getUnits({
            stage: user.stage,
            grade: user.grade,
            semester: await getStudentSemester(user)
        });
    }
    return await getUnits();
}

// ==== 8. فلترة وعرض القائمة ====

function applyFiltersAndRender({ keepAnimated = false } = {}) {
    let filtered = [...state.lessons];

    const latest = isLatestMode();

    if (state.activeUnitId !== null && !latest) {
        filtered = filtered.filter(l => l.unit_id == state.activeUnitId);
    }

    if (state.activeStage) {
        filtered = filtered.filter(l => l.stage === state.activeStage);
    }
    if (state.activeGrade !== null) {
        filtered = filtered.filter(l => Number(l.grade) === state.activeGrade);
    }
    if (state.workingSemester) {
        filtered = filtered.filter(l => l.semester === state.workingSemester);
    }

    switch (state.activeCategory) {
        case 'first':
            filtered = filtered.filter(l => l.semester === 'أول');
            break;
        case 'second':
            filtered = filtered.filter(l => l.semester === 'ثاني');
            break;
        case 'favorites':
            filtered = filtered.filter(l => l.is_favorite);
            break;
        case 'completed':
            filtered = filtered.filter(l => l.completed);
            break;
    }

    if (state.searchTerm) {
        const term = state.searchTerm.toLowerCase().trim();
        filtered = filtered.filter(l =>
            l.title?.toLowerCase().includes(term) ||
            l.description?.toLowerCase().includes(term)
        );
    }

    if (latest) {
        filtered.sort((a, b) => getCreatedMs(b.created_at) - getCreatedMs(a.created_at));
    } else {
        filtered.sort((a, b) => {
            const unitA = state.units.find(u => u.id == a.unit_id);
            const unitB = state.units.find(u => u.id == b.unit_id);
            const unitOrderDiff = (unitA?.order || 0) - (unitB?.order || 0);
            if (unitOrderDiff !== 0) return unitOrderDiff;
            return (a.order || 0) - (b.order || 0);
        });
    }

    state.filteredLessons = filtered;
    updateSectionHeader();

    renderLessonsGrid(filtered, { keepAnimated });
    updateEmptyStateVisibility();
    updateClearFiltersButton();
}

function updateSectionHeader() {
    const { unitsTitleIcon, unitsTitleText, sectionCount } = state.elements;
    if (!unitsTitleText) return;
    const latest = isLatestMode();
    unitsTitleText.textContent = latest ? 'أحدث الدروس' : 'الوحدات والأبواب';
    if (unitsTitleIcon) unitsTitleIcon.className = latest ? 'fas fa-clock' : 'fas fa-layer-group';
    if (sectionCount) {
        sectionCount.hidden = !latest;
        if (latest) sectionCount.textContent = `${state.filteredLessons.length} درس`;
    }
}

function renderUnitsCarousel() {
    const container = state.elements.unitsContainer;
    if (!container) return;

    const isAdmin = isStaffUser(state.currentUser);

    updateSectionHeader();
    if (isLatestMode()) {
        container.hidden = true;
        return;
    }
    container.hidden = false;

    const inScope = (item) => !isAdmin || (
        (!state.activeStage || item.stage === state.activeStage) &&
        (state.activeGrade === null || Number(item.grade) === state.activeGrade) &&
        (!state.workingSemester || item.semester === state.workingSemester)
    );

    const visibleUnits = state.units.filter(inScope);
    const scopedLessons = state.lessons.filter(inScope);
    const unitCount = (unit) => Math.max(
        unit.lessons_count || 0,
        scopedLessons.filter(l => l.unit_id == unit.id).length
    );

    if (visibleUnits.length === 0) {
        container.innerHTML = `<div class="units-empty">
            <i class="fas fa-folder-open"></i>
            <p>لا توجد وحدات متاحة</p>
        </div>`;
        return;
    }

    const totalCount = Math.max(
        visibleUnits.reduce((sum, unit) => sum + unitCount(unit), 0),
        scopedLessons.length
    );

    const allBtn = `<div class="unit-card ${state.activeUnitId === null ? 'active' : ''}" data-unit-id="all" role="button" tabindex="0" aria-pressed="${state.activeUnitId === null}">
        <div class="unit-card-main">
            <div class="unit-icon"><i class="fas fa-th-large"></i></div>
            <h4 class="unit-name">الكل</h4>
            <span class="unit-count">${totalCount} درس</span>
        </div>
    </div>`;

    const unitActionsHtml = (unit) => isAdmin ? `
        <div class="unit-card-actions">
            <button type="button" class="action-btn edit-btn" data-unit-action="edit" data-unit-id="${unit.id}" title="تعديل الوحدة" aria-label="تعديل الوحدة">
                <i class="fas fa-edit" aria-hidden="true"></i>
            </button>
            <button type="button" class="action-btn delete-btn" data-unit-action="delete" data-unit-id="${unit.id}" title="حذف الوحدة" aria-label="حذف الوحدة">
                <i class="fas fa-trash-alt" aria-hidden="true"></i>
            </button>
        </div>` : '';

    const unitsHtml = visibleUnits.map(unit => `
        <div class="unit-card ${state.activeUnitId == unit.id ? 'active' : ''}" data-unit-id="${unit.id}" role="button" tabindex="0" aria-pressed="${state.activeUnitId == unit.id}">
            <div class="unit-card-main">
                <div class="unit-icon"><i class="fas fa-layer-group"></i></div>
                <h4 class="unit-name">${escapeHtml(unit.name)}</h4>
                <span class="unit-count">${unitCount(unit)} درس</span>
            </div>
            ${unitActionsHtml(unit)}
        </div>`).join('');

    container.innerHTML = allBtn + unitsHtml;

    const selectUnit = (card) => {
        const val = card.dataset.unitId;
        const newId = val === 'all' ? null : parseInt(val);
        state.activeUnitId = (state.activeUnitId === newId) ? null : newId;
        container.querySelectorAll('.unit-card').forEach(c => {
            const cVal = c.dataset.unitId;
            const cId = cVal === 'all' ? null : parseInt(cVal);
            const isActive = cId === state.activeUnitId;
            c.classList.toggle('active', isActive);
            c.setAttribute('aria-pressed', String(isActive));
        });
        applyFiltersAndRender();
        updateClearFiltersButton();
    };

    container.querySelectorAll('.unit-card').forEach(card => {
        card.addEventListener('click', () => selectUnit(card));
        card.addEventListener('keydown', (e) => {
            if (e.target !== card) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectUnit(card);
            }
        });
    });

    container.querySelectorAll('[data-unit-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const unit = state.units.find(u => u.id == btn.dataset.unitId);
            if (!unit) return;
            if (btn.dataset.unitAction === 'edit') {
                callLessonManager('openEditUnitModal', unit);
            } else {
                callLessonManager('confirmDeleteUnit', unit);
            }
        });
    });
}

function renderLessonsGrid(lessons, { keepAnimated = false } = {}) {
    const grid = state.elements.lessonsGrid;
    if (!grid) return;

    if (!lessons || lessons.length === 0) {
        grid.innerHTML = '';
        state.renderedCardIds = new Set();
        return;
    }

    const isAdmin = isStaffUser(state.currentUser);
    const known = keepAnimated ? state.renderedCardIds : new Set();

    grid.innerHTML = lessons
        .map(lesson => createLessonCard(lesson, isAdmin, known.has(String(lesson.id))))
        .join('');
    state.renderedCardIds = new Set(lessons.map(l => String(l.id)));
    bindImageFallbacks(grid, '.lesson-card-cover img', 'cover-placeholder-inner');

    grid.querySelectorAll('.lesson-card').forEach(card => {
        const id = card.dataset.id;

        card.addEventListener('click', (e) => {
            if (e.target.closest('.lesson-card-tools')) return;
            if (e.target.closest('button') && !e.target.closest('.lesson-tools-toggle')) return;
            if (isAdmin) {
                toggleCardTools(card, grid);
                return;
            }
            navigateToLesson(id);
        });

        const startBtn = card.querySelector('.start-lesson-btn');
        startBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateToLesson(id);
        });

        const saveBtn = card.querySelector('.lesson-save-btn');
        saveBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleToggleFavorite(id);
        });
    });

    if (isAdmin) {
        bindAdminActions(grid);
    }
}

function createLessonCard(lesson, isAdmin, isKnown = false) {
    const rawProgress = Number(lesson.progress) || 0;
    const progress = Math.min(100, Math.max(0, rawProgress));
    const completed = lesson.completed || false;
    const inProgress = !completed && progress > 0;
    const isFavorite = lesson.is_favorite || false;

    const coverHtml = lesson.cover_image_url
        ? `<img src="${escapeHtml(lesson.cover_image_url)}" alt="${escapeHtml(lesson.title)}" loading="lazy" decoding="async">`
        : `<div class="cover-placeholder-inner"><i class="fas fa-book-open" aria-hidden="true"></i></div>`;

    const statusBadgeHtml = completed
        ? `<span class="lesson-status-badge status-completed completed-badge"><i class="fas fa-check-circle" aria-hidden="true"></i> مكتمل</span>`
        : inProgress
            ? `<span class="lesson-status-badge status-inprogress"><i class="fas fa-spinner" aria-hidden="true"></i> قيد التقدم</span>`
            : '<span></span>';
    const durationBadgeHtml = `<span class="lesson-duration-badge"><i class="fas fa-clock" aria-hidden="true"></i> ${lesson.duration || 0} دقيقة</span>`;

    const tagsParts = [];
    if (lesson.grade) tagsParts.push(`<span class="lesson-tag lesson-tag-secondary">الصف ${escapeHtml(String(lesson.grade))}</span>`);
    if (lesson.semester) tagsParts.push(`<span class="lesson-tag lesson-tag-success">${lesson.semester === 'أول' ? 'الفصل الأول' : lesson.semester === 'ثاني' ? 'الفصل الثاني' : escapeHtml(lesson.semester)}</span>`);
    const metaHtml = tagsParts.length
        ? `<div class="lesson-card-meta"><div class="lesson-card-tags">${tagsParts.join('')}</div></div>`
        : '';

    const progressHtml = progress > 0 ? `
        <div class="lesson-progress">
            <div class="progress-bar-container" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
                <div class="progress-bar-fill" style="width:${progress}%"></div>
            </div>
            <span class="progress-text">${progress}%</span>
        </div>` : '';

    const adminActionsHtml = isAdmin ? `
        <div class="lesson-card-tools" id="lesson-tools-${lesson.id}">
            <div class="lesson-card-tools-inner">
                <div class="lesson-card-admin-actions teacher-only" role="group" aria-label="إجراءات الدرس">
                    <button type="button" class="action-btn edit-btn" data-action="edit" data-id="${lesson.id}" title="تعديل الدرس" aria-label="تعديل الدرس">
                        <i class="fas fa-edit" aria-hidden="true"></i><span>تعديل</span>
                    </button>
                    <button type="button" class="action-btn move-btn" data-action="move" data-id="${lesson.id}" title="تحريك الدرس" aria-label="تحريك الدرس">
                        <i class="fas fa-arrows-alt-v" aria-hidden="true"></i><span>نقل</span>
                    </button>
                    <button type="button" class="action-btn delete-btn" data-action="delete" data-id="${lesson.id}" title="حذف الدرس" aria-label="حذف الدرس">
                        <i class="fas fa-trash-alt" aria-hidden="true"></i><span>حذف</span>
                    </button>
                </div>
            </div>
        </div>` : '';

    const toolsToggleHtml = isAdmin ? `
        <button type="button" class="lesson-tools-toggle" aria-expanded="false" aria-controls="lesson-tools-${lesson.id}" title="أدوات المعلم" aria-label="أدوات المعلم">
            <i class="fas fa-sliders-h" aria-hidden="true"></i>
        </button>` : '';

    const favLabel = isFavorite ? 'إزالة من المحفوظات' : 'حفظ الدرس';

    return `
        <div class="lesson-card ${completed ? 'completed' : ''} ${inProgress ? 'in-progress' : ''} ${isFavorite ? 'favorited' : ''} ${isKnown ? 'is-static' : ''}" data-id="${lesson.id}" role="article" aria-label="${escapeHtml(lesson.title)}">
            <div class="lesson-card-cover">
                ${coverHtml}
                <div class="lesson-card-badges">
                    ${statusBadgeHtml}
                    ${durationBadgeHtml}
                </div>
                <div class="lesson-play-overlay" aria-hidden="true"><i class="fas fa-play"></i></div>
                <button type="button" class="lesson-save-btn ${isFavorite ? 'active' : ''}" data-id="${lesson.id}" title="${favLabel}" aria-label="${favLabel}" aria-pressed="${isFavorite}">
                    <i class="${isFavorite ? 'fas fa-bookmark' : 'far fa-bookmark'}" aria-hidden="true"></i>
                </button>
            </div>
            <div class="lesson-card-body">
                <div class="lesson-card-header">
                    <h3 class="lesson-title">${escapeHtml(lesson.title)}</h3>
                    ${lesson.description ? `<p class="lesson-description">${escapeHtml(lesson.description)}</p>` : ''}
                </div>
                ${metaHtml}
                ${progressHtml}
            </div>
            <div class="lesson-card-footer ${isAdmin ? 'has-admin' : ''}">
                ${adminActionsHtml}
                <button type="button" class="btn btn-primary btn-sm start-lesson-btn" data-id="${lesson.id}">
                    <i class="fas fa-play" aria-hidden="true"></i>
                    ${completed ? 'مراجعة' : 'ابدأ الدرس'}
                </button>
                ${toolsToggleHtml}
            </div>
        </div>`;
}

// ==== 9. التحميل الهيكلي (Skeleton) ====

function renderSkeletonCards(count = CONFIG.SKELETON_COUNT) {
    const safeCount = Math.max(1, Math.min(count, CONFIG.SKELETON_COUNT));
    const singleCard = `
        <div class="lesson-card-skeleton" aria-hidden="true">
            <div class="skeleton-block skeleton-cover"></div>
            <div class="skeleton-body">
                <div class="skeleton-block skeleton-line skeleton-title-line"></div>
                <div class="skeleton-block skeleton-line skeleton-title-line-short"></div>
                <div class="skeleton-block skeleton-line skeleton-desc-line"></div>
                <div class="skeleton-block skeleton-line skeleton-desc-line-short"></div>
                <div class="skeleton-tags">
                    <div class="skeleton-block skeleton-tag"></div>
                    <div class="skeleton-block skeleton-tag"></div>
                </div>
            </div>
            <div class="skeleton-footer">
                <div class="skeleton-block"></div>
                <div class="skeleton-block"></div>
            </div>
        </div>`;
    return Array.from({ length: safeCount }, () => singleCard).join('');
}

// للتحميل الأولي فقط، لا أثناء "تحميل المزيد"
function showSkeletonGrid(count) {
    const grid = state.elements.lessonsGrid;
    if (!grid) return;
    if (state.elements.emptyState) state.elements.emptyState.style.display = 'none';
    grid.style.display = 'grid';
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = renderSkeletonCards(count);
}

function setCardTools(card, open) {
    card.classList.toggle('tools-open', open);
    card.querySelector('.lesson-tools-toggle')?.setAttribute('aria-expanded', String(open));
}

function toggleCardTools(card, grid) {
    const open = !card.classList.contains('tools-open');
    if (open) {
        grid.querySelectorAll('.lesson-card.tools-open').forEach(other => {
            if (other !== card) setCardTools(other, false);
        });
    }
    setCardTools(card, open);
    if (!open) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => {
        if (!card.classList.contains('tools-open')) return;
        card.querySelector('.lesson-card-footer')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
    }, reduce ? 0 : 420);
}

function bindAdminActions(grid) {
    grid.querySelectorAll('[data-action="edit"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditLessonModal(btn.dataset.id);
        });
    });
    grid.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openDeleteConfirmModal(btn.dataset.id);
        });
    });
    grid.querySelectorAll('[data-action="move"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openMoveLessonModal(btn.dataset.id);
        });
    });
}

function renderEmptyState(isError = false) {
    const grid = state.elements.lessonsGrid;
    const emptyState = state.elements.emptyState;
    if (!grid || !emptyState) return;

    grid.innerHTML = '';
    emptyState.style.display = 'flex';

    if (state.elements.emptyStateMessage) {
        if (isError) {
            state.elements.emptyStateMessage.textContent = 'حدث خطأ أثناء تحميل الدروس';
        } else if (state.searchTerm) {
            state.elements.emptyStateMessage.textContent = `لا توجد نتائج لـ "${state.searchTerm}"`;
        } else if (state.activeCategory !== 'all') {
            state.elements.emptyStateMessage.textContent = 'لا توجد دروس في هذا التصنيف';
        } else {
            state.elements.emptyStateMessage.textContent = 'لا توجد دروس متاحة حالياً';
        }
    }

    const oldRetry = emptyState.querySelector('.retry-btn');
    if (oldRetry) oldRetry.remove();

    if (isError) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-outline retry-btn';
        retryBtn.textContent = 'إعادة المحاولة';
        retryBtn.addEventListener('click', () => loadListData(true));
        emptyState.appendChild(retryBtn);
    }
}

function updateEmptyStateVisibility() {
    const emptyState = state.elements.emptyState;
    const grid = state.elements.lessonsGrid;
    if (!emptyState || !grid) return;

    const isEmpty = state.filteredLessons.length === 0 && !state.isLoading;
    emptyState.style.display = isEmpty ? 'flex' : 'none';
    grid.style.display = isEmpty ? 'none' : 'grid';

    if (isEmpty && state.elements.emptyStateMessage) {
        if (state.searchTerm) {
            state.elements.emptyStateMessage.textContent = `لا توجد نتائج لـ "${state.searchTerm}"`;
        } else if (state.activeCategory === 'favorites') {
            state.elements.emptyStateMessage.textContent = 'لم تحفظ أي دروس بعد';
        } else if (state.activeCategory === 'completed') {
            state.elements.emptyStateMessage.textContent = 'لم تُكمل أي دروس بعد';
        } else if (state.activeUnitId !== null || state.activeStage || state.activeGrade !== null || state.workingSemester) {
            state.elements.emptyStateMessage.textContent = 'لا توجد دروس في هذا النطاق';
        } else {
            state.elements.emptyStateMessage.textContent = 'لا توجد دروس متاحة حالياً';
        }
    }
}

function updateLoadMoreButton() {
    const container = state.elements.loadMoreContainer;
    const btn = state.elements.loadMoreBtn;
    if (!container || !btn) return;

    // يظهر طالما بقيت صفحات، حتى لو الفلاتر المحلية لا تُظهر درسًا
    if (state.hasMore) {
        container.style.display = 'flex';
        btn.disabled = state.isLoadingMore;
        btn.innerHTML = state.isLoadingMore
            ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> جاري التحميل...'
            : '<i class="fas fa-arrow-down" aria-hidden="true"></i> تحميل المزيد';
    } else {
        container.style.display = 'none';
    }
}

function updateClearFiltersButton() {
    const btn = state.elements.clearFiltersBtn;
    if (!btn) return;
    const hasActive = state.searchTerm || state.activeCategory !== 'all' || state.activeUnitId !== null
        || !!state.activeStage || state.activeGrade !== null || !!state.workingSemester;
    btn.style.display = hasActive ? 'inline-flex' : 'none';
}

function updateStatsSummary() {
    if (!state.elements.statsSummary ||
        isElementHidden(state.elements.statsSummary)) return;
    if (state.currentUser?.user_type !== 'student') return;

    const lessons = state.lessons;
    const total = lessons.length;
    const completed = lessons.filter(l => l.completed).length;
    const favorites = lessons.filter(l => l.is_favorite).length;
    const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

    if (state.elements.totalLessonsEl)
        state.elements.totalLessonsEl.textContent = total;
    if (state.elements.completedLessonsEl)
        state.elements.completedLessonsEl.textContent = completed;
    if (state.elements.completionRateEl)
        state.elements.completionRateEl.textContent = rate + '%';
    if (state.elements.favoriteLessonsEl)
        state.elements.favoriteLessonsEl.textContent = favorites;
}

// ==== 10. معالجات أحداث القائمة ====

function bindListEvents() {
    state.elements.categoryBtns?.forEach(btn => {
        btn.addEventListener('click', () => setActiveCategory(btn.dataset.category));
    });

    if (state.elements.searchInput) {
        state.elements.searchInput.addEventListener('input', handleSearchInput);
    }
    if (state.elements.clearSearchBtn) {
        state.elements.clearSearchBtn.addEventListener('click', clearSearch);
    }
    if (state.elements.clearFiltersBtn) {
        state.elements.clearFiltersBtn.addEventListener('click', clearAllFilters);
    }

    if (state.elements.loadMoreBtn) {
        state.elements.loadMoreBtn.addEventListener('click', loadMoreLessons);
    }

    if (state.elements.addLessonBtn) {
        state.elements.addLessonBtn.addEventListener('click', openAddLessonModal);
    }
    if (state.elements.addUnitBtn) {
        state.elements.addUnitBtn.addEventListener('click', openAddUnitModal);
    }

    bindCardGlow(state.elements.lessonsGrid);

    state.scrollHandler = () => {
        if (state.isLoading || state.isLoadingMore || !state.hasMore) return;
        const scrollPos = window.innerHeight + window.scrollY;
        const threshold = document.body.offsetHeight - CONFIG.SCROLL_THRESHOLD;
        if (scrollPos >= threshold) loadMoreLessons();
    };
    window.addEventListener('scroll', state.scrollHandler, { passive: true });

    const unsubCreated = EventBus.on('lesson:created', () => refreshListData());
    const unsubUpdated = EventBus.on('lesson:updated', () => refreshListData());
    const unsubDeleted = EventBus.on('lesson:deleted', () => refreshListData());
    const unsubUnitCreated = EventBus.on('unit:created', () => refreshListData());
    const unsubUnitUpdated = EventBus.on('unit:updated', () => refreshListData());
    const unsubUnitDeleted = EventBus.on('unit:deleted', () => refreshListData());
    const unsubSemester = EventBus.on('semester:active-changed', ({ stage, grade } = {}) => {
        const user = state.currentUser;
        if (!isStudentUser(user)) return;
        if (normalizeStage(user.stage) === normalizeStage(stage) && String(user.grade) === String(grade)) {
            state.semesterPromise = null;
            renderStudentSubtitle();
            refreshListData();
        }
    });
    state.eventUnsubscribers.push(
        unsubCreated, unsubUpdated, unsubDeleted,
        unsubUnitCreated, unsubUnitUpdated, unsubUnitDeleted,
        unsubSemester
    );
}

function handleSearchInput(e) {
    const query = e.target.value;
    if (state.elements.clearSearchBtn) {
        state.elements.clearSearchBtn.style.display = query ? 'flex' : 'none';
    }
    if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = setTimeout(() => {
        state.searchTerm = query.trim();
        // إعادة التحميل عبر searchLessons لتغطية كل الدروس لا المُحمَّل محليًا فقط
        loadListData(true);
    }, CONFIG.SEARCH_DEBOUNCE_MS);
}

function clearSearch() {
    if (state.elements.searchInput) state.elements.searchInput.value = '';
    if (state.elements.clearSearchBtn) state.elements.clearSearchBtn.style.display = 'none';
    if (!state.searchTerm) return;
    state.searchTerm = '';
    loadListData(true);
}

function clearAllFilters() {
    const hadSearchTerm = !!state.searchTerm;

    state.activeCategory = 'all';
    state.activeUnitId = null;
    state.searchTerm = '';
    state.activeStage = null;
    state.activeGrade = null;
    state.workingSemester = null;

    if (state.elements.searchInput) state.elements.searchInput.value = '';
    if (state.elements.clearSearchBtn) state.elements.clearSearchBtn.style.display = 'none';

    state.elements.categoryBtns?.forEach(btn => {
        const isAll = btn.dataset.category === 'all';
        btn.classList.toggle('active', isAll);
        btn.setAttribute('aria-pressed', String(isAll));
    });

    if (isStaffUser(state.currentUser)) {
        renderTeacherCategoryTree();
    }
    renderUnitsCarousel();

    if (hadSearchTerm) {
        loadListData(true);
        return;
    }

    applyFiltersAndRender();
    updateEmptyStateVisibility();
    updateClearFiltersButton();
}

// ==== 11. شجرة تنقّل المعلم ====

function renderTeacherCategoryTree() {
    const container = state.elements.categoriesContainer;
    if (!container) return;

    const countForStage = (stage) => state.lessons.filter(l => l.stage === stage).length;
    const countForGrade = (stage, grade) => state.lessons.filter(l => l.stage === stage && Number(l.grade) === grade).length;

    const stageChipsHtml = HIERARCHY.stages.map(stage => {
        const isStageActive = state.activeStage === stage.value;
        return `
            <button type="button" class="stage-chip ${isStageActive ? 'active' : ''}"
                data-stage="${escapeHtml(stage.value)}" aria-expanded="${isStageActive}">
                <span class="stage-chip-icon"><i class="fas fa-layer-group" aria-hidden="true"></i></span>
                <span class="stage-chip-text">
                    <span class="stage-chip-name">${stage.label}</span>
                    <span class="chip-count">${countForStage(stage.value)} درس</span>
                </span>
                <i class="fas fa-chevron-down stage-chevron" aria-hidden="true"></i>
            </button>`;
    }).join('');

    const activeStage = HIERARCHY.stages.find(stage => stage.value === state.activeStage);
    const stageEntering = state.treeStageShown !== state.activeStage;
    const gradeEntering = state.treeGradeShown !== state.activeGrade || stageEntering;
    state.treeStageShown = state.activeStage;
    state.treeGradeShown = state.activeGrade;

    let panelHtml = '';
    if (activeStage) {
        let semesterHtml = '';

        const gradesHtml = HIERARCHY.grades.map(grade => {
            const isGradeActive = state.activeGrade === grade.value;

            if (isGradeActive) {
                const liveSemester = state.liveSemesterCache[`${activeStage.value}_${grade.value}`];
                const showLiveHint = state.workingSemester && liveSemester && liveSemester !== state.workingSemester;

                semesterHtml = `
                    <div class="semester-toggle ${gradeEntering ? 'is-entering' : ''}" role="group" aria-label="اختيار الفصل الدراسي للتصفح">
                        <span class="semester-toggle-hint">
                            <i class="fas fa-eye" aria-hidden="true"></i>
                            للتصفح فقط — لا يغيّر ما يراه الطلاب
                        </span>
                        <div class="semester-toggle-buttons">
                            ${HIERARCHY.semesters.map(sem => `
                                <button type="button" class="semester-chip ${state.workingSemester === sem.value ? 'active' : ''}"
                                    data-semester="${sem.value}">
                                    الفصل ${sem.label}
                                </button>`).join('')}
                        </div>
                        ${showLiveHint ? `
                            <p class="browsing-live-hint">
                                <i class="fas fa-info-circle" aria-hidden="true"></i>
                                تعرض الآن الفصل ${state.workingSemester === 'أول' ? 'الأول' : 'الثاني'} —
                                والفصل الظاهر حاليًا للطلاب هو ${liveSemester === 'أول' ? 'الأول' : 'الثاني'}
                            </p>` : ''}
                    </div>`;
            }

            return `
                <button type="button" class="grade-chip ${isGradeActive ? 'active' : ''}"
                    data-stage="${escapeHtml(activeStage.value)}" data-grade="${grade.value}">
                    <span class="grade-chip-name">الصف ${grade.label}</span>
                    <span class="chip-count">${countForGrade(activeStage.value, grade.value)} درس</span>
                </button>`;
        }).join('');

        panelHtml = `<div class="grade-chips ${stageEntering ? 'is-entering' : ''}">${gradesHtml}${semesterHtml}</div>`;
    }

    container.classList.add('is-tree');
    container.innerHTML = `<div class="teacher-category-tree"><div class="stage-chips">${stageChipsHtml}</div>${panelHtml}</div>`;

    container.querySelectorAll('.stage-chip').forEach(btn => {
        btn.addEventListener('click', () => toggleStageContext(btn.dataset.stage));
    });
    container.querySelectorAll('.grade-chip').forEach(btn => {
        btn.addEventListener('click', () => toggleGradeContext(btn.dataset.stage, parseInt(btn.dataset.grade, 10)));
    });
    container.querySelectorAll('.semester-chip').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setWorkingSemester(btn.dataset.semester);
        });
    });
}

function toggleStageContext(stage) {
    state.activeStage = (state.activeStage === stage) ? null : stage;
    state.activeGrade = null;
    state.workingSemester = null;
    state.activeUnitId = null;
    applyFiltersAndRender();
    renderUnitsCarousel();
    renderTeacherCategoryTree();
    updateClearFiltersButton();
}

async function toggleGradeContext(stage, grade) {
    const isSame = state.activeStage === stage && state.activeGrade === grade;
    state.activeStage = stage;
    state.activeGrade = isSame ? null : grade;
    state.workingSemester = null;
    state.activeUnitId = null;
    applyFiltersAndRender();
    renderUnitsCarousel();
    renderTeacherCategoryTree();
    updateClearFiltersButton();

    if (isSame) return;

    // الفصل الحي يُعرض كتنبيه فقط بدون تأثير على أي فلترة
    const cacheKey = `${stage}_${grade}`;
    if (state.liveSemesterCache[cacheKey] === undefined) {
        try {
            state.liveSemesterCache[cacheKey] = await getActiveSemesterFor(stage, grade);
        } catch (_) {
            state.liveSemesterCache[cacheKey] = null;
        }
        renderTeacherCategoryTree();
    }
}

function setWorkingSemester(semester) {
    state.workingSemester = semester;
    state.activeUnitId = null;
    applyFiltersAndRender();
    renderUnitsCarousel();
    renderTeacherCategoryTree();
    updateClearFiltersButton();
}

function setActiveCategory(category) {
    state.activeCategory = category;
    state.elements.categoryBtns?.forEach(btn => {
        const isActive = btn.dataset.category === category;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
    });
    applyFiltersAndRender();
    updateClearFiltersButton();
}

async function refreshListData() {
    await loadListData(true);
}

// ==== 12. جلب وعرض بيانات الدرس الفردي ====

async function loadLessonData(lessonId) {
    const self = state;
    showLoading(true);
    try {
        const fetchedLesson = await getLessonById(lessonId);
        if (state !== self) return;
        state.lessonData = fetchedLesson;
        if (!state.lessonData) {
            showToast('الدرس غير موجود', 'error');
            window.router?.navigateTo('not-found');
            return;
        }

        if (!canStudentAccessLesson(state.lessonData)) {
            showToast('هذا الدرس غير متاح لمرحلتك أو صفك الدراسي', 'warning');
            window.router?.navigateTo('lessons');
            return;
        }

        state.units = await fetchLessonUnits(state.lessonData);

        try {
            state.examData = await getExamByLessonId(lessonId);
        } catch (_) {
            state.examData = null;
        }

        // المعلم والمشرف لا يُسجَّل لهم تقدم
        if (isStudentUser(state.currentUser)) {
            try {
                const progressMap = await getProgressMap();
                const thisProgress = progressMap.get(String(lessonId));
                if (thisProgress) {
                    state.watchProgress = thisProgress.progress || 0;
                    state.totalTimeSpent = thisProgress.total_time_spent || 0;
                }
                await updateUserProgress(
                    state.currentUser.id,
                    state.lessonId,
                    state.watchProgress,
                    state.totalTimeSpent
                );
            } catch (_) { }
        }

        if (state !== self) return;
        renderLessonView();

        // يستمع إليه directing.js لعرض رسالة توجيهية
        EventBus.emit('lesson:loaded', state.lessonData);

        if (state.currentUser?.id) {
            EventBus.emit('lesson:viewed', {
                userId: state.currentUser.id,
                lessonId: state.lessonId,
                viewedAt: new Date().toISOString()
            });
        }

        loadRecommendations();
    } catch (error) {
        console.error('❌ فشل تحميل الدرس:', error);
        showToast('تعذر تحميل الدرس', 'error');
        if (state === self) showErrorState(state.container, error);
    } finally {
        if (state === self) showLoading(false);
    }
}

async function fetchLessonUnits(lesson) {
    try {
        return await fetchUnits({ stage: lesson.stage, grade: lesson.grade });
    } catch (error) {
        console.error('❌ [lessons] فشل جلب وحدات الدرس:', error);
        return [];
    }
}

async function refreshLessonView() {
    try {
        const lesson = await getLessonById(state.lessonId);
        if (!lesson || !state.lessonId) return;
        state.lessonData = lesson;
        state.units = await fetchLessonUnits(lesson);
        renderLessonView();
    } catch (error) {
        console.error('❌ [lessons] فشل تحديث الدرس بعد التعديل:', error);
    }
}

function renderLessonView() {
    const lesson = state.lessonData;
    if (!lesson) return;

    const unit = state.units.find(u => u.id == lesson.unit_id);

    if (state.elements.breadcrumbTitle)
        state.elements.breadcrumbTitle.textContent = lesson.title;
    if (state.elements.lessonTitle)
        state.elements.lessonTitle.textContent = lesson.title;
    if (state.elements.lessonDescription) {
        state.elements.lessonDescription.textContent = lesson.description || '';
        state.elements.lessonDescription.style.display = lesson.description ? '' : 'none';
    }
    if (state.elements.screenTitleSpan)
        state.elements.screenTitleSpan.textContent = lesson.title;
    if (state.elements.stageBadge)
        state.elements.stageBadge.textContent = STAGE_LABELS[normalizeStage(lesson.stage)] || lesson.stage || '';
    if (state.elements.gradeBadge)
        state.elements.gradeBadge.textContent = `الصف ${lesson.grade}`;
    if (state.elements.semesterBadge)
        state.elements.semesterBadge.textContent =
            lesson.semester === 'أول' ? 'الفصل الأول' :
            lesson.semester === 'ثاني' ? 'الفصل الثاني' : (lesson.semester || '');
    if (state.elements.unitBadge) {
        if (unit) {
            state.elements.unitBadge.textContent = unit.name;
            state.elements.unitBadge.style.display = 'inline-flex';
        } else {
            state.elements.unitBadge.style.display = 'none';
        }
    }
    if (state.elements.durationEl)
        state.elements.durationEl.textContent = lesson.duration || 0;
    if (state.elements.likesCountEl)
        state.elements.likesCountEl.textContent = lesson.likes || 0;

    renderVideoSection(lesson);
    renderPdfSection(lesson);

    if (state.elements.coverImage && state.elements.coverWrapper) {
        if (lesson.cover_image_url) {
            state.elements.coverImage.src = lesson.cover_image_url;
            state.elements.coverImage.alt = `غلاف الدرس: ${lesson.title}`;
            state.elements.coverWrapper.style.display = 'block';
            state.elements.introContent?.classList.add('has-cover');
            state.elements.coverImage.onerror = () => {
                state.elements.coverWrapper.style.display = 'none';
                state.elements.introContent?.classList.remove('has-cover');
            };
        } else {
            state.elements.coverWrapper.style.display = 'none';
            state.elements.introContent?.classList.remove('has-cover');
        }
    }

    updateLikeButtonState();
    updateFavoriteButtonState();

    if (state.watchProgress > 0) {
        updateProgressUI(state.watchProgress);
    }

    document.title = `بيولوجست | ${lesson.title}`;
    updateCompleteButtonState();
    renderExamCard();
}

function renderVideoSection(lesson) {
    const container = state.elements.videoContainer;
    if (!container) return;

    const videoId = extractYouTubeId(lesson.video_url);
    if (!videoId) {
        delete container.dataset.videoId;
        container.innerHTML = `
            <div class="video-placeholder">
                <i class="fas fa-video-slash video-icon" aria-hidden="true"></i>
                <p class="video-text">لا يتوفر فيديو لهذا الدرس</p>
            </div>`;
        return;
    }

    // لا نعيد بناء المشغّل إذا لم يتغير الفيديو حتى لا يتوقف التشغيل
    if (container.dataset.videoId === videoId) return;
    container.dataset.videoId = videoId;
    container.innerHTML = `
        <iframe
            width="100%"
            height="400"
            src="https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1"
            title="${escapeHtml(lesson.title)}"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
            loading="lazy"
        ></iframe>`;
}

function renderPdfSection(lesson) {
    const container = state.elements.pdfContainer;
    const section = container?.closest('.pdf-section');
    const pdfHref = toSafeHttpUrl(lesson.pdf_url);

    if (state.elements.pdfBtn) {
        if (pdfHref) {
            state.elements.pdfBtn.style.display = 'inline-flex';
            state.elements.pdfBtn.setAttribute('href', pdfHref);
            state.elements.pdfBtn.setAttribute('target', '_blank');
            state.elements.pdfBtn.setAttribute('rel', 'noopener noreferrer');
        } else {
            state.elements.pdfBtn.style.display = 'none';
        }
    }

    if (!container) return;
    if (!pdfHref) {
        if (section) section.style.display = 'none';
        return;
    }
    if (section) section.style.display = '';
    container.innerHTML = `
        <div class="pdf-placeholder">
            <i class="fas fa-file-pdf pdf-icon" aria-hidden="true"></i>
            <p class="pdf-text">ملف الدرس جاهز للتحميل</p>
        </div>`;
}

function renderExamCard() {
    const card = state.elements.examCardContainer;
    if (state.examData && card) {
        const durationEl = card.querySelector('#exam-duration-value');
        const questionsEl = card.querySelector('#exam-questions-value');
        if (durationEl) durationEl.textContent = state.examData.duration || 10;
        if (questionsEl) questionsEl.textContent = state.examData.questions_count || 0;
    }
    renderExamButton();
}

function isExamAvailable() {
    if (!state.examData) return false;
    return isStaffUser(state.currentUser) || (state.examData.questions_count || 0) > 0;
}

function renderExamButton() {
    const holder = state.elements.examBtnContainer;
    if (!holder) return;
    holder.innerHTML = '';
    if (!isExamAvailable()) return;

    const unlocked = isStaffUser(state.currentUser) || state.watchProgress >= 100;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${unlocked ? 'btn-success' : 'btn-outline'}`;
    btn.disabled = !unlocked;
    btn.innerHTML = unlocked
        ? '<i class="fas fa-graduation-cap" aria-hidden="true"></i> امتحان الدرس'
        : '<i class="fas fa-lock" aria-hidden="true"></i> أكمل الدرس لفتح الامتحان';
    if (unlocked) btn.addEventListener('click', startExam);
    holder.appendChild(btn);
}

function extractYouTubeId(url) {
    if (!url) return null;
    const regExp = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([^#&?]{11})/;
    const match = url.match(regExp);
    return match ? match[1] : null;
}

function hasLikedLesson() {
    const userId = state.currentUser?.id;
    if (userId === undefined || userId === null) return false;
    return (state.lessonData?.liked_by || []).some(id => String(id) === String(userId));
}

function updateLikeButtonState() {
    if (!state.elements.likeBtn || !state.lessonData) return;
    const liked = hasLikedLesson();
    state.elements.likeBtn.classList.toggle('active', liked);
    const icon = state.elements.likeBtn.querySelector('i');
    if (icon) icon.className = liked ? 'fas fa-heart' : 'far fa-heart';
    state.elements.likeBtn.setAttribute('aria-pressed', String(liked));
}

function updateFavoriteButtonState() {
    if (!state.elements.favoriteBtn || !state.lessonData) return;
    const isFav = getFavorites().includes(String(state.lessonData.id));
    const icon = state.elements.favoriteBtn.querySelector('i');
    const label = state.elements.favoriteBtn.querySelector('span');
    const favText = isFav ? 'إزالة من المحفوظات' : 'حفظ الدرس';
    if (icon) icon.className = isFav ? 'fas fa-bookmark' : 'far fa-bookmark';
    if (label) label.textContent = favText;
    state.elements.favoriteBtn.classList.toggle('active', isFav);
    state.elements.favoriteBtn.setAttribute('aria-pressed', String(isFav));
    state.elements.favoriteBtn.title = favText;
    state.elements.favoriteBtn.setAttribute('aria-label', favText);
}

function updateProgressUI(percent) {
    if (state.elements.progressBarFill) {
        state.elements.progressBarFill.style.width = percent + '%';
        state.elements.progressBarFill.parentElement?.setAttribute('aria-valuenow', String(percent));
    }
    if (state.elements.progressPercentage)
        state.elements.progressPercentage.textContent = percent + '%';
}

// ==== 13. معالجات أحداث عرض الدرس ====

function bindViewEvents() {
    if (state.elements.startBtn) {
        state.elements.startBtn.addEventListener('click', startLesson);
    }
    if (state.elements.completeBtn) {
        state.elements.completeBtn.addEventListener('click', completeLesson);
    }
    if (state.elements.likeBtn) {
        state.elements.likeBtn.addEventListener('click', toggleLessonLikeHandler);
    }
    if (state.elements.favoriteBtn) {
        state.elements.favoriteBtn.addEventListener('click', toggleFavoriteInView);
    }
    if (state.elements.editLessonBtn) {
        state.elements.editLessonBtn.addEventListener('click', () =>
            openEditLessonModal(state.lessonId));
    }
    if (state.elements.deleteLessonBtn) {
        state.elements.deleteLessonBtn.addEventListener('click', () =>
            openDeleteConfirmModal(state.lessonId));
    }
    if (state.elements.startExamBtn) {
        state.elements.startExamBtn.addEventListener('click', startExam);
    }
    if (state.elements.backToLessonsBtn) {
        state.elements.backToLessonsBtn.addEventListener('click', () => {
            window.router?.navigateTo('lessons');
        });
    }

    state.visibilityHandler = (event) => {
        if (event?.type === 'visibilitychange' && !document.hidden) return;
        saveProgressNow();
    };
    document.addEventListener('visibilitychange', state.visibilityHandler);
    window.addEventListener('pagehide', state.visibilityHandler);

    const unsubDeleted = EventBus.on('lesson:deleted', ({ lessonId } = {}) => {
        if (String(lessonId) !== String(state.lessonId)) return;
        showToast('تم حذف هذا الدرس', 'info');
        window.router?.navigateTo('lessons');
    });
    const unsubUpdated = EventBus.on('lesson:updated', ({ lessonId } = {}) => {
        if (String(lessonId) === String(state.lessonId)) refreshLessonView();
    });
    state.eventUnsubscribers.push(unsubDeleted, unsubUpdated);
}

function isCompletionLocked() {
    if (!isStudentUser(state.currentUser)) return false;
    const duration = Number(state.lessonData?.duration) || 0;
    if (duration <= 0 || CONFIG.COMPLETE_MIN_PERCENT <= 0) return false;
    return state.watchProgress < CONFIG.COMPLETE_MIN_PERCENT;
}

function updateCompleteButtonState() {
    const btn = state.elements.completeBtn;
    if (!btn) return;
    const locked = isCompletionLocked();
    btn.disabled = locked;
    btn.setAttribute('aria-disabled', String(locked));
    btn.title = locked ? `يمكنك إنهاء الدرس بعد مشاهدة ${CONFIG.COMPLETE_MIN_PERCENT}% منه` : '';
}

function saveProgressNow() {
    if (!state.watchStartTime || !state.lessonId || !isStudentUser(state.currentUser)) return;
    state.lastSaveTs = Date.now();
    state.lastSavedPercent = state.watchProgress;
    updateUserProgress(
        state.currentUser.id,
        state.lessonId,
        state.watchProgress,
        getTotalElapsedSec()
    ).catch(() => { });
}

function saveProgressIfDue() {
    if (!isStudentUser(state.currentUser) || !state.lessonId) return;
    const reachedEnd = state.watchProgress >= 100;
    const stepReached = state.watchProgress >= state.lastSavedPercent + CONFIG.PROGRESS_SAVE_STEP_PERCENT;
    const throttled = (Date.now() - state.lastSaveTs) < CONFIG.PROGRESS_SAVE_INTERVAL_SEC * 1000;
    if (reachedEnd || (stepReached && !throttled)) saveProgressNow();
}

// لا نحتسب الوقت والتبويب مخفي
function tickWatch() {
    const now = Date.now();
    const deltaSec = Math.min((now - state.lastTickAt) / 1000, 5);
    state.lastTickAt = now;
    if (!document.hidden) state.sessionActiveSec += deltaSec;

    const elapsed = getTotalElapsedSec();
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;

    if (state.elements.timerValue) {
        state.elements.timerValue.textContent =
            `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    const duration = state.lessonData?.duration;
    if (!(duration && duration > 0)) return;

    const progressPercent = Math.min(100, Math.floor((elapsed / (duration * 60)) * 100));
    if (progressPercent <= state.watchProgress) return;

    state.watchProgress = progressPercent;
    updateProgressUI(progressPercent);
    updateCompleteButtonState();
    saveProgressIfDue();

    if (progressPercent >= 100) {
        clearInterval(state.watchInterval);
        state.watchInterval = null;
        renderExamButton();
    }
}

function startLesson() {
    if (!state.currentUser) {
        showToast('يرجى تسجيل الدخول أولاً', 'warning');
        window.router?.navigateTo('login');
        return;
    }

    if (state.elements.introSection)
        state.elements.introSection.style.display = 'none';
    if (state.elements.screenSection)
        state.elements.screenSection.style.display = 'block';
    scrollToSection(state.elements.screenSection);

    state.watchStartTime = Date.now();
    state.lastTickAt = Date.now();
    state.lastSavedPercent = state.watchProgress;
    state.lastSaveTs = Date.now();
    if (state.watchInterval) clearInterval(state.watchInterval);

    updateCompleteButtonState();
    state.watchInterval = setInterval(tickWatch, 1000);
}

async function completeLesson() {
    if (!state.currentUser) {
        showToast('يرجى تسجيل الدخول أولاً', 'warning');
        return;
    }
    if (state.isCompleting) return;
    if (isCompletionLocked()) {
        showToast(`أكمل مشاهدة ${CONFIG.COMPLETE_MIN_PERCENT}% من الدرس على الأقل لإنهائه`, 'warning');
        return;
    }
    state.isCompleting = true;

    try {
        if (state.watchInterval) {
            clearInterval(state.watchInterval);
            state.watchInterval = null;
        }

        state.totalTimeSpent = getTotalElapsedSec();
        state.sessionActiveSec = 0;
        state.watchStartTime = null;
        state.watchProgress = 100;

        const tracked = isStudentUser(state.currentUser);
        if (tracked) {
            try {
                await updateUserProgress(state.currentUser.id, state.lessonId, 100, state.totalTimeSpent);
            } catch (error) {
                console.error('فشل حفظ تقدم الدرس:', error);
                showToast('تعذر حفظ تقدمك، تحقق من اتصالك', 'warning');
            }
        }

        if (state.elements.screenSection)
            state.elements.screenSection.style.display = 'none';
        if (state.elements.resultsSection)
            state.elements.resultsSection.style.display = 'block';

        if (state.elements.timeSpent) {
            const min = Math.floor(state.totalTimeSpent / 60);
            const sec = state.totalTimeSpent % 60;
            state.elements.timeSpent.textContent =
                `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        }
        if (state.elements.lastWatched) {
            state.elements.lastWatched.textContent = new Date().toLocaleString('ar-EG');
        }

        updateProgressUI(100);
        scrollToSection(state.elements.resultsSection);
        launchConfetti();
        showToast('أحسنت! تم إكمال الدرس بنجاح 🎉', 'success');

        if (tracked) {
            EventBus.emit('lesson:completed', {
                userId: state.currentUser.id,
                lessonId: state.lessonId,
                completedAt: new Date().toISOString(),
                progress: 100,
                totalTime: state.totalTimeSpent
            });
        }

        if (isExamAvailable() && state.elements.examCardContainer) {
            state.elements.examCardContainer.style.display = 'block';
            if (state.elements.startExamBtn)
                state.elements.startExamBtn.style.display = 'inline-flex';
        }
        renderExamButton();
    } finally {
        state.isCompleting = false;
    }
}

async function toggleLessonLikeHandler() {
    if (!state.currentUser) {
        showToast('يرجى تسجيل الدخول', 'warning');
        return;
    }
    if (!state.lessonData || state.isLiking) return;
    state.isLiking = true;

    try {
        const wasLiked = hasLikedLesson();
        await toggleLessonLike(state.lessonId, state.currentUser.id);

        if (wasLiked) {
            state.lessonData.likes = Math.max(0, (state.lessonData.likes || 1) - 1);
            state.lessonData.liked_by = (state.lessonData.liked_by || [])
                .filter(id => String(id) !== String(state.currentUser.id));
        } else {
            state.lessonData.likes = (state.lessonData.likes || 0) + 1;
            state.lessonData.liked_by = [...(state.lessonData.liked_by || []), state.currentUser.id];
        }

        if (state.elements.likesCountEl)
            state.elements.likesCountEl.textContent = state.lessonData.likes;
        updateLikeButtonState();
    } catch (_) {
        showToast('فشل تحديث الإعجاب', 'error');
    } finally {
        state.isLiking = false;
    }
}

async function toggleFavoriteInView() {
    if (!state.lessonData) return;
    const change = toggleFavoriteLocally(state.lessonData.id);
    updateFavoriteButtonState();
    await commitFavoriteChange(change);
}

function startExam() {
    if (!state.examData) {
        showToast('لا يوجد امتحان مرتبط بهذا الدرس', 'warning');
        return;
    }
    if (isStudentUser(state.currentUser) && state.watchProgress < 100) {
        showToast('أكمل الدرس أولاً لفتح الامتحان', 'warning');
        return;
    }
    window.router?.navigateTo('exam-view', { path: { id: state.examData.id } });
}

// ==== 14. التوصيات ====

async function loadRecommendations() {
    if (!state.lessonData) return;
    try {
        const user = state.currentUser;
        let completedIds = [];
        if (user?.id) {
            try {
                const progressMap = await getProgressMap();
                completedIds = [...progressMap.values()].filter(p => p.completed).map(p => String(p.lesson_id));
            } catch (_) { }
        }

        const options = {
            limit: CONFIG.RECOMMENDATIONS_COUNT * 3,
            unitId: state.lessonData.unit_id,
            stage: state.lessonData.stage,
            grade: state.lessonData.grade,
            semester: state.lessonData.semester
        };

        const candidates = await getAllLessons(options);
        // نفس الوحدة أولاً لأن الـ API لا يفلتر بالوحدة
        const sameUnit = (l) => String(l.unit_id) === String(state.lessonData.unit_id) ? 0 : 1;
        state.recommendedLessons = candidates
            .filter(l => String(l.id) !== String(state.lessonId) && !completedIds.includes(String(l.id)))
            .sort((a, b) => sameUnit(a) - sameUnit(b))
            .slice(0, CONFIG.RECOMMENDATIONS_COUNT);

        renderRecommendations();
    } catch (error) {
        // التوصيات اختيارية: عند الفشل نخفي القسم بدل عرض عنوان فارغ
        console.warn('⚠️ [lessons] تعذر تحميل التوصيات:', error?.message || error);
        state.elements.recommendationsContainer?.closest('.recommendations-section')?.style.setProperty('display', 'none');
    }
}

function renderRecommendations() {
    const container = state.elements.recommendationsContainer;
    if (!container) return;

    if (!state.recommendedLessons.length) {
        container.innerHTML = '<p class="text-muted">لا توجد توصيات متاحة حالياً</p>';
        return;
    }

    container.innerHTML = state.recommendedLessons.map(lesson => `
        <div class="recommendation-item" data-id="${lesson.id}" role="button" tabindex="0" aria-label="${escapeHtml(lesson.title)}">
            <div class="recommendation-cover">
                ${lesson.cover_image_url
                    ? `<img src="${escapeHtml(lesson.cover_image_url)}" alt="${escapeHtml(lesson.title)}" loading="lazy">`
                    : `<i class="fas fa-book-open" aria-hidden="true"></i>`}
            </div>
            <div class="recommendation-info">
                <h4 class="recommendation-title">${escapeHtml(lesson.title)}</h4>
                <span class="recommendation-meta"><i class="fas fa-clock" aria-hidden="true"></i> ${lesson.duration || 0} دقيقة</span>
            </div>
        </div>`).join('');

    container.querySelectorAll('.recommendation-item').forEach(item => {
        const goToLesson = () => navigateToLesson(item.dataset.id);
        item.addEventListener('click', goToLesson);
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                goToLesson();
            }
        });
    });
    bindImageFallbacks(container, '.recommendation-cover img');
}

// ==== 15. التعامل مع lesson-manager ====

async function callLessonManager(action, ...args) {
    try {
        const manager = window.lessonManager || await import('./lesson-manager.js');
        await manager[action](...args);
    } catch (error) {
        console.error(`❌ [lessons] تعذر تنفيذ ${action}:`, error);
        showToast('تعذر فتح النافذة المطلوبة', 'error');
    }
}

function getBrowseContext() {
    if (!(state.activeStage || state.activeGrade !== null || state.workingSemester)) return null;
    return {
        stage: state.activeStage || undefined,
        grade: state.activeGrade || undefined,
        semester: state.workingSemester || undefined
    };
}

function openAddLessonModal() {
    if (!isStaffUser(state.currentUser)) {
        showToast('ليس لديك صلاحية لإضافة دروس', 'error');
        return;
    }
    callLessonManager('openAddLessonModal', getBrowseContext());
}

function openAddUnitModal() {
    if (!isStaffUser(state.currentUser)) {
        showToast('ليس لديك صلاحية لإضافة وحدات', 'error');
        return;
    }
    callLessonManager('openAddUnitModal', getBrowseContext());
}

function openEditLessonModal(lessonId) {
    return callLessonManager('openEditLessonModal', lessonId);
}

function openDeleteConfirmModal(lessonId) {
    return callLessonManager('confirmDeleteLesson', lessonId);
}

function openMoveLessonModal(lessonId) {
    return callLessonManager('openMoveLessonModal', lessonId);
}

// ==== 16. المفضلة (localStorage) ====

function getFavorites() {
    if (Array.isArray(state.currentUser?.favorites)) {
        return state.currentUser.favorites.map(String);
    }
    try {
        return JSON.parse(localStorage.getItem(CONFIG.FAVORITES_KEY) || '[]');
    } catch {
        return [];
    }
}

function setFavorites(favorites) {
    localStorage.setItem(CONFIG.FAVORITES_KEY, JSON.stringify(favorites));
}

function updateFavoriteCardUI(lessonId, isNowFavorite) {
    const card = state.elements.lessonsGrid?.querySelector(`.lesson-card[data-id="${lessonId}"]`);
    if (!card) return;
    const btn = card.querySelector('.lesson-save-btn');
    const icon = btn?.querySelector('i');
    const label = isNowFavorite ? 'إزالة من المحفوظات' : 'حفظ الدرس';
    if (btn) {
        btn.classList.toggle('active', isNowFavorite);
        btn.setAttribute('aria-pressed', String(isNowFavorite));
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }
    if (icon) icon.className = isNowFavorite ? 'fas fa-bookmark' : 'far fa-bookmark';
    card.classList.toggle('favorited', isNowFavorite);
}

async function handleToggleFavorite(lessonId) {
    const change = toggleFavoriteLocally(lessonId);

    const lesson = state.lessons.find(l => String(l.id) === change.id);
    if (lesson) lesson.is_favorite = change.isNowFavorite;
    updateFavoriteCardUI(lessonId, change.isNowFavorite);
    if (state.activeCategory === 'favorites') applyFiltersAndRender();
    updateStatsSummary();

    await commitFavoriteChange(change);
}

function toggleFavoriteLocally(lessonId) {
    const id = String(lessonId);
    const favorites = getFavorites();
    const idx = favorites.indexOf(id);
    const isNowFavorite = idx === -1;

    if (isNowFavorite) {
        favorites.push(id);
    } else {
        favorites.splice(idx, 1);
    }

    setFavorites(favorites);
    if (state.currentUser) state.currentUser.favorites = favorites;
    return { id, favorites, isNowFavorite };
}

async function commitFavoriteChange({ id, favorites, isNowFavorite }) {
    EventBus.emit(isNowFavorite ? 'lesson:favorited' : 'lesson:unfavorited', {
        userId: state.currentUser?.id || null,
        lessonId: id,
        date: new Date().toISOString()
    });

    const message = isNowFavorite ? 'تم حفظ الدرس 🔖' : 'تمت إزالة الدرس من المحفوظات';
    if (!state.currentUser?.id) {
        showToast(message, 'success');
        return;
    }

    await updateSessionUser({ favorites }).catch(() => { });

    try {
        await syncUserFavorites(state.currentUser.id, favorites);
        showToast(message, 'success');
    } catch (error) {
        console.error('❌ [lessons] فشل مزامنة المفضلة مع الخادم:', error);
        showToast('تم الحفظ محلياً، لكن تعذّرت المزامنة مع حسابك', 'warning');
    }
}

// ==== 17. دوال مساعدة ====

function navigateToLesson(lessonId) {
    if (!state.currentUser) {
        showToast('يرجى تسجيل الدخول', 'warning');
        window.router?.navigateTo('login');
        return;
    }
    window.router?.navigateTo('lesson-view', { path: { id: lessonId } });
}

function scrollToSection(el) {
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }));
}

function bindCardGlow(grid) {
    if (!grid || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let frame = 0;
    grid.addEventListener('pointermove', (e) => {
        const card = e.target.closest?.('.lesson-card');
        if (!card || frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            const rect = card.getBoundingClientRect();
            card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
            card.style.setProperty('--my', `${e.clientY - rect.top}px`);
        });
    }, { passive: true });
}

function launchConfetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const styles = getComputedStyle(document.documentElement);
    const colors = ['--primary', '--accent', '--success', '--warning', '--secondary']
        .map(v => styles.getPropertyValue(v).trim())
        .filter(Boolean);
    if (!colors.length) return;

    const width = window.innerWidth;
    const startY = Math.round(window.innerHeight * 0.25);
    for (let i = 0; i < 36; i++) {
        const piece = document.createElement('span');
        piece.className = 'lesson-confetti';
        piece.style.background = colors[i % colors.length];
        document.body.appendChild(piece);

        const x = Math.random() * width;
        const drift = (Math.random() - 0.5) * 240;
        const fall = window.innerHeight * (0.45 + Math.random() * 0.4);
        const spin = (Math.random() - 0.5) * 720;
        const anim = piece.animate([
            { transform: `translate3d(${x}px, ${startY}px, 0) rotate(0deg)`, opacity: 1 },
            { transform: `translate3d(${x + drift}px, ${startY + fall}px, 0) rotate(${spin}deg)`, opacity: 0 }
        ], { duration: 1300 + Math.random() * 900, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
        anim.onfinish = () => piece.remove();
    }
}

// كلاس is-loading في HTML يجعل CSS يخفي المقدمة والتوصيات طالما موجود
function getViewPageRoot(container = state.container) {
    return container?.querySelector('.lesson-view-page') || null;
}

function showLoading(show) {
    if (state.pageType === CONFIG.PAGE_TYPE_VIEW) {
        if (state.elements.loadingState) {
            state.elements.loadingState.style.display = show ? 'flex' : 'none';
        }
        state.container?.classList.toggle('is-loading', show);
        getViewPageRoot()?.classList.toggle('is-loading', show);
        return;
    }
    // التحميل الهيكلي يغني عن المؤشر النصي، فنكتفي بضبط aria-busy الذي يتحكم بتعتيم الشبكة
    if (state.elements.lessonsGrid) {
        state.elements.lessonsGrid.setAttribute('aria-busy', String(show));
    }
}

function showErrorState(container, error) {
    if (!container) return;
    console.error('❌ [lessons] حالة خطأ:', error);

    const errDiv = document.createElement('div');
    errDiv.className = 'error-state';
    errDiv.setAttribute('role', 'alert');
    errDiv.innerHTML = `
        <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
        <h3>عذراً، حدث خطأ</h3>
        <p>تعذّر تحميل الصفحة، تحقق من اتصالك بالإنترنت ثم أعد المحاولة.</p>`;

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-primary';
    retryBtn.textContent = 'إعادة تحميل الصفحة';
    retryBtn.addEventListener('click', () => window.location.reload());
    errDiv.appendChild(retryBtn);

    // نخفي كل الأقسام ونعرض الخطأ في مكانها لأن القسم الداخلي كان مخفيًا
    if (state.pageType === CONFIG.PAGE_TYPE_VIEW) {
        container.classList.remove('is-loading');
        getViewPageRoot(container)?.classList.remove('is-loading');
        container.querySelectorAll('.lesson-intro-section, .lesson-screen-section, .lesson-results-section, .recommendations-section, .loading-state')
            .forEach(el => { el.style.display = 'none'; });
        container.querySelector(':scope > .error-state')?.remove();
        container.appendChild(errDiv);
        return;
    }

    const target = container.querySelector('.lessons-grid') || container;
    target.style.display = 'grid';
    target.innerHTML = '';
    target.appendChild(errDiv);
}

function showToast(message, type = 'info') {
    if (window.modals?.toast) {
        window.modals.toast(message, type);
    } else {
        console.log(`[Toast/${type}] ${message}`);
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

// ==== 18. التصدير ====
export { loadListData as loadData };
