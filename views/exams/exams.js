/* مدير صفحتي قائمة الامتحانات وأداء الامتحان - v5.0.0 */

import { getCurrentUser, isTeacher, isModerator } from '../../js/core/session.js';
import {
    getExams,
    getExamFullData,
    saveExamResult,
    updateUserExamScore,
    getUnits,
    getUserExamResultsMap,
    getActiveSemesterFor
} from '../../js/core/api.js';
import { EventBus } from '../../js/core/event-bus.js';

// ==== 1. الثوابت والتكوين ====
// يجب أن تطابق STAGES/GRADES/SEMESTERS في exam-manager.js (لم تُستورد حتى لا نفرض تحميله على كل مستخدم)
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
    EXAMS_PER_PAGE: 12,
    // عدد الامتحانات المجلوبة دفعة واحدة ليعمل الفلتر والترتيب على مجموعة كاملة
    FETCH_LIMIT: 200,
    SKELETON_COUNT: 6,
    SEARCH_DEBOUNCE_MS: 200,
    SCROLL_THRESHOLD: 250,
    // درجة النجاح بالنسبة المئوية
    PASS_THRESHOLD: 50,
    // آخر ثوانٍ يتحوّل فيها المؤقت إلى حالة التنبيه
    TIMER_WARNING_SEC: 120,
    SESSION_PREFIX: 'biologist_exam_session_v1',
    PAGE_TYPE_LIST: 'list',
    PAGE_TYPE_VIEW: 'view'
};

const LEVEL_TIERS = [
    { min: 90, key: 'advanced', label: 'مستوى متقدم' },
    { min: 75, key: 'good', label: 'مستوى جيد جداً' },
    { min: 50, key: 'acceptable', label: 'مستوى مقبول' },
    { min: 0, key: 'beginner', label: 'يحتاج مراجعة' }
];

const MEDAL_TIERS = [
    { min: 95, key: 'gold', label: 'ميدالية ذهبية' },
    { min: 90, key: 'silver', label: 'ميدالية فضية' },
    { min: 85, key: 'bronze', label: 'ميدالية برونزية' }
];

// ==== 2. الحالة الداخلية الأولية ====
const INITIAL_STATE = () => ({
    initialized: false,
    container: null,
    pageType: null,
    examId: null,
    currentUser: null,

    // ---- القائمة ----
    exams: [],
    units: [],
    filteredExams: [],
    visibleCount: CONFIG.EXAMS_PER_PAGE,
    isLoading: false,
    pendingReload: false,
    activeCategory: 'all',
    searchTerm: '',
    activeUnitId: null,
    studentSemester: null,
    examResultsMap: {},
    // سياق تصفح المعلم فقط، لا علاقة له بما يظهر فعليًا للطلاب
    activeStage: null,
    activeGrade: null,
    workingSemester: null,
    treeStageShown: null,
    treeGradeShown: null,
    liveSemesterCache: {},
    renderedCardIds: new Set(),
    searchDebounceTimer: null,
    scrollHandler: null,

    // ---- أداء الامتحان ----
    examMeta: null,
    questions: [],
    previousBest: null,
    currentIndex: 0,
    answers: {},
    markedForReview: new Set(),
    startedAt: null,
    endsAt: null,
    durationSeconds: 0,
    remainingSeconds: 0,
    timerInterval: null,
    inProgress: false,
    submitted: false,
    result: null,
    pendingSave: null,
    reviewFilter: 'all',
    screen: 'intro',
    countRaf: null,
    viewHandlers: null,

    elements: {},
    eventUnsubscribers: []
});

let state = INITIAL_STATE();

const STAGE_ALIASES = { preparatory: 'إعدادي', secondary: 'ثانوي', 'الإعدادية': 'إعدادي', 'الثانوية': 'ثانوي' };
const SEMESTER_ALIASES = { first: 'أول', second: 'ثاني', 'الأول': 'أول', 'الثاني': 'ثاني' };

const isStaffUser = (user) => !!user && (isTeacher(user) || isModerator(user));
const isStudentUser = (user) => user?.user_type === 'student';
const normalizeStage = (stage) => STAGE_ALIASES[stage] || stage || '';
const normalizeSemester = (semester) => SEMESTER_ALIASES[semester] || semester || '';
const semesterLabel = (semester) => {
    const value = normalizeSemester(semester);
    return value === 'أول' ? 'الأول' : value === 'ثاني' ? 'الثاني' : (semester || '');
};
const stageLabel = (stage) => ({ 'إعدادي': 'الإعدادي', 'ثانوي': 'الثانوي' }[normalizeStage(stage)] || stage || '');

const isLatestMode = () => isStaffUser(state.currentUser) && (!state.activeStage || state.activeGrade === null);

function getCreatedMs(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    if (typeof value._seconds === 'number') return value._seconds * 1000;
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
}

function safeInt(value, fallback = 0) {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
}

function formatTime(totalSeconds) {
    const s = Math.max(0, safeInt(totalSeconds, 0));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}

function letterAr(index) {
    const letters = ['أ', 'ب', 'ج', 'د', 'هـ', 'و'];
    return letters[index] || String(index + 1);
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function canStudentAccessExam(meta) {
    const user = state.currentUser;
    if (!isStudentUser(user)) return true;
    if (meta.stage && normalizeStage(user.stage) !== normalizeStage(meta.stage)) return false;
    if (meta.grade && Number(user.grade) !== Number(meta.grade)) return false;
    return true;
}

async function getStudentSemester(user = state.currentUser) {
    if (state.studentSemester) return state.studentSemester;
    const semester = await getActiveSemesterFor(user.stage, user.grade);
    state.studentSemester = semester ? normalizeSemester(semester) : null;
    return state.studentSemester;
}

function bindImageFallbacks(root, selector, wrapperClass = '') {
    root.querySelectorAll(selector).forEach(img => {
        img.addEventListener('error', () => {
            const icon = document.createElement('i');
            icon.className = 'fas fa-graduation-cap';
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

export async function initExamViewPage(container, params = {}) {
    if (state.initialized && state.container === container) return;

    const examId = params.path?.id;
    if (!examId) {
        console.error('❌ [exams] معرف الامتحان مفقود');
        window.router?.navigateTo('not-found');
        return;
    }

    if (!getCurrentUser()) {
        showToast('يرجى تسجيل الدخول أولاً', 'warning');
        window.router?.navigateTo('login');
        return;
    }

    await initCommon(container, CONFIG.PAGE_TYPE_VIEW, { ...params, examId });
}

async function initCommon(container, pageType, params) {
    if (state.initialized || state.container) await _cleanup();

    state.container = container;
    state.pageType = pageType;
    state.currentUser = getCurrentUser();
    if (pageType === CONFIG.PAGE_TYPE_VIEW) {
        state.examId = params.examId;
    }
    const self = state;

    try {
        cacheElements(container);

        if (pageType === CONFIG.PAGE_TYPE_LIST) {
            setupUIForList();
            bindListEvents();
            await loadInitialListData();
        } else {
            setupUIForView();
            bindViewEvents();
            await loadExamData(state.examId);
        }

        if (self !== state) return;
        state.initialized = true;
        EventBus.emit('page:ready', {
            page: pageType === CONFIG.PAGE_TYPE_LIST ? 'exams' : 'exam-view'
        });
    } catch (error) {
        if (self !== state) return;
        console.error('❌ [exams] فشل تهيئة الصفحة:', error);
        showToast('حدث خطأ أثناء تحميل الصفحة', 'error');
        showErrorState(container, error);
    }
}

export async function cleanupPage() {
    await _cleanup();
}

export async function cleanupExamViewPage() {
    await _cleanup();
}

async function _cleanup() {
    stopTimer();
    closeImageZoom();
    cancelAnimationFrame(state.countRaf);

    if (state.searchDebounceTimer) {
        clearTimeout(state.searchDebounceTimer);
    }
    if (state.scrollHandler) {
        window.removeEventListener('scroll', state.scrollHandler);
    }
    if (state.viewHandlers) {
        const h = state.viewHandlers;
        document.removeEventListener('keydown', h.keydown);
        document.removeEventListener('visibilitychange', h.visibility);
        window.removeEventListener('beforeunload', h.beforeUnload);
        window.removeEventListener('pagehide', h.pageHide);
    }
    state.eventUnsubscribers.forEach(fn => {
        try { fn(); } catch (_) { }
    });

    document.body.classList.remove('exam-lightbox-open');
    document.body.classList.remove('exam-focus-mode');

    state = INITIAL_STATE();
}

// ==== 4. دوال مساعدة DOM ====

function cacheElements(container) {
    const q = (sel) => container.querySelector(sel);
    const isList = state.pageType === CONFIG.PAGE_TYPE_LIST;
    state.elements = {
        loadingState: q('.loading-state'),
        ...(isList ? {
            examsGrid: q('#exams-grid'),
            unitsContainer: q('#units-container'),
            unitsTitleIcon: q('#units-title-icon'),
            unitsTitleText: q('#units-title-text'),
            sectionCount: q('#section-count'),
            categoryBtns: container.querySelectorAll('.category-btn'),
            categoriesContainer: q('.categories-container'),
            categoriesTitle: q('#categories-title'),
            statsSummary: q('.stats-summary'),
            emptyState: q('#exams-empty-state'),
            emptyStateMessage: q('#empty-state-message'),
            clearFiltersBtn: q('#clear-filters-btn'),
            loadMoreBtn: q('#load-more-exams'),
            loadMoreContainer: q('.load-more-container'),
            searchInput: q('#exams-search-input'),
            clearSearchBtn: q('#clear-search-btn'),
            totalExamsEl: q('[data-stat="total-exams"]'),
            completedExamsEl: q('[data-stat="completed-exams"]'),
            passedExamsEl: q('[data-stat="passed-exams"]'),
            averageScoreEl: q('[data-stat="average-score"]'),
            subtitleEl: q('#exams-subtitle'),
            addExamBtn: q('[data-action="add-exam"]')
        } : {
            introSection: q('#exam-intro-section'),
            screenSection: q('#exam-screen-section'),
            resultsSection: q('#exam-results-section'),
            reviewSection: q('#exam-review-section'),
            breadcrumbTitle: q('#breadcrumb-exam-title'),
            examTitle: q('#exam-title'),
            examDescription: q('#exam-description'),
            stageBadge: q('#exam-stage-badge'),
            gradeBadge: q('#exam-grade-badge'),
            semesterBadge: q('#exam-semester-badge'),
            scopeBadge: q('#exam-scope-badge'),
            challengeBadge: q('#exam-challenge-badge'),
            questionsCountEl: q('#exam-questions-count'),
            durationEl: q('#exam-duration'),
            passScoreEl: q('#exam-pass-score'),
            bestStat: q('#exam-best-stat'),
            bestScoreEl: q('#exam-best-score'),
            resumeCard: q('#exam-resume-card'),
            resumeTime: q('#exam-resume-time'),
            resumeBtn: q('[data-action="resume-exam"]'),
            restartBtn: q('[data-action="restart-exam"]'),
            startBtn: q('[data-action="start-exam"]'),
            backBtns: container.querySelectorAll('[data-action="back-to-exams"]'),

            timerPill: q('.status-pill-time'),
            timerValue: q('#timer-value'),
            questionCounter: q('#question-counter'),
            answeredCount: q('#answered-count'),
            progressPercentage: q('#exam-progress-percentage'),
            progressBarFill: q('#exam-progress-bar'),
            progressBar: q('#exam-progressbar'),

            paletteGrid: q('#question-palette-grid'),
            paletteArrows: container.querySelectorAll('[data-action="palette-prev"], [data-action="palette-next"]'),

            questionNumber: q('#question-number'),
            clearBtn: q('#clear-answer-btn'),
            markBtn: q('#mark-review-btn'),
            markLabel: q('#mark-review-label'),
            imgCol: q('#question-image-col'),
            imgFrame: q('#question-image-frame'),
            img: q('#question-image'),
            zoomBtn: q('#image-zoom-btn'),
            questionText: q('#question-text'),
            options: q('#question-options'),
            prevBtn: q('#prev-question-btn'),
            nextBtn: q('#next-question-btn'),
            navCounter: q('#nav-counter'),
            submitBtn: q('#submit-exam-btn'),

            zoomOverlay: q('#image-zoom-overlay'),
            zoomImg: q('#image-zoom-img'),
            zoomClose: q('#image-zoom-close'),

            scoreCircle: q('#score-circle'),
            scoreValue: q('#score-value'),
            levelBadge: q('#level-badge'),
            medalDisplay: q('#medal-display'),
            medalName: q('#medal-name'),
            prevBestNote: q('#prev-best-note'),
            resultCorrect: q('#result-correct'),
            resultWrong: q('#result-wrong'),
            resultSkipped: q('#result-skipped'),
            resultTime: q('#result-time'),
            feedback: q('#results-feedback'),
            openReviewBtn: q('[data-action="open-review"]'),
            retryBtn: q('[data-action="retry-exam"]'),
            backToResultsBtn: q('[data-action="back-to-results"]'),

            reviewFilters: q('#review-filters'),
            reviewList: q('#review-questions')
        })
    };
}

// ==== 5. إعداد واجهة القائمة حسب الصلاحيات ====

function setupUIForList() {
    const user = state.currentUser;
    const isAdmin = isStaffUser(user);

    if (state.elements.addExamBtn) {
        state.elements.addExamBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    if (state.elements.statsSummary) {
        state.elements.statsSummary.style.display = isStudentUser(user) ? 'block' : 'none';
    }

    if (state.elements.subtitleEl) {
        if (isAdmin) {
            state.elements.subtitleEl.textContent = 'إدارة جميع الامتحانات';
        } else if (user) {
            renderStudentSubtitle();
        } else {
            state.elements.subtitleEl.textContent = 'سجّل الدخول لعرض امتحاناتك';
        }
    }

    // الطالب يرى فصله الحالي فقط، فلا معنى لتصنيفَي الترم الأول/الثاني
    if (!isAdmin) {
        state.elements.categoryBtns?.forEach(btn => {
            if (btn.dataset.category === 'first' || btn.dataset.category === 'second') {
                btn.style.display = 'none';
            }
        });
    }
    // الامتحانات المكتملة تخص الطالب وحده
    if (!isStudentUser(user)) {
        state.elements.categoryBtns?.forEach(btn => {
            if (btn.dataset.category === 'completed') btn.style.display = 'none';
        });
    }

    if (isAdmin) {
        if (state.elements.categoriesTitle) {
            state.elements.categoriesTitle.textContent = 'تصفح حسب المرحلة والصف';
        }
        renderTeacherCategoryTree();
    }
}

function renderStudentSubtitle() {
    const user = state.currentUser;
    const el = state.elements.subtitleEl;
    if (!user || !el) return;

    const stageMap = { 'إعدادي': 'المرحلة الإعدادية', 'ثانوي': 'المرحلة الثانوية' };
    const stage = normalizeStage(user.stage);
    const parts = [
        stageMap[stage] || stage,
        user.grade ? `الصف ${user.grade}` : '',
        state.studentSemester ? `الفصل ${semesterLabel(state.studentSemester)}` : ''
    ].filter(Boolean);
    el.textContent = parts.join(' – ') || 'حسب مرحلتك';
}

// ==== 6. جلب بيانات القائمة ====
// التصفية بالمرحلة والصف والفصل تتم هنا لا في الخادم، لأن getExams يفهم القيم الإنجليزية فقط
// ويتجاهل العربية بصمت فكان الطالب يرى امتحانات كل المراحل

async function loadInitialListData() {
    await loadListData();
}

async function loadListData() {
    if (state.isLoading) {
        // طلب إعادة تحميل أثناء تحميل جارٍ يُؤجَّل بدل أن يُتجاهل
        state.pendingReload = true;
        return;
    }
    const self = state;
    self.isLoading = true;
    showLoading(true);
    showSkeletonGrid(CONFIG.SKELETON_COUNT);

    try {
        const user = self.currentUser;
        const isAdmin = isStaffUser(user);

        if (user && !isAdmin && user.stage && user.grade) {
            await getStudentSemester(user).catch(() => null);
            if (state !== self) return;
            renderStudentSubtitle();
        }

        const [rawExams, resultsMap] = await Promise.all([
            getExams({ limit: CONFIG.FETCH_LIMIT }),
            isStudentUser(user)
                ? getUserExamResultsMap(user.id).catch(() => ({}))
                : Promise.resolve({})
        ]);
        if (state !== self) return;

        self.examResultsMap = resultsMap || {};
        self.exams = filterByAudience(rawExams || []).map(exam => {
            const result = self.examResultsMap[exam.id] || null;
            return {
                ...exam,
                completed: !!result,
                bestScore: result ? safeInt(result.score, 0) : null,
                passed: !!result?.passed
            };
        });

        // فشل جلب الوحدات لا يمنع عرض الامتحانات
        const units = await fetchUnits().catch(error => {
            console.error('❌ [exams] فشل جلب الوحدات:', error);
            return [];
        });
        if (state !== self) return;
        self.units = units;
        if (self.activeUnitId !== null && !self.units.some(u => u.id == self.activeUnitId)) {
            self.activeUnitId = null;
        }

        // ننهي حالة التحميل قبل الرسم لتظهر حالة "لا توجد امتحانات" عند الحاجة
        self.isLoading = false;
        applyFiltersAndRender();
        renderUnitsCarousel();
        updateStatsSummary();

        if (isAdmin) {
            renderTeacherCategoryTree();
        }
    } catch (error) {
        if (state !== self) return;
        console.error('❌ [exams] فشل جلب البيانات:', error);
        showToast('تعذر تحميل الامتحانات', 'error');
        renderEmptyState(true);
    } finally {
        if (state === self) {
            self.isLoading = false;
            showLoading(false);
            if (self.pendingReload) {
                self.pendingReload = false;
                loadListData();
            }
        }
    }
}

function filterByAudience(exams) {
    const user = state.currentUser;
    if (!user || isStaffUser(user)) return exams;

    const stage = normalizeStage(user.stage);
    const grade = safeInt(user.grade, null);
    const semester = state.studentSemester;

    return exams.filter(exam => {
        if (stage && normalizeStage(exam.stage) !== stage) return false;
        if (grade !== null && safeInt(exam.grade, null) !== grade) return false;
        if (semester && normalizeSemester(exam.semester) !== semester) return false;
        return true;
    });
}

async function fetchUnits() {
    const user = state.currentUser;
    if (user && !isStaffUser(user)) {
        if (!user.stage || !user.grade) return [];
        const options = { stage: normalizeStage(user.stage), grade: user.grade };
        if (state.studentSemester) options.semester = state.studentSemester;
        return (await getUnits(options)) || [];
    }
    return (await getUnits()) || [];
}

// ==== 7. فلترة وعرض القائمة ====

function matchesBrowseContext(exam) {
    if (state.activeStage && normalizeStage(exam.stage) !== state.activeStage) return false;
    if (state.activeGrade !== null && safeInt(exam.grade, null) !== state.activeGrade) return false;
    if (state.workingSemester && normalizeSemester(exam.semester) !== state.workingSemester) return false;
    return true;
}

function applyFiltersAndRender({ keepAnimated = false, resetPaging = true } = {}) {
    let filtered = state.exams.filter(matchesBrowseContext);

    const latest = isLatestMode();

    if (state.activeUnitId !== null && !latest) {
        filtered = filtered.filter(e => e.unit_id == state.activeUnitId);
    }

    switch (state.activeCategory) {
        case 'first':
            filtered = filtered.filter(e => normalizeSemester(e.semester) === 'أول');
            break;
        case 'second':
            filtered = filtered.filter(e => normalizeSemester(e.semester) === 'ثاني');
            break;
        case 'comprehensive':
            filtered = filtered.filter(e => e.exam_scope === 'comprehensive');
            break;
        case 'challenge':
            filtered = filtered.filter(e => e.is_challenge);
            break;
        case 'completed':
            filtered = filtered.filter(e => e.completed);
            break;
    }

    if (state.searchTerm) {
        const term = state.searchTerm.toLowerCase().trim();
        filtered = filtered.filter(e =>
            String(e.title || '').toLowerCase().includes(term) ||
            String(e.description || '').toLowerCase().includes(term)
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

    state.filteredExams = filtered;
    if (resetPaging) state.visibleCount = CONFIG.EXAMS_PER_PAGE;
    updateSectionHeader();

    renderExamsGrid(filtered, { keepAnimated });
    updateEmptyStateVisibility();
    updateClearFiltersButton();
    updateLoadMoreButton();
}

function updateSectionHeader() {
    const { unitsTitleIcon, unitsTitleText, sectionCount } = state.elements;
    if (!unitsTitleText) return;
    const latest = isLatestMode();
    unitsTitleText.textContent = latest ? 'أحدث الامتحانات' : 'الوحدات والأبواب';
    if (unitsTitleIcon) unitsTitleIcon.className = latest ? 'fas fa-clock' : 'fas fa-layer-group';
    if (sectionCount) {
        sectionCount.hidden = !latest;
        if (latest) sectionCount.textContent = `${state.filteredExams.length} امتحان`;
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
        (!state.activeStage || normalizeStage(item.stage) === state.activeStage) &&
        (state.activeGrade === null || Number(item.grade) === state.activeGrade) &&
        (!state.workingSemester || normalizeSemester(item.semester) === state.workingSemester)
    );

    const visibleUnits = state.units.filter(inScope);
    const scopedExams = state.exams.filter(matchesBrowseContext);
    const unitCount = (unit) => scopedExams.filter(e => e.unit_id == unit.id).length;

    if (visibleUnits.length === 0) {
        container.innerHTML = `<div class="units-empty">
            <i class="fas fa-folder-open"></i>
            <p>لا توجد وحدات متاحة</p>
        </div>`;
        return;
    }

    const allBtn = `<div class="unit-card ${state.activeUnitId === null ? 'active' : ''}" data-unit-id="all" role="button" tabindex="0" aria-pressed="${state.activeUnitId === null}">
        <div class="unit-card-main">
            <div class="unit-icon"><i class="fas fa-th-large"></i></div>
            <h4 class="unit-name">الكل</h4>
            <span class="unit-count">${scopedExams.length} امتحان</span>
        </div>
    </div>`;

    const unitsHtml = visibleUnits.map(unit => `
        <div class="unit-card ${state.activeUnitId == unit.id ? 'active' : ''}" data-unit-id="${escapeHtml(unit.id)}" role="button" tabindex="0" aria-pressed="${state.activeUnitId == unit.id}">
            <div class="unit-card-main">
                <div class="unit-icon"><i class="fas fa-layer-group"></i></div>
                <h4 class="unit-name">${escapeHtml(unit.name)}</h4>
                <span class="unit-count">${unitCount(unit)} امتحان</span>
            </div>
        </div>`).join('');

    container.innerHTML = allBtn + unitsHtml;

    const selectUnit = (card) => {
        const val = card.dataset.unitId;
        const newId = val === 'all' ? null : val;
        state.activeUnitId = (state.activeUnitId == newId) ? null : newId;
        container.querySelectorAll('.unit-card').forEach(c => {
            const cVal = c.dataset.unitId;
            const cId = cVal === 'all' ? null : cVal;
            const isActive = cId == state.activeUnitId;
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
}

function renderExamsGrid(exams, { keepAnimated = false } = {}) {
    const grid = state.elements.examsGrid;
    if (!grid) return;

    grid.removeAttribute('aria-busy');

    if (!exams || exams.length === 0) {
        grid.innerHTML = '';
        state.renderedCardIds = new Set();
        return;
    }

    const isAdmin = isStaffUser(state.currentUser);
    const known = keepAnimated ? state.renderedCardIds : new Set();
    const visible = exams.slice(0, state.visibleCount);

    grid.innerHTML = visible
        .map(exam => createExamCard(exam, isAdmin, known.has(String(exam.id))))
        .join('');
    state.renderedCardIds = new Set(visible.map(e => String(e.id)));
    bindImageFallbacks(grid, '.exam-card-cover img', 'cover-placeholder-inner');

    grid.querySelectorAll('.exam-card').forEach(card => {
        const id = card.dataset.id;

        card.addEventListener('click', (e) => {
            if (e.target.closest('.exam-card-tools')) return;
            if (e.target.closest('button') && !e.target.closest('.exam-tools-toggle')) return;
            if (isAdmin) {
                toggleCardTools(card, grid);
                return;
            }
            navigateToExam(id);
        });

        const startBtn = card.querySelector('.start-exam-btn');
        startBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateToExam(id);
        });
    });

    if (isAdmin) {
        bindAdminActions(grid);
    }
}

function createExamCard(exam, isAdmin, isKnown = false) {
    const unit = exam.unit_id ? state.units.find(u => u.id == exam.unit_id) : null;
    const isComprehensive = exam.exam_scope === 'comprehensive';
    const scopeLabel = isComprehensive ? 'شامل' : (unit?.name || 'وحدة');
    const scopeIcon = isComprehensive ? 'fa-globe' : 'fa-layer-group';

    const completed = !!exam.completed;
    const passed = completed && exam.passed;
    const failed = completed && !exam.passed;
    const progress = completed ? Math.min(100, Math.max(0, safeInt(exam.bestScore, 0))) : 0;

    const coverHtml = exam.cover_image_url
        ? `<img src="${escapeHtml(exam.cover_image_url)}" alt="${escapeHtml(exam.title)}" loading="lazy" decoding="async">`
        : `<div class="cover-placeholder-inner"><i class="fas fa-graduation-cap" aria-hidden="true"></i></div>`;

    const statusBadgeHtml = passed
        ? `<span class="exam-status-badge status-completed completed-badge"><i class="fas fa-check-circle" aria-hidden="true"></i> ناجح ${progress}%</span>`
        : failed
            ? `<span class="exam-status-badge status-inprogress status-failed"><i class="fas fa-redo" aria-hidden="true"></i> ${progress}%</span>`
            : exam.is_challenge
                ? `<span class="exam-status-badge status-challenge"><i class="fas fa-trophy" aria-hidden="true"></i> المتفوقين</span>`
                : '<span></span>';
    const durationBadgeHtml = `<span class="exam-duration-badge"><i class="fas fa-clock" aria-hidden="true"></i> ${safeInt(exam.duration, 30)} دقيقة</span>`;

    const tagsParts = [];
    if (exam.grade) tagsParts.push(`<span class="exam-tag exam-tag-secondary">الصف ${escapeHtml(String(exam.grade))}</span>`);
    if (exam.semester) tagsParts.push(`<span class="exam-tag exam-tag-success">الفصل ${escapeHtml(semesterLabel(exam.semester))}</span>`);
    tagsParts.push(`<span class="exam-tag exam-tag-primary"><i class="fas ${scopeIcon}" aria-hidden="true"></i> ${escapeHtml(scopeLabel)}</span>`);
    const metaHtml = `<div class="exam-card-meta">
        <div class="exam-card-tags">${tagsParts.join('')}</div>
        <span class="exam-questions-count"><i class="fas fa-question-circle" aria-hidden="true"></i> ${safeInt(exam.questions_count, 0)} سؤال</span>
    </div>`;

    const progressHtml = progress > 0 ? `
        <div class="exam-progress">
            <div class="progress-bar-container" role="progressbar" aria-label="أفضل نتيجة" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
                <div class="progress-bar-fill" style="width:${progress}%"></div>
            </div>
            <span class="progress-text">${progress}%</span>
        </div>` : '';

    const adminActionsHtml = isAdmin ? `
        <div class="exam-card-tools" id="exam-tools-${exam.id}">
            <div class="exam-card-tools-inner">
                <div class="exam-card-admin-actions teacher-only" role="group" aria-label="إجراءات الامتحان">
                    <button type="button" class="action-btn edit-btn" data-action="edit" data-id="${exam.id}" title="تعديل الامتحان" aria-label="تعديل الامتحان">
                        <i class="fas fa-edit" aria-hidden="true"></i><span>تعديل</span>
                    </button>
                    <button type="button" class="action-btn move-btn" data-action="move" data-id="${exam.id}" title="تحريك الامتحان" aria-label="تحريك الامتحان">
                        <i class="fas fa-arrows-alt-v" aria-hidden="true"></i><span>نقل</span>
                    </button>
                    <button type="button" class="action-btn delete-btn" data-action="delete" data-id="${exam.id}" title="حذف الامتحان" aria-label="حذف الامتحان">
                        <i class="fas fa-trash-alt" aria-hidden="true"></i><span>حذف</span>
                    </button>
                </div>
            </div>
        </div>` : '';

    const toolsToggleHtml = isAdmin ? `
        <button type="button" class="exam-tools-toggle" aria-expanded="false" aria-controls="exam-tools-${exam.id}" title="أدوات المعلم" aria-label="أدوات المعلم">
            <i class="fas fa-sliders-h" aria-hidden="true"></i>
        </button>` : '';

    return `
        <div class="exam-card ${passed ? 'completed' : ''} ${failed ? 'in-progress' : ''} ${isKnown ? 'is-static' : ''}" data-id="${exam.id}" role="article" aria-label="${escapeHtml(exam.title)}">
            <div class="exam-card-cover">
                ${coverHtml}
                <div class="exam-card-badges">
                    ${statusBadgeHtml}
                    ${durationBadgeHtml}
                </div>
                <div class="exam-play-overlay" aria-hidden="true"><i class="fas fa-play"></i></div>
            </div>
            <div class="exam-card-body">
                <div class="exam-card-header">
                    <h3 class="exam-title">${escapeHtml(exam.title)}</h3>
                    ${exam.description ? `<p class="exam-description">${escapeHtml(exam.description)}</p>` : ''}
                </div>
                ${metaHtml}
                ${progressHtml}
            </div>
            <div class="exam-card-footer ${isAdmin ? 'has-admin' : ''}">
                ${adminActionsHtml}
                <button type="button" class="btn btn-primary btn-sm start-exam-btn" data-id="${exam.id}">
                    <i class="fas ${completed ? 'fa-redo' : 'fa-play'}" aria-hidden="true"></i>
                    ${completed ? 'إعادة المحاولة' : 'ابدأ الامتحان'}
                </button>
                ${toolsToggleHtml}
            </div>
        </div>`;
}

// ==== 8. التحميل الهيكلي (Skeleton) ====

function renderSkeletonCards(count = CONFIG.SKELETON_COUNT) {
    const safeCount = Math.max(1, Math.min(count, CONFIG.SKELETON_COUNT));
    const singleCard = `
        <div class="exam-card-skeleton" aria-hidden="true">
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

function showSkeletonGrid(count) {
    const grid = state.elements.examsGrid;
    if (!grid) return;
    if (state.elements.emptyState) state.elements.emptyState.style.display = 'none';
    if (state.elements.loadMoreContainer) state.elements.loadMoreContainer.style.display = 'none';
    grid.style.display = 'grid';
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = renderSkeletonCards(count);
}

function setCardTools(card, open) {
    card.classList.toggle('tools-open', open);
    card.querySelector('.exam-tools-toggle')?.setAttribute('aria-expanded', String(open));
}

function toggleCardTools(card, grid) {
    const open = !card.classList.contains('tools-open');
    if (open) {
        grid.querySelectorAll('.exam-card.tools-open').forEach(other => {
            if (other !== card) setCardTools(other, false);
        });
    }
    setCardTools(card, open);
    if (!open) return;

    const reduce = prefersReducedMotion();
    setTimeout(() => {
        if (!card.classList.contains('tools-open')) return;
        card.querySelector('.exam-card-footer')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
    }, reduce ? 0 : 420);
}

function bindAdminActions(grid) {
    grid.querySelectorAll('[data-action="edit"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditExamModal(btn.dataset.id);
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
            openMoveExamModal(btn.dataset.id);
        });
    });
}

function renderEmptyState(isError = false) {
    const grid = state.elements.examsGrid;
    const emptyState = state.elements.emptyState;
    if (!grid || !emptyState) return;

    grid.removeAttribute('aria-busy');
    grid.innerHTML = '';
    grid.style.display = 'none';
    emptyState.style.display = 'flex';
    if (state.elements.loadMoreContainer) state.elements.loadMoreContainer.style.display = 'none';

    if (state.elements.emptyStateMessage) {
        state.elements.emptyStateMessage.textContent = isError
            ? 'حدث خطأ أثناء تحميل الامتحانات'
            : 'لا توجد امتحانات متاحة حالياً';
    }

    emptyState.querySelector('.retry-btn')?.remove();

    if (isError) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-outline retry-btn';
        retryBtn.textContent = 'إعادة المحاولة';
        retryBtn.addEventListener('click', () => loadListData());
        emptyState.appendChild(retryBtn);
    }
}

function updateEmptyStateVisibility() {
    const emptyState = state.elements.emptyState;
    const grid = state.elements.examsGrid;
    if (!emptyState || !grid) return;

    const isEmpty = state.filteredExams.length === 0 && !state.isLoading;
    emptyState.style.display = isEmpty ? 'flex' : 'none';
    grid.style.display = isEmpty ? 'none' : 'grid';
    emptyState.querySelector('.retry-btn')?.remove();

    if (isEmpty && state.elements.emptyStateMessage) {
        if (state.searchTerm) {
            state.elements.emptyStateMessage.textContent = `لا توجد نتائج لـ "${state.searchTerm}"`;
        } else if (state.activeCategory === 'completed') {
            state.elements.emptyStateMessage.textContent = 'لم تُكمل أي امتحانات بعد';
        } else if (state.activeCategory !== 'all') {
            state.elements.emptyStateMessage.textContent = 'لا توجد امتحانات في هذا التصنيف';
        } else if (state.activeUnitId !== null || state.activeStage || state.activeGrade !== null || state.workingSemester) {
            state.elements.emptyStateMessage.textContent = 'لا توجد امتحانات في هذا النطاق';
        } else {
            state.elements.emptyStateMessage.textContent = 'لا توجد امتحانات متاحة حالياً';
        }
    }
}

function hasMoreExams() {
    return state.filteredExams.length > state.visibleCount;
}

function updateLoadMoreButton() {
    const container = state.elements.loadMoreContainer;
    const btn = state.elements.loadMoreBtn;
    if (!container || !btn) return;

    if (hasMoreExams()) {
        const remaining = state.filteredExams.length - state.visibleCount;
        container.style.display = 'flex';
        btn.innerHTML = `<i class="fas fa-arrow-down" aria-hidden="true"></i> تحميل المزيد (${remaining})`;
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

// ملخص الطالب يُحسب من نتائجه داخل نطاق امتحاناته فيتطابق دائماً مع ما يراه في البطاقات
function updateStatsSummary() {
    if (!state.elements.statsSummary ||
        state.elements.statsSummary.style.display === 'none') return;
    if (!isStudentUser(state.currentUser)) return;

    const scoped = state.exams.filter(matchesBrowseContext);
    const done = scoped.filter(e => e.completed);
    const passed = done.filter(e => e.passed).length;
    const average = done.length
        ? Math.round(done.reduce((sum, e) => sum + (e.bestScore || 0), 0) / done.length)
        : 0;

    if (state.elements.totalExamsEl)
        state.elements.totalExamsEl.textContent = scoped.length;
    if (state.elements.completedExamsEl)
        state.elements.completedExamsEl.textContent = done.length;
    if (state.elements.passedExamsEl)
        state.elements.passedExamsEl.textContent = passed;
    if (state.elements.averageScoreEl)
        state.elements.averageScoreEl.textContent = average + '%';
}

// ==== 9. معالجات أحداث القائمة ====

function bindListEvents() {
    state.elements.categoryBtns?.forEach(btn => {
        btn.addEventListener('click', () => setActiveCategory(btn.dataset.category));
    });

    if (state.elements.searchInput) {
        state.elements.searchInput.addEventListener('input', handleSearchInput);
        state.elements.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && state.elements.searchInput.value) clearSearch();
        });
    }
    if (state.elements.clearSearchBtn) {
        state.elements.clearSearchBtn.addEventListener('click', clearSearch);
    }
    if (state.elements.clearFiltersBtn) {
        state.elements.clearFiltersBtn.addEventListener('click', clearAllFilters);
    }

    if (state.elements.loadMoreBtn) {
        state.elements.loadMoreBtn.addEventListener('click', loadMoreExams);
    }

    if (state.elements.addExamBtn) {
        state.elements.addExamBtn.addEventListener('click', openAddExamModal);
    }

    bindCardGlow(state.elements.examsGrid);

    state.scrollHandler = () => {
        if (state.isLoading || !hasMoreExams()) return;
        const scrollPos = window.innerHeight + window.scrollY;
        const threshold = document.body.offsetHeight - CONFIG.SCROLL_THRESHOLD;
        if (scrollPos >= threshold) loadMoreExams();
    };
    window.addEventListener('scroll', state.scrollHandler, { passive: true });

    const unsubCreated = EventBus.on('exam:created', () => refreshListData());
    const unsubUpdated = EventBus.on('exam:updated', () => refreshListData());
    const unsubDeleted = EventBus.on('exam:deleted', () => refreshListData());
    const unsubMoved = EventBus.on('exam:moved', () => refreshListData());
    const unsubUnitCreated = EventBus.on('unit:created', () => refreshListData());
    const unsubUnitUpdated = EventBus.on('unit:updated', () => refreshListData());
    const unsubUnitDeleted = EventBus.on('unit:deleted', () => refreshListData());
    const unsubSemester = EventBus.on('semester:active-changed', ({ stage, grade } = {}) => {
        const user = state.currentUser;
        if (!isStudentUser(user)) return;
        if (normalizeStage(user.stage) === normalizeStage(stage) && String(user.grade) === String(grade)) {
            state.studentSemester = null;
            refreshListData();
        }
    });
    state.eventUnsubscribers.push(
        unsubCreated, unsubUpdated, unsubDeleted, unsubMoved,
        unsubUnitCreated, unsubUnitUpdated, unsubUnitDeleted,
        unsubSemester
    );
}

function loadMoreExams() {
    if (!hasMoreExams()) return;
    state.visibleCount += CONFIG.EXAMS_PER_PAGE;
    renderExamsGrid(state.filteredExams, { keepAnimated: true });
    updateLoadMoreButton();
}

function handleSearchInput(e) {
    const query = e.target.value;
    if (state.elements.clearSearchBtn) {
        state.elements.clearSearchBtn.style.display = query ? 'flex' : 'none';
    }
    if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = setTimeout(() => {
        state.searchTerm = query.trim();
        applyFiltersAndRender();
    }, CONFIG.SEARCH_DEBOUNCE_MS);
}

function clearSearch() {
    if (state.elements.searchInput) {
        state.elements.searchInput.value = '';
        state.elements.searchInput.focus();
    }
    if (state.elements.clearSearchBtn) state.elements.clearSearchBtn.style.display = 'none';
    if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);
    if (!state.searchTerm) return;
    state.searchTerm = '';
    applyFiltersAndRender();
}

function clearAllFilters() {
    state.activeCategory = 'all';
    state.activeUnitId = null;
    state.searchTerm = '';
    state.activeStage = null;
    state.activeGrade = null;
    state.workingSemester = null;
    if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);

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
    applyFiltersAndRender();
    updateStatsSummary();
}

// ==== 10. شجرة تنقّل المعلم ====
// للتصفح فقط ولا تغيّر الفصل الذي يراه الطلاب

function renderTeacherCategoryTree() {
    const container = state.elements.categoriesContainer;
    if (!container) return;

    const countForStage = (stage) => state.exams.filter(e => normalizeStage(e.stage) === stage).length;
    const countForGrade = (stage, grade) =>
        state.exams.filter(e => normalizeStage(e.stage) === stage && safeInt(e.grade, null) === grade).length;

    const stageChipsHtml = HIERARCHY.stages.map(stage => {
        const isStageActive = state.activeStage === stage.value;
        return `
            <button type="button" class="stage-chip ${isStageActive ? 'active' : ''}"
                data-stage="${escapeHtml(stage.value)}" aria-expanded="${isStageActive}">
                <span class="stage-chip-icon"><i class="fas fa-layer-group" aria-hidden="true"></i></span>
                <span class="stage-chip-text">
                    <span class="stage-chip-name">${stage.label}</span>
                    <span class="chip-count">${countForStage(stage.value)} امتحان</span>
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
                                تعرض الآن الفصل ${semesterLabel(state.workingSemester)} —
                                والفصل الظاهر حاليًا للطلاب هو ${semesterLabel(liveSemester)}
                            </p>` : ''}
                    </div>`;
            }

            return `
                <button type="button" class="grade-chip ${isGradeActive ? 'active' : ''}"
                    data-stage="${escapeHtml(activeStage.value)}" data-grade="${grade.value}">
                    <span class="grade-chip-name">الصف ${grade.label}</span>
                    <span class="chip-count">${countForGrade(activeStage.value, grade.value)} امتحان</span>
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

function refreshAfterTreeContextChange() {
    state.activeUnitId = null;
    applyFiltersAndRender();
    renderUnitsCarousel();
    renderTeacherCategoryTree();
    updateClearFiltersButton();
    updateStatsSummary();
}

function toggleStageContext(stage) {
    state.activeStage = (state.activeStage === stage) ? null : stage;
    state.activeGrade = null;
    state.workingSemester = null;
    refreshAfterTreeContextChange();
}

async function toggleGradeContext(stage, grade) {
    const self = state;
    const isSame = state.activeStage === stage && state.activeGrade === grade;
    state.activeStage = stage;
    state.activeGrade = isSame ? null : grade;
    state.workingSemester = null;
    refreshAfterTreeContextChange();

    if (isSame) return;

    // الفصل الحي يُعرض كتنبيه فقط بدون تأثير على أي فلترة
    const cacheKey = `${stage}_${grade}`;
    if (state.liveSemesterCache[cacheKey] === undefined) {
        let live = null;
        try {
            live = normalizeSemester(await getActiveSemesterFor(stage, grade)) || null;
        } catch (_) { /* التلميح اختياري */ }
        if (self !== state) return;
        state.liveSemesterCache[cacheKey] = live;
        renderTeacherCategoryTree();
    }
}

function setWorkingSemester(semester) {
    state.workingSemester = state.workingSemester === semester ? null : semester;
    refreshAfterTreeContextChange();
}

function setActiveCategory(category) {
    state.activeCategory = state.activeCategory === category && category !== 'all' ? 'all' : category;
    state.elements.categoryBtns?.forEach(btn => {
        const isActive = btn.dataset.category === state.activeCategory;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
    });
    applyFiltersAndRender();
    updateClearFiltersButton();
}

async function refreshListData() {
    await loadListData();
}

// ==== 11. جلب وعرض بيانات الامتحان الفردي ====

async function loadExamData(examId) {
    const self = state;
    showLoading(true);
    try {
        const data = await getExamFullData(examId);
        if (state !== self) return;

        if (!data || !data.questions || data.questions.length === 0) {
            showToast('الامتحان غير موجود أو لا يحتوي على أسئلة', 'error');
            window.router?.navigateTo('exams');
            return;
        }

        if (!canStudentAccessExam(data.meta)) {
            showToast('هذا الامتحان غير متاح لمرحلتك أو صفك الدراسي', 'warning');
            window.router?.navigateTo('exams');
            return;
        }

        state.examMeta = data.meta;
        state.questions = data.questions;
        state.durationSeconds = Math.max(60, safeInt(data.meta.duration, 30) * 60);

        if (isStudentUser(state.currentUser)) {
            try {
                const map = await getUserExamResultsMap(state.currentUser.id);
                if (state !== self) return;
                state.previousBest = map?.[safeInt(examId, examId)] || null;
            } catch (_) {
                state.previousBest = null;
            }
        }

        renderIntroScreen();
    } finally {
        if (state === self) showLoading(false);
    }
}

function setupUIForView() {
    // المعلم والمشرف في وضع معاينة: لا تُحفظ نتائجهم
    state.elements.submitBtn?.setAttribute('data-preview', String(!isStudentUser(state.currentUser)));
}

// ==== 12. شاشة المقدمة ====

function renderIntroScreen() {
    const meta = state.examMeta;
    const el = state.elements;

    if (el.breadcrumbTitle) el.breadcrumbTitle.textContent = meta.title;
    if (el.examTitle) el.examTitle.textContent = meta.title;
    if (el.examDescription) el.examDescription.textContent = meta.description || 'لا يوجد وصف لهذا الامتحان.';
    if (el.stageBadge) el.stageBadge.textContent = stageLabel(meta.stage) || '-';
    if (el.gradeBadge) el.gradeBadge.textContent = `الصف ${meta.grade || '-'}`;
    if (el.semesterBadge) el.semesterBadge.textContent = `الفصل ${semesterLabel(meta.semester) || '-'}`;
    if (el.scopeBadge) el.scopeBadge.textContent = meta.exam_scope === 'comprehensive' ? 'امتحان شامل' : 'امتحان وحدة';
    if (el.challengeBadge) el.challengeBadge.style.display = meta.is_challenge ? 'inline-flex' : 'none';
    if (el.questionsCountEl) el.questionsCountEl.textContent = state.questions.length;
    if (el.durationEl) el.durationEl.textContent = state.durationSeconds / 60;
    if (el.passScoreEl) el.passScoreEl.textContent = CONFIG.PASS_THRESHOLD;

    if (state.previousBest && el.bestStat) {
        if (el.bestScoreEl) el.bestScoreEl.textContent = safeInt(state.previousBest.score, 0);
        el.bestStat.style.display = 'flex';
        el.bestStat.parentElement?.classList.add('has-best');
    }

    const saved = readSession();
    const remaining = saved ? Math.floor((saved.endsAt - Date.now()) / 1000) : 0;
    if (saved && remaining > 0) {
        if (el.resumeTime) el.resumeTime.textContent = formatTime(remaining);
        if (el.resumeCard) el.resumeCard.style.display = 'flex';
        if (el.startBtn) el.startBtn.style.display = 'none';
    } else {
        if (saved) {
            clearSession();
            showToast('انتهى وقت محاولتك السابقة', 'info');
        }
        if (el.resumeCard) el.resumeCard.style.display = 'none';
        if (el.startBtn) el.startBtn.style.display = '';
    }

    document.title = `${meta.title} - منصة بيولوجست`;
    showScreen('intro');
}

// ==== 13. معالجات أحداث أداء الامتحان ====

function bindViewEvents() {
    const el = state.elements;

    el.startBtn?.addEventListener('click', () => startExam());
    el.resumeBtn?.addEventListener('click', resumeExam);
    el.restartBtn?.addEventListener('click', () => {
        clearSession();
        startExam();
    });
    el.backBtns?.forEach(btn => btn.addEventListener('click', goToList));

    el.prevBtn?.addEventListener('click', () => goToQuestion(state.currentIndex - 1));
    el.nextBtn?.addEventListener('click', () => goToQuestion(state.currentIndex + 1));
    el.submitBtn?.addEventListener('click', () => confirmSubmitExam());
    el.markBtn?.addEventListener('click', toggleMarkForReview);
    el.clearBtn?.addEventListener('click', clearCurrentAnswer);

    el.options?.addEventListener('change', (e) => {
        if (e.target?.matches('input[name="exam-answer"]')) selectAnswer(e.target.value);
    });

    el.paletteGrid?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-index]');
        if (btn) goToQuestion(safeInt(btn.dataset.index, 0));
    });
    el.paletteArrows?.forEach(btn => {
        btn.addEventListener('click', () => {
            const grid = el.paletteGrid;
            if (!grid) return;
            // الاتجاه RTL: السهم الأيمن يرجع للبداية والأيسر يتقدم
            const step = Math.max(120, grid.clientWidth * 0.7);
            const dir = btn.dataset.action === 'palette-prev' ? 1 : -1;
            grid.scrollBy({ left: dir * step, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        });
    });

    el.imgFrame?.addEventListener('click', openImageZoom);
    el.zoomBtn?.addEventListener('click', openImageZoom);
    el.zoomClose?.addEventListener('click', closeImageZoom);
    el.zoomOverlay?.addEventListener('click', (e) => {
        if (e.target === el.zoomOverlay) closeImageZoom();
    });
    el.img?.addEventListener('error', () => el.imgCol?.classList.add('is-broken'));

    el.retryBtn?.addEventListener('click', retryExam);
    el.openReviewBtn?.addEventListener('click', openReviewScreen);
    el.backToResultsBtn?.addEventListener('click', () => showScreen('results'));
    el.feedback?.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="retry-save"]')) retrySaveResult();
    });
    el.reviewFilters?.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-filter]');
        if (!chip) return;
        state.reviewFilter = chip.dataset.filter;
        renderReviewList();
    });

    state.viewHandlers = {
        keydown: handleViewKeydown,
        beforeUnload: handleBeforeUnload,
        pageHide: persistSession,
        visibility: () => {
            if (document.visibilityState === 'visible' && state.inProgress) tick();
        }
    };
    document.addEventListener('keydown', state.viewHandlers.keydown);
    document.addEventListener('visibilitychange', state.viewHandlers.visibility);
    window.addEventListener('beforeunload', state.viewHandlers.beforeUnload);
    window.addEventListener('pagehide', state.viewHandlers.pageHide);

    const unsubDeleted = EventBus.on('exam:deleted', ({ examId } = {}) => {
        if (String(examId) !== String(state.examId)) return;
        clearSession();
        state.inProgress = false;
        showToast('تم حذف هذا الامتحان', 'info');
        window.router?.navigateTo('exams');
    });
    state.eventUnsubscribers.push(unsubDeleted);

    // حماية الامتحان الجاري من الخروج العرضي بزر الرجوع
    const unregisterBack = window.router?.registerBackHandler?.(() => {
        if (!state.inProgress || state.submitted) return false;
        window.modals?.confirm({
            title: 'مغادرة الامتحان؟',
            message: 'إجاباتك محفوظة مؤقتاً ويمكنك المتابعة طالما لم ينتهِ الوقت. هل تريد المغادرة؟',
            confirmText: 'مغادرة',
            cancelText: 'متابعة الامتحان',
            confirmType: 'danger',
            onConfirm: () => {
                persistSession();
                window.router?.navigateTo('exams');
            }
        });
        return true;
    });
    if (unregisterBack) state.eventUnsubscribers.push(unregisterBack);
}

function goToList() {
    window.router?.navigateTo('exams');
}

function handleBeforeUnload(e) {
    if (!state.inProgress) return;
    persistSession();
    e.preventDefault();
    e.returnValue = '';
}

function handleViewKeydown(e) {
    if (e.key === 'Escape') {
        closeImageZoom();
        return;
    }
    if (!state.inProgress || state.screen !== 'screen') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target?.closest?.('input[type="text"], textarea, [contenteditable]')) return;
    if (state.elements.zoomOverlay?.classList.contains('open')) return;

    const question = state.questions[state.currentIndex];
    switch (e.key) {
        case 'ArrowLeft': goToQuestion(state.currentIndex + 1); break;   // RTL: اليسار = التالي
        case 'ArrowRight': goToQuestion(state.currentIndex - 1); break;
        case 'm': case 'M': toggleMarkForReview(); break;
        default: {
            const n = parseInt(e.key, 10);
            if (!question || Number.isNaN(n)) return;
            if (question.type === 'multiple_choice' && n >= 1 && n <= question.options.length) {
                selectAnswer(String(n - 1), true);
            } else if (question.type !== 'multiple_choice' && (n === 1 || n === 2)) {
                selectAnswer(n === 1 ? 'true' : 'false', true);
            }
        }
    }
}

// ==== 14. حفظ الجلسة واستئنافها ====
// يمنع ضياع الإجابات عند تحديث الصفحة، ويعتمد على وقت الانتهاء المطلق لا على عدّاد قابل للتلاعب بالتحديث

function sessionKey() {
    return `${CONFIG.SESSION_PREFIX}_${state.currentUser?.id}_${state.examId}`;
}

function persistSession() {
    if (!state.inProgress || state.submitted) return;
    try {
        sessionStorage.setItem(sessionKey(), JSON.stringify({
            answers: state.answers,
            marked: [...state.markedForReview],
            currentIndex: state.currentIndex,
            startedAt: state.startedAt,
            endsAt: state.endsAt,
            total: state.questions.length
        }));
    } catch (_) { /* التخزين قد يكون محظوراً */ }
}

function readSession() {
    try {
        const raw = sessionStorage.getItem(sessionKey());
        if (!raw) return null;
        const saved = JSON.parse(raw);
        if (!saved || saved.total !== state.questions.length || !saved.endsAt) return null;
        return saved;
    } catch (_) {
        return null;
    }
}

function clearSession() {
    try { sessionStorage.removeItem(sessionKey()); } catch (_) { }
}

// ==== 15. تكبير صورة السؤال ====

function openImageZoom() {
    const el = state.elements;
    const question = state.questions[state.currentIndex];
    if (!question?.image || !el.zoomOverlay || !el.zoomImg) return;
    el.zoomImg.src = question.image;
    el.zoomOverlay.removeAttribute('hidden');
    requestAnimationFrame(() => el.zoomOverlay.classList.add('open'));
    document.body.classList.add('exam-lightbox-open');
    el.zoomClose?.focus();
}

function closeImageZoom() {
    const el = state.elements;
    if (!el.zoomOverlay) return;
    el.zoomOverlay.classList.remove('open');
    el.zoomOverlay.setAttribute('hidden', '');
    document.body.classList.remove('exam-lightbox-open');
}

// ==== 16. بدء الامتحان واستئنافه ====

function startExam() {
    cancelAnimationFrame(state.countRaf);
    state.currentIndex = 0;
    state.answers = {};
    state.markedForReview = new Set();
    state.submitted = false;
    state.result = null;
    state.pendingSave = null;
    state.startedAt = Date.now();
    state.endsAt = state.startedAt + state.durationSeconds * 1000;
    state.remainingSeconds = state.durationSeconds;
    state.inProgress = true;

    beginScreen();
    persistSession();

    EventBus.emit('exam:start', {
        examId: state.examId,
        userId: state.currentUser?.id
    });
}

function resumeExam() {
    const saved = readSession();
    if (!saved || saved.endsAt <= Date.now()) {
        clearSession();
        startExam();
        return;
    }
    state.answers = saved.answers || {};
    state.markedForReview = new Set(saved.marked || []);
    state.currentIndex = Math.min(Math.max(0, saved.currentIndex || 0), state.questions.length - 1);
    state.startedAt = saved.startedAt || Date.now();
    state.endsAt = saved.endsAt;
    state.submitted = false;
    state.result = null;
    state.inProgress = true;
    beginScreen();
}

function beginScreen() {
    showScreen('screen');
    renderPalette();
    renderQuestion(state.currentIndex);
    startTimer();
}

function retryExam() {
    clearSession();
    startExam();
}

// ==== 17. المؤقت ====

function startTimer() {
    stopTimer();
    tick();
    state.timerInterval = setInterval(tick, 500);
}

function stopTimer() {
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
}

function tick() {
    if (!state.inProgress || state.submitted) return;
    state.remainingSeconds = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
    updateTimerDisplay();

    if (state.remainingSeconds <= 0) {
        stopTimer();
        window.modals?.closeAllModals?.();
        showToast('انتهى وقت الامتحان، سيتم التسليم تلقائياً', 'warning');
        submitExam(true);
    }
}

function updateTimerDisplay() {
    const el = state.elements;
    const seconds = state.remainingSeconds;
    if (el.timerValue) el.timerValue.textContent = formatTime(seconds);
    if (el.timerPill) {
        el.timerPill.classList.toggle('timer-warning', seconds <= CONFIG.TIMER_WARNING_SEC);
    }
}

// ==== 18. عرض الأسئلة والتنقل ====

function renderQuestion(index) {
    const question = state.questions[index];
    if (!question) return;

    state.currentIndex = index;
    const el = state.elements;
    const total = state.questions.length;

    if (el.questionNumber) el.questionNumber.textContent = index + 1;
    if (el.questionCounter) el.questionCounter.textContent = `${index + 1} / ${total}`;
    if (el.navCounter) el.navCounter.textContent = `${index + 1} / ${total}`;
    if (el.questionText) el.questionText.textContent = question.text;

    if (el.imgCol) {
        el.imgCol.classList.remove('is-broken');
        if (question.image) {
            el.imgCol.style.display = '';
            if (el.img) {
                el.img.src = question.image;
                el.img.alt = `صورة السؤال ${index + 1}`;
            }
        } else {
            el.imgCol.style.display = 'none';
            if (el.img) el.img.removeAttribute('src');
        }
    }

    if (el.options) el.options.innerHTML = buildOptionsHTML(question, state.answers[index]);
    updateMarkButton();
    updateClearButton();

    if (el.prevBtn) el.prevBtn.disabled = index === 0;
    if (el.nextBtn) {
        const last = index === total - 1;
        el.nextBtn.disabled = last;
        const label = el.nextBtn.querySelector('span');
        if (label) label.textContent = last ? 'الأخير' : 'التالي';
    }

    updateProgress();
    updatePalette();
    persistSession();
}

function buildOptionsHTML(question, selectedValue) {
    const selected = selectedValue === undefined ? null : String(selectedValue);
    const option = (value, text, letterHtml, i) => `
        <label class="question-option${selected === value ? ' selected' : ''}">
            <input type="radio" name="exam-answer" value="${value}" ${selected === value ? 'checked' : ''}>
            <span class="option-letter">${letterHtml}</span>
            <span class="option-text">${text}</span>
            <kbd class="option-key" aria-hidden="true">${i + 1}</kbd>
        </label>`;

    if (question.type === 'multiple_choice') {
        return question.options.map((o, i) => option(String(i), escapeHtml(o), letterAr(i), i)).join('');
    }
    return option('true', 'صح', '<i class="fas fa-check" aria-hidden="true"></i>', 0)
         + option('false', 'خطأ', '<i class="fas fa-times" aria-hidden="true"></i>', 1);
}

function selectAnswer(rawValue, rerenderOptions = false) {
    state.answers[state.currentIndex] = String(rawValue);

    const el = state.elements;
    if (rerenderOptions) {
        el.options.innerHTML = buildOptionsHTML(state.questions[state.currentIndex], rawValue);
    } else {
        el.options?.querySelectorAll('.question-option').forEach(label => {
            label.classList.toggle('selected', label.querySelector('input')?.checked === true);
        });
    }
    updateClearButton();
    updateProgress();
    updatePalette();
    persistSession();
}

function clearCurrentAnswer() {
    delete state.answers[state.currentIndex];
    renderQuestion(state.currentIndex);
}

function updateClearButton() {
    const btn = state.elements.clearBtn;
    if (btn) btn.disabled = state.answers[state.currentIndex] === undefined;
}

function goToQuestion(index) {
    if (index < 0 || index >= state.questions.length || index === state.currentIndex) return;
    renderQuestion(index);
    state.elements.screenSection?.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

function toggleMarkForReview() {
    const index = state.currentIndex;
    if (state.markedForReview.has(index)) state.markedForReview.delete(index);
    else state.markedForReview.add(index);
    updateMarkButton();
    updatePalette();
    persistSession();
}

function updateMarkButton() {
    const marked = state.markedForReview.has(state.currentIndex);
    const { markBtn, markLabel } = state.elements;
    markBtn?.classList.toggle('marked', marked);
    markBtn?.setAttribute('aria-pressed', String(marked));
    if (markLabel) markLabel.textContent = marked ? 'إزالة التعليم' : 'تعليم للمراجعة';
}

function updateProgress() {
    const total = state.questions.length;
    const answered = Object.keys(state.answers).length;
    const percent = total > 0 ? Math.round((answered / total) * 100) : 0;
    const el = state.elements;

    if (el.progressPercentage) el.progressPercentage.textContent = `${percent}%`;
    if (el.progressBarFill) el.progressBarFill.style.width = `${percent}%`;
    if (el.progressBar) el.progressBar.setAttribute('aria-valuenow', String(percent));
    if (el.answeredCount) el.answeredCount.textContent = answered;
}

// ==== 19. قائمة الأسئلة ====
// تُبنى مرة واحدة وتُحدَّث بالكلاسات فقط، فلا تُعاد كتابة DOM مع كل إجابة

function renderPalette() {
    const grid = state.elements.paletteGrid;
    if (!grid) return;
    grid.innerHTML = state.questions.map((_, i) =>
        `<button type="button" class="palette-btn" data-index="${i}" aria-label="السؤال ${i + 1}">${i + 1}</button>`
    ).join('');
    updatePalette();
}

function updatePalette() {
    const grid = state.elements.paletteGrid;
    if (!grid) return;
    const buttons = grid.children;
    for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        btn.classList.toggle('answered', state.answers[i] !== undefined);
        btn.classList.toggle('marked', state.markedForReview.has(i));
        const current = i === state.currentIndex;
        btn.classList.toggle('current', current);
        if (current) {
            btn.setAttribute('aria-current', 'true');
            centerPaletteButton(grid, btn);
        } else {
            btn.removeAttribute('aria-current');
        }
    }
}

// الإزاحة بالإحداثيات الفعلية فتعمل في RTL دون حسابات scrollLeft السالبة
function centerPaletteButton(grid, btn) {
    if (grid.scrollWidth <= grid.clientWidth) return;
    const gridRect = grid.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const delta = (btnRect.left + btnRect.width / 2) - (gridRect.left + gridRect.width / 2);
    grid.scrollBy({ left: delta, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// ==== 20. التسليم والتصحيح ====
// الحدثان exam:complete وmedal:earned بهذين الاسمين، وتحديث exam_score للدرس مطلوب
// ملاحظة أمنية: التصحيح هنا في المتصفح لأن getExamFullData يرسل الإجابات الصحيحة مع الأسئلة،
// والحل الجذري يكون في الخادم (Cloud Function) ولا يمكن إنجازه من الواجهة وحدها

function confirmSubmitExam() {
    if (state.submitted) return;
    const total = state.questions.length;
    const answered = Object.keys(state.answers).length;
    const marked = state.markedForReview.size;

    const notes = [];
    if (answered < total) notes.push(`لديك ${total - answered} سؤال بدون إجابة.`);
    if (marked > 0) notes.push(`لديك ${marked} سؤال معلّم للمراجعة.`);
    const message = notes.length
        ? `${notes.join(' ')} هل تريد تسليم الامتحان الآن؟ لن تتمكن من تعديل إجاباتك بعد ذلك.`
        : 'هل أنت متأكد من تسليم الامتحان؟ لن تتمكن من تعديل إجاباتك بعد ذلك.';

    if (window.modals?.confirm) {
        window.modals.confirm({
            title: notes.length ? 'قبل التسليم' : 'تأكيد التسليم',
            message,
            confirmText: 'تسليم',
            cancelText: 'متابعة الإجابة',
            onConfirm: () => submitExam(false)
        });
    } else if (window.confirm(message)) {
        submitExam(false);
    }
}

async function submitExam(autoSubmitted) {
    if (state.submitted) return;
    state.submitted = true;
    state.inProgress = false;
    stopTimer();
    clearSession();

    const self = state;
    const timeTakenSeconds = Math.min(
        state.durationSeconds,
        Math.max(0, Math.round((Date.now() - state.startedAt) / 1000))
    );
    const result = calculateResults(timeTakenSeconds);
    state.result = result;

    renderResultsScreen(result, autoSubmitted);

    // المعلم والمشرف في وضع معاينة: لا تُحفظ نتائجهم حتى لا تلوّث إحصائيات الطلاب
    if (isStudentUser(state.currentUser)) {
        state.pendingSave = { result, saved: false };
        await persistResult();
        if (self !== state) return;
    } else {
        showFeedback(result, autoSubmitted, 'preview');
    }

    EventBus.emit('exam:complete', {
        examId: state.examId,
        userId: state.currentUser.id,
        score: result.percentage,
        passed: result.passed,
        medal: result.medal?.key || null
    });

    if (result.medal) {
        EventBus.emit('medal:earned', {
            element: state.elements.medalDisplay,
            examId: state.examId,
            userId: state.currentUser.id,
            medal: result.medal.key,
            medalLabel: result.medal.label
        });
    }
}

async function persistResult() {
    const self = state;
    const pending = state.pendingSave;
    if (!pending || pending.saved) return;
    const { result } = pending;

    try {
        await saveExamResult(state.currentUser.id, {
            examId: state.examId,
            score: result.percentage,
            totalQuestions: result.total,
            correctAnswers: result.correctCount,
            timeTaken: result.timeTakenSeconds,
            passed: result.passed,
            feedback: result.levelLabel
        });
        if (self !== state) return;
        pending.saved = true;

        if (state.examMeta?.lesson_id) {
            try {
                await updateUserExamScore(state.currentUser.id, state.examMeta.lesson_id, result.percentage);
            } catch (scoreError) {
                console.error('⚠️ [exams] فشل تحديث درجة امتحان الدرس:', scoreError.message);
            }
        }
        if (self !== state) return;
        showFeedback(result, result.autoSubmitted, 'saved');
    } catch (error) {
        console.error('❌ [exams] فشل حفظ نتيجة الامتحان:', error);
        if (self !== state) return;
        showFeedback(result, result.autoSubmitted, 'failed');
    }
}

async function retrySaveResult() {
    const btn = state.elements.feedback?.querySelector('[data-action="retry-save"]');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'جاري الحفظ...';
    }
    await persistResult();
}

function calculateResults(timeTakenSeconds) {
    const questions = state.questions;
    const total = questions.length;
    let correctCount = 0;
    let skippedCount = 0;
    const perQuestion = [];

    questions.forEach((q, i) => {
        const rawAnswer = state.answers[i];
        let isCorrect = false;
        let userAnswerLabel = 'لم تتم الإجابة';
        let correctAnswerLabel = '';
        const answered = rawAnswer !== undefined;

        if (q.type === 'multiple_choice') {
            const userIndex = answered ? safeInt(rawAnswer, -1) : -1;
            isCorrect = userIndex === q.correct;
            correctAnswerLabel = `${letterAr(q.correct)}) ${q.options[q.correct] ?? ''}`;
            if (userIndex >= 0 && q.options[userIndex] !== undefined) {
                userAnswerLabel = `${letterAr(userIndex)}) ${q.options[userIndex]}`;
            }
        } else {
            const userBool = rawAnswer === 'true' ? true : rawAnswer === 'false' ? false : null;
            isCorrect = userBool !== null && userBool === q.correct;
            correctAnswerLabel = q.correct ? 'صح' : 'خطأ';
            if (userBool !== null) userAnswerLabel = userBool ? 'صح' : 'خطأ';
        }

        if (isCorrect) correctCount++;
        if (!answered) skippedCount++;
        perQuestion.push({
            index: i,
            question: q,
            isCorrect,
            answered,
            marked: state.markedForReview.has(i),
            userAnswerLabel,
            correctAnswerLabel
        });
    });

    const percentage = total > 0 ? Math.round((correctCount / total) * 100) : 0;
    const passed = percentage >= CONFIG.PASS_THRESHOLD;
    const level = LEVEL_TIERS.find(l => percentage >= l.min) || LEVEL_TIERS[LEVEL_TIERS.length - 1];
    const medal = state.examMeta.is_challenge ? (MEDAL_TIERS.find(m => percentage >= m.min) || null) : null;

    return {
        total,
        correctCount,
        wrongCount: total - correctCount - skippedCount,
        skippedCount,
        percentage,
        passed,
        timeTakenSeconds,
        levelKey: level.key,
        levelLabel: level.label,
        medal,
        perQuestion
    };
}

// ==== 21. شاشة النتائج ====

function renderResultsScreen(result, autoSubmitted) {
    const el = state.elements;
    result.autoSubmitted = !!autoSubmitted;

    if (el.resultCorrect) el.resultCorrect.textContent = result.correctCount;
    if (el.resultWrong) el.resultWrong.textContent = result.wrongCount;
    if (el.resultSkipped) el.resultSkipped.textContent = result.skippedCount;
    if (el.resultTime) el.resultTime.textContent = formatTime(result.timeTakenSeconds);

    animateScore(result.percentage);

    if (el.levelBadge) {
        el.levelBadge.textContent = result.levelLabel;
        el.levelBadge.className = `level-badge level-${result.levelKey}`;
    }

    if (el.medalDisplay) {
        el.medalDisplay.style.display = result.medal ? '' : 'none';
        el.medalDisplay.className = `medal-display${result.medal ? ` medal-${result.medal.key}` : ''}`;
        if (result.medal && el.medalName) el.medalName.textContent = result.medal.label;
    }

    const previous = state.previousBest;
    if (el.prevBestNote) {
        if (previous && isStudentUser(state.currentUser)) {
            const before = safeInt(previous.score, 0);
            const diff = result.percentage - before;
            el.prevBestNote.textContent = diff > 0
                ? `تحسّنت بمقدار ${diff}% عن أفضل نتيجة سابقة (${before}%) 🎉`
                : `أفضل نتيجة سابقة: ${before}%`;
            el.prevBestNote.style.display = '';
        } else {
            el.prevBestNote.style.display = 'none';
        }
    }

    if (el.feedback) {
        el.feedback.innerHTML = isStudentUser(state.currentUser)
            ? '<div class="feedback-message feedback-info"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i><p>جاري حفظ نتيجتك...</p></div>'
            : '';
    }

    state.reviewFilter = 'all';
    showScreen('results');
}

function animateScore(target) {
    const el = state.elements;
    cancelAnimationFrame(state.countRaf);
    const apply = (value) => {
        if (el.scoreValue) el.scoreValue.textContent = `${value}%`;
        el.scoreCircle?.style.setProperty('--score', value);
    };
    if (prefersReducedMotion() || target === 0) {
        apply(target);
        return;
    }

    const start = performance.now();
    const duration = 900;
    const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        apply(Math.round(target * (1 - Math.pow(1 - t, 3))));
        if (t < 1) state.countRaf = requestAnimationFrame(step);
    };
    state.countRaf = requestAnimationFrame(step);
}

function showFeedback(result, autoSubmitted, mode) {
    const el = state.elements.feedback;
    if (!el) return;

    const parts = [];
    const message = (type, icon, text, extra = '') =>
        parts.push(`<div class="feedback-message feedback-${type}"><i class="fas ${icon}" aria-hidden="true"></i><p>${escapeHtml(text)}</p>${extra}</div>`);

    if (autoSubmitted) message('warning', 'fa-hourglass-end', 'تم تسليم الامتحان تلقائياً لانتهاء الوقت المحدد.');

    message(result.passed ? 'success' : 'warning',
        result.passed ? 'fa-check-circle' : 'fa-exclamation-triangle',
        result.passed ? 'أحسنت! لقد اجتزت الامتحان بنجاح.' : 'لم تصل للحد الأدنى للنجاح، راجع إجاباتك وحاول مرة أخرى.');

    if (mode === 'failed') {
        message('error', 'fa-wifi', 'تم تصحيح الامتحان لكن تعذر حفظ النتيجة. تحقق من اتصالك ثم أعد المحاولة.',
            '<button type="button" class="btn btn-outline" data-action="retry-save"><i class="fas fa-redo" aria-hidden="true"></i> إعادة محاولة الحفظ</button>');
    } else if (mode === 'preview') {
        message('info', 'fa-eye', 'وضع المعاينة: لا تُحفظ نتائج المعلمين.');
    }

    el.innerHTML = parts.join('');
}

// ==== 22. شاشة المراجعة ====

function openReviewScreen() {
    if (!state.result) return;
    state.reviewFilter = 'all';
    renderReviewList();
    showScreen('review');
}

function renderReviewList() {
    const { reviewList, reviewFilters } = state.elements;
    if (!reviewList || !state.result) return;

    const filter = state.reviewFilter;
    reviewFilters?.querySelectorAll('[data-filter]').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.filter === filter);
    });

    const items = state.result.perQuestion.filter(item => {
        if (filter === 'wrong') return item.answered && !item.isCorrect;
        if (filter === 'skipped') return !item.answered;
        if (filter === 'marked') return item.marked;
        return true;
    });

    if (items.length === 0) {
        reviewList.innerHTML = '<div class="review-empty"><i class="fas fa-inbox" aria-hidden="true"></i><p>لا توجد أسئلة في هذا التصنيف.</p></div>';
        return;
    }

    reviewList.innerHTML = items.map(item => {
        const status = !item.answered ? 'skipped' : item.isCorrect ? 'correct' : 'incorrect';
        const statusLabel = {
            correct: '<i class="fas fa-check-circle" aria-hidden="true"></i> إجابة صحيحة',
            incorrect: '<i class="fas fa-times-circle" aria-hidden="true"></i> إجابة خاطئة',
            skipped: '<i class="fas fa-minus-circle" aria-hidden="true"></i> بدون إجابة'
        }[status];

        const image = item.question.image
            ? `<div class="review-question-image"><img src="${escapeHtml(item.question.image)}" alt="صورة السؤال ${item.index + 1}" loading="lazy"></div>`
            : '';

        return `
            <article class="review-question-card ${status}">
                <div class="review-question-header">
                    <span class="review-question-num">السؤال ${item.index + 1}${item.marked ? ' <i class="fas fa-bookmark" aria-label="معلّم للمراجعة"></i>' : ''}</span>
                    <span class="review-status status-${status}">${statusLabel}</span>
                </div>
                <p class="review-question-text">${escapeHtml(item.question.text)}</p>
                ${image}
                <div class="review-answers">
                    <div class="review-user-answer"><span>إجابتك:</span><strong class="${item.isCorrect ? 'text-success' : 'text-danger'}">${escapeHtml(item.userAnswerLabel)}</strong></div>
                    ${!item.isCorrect ? `<div class="review-correct-answer"><span>الإجابة الصحيحة:</span><strong class="text-success">${escapeHtml(item.correctAnswerLabel)}</strong></div>` : ''}
                </div>
            </article>`;
    }).join('');
}

// ==== 23. التحكم في عرض الأقسام ====

function showScreen(name) {
    const el = state.elements;
    state.screen = name;
    const sections = {
        intro: el.introSection,
        screen: el.screenSection,
        results: el.resultsSection,
        review: el.reviewSection
    };
    Object.entries(sections).forEach(([key, section]) => {
        if (section) section.style.display = key === name ? '' : 'none';
    });

    if (name !== 'screen') closeImageZoom();
    state.container?.setAttribute('data-screen', name);
    // وضع التركيز أثناء حل الأسئلة فقط
    document.body.classList.toggle('exam-focus-mode', name === 'screen');
    window.scrollTo?.({ top: 0, behavior: 'auto' });

    const heading = name === 'results' ? el.resultsSection?.querySelector('h2') : null;
    if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
    }
}

// ==== 24. التعامل مع exam-manager ====

async function callExamManager(action, ...args) {
    try {
        const manager = window.examManager || await import('./exam-manager.js');
        await manager[action](...args);
    } catch (error) {
        console.error(`❌ [exams] تعذر تنفيذ ${action}:`, error);
        showToast('تعذر فتح النافذة المطلوبة', 'error');
    }
}

function guardStaff() {
    if (isStaffUser(state.currentUser)) return true;
    showToast('ليس لديك صلاحية لهذا الإجراء', 'error');
    return false;
}

function openAddExamModal() {
    if (!isStaffUser(state.currentUser)) {
        showToast('ليس لديك صلاحية لإضافة امتحانات', 'error');
        return;
    }
    callExamManager('openAddExamModal');
}

function openEditExamModal(examId) {
    if (guardStaff()) return callExamManager('openEditExamModal', examId);
}

function openDeleteConfirmModal(examId) {
    if (guardStaff()) return callExamManager('confirmDeleteExam', examId);
}

function openMoveExamModal(examId) {
    if (guardStaff()) return callExamManager('openMoveExamModal', examId);
}

// ==== 25. دوال مساعدة ====

function navigateToExam(examId) {
    if (!state.currentUser) {
        showToast('يرجى تسجيل الدخول', 'warning');
        window.router?.navigateTo('login');
        return;
    }
    window.router?.navigateTo('exam-view', { path: { id: examId } });
}

function bindCardGlow(grid) {
    if (!grid || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let frame = 0;
    grid.addEventListener('pointermove', (e) => {
        const card = e.target.closest?.('.exam-card');
        if (!card || frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            const rect = card.getBoundingClientRect();
            card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
            card.style.setProperty('--my', `${e.clientY - rect.top}px`);
        });
    }, { passive: true });
}

// كلاس is-loading في HTML يجعل CSS يخفي المقدمة طالما موجود
function getViewPageRoot(container = state.container) {
    return container?.querySelector('.exam-view-page') || null;
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
    if (state.elements.examsGrid) {
        state.elements.examsGrid.setAttribute('aria-busy', String(show));
    }
}

function showErrorState(container, error) {
    if (!container) return;
    console.error('❌ [exams] حالة خطأ:', error);

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
        container.querySelectorAll('.exam-intro-section, .exam-screen-section, .exam-results-section, .exam-review-section, .loading-state')
            .forEach(el => { el.style.display = 'none'; });
        container.querySelector(':scope > .error-state')?.remove();
        container.appendChild(errDiv);
        return;
    }

    const target = container.querySelector('.exams-grid') || container;
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
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

// ==== 26. التصدير ====
export { loadListData as loadExams };
