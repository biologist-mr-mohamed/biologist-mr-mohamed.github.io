/* مدير عمليات الامتحانات (إنشاء وتعديل وحذف ونقل) - v5.0.0 */

import { getCurrentUser, isTeacher, isModerator } from '../../js/core/session.js';
import {
    createExam,
    updateExam,
    deleteExam,
    getExamFullData,
    getExamByLessonId,
    getLessonById,
    moveExam,
    getUnits
} from '../../js/core/api.js';
import { EventBus } from '../../js/core/event-bus.js';

// ==== 1. الثوابت والتكوين ====

const EXAM_DEFAULTS = {
    duration: 30,
    questionsCount: 30
};

const QUESTION_TYPES = {
    MCQ: 'multiple_choice',
    TRUE_FALSE: 'true_false'
};

const STAGES = [
    { value: 'إعدادي', label: 'المرحلة الإعدادية' },
    { value: 'ثانوي', label: 'المرحلة الثانوية' }
];
const GRADES = [1, 2, 3];
const SEMESTERS = [
    { value: 'أول', label: 'الفصل الدراسي الأول' },
    { value: 'ثاني', label: 'الفصل الدراسي الثاني' }
];

// ==== 2. الحالة الداخلية ====
// الحالة الابتدائية من دالة مصنع واحدة لتجنب تباين نسختيها

const INITIAL_STATE = () => ({
    currentExamId: null,
    examMeta: {
        title: '',
        stage: '',
        grade: '',
        semester: '',
        exam_scope: 'unit',
        unit_id: null,
        lesson_id: null,
        lesson_title: '',
        duration: EXAM_DEFAULTS.duration,
        questionsCount: EXAM_DEFAULTS.questionsCount,
        is_challenge: false,
        description: '',
        cover_image_url: ''
    },
    availableUnits: [],
    questions: [],
    isEditMode: false,
    composerType: QUESTION_TYPES.MCQ,
    composerEditIndex: null
});

let state = INITIAL_STATE();

// ==== 3. حارس النقر المتكرر ====

let isModalOpening = false;

function acquireModalGuard() {
    if (isModalOpening) return false;
    isModalOpening = true;
    setTimeout(() => { isModalOpening = false; }, 4000);
    return true;
}

function releaseModalGuard() {
    isModalOpening = false;
}

// ==== 4. دوال التحقق من الصلاحية والمساعدة العامة ====

function checkPermission() {
    const user = getCurrentUser();
    return user && (isTeacher(user) || isModerator(user));
}

function showToast(message, type = 'info') {
    if (window.modals?.toast) window.modals.toast(message, type);
    else console.log(`[${type}] ${message}`);
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

// ==== 4.1 أنماط النوافذ خارج صفحة الامتحانات ====
// المودال قد يُفتح من صفحة الدرس حيث لا يُحمَّل exams.css، فنحمّله مؤقتاً ونزيله عند مغادرة الصفحة

const EXAM_STYLES_HREF = '/views/exams/exams.css';

function ensureExamStyles() {
    const route = window.router?.getCurrentRoute?.().name;
    if (route === 'exams' || route === 'exam-view') return Promise.resolve();
    if (document.querySelector('link[data-exam-manager-style]')) return Promise.resolve();

    return new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = EXAM_STYLES_HREF;
        link.setAttribute('data-exam-manager-style', '1');
        link.onload = () => resolve();
        link.onerror = () => resolve();
        setTimeout(resolve, 1500);
        document.head.appendChild(link);

        const off = EventBus.on('pageChanged', () => {
            link.remove();
            if (typeof off === 'function') off();
        });
    });
}

// عنوان الدرس المرتبط للعرض فقط
async function resolveLessonTitle(lessonId) {
    try {
        const lesson = await getLessonById(lessonId);
        return lesson?.title || '';
    } catch (_) {
        return '';
    }
}

// ==== 5. دوال النوافذ الرئيسية ====

// context اختياري: { lesson_id, lesson_title, title, stage, grade, semester, unit_id } لإنشاء امتحان مرتبط بدرس
async function openAddExamModal(context = null) {
    if (!checkPermission()) {
        showToast('ليس لديك صلاحية لإضافة امتحان', 'error');
        return;
    }
    const ctx = (context && typeof context === 'object' && context.lesson_id) ? context : null;
    if (!acquireModalGuard()) return;

    try {
        await ensureExamStyles();

        // الدرس الواحد له امتحان واحد فقط
        if (ctx) {
            const existing = await getExamByLessonId(ctx.lesson_id).catch(() => null);
            if (existing?.id) {
                releaseModalGuard();
                showToast('هذا الدرس له امتحان بالفعل، سيتم فتحه للتعديل', 'info');
                return openEditExamModal(existing.id);
            }
        }

        state = INITIAL_STATE();
        state.isEditMode = false;

        if (ctx) {
            Object.assign(state.examMeta, {
                lesson_id: ctx.lesson_id,
                lesson_title: ctx.lesson_title || '',
                title: ctx.title || '',
                stage: ctx.stage || '',
                grade: ctx.grade || '',
                semester: ctx.semester || '',
                unit_id: ctx.unit_id ?? null,
                exam_scope: 'unit'
            });
        }

        state.availableUnits = await fetchUnitsForSelect(
            state.examMeta.stage,
            state.examMeta.grade,
            state.examMeta.semester
        );

        showExamMetaModal();
    } catch (error) {
        releaseModalGuard();
        console.error('فشل فتح نافذة إضافة الامتحان:', error);
        showToast('تعذر فتح نافذة الإضافة', 'error');
    }
}

function showExamMetaModal() {
    const modalContent = buildExamFormHTML(state.availableUnits, state.isEditMode);

    window.modals.showModal({
        title: state.isEditMode ? 'تعديل الامتحان' : 'إضافة امتحان جديد',
        html: modalContent,
        size: 'large',
        rtl: true,
        buttons: [
            { text: 'إلغاء', role: 'cancel', type: 'secondary' },
            { text: 'التالي: إضافة الأسئلة', role: 'confirm', type: 'primary' }
        ],
        onOpen: (modalInstance) => {
            releaseModalGuard();
            bindFormEvents(modalInstance.element);
            populateFormFields(modalInstance.element);
        },
        onClose: () => releaseModalGuard(),
        onConfirm: async (modalInstance) => {
            if (!collectFormData(modalInstance.element)) return false;
            if (!validateExamMeta()) {
                showToast('يرجى ملء جميع الحقول المطلوبة (بما فيها الوحدة إن كان الامتحان من نوع وحدة)', 'warning');
                return false;
            }

            modalInstance.close(null, () => openQuestionsEditor());
            return false;
        }
    });
}

async function openEditExamModal(examId) {
    if (!checkPermission()) {
        showToast('ليس لديك صلاحية لتعديل الامتحان', 'error');
        return;
    }
    if (!acquireModalGuard()) return;

    state = INITIAL_STATE();
    state.isEditMode = true;
    state.currentExamId = examId;

    await ensureExamStyles();

    let examData;
    try {
        examData = await getExamFullData(examId);
        if (!examData) {
            releaseModalGuard();
            showToast('الامتحان غير موجود', 'error');
            return;
        }
    } catch (err) {
        releaseModalGuard();
        console.error('فشل تحميل بيانات الامتحان:', err);
        showToast('تعذر تحميل بيانات الامتحان', 'error');
        return;
    }

    state.examMeta = {
        title: examData.meta.title || '',
        stage: examData.meta.stage || '',
        grade: examData.meta.grade || '',
        semester: examData.meta.semester || '',
        exam_scope: examData.meta.exam_scope || 'unit',
        unit_id: examData.meta.unit_id || null,
        lesson_id: examData.meta.lesson_id || null,
        duration: examData.meta.duration || EXAM_DEFAULTS.duration,
        questionsCount: examData.questions?.length || EXAM_DEFAULTS.questionsCount,
        is_challenge: examData.meta.is_challenge || false,
        description: examData.meta.description || '',
        cover_image_url: examData.meta.cover_image_url || ''
    };
    state.questions = examData.questions || [];

    if (state.examMeta.lesson_id) {
        state.examMeta.lesson_title = await resolveLessonTitle(state.examMeta.lesson_id);
    }

    state.availableUnits = await fetchUnitsForSelect(
        state.examMeta.stage,
        state.examMeta.grade,
        state.examMeta.semester
    );

    const modalContent = buildExamFormHTML(state.availableUnits, true);

    window.modals.showModal({
        title: `تعديل الامتحان: ${escapeHtml(state.examMeta.title)}`,
        html: modalContent,
        size: 'large',
        rtl: true,
        buttons: [
            { text: 'إلغاء', role: 'cancel', type: 'secondary' },
            { text: 'التالي: مراجعة الأسئلة', role: 'confirm', type: 'primary' }
        ],
        onOpen: (modalInstance) => {
            releaseModalGuard();
            bindFormEvents(modalInstance.element);
            populateFormFields(modalInstance.element);
        },
        onClose: () => releaseModalGuard(),
        onConfirm: async (modalInstance) => {
            if (!collectFormData(modalInstance.element)) return false;
            if (!validateExamMeta()) {
                showToast('يرجى تصحيح الأخطاء قبل المتابعة', 'warning');
                return false;
            }

            modalInstance.close(null, () => openQuestionsEditor());
            return false;
        }
    });
}

function confirmDeleteExam(examId) {
    if (!checkPermission()) {
        showToast('ليس لديك صلاحية', 'error');
        return;
    }

    window.modals.confirm({
        title: 'تأكيد الحذف',
        message: 'هل أنت متأكد من حذف هذا الامتحان؟ سيتم نقله إلى المهملات ويمكن استعادته خلال 3 أيام.',
        confirmText: 'نقل إلى المهملات',
        cancelText: 'إلغاء',
        confirmType: 'danger',
        onConfirm: async () => {
            try {
                await deleteExam(examId, true);
                showToast('تم نقل الامتحان إلى المهملات', 'success');
                EventBus.emit('exam:deleted', { examId });
            } catch (error) {
                console.error('فشل حذف الامتحان:', error);
                showToast('فشل حذف الامتحان', 'error');
            }
        }
    });
}

function openMoveExamModal(examId) {
    if (!checkPermission()) return;
    ensureExamStyles();

    window.modals.showModal({
        title: 'تحريك الامتحان',
        html: `
            <div class="move-exam-container">
                <p class="move-hint">اختر اتجاه التحريك بين الامتحانات:</p>
                <div class="move-actions">
                    <button class="btn btn-outline move-up-btn" aria-label="تحريك الامتحان للأعلى">
                        <i class="fas fa-arrow-up" aria-hidden="true"></i> للأعلى
                    </button>
                    <button class="btn btn-outline move-down-btn" aria-label="تحريك الامتحان للأسفل">
                        <i class="fas fa-arrow-down" aria-hidden="true"></i> للأسفل
                    </button>
                </div>
            </div>`,
        size: 'small',
        rtl: true,
        buttons: [{ text: 'إغلاق', role: 'cancel', type: 'secondary' }],
        onOpen: (modal) => {
            modal.element.querySelector('.move-up-btn')?.addEventListener('click', async () => {
                try {
                    await moveExam(examId, 'up');
                    showToast('تم تحريك الامتحان للأعلى', 'success');
                    EventBus.emit('exam:moved', { examId, direction: 'up' });
                    modal.close();
                } catch (_) {
                    showToast('فشل تحريك الامتحان، ربما هو في أعلى الترتيب', 'warning');
                }
            });
            modal.element.querySelector('.move-down-btn')?.addEventListener('click', async () => {
                try {
                    await moveExam(examId, 'down');
                    showToast('تم تحريك الامتحان للأسفل', 'success');
                    EventBus.emit('exam:moved', { examId, direction: 'down' });
                    modal.close();
                } catch (_) {
                    showToast('فشل تحريك الامتحان، ربما هو في آخر الترتيب', 'warning');
                }
            });
        }
    });
}

// ==== 6. محرر الأسئلة ====

function openQuestionsEditor() {
    const questionsHTML = buildQuestionsEditorHTML();

    window.modals.showModal({
        title: `إضافة أسئلة: ${escapeHtml(state.examMeta.title)}`,
        html: questionsHTML,
        size: 'xlarge',
        rtl: true,
        buttons: [
            {
                text: 'السابق', role: 'secondary', type: 'outline', handler: () => {
                    showExamMetaModal();
                }
            },
            { text: 'معاينة وحفظ', role: 'confirm', type: 'primary' }
        ],
        onOpen: (modalInstance) => {
            bindQuestionsEditorEvents(modalInstance.element);
        },
        onConfirm: async (modalInstance) => {
            if (state.questions.length === 0) {
                showToast('يجب إضافة سؤال واحد على الأقل', 'warning');
                return false;
            }

            modalInstance.close(null, () => openPreviewModal());
            return false;
        }
    });
}

// ==== 7. نافذة المعاينة والحفظ النهائي ====

function openPreviewModal() {
    const previewHTML = buildPreviewHTML();

    window.modals.showModal({
        title: 'مراجعة الامتحان قبل الحفظ',
        html: previewHTML,
        size: 'large',
        rtl: true,
        buttons: [
            { text: 'تعديل الأسئلة', role: 'secondary', type: 'outline', handler: () => openQuestionsEditor() },
            { text: state.isEditMode ? 'حفظ التعديلات' : 'حفظ الامتحان', role: 'confirm', type: 'primary' }
        ],
        onConfirm: async () => {
            try {
                if (state.isEditMode) {
                    await saveExamChanges();
                    showToast('تم تحديث الامتحان بنجاح ✅', 'success');
                    EventBus.emit('exam:updated', { examId: state.currentExamId });
                } else {
                    const newId = await saveNewExam();
                    showToast('تم إنشاء الامتحان بنجاح ✅', 'success');
                    EventBus.emit('exam:created', { examId: newId });
                }
                window.modals.closeAllModals();
                // الامتحان المرتبط بدرس يبقى المستخدم في مكانه (صفحة الدرس أو قائمته)
                if (window.router && !state.examMeta.lesson_id) window.router.navigateTo('exams');
                return true;
            } catch (error) {
                console.error('فشل حفظ الامتحان:', error);
                showToast('فشل حفظ الامتحان، حاول مجدداً', 'error');
                return false;
            }
        }
    });
}

// ==== 8. دوال بناء HTML ====

function buildExamFormHTML(units = [], isEdit = false) {
    const meta = state.examMeta;
    const isComprehensive = meta.exam_scope === 'comprehensive';
    const linked = !!meta.lesson_id;
    const linkedUnitName = units.find(u => u.id == meta.unit_id)?.name;
    // امتحان الدرس يرث المرحلة والصف والفصل والوحدة من الدرس نفسه ولا يُعدَّل هنا
    const linkedInfoHtml = `
            <div class="exam-lesson-link" role="note">
                <div class="exam-lesson-link-head"><i class="fas fa-link" aria-hidden="true"></i> امتحان مرتبط بدرس</div>
                <p class="exam-lesson-link-title">${escapeHtml(meta.lesson_title || 'درس غير متاح')}</p>
                <div class="exam-lesson-link-tags">
                    <span class="badge">${escapeHtml(meta.stage)}</span>
                    <span class="badge">الصف ${escapeHtml(String(meta.grade))}</span>
                    <span class="badge">الفصل ${escapeHtml(meta.semester)}</span>
                    ${linkedUnitName ? `<span class="badge">${escapeHtml(linkedUnitName)}</span>` : ''}
                </div>
                <p class="form-hint">المرحلة والصف والفصل والوحدة تُؤخذ من الدرس تلقائياً.</p>
            </div>`;
    const unitOptions = units.map(u =>
        `<option value="${u.id}" ${meta.unit_id == u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`
    ).join('');
    const unitsHintText = !meta.stage || !meta.grade
        ? 'اختر المرحلة والصف لعرض الوحدات المتاحة'
        : (units.length === 0 ? 'لا توجد وحدات لهذا الاختيار' : `${units.length} وحدة متاحة`);

    return `
        <form id="exam-meta-form" class="exam-form">
            <div class="form-row">
                <div class="form-group">
                    <label for="exam-title">
                        اسم الامتحان <span class="required" aria-label="مطلوب">*</span>
                    </label>
                    <input type="text"
                           id="exam-title"
                           name="title"
                           value="${escapeHtml(meta.title)}"
                           placeholder="مثال: امتحان الوحدة الأولى - أسس علم الأحياء"
                           maxlength="150"
                           required
                           autocomplete="off">
                </div>
            </div>

            ${linked ? linkedInfoHtml : `
            <div class="form-row three-cols">
                <div class="form-group">
                    <label for="exam-stage">المرحلة <span class="required" aria-label="مطلوب">*</span></label>
                    <select id="exam-stage" name="stage" required>
                        <option value="">اختر المرحلة</option>
                        ${STAGES.map(s => `<option value="${s.value}" ${meta.stage === s.value ? 'selected' : ''}>${s.label}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label for="exam-grade">الصف <span class="required" aria-label="مطلوب">*</span></label>
                    <select id="exam-grade" name="grade" required>
                        <option value="">اختر الصف</option>
                        ${GRADES.map(g => `<option value="${g}" ${meta.grade == g ? 'selected' : ''}>الصف ${g}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label for="exam-semester">الفصل <span class="required" aria-label="مطلوب">*</span></label>
                    <select id="exam-semester" name="semester" required>
                        <option value="">اختر الفصل</option>
                        ${SEMESTERS.map(s => `<option value="${s.value}" ${meta.semester === s.value ? 'selected' : ''}>${s.label}</option>`).join('')}
                    </select>
                </div>
            </div>

            <!-- نطاق الامتحان: امتحان وحدة أم امتحان شامل -->
            <div class="form-row">
                <div class="form-group">
                    <label>نوع الامتحان <span class="required" aria-label="مطلوب">*</span></label>
                    <div class="exam-scope-toggle" id="exam-scope-toggle" role="radiogroup">
                        <label class="radio-pill-label">
                            <input type="radio" name="exam_scope" value="unit" ${!isComprehensive ? 'checked' : ''}>
                            <span><i class="fas fa-layer-group" aria-hidden="true"></i> امتحان وحدة</span>
                        </label>
                        <label class="radio-pill-label">
                            <input type="radio" name="exam_scope" value="comprehensive" ${isComprehensive ? 'checked' : ''}>
                            <span><i class="fas fa-globe" aria-hidden="true"></i> امتحان شامل</span>
                        </label>
                    </div>
                    <p class="form-hint">امتحان الوحدة يظهر تحت تبويب وحدته في صفحة الامتحانات، والامتحان الشامل يظهر في تبويب "الشامل" ويغطي أكثر من وحدة.</p>
                </div>
            </div>

            <div class="form-row" id="exam-unit-row" style="${isComprehensive ? 'display:none;' : ''}">
                <div class="form-group">
                    <label for="exam-unit">الوحدة <span class="required" aria-label="مطلوب">*</span></label>
                    <select id="exam-unit" name="unit_id" ${isComprehensive ? '' : 'required'}>
                        <option value="">${(!meta.stage || !meta.grade) ? 'اختر المرحلة والصف أولاً' : 'اختر الوحدة'}</option>
                        ${unitOptions}
                    </select>
                    <p class="form-hint" id="exam-units-hint">${unitsHintText}</p>
                </div>
            </div>
            `}

            <div class="form-row two-cols">
                <div class="form-group">
                    <label for="exam-duration">الوقت (بالدقائق)</label>
                    <input type="number" id="exam-duration" name="duration" min="1" max="180" value="${meta.duration}">
                </div>
                <div class="form-group">
                    <label for="exam-questions-count">عدد الأسئلة المستهدف</label>
                    <input type="number" id="exam-questions-count" name="questionsCount" min="1" max="100" value="${meta.questionsCount || EXAM_DEFAULTS.questionsCount}">
                    <p class="form-hint">للاسترشاد فقط أثناء إضافة الأسئلة، لا يمنع الحفظ بعدد مختلف.</p>
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label for="exam-cover-image">رابط صورة الغلاف (اختياري)</label>
                    <input type="url" id="exam-cover-image" name="cover_image_url" value="${escapeHtml(meta.cover_image_url || '')}" placeholder="https://...">
                </div>
            </div>

            <div class="form-row">
                <div class="form-group checkbox-group">
                    <label>
                        <input type="checkbox" id="exam-challenge" name="is_challenge" ${meta.is_challenge ? 'checked' : ''}>
                        امتحان المتفوقين (يمنح ميداليات ذهبية/فضية/برونزية عند تجاوز 85%)
                    </label>
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label for="exam-description">وصف الامتحان (اختياري)</label>
                    <textarea id="exam-description" name="description" rows="3" maxlength="500">${escapeHtml(meta.description || '')}</textarea>
                </div>
            </div>
        </form>
    `;
}

function buildQuestionsEditorHTML() {
    const questionsCount = state.questions.length;
    const target = state.examMeta.questionsCount || EXAM_DEFAULTS.questionsCount;
    const isEditing = state.composerEditIndex !== null;

    return `
        <div class="questions-editor">
            <div class="editor-header">
                <h3>الأسئلة (<span id="questions-progress">${questionsCount} / ${target}</span>)</h3>
            </div>

            <div class="question-composer" id="question-composer">
                <div class="composer-type-toggle" role="tablist" aria-label="نوع السؤال">
                    <button type="button" class="composer-type-btn ${state.composerType === QUESTION_TYPES.MCQ ? 'active' : ''}"
                        data-type="${QUESTION_TYPES.MCQ}" role="tab" aria-selected="${state.composerType === QUESTION_TYPES.MCQ}">
                        <i class="fas fa-list-ul" aria-hidden="true"></i> اختيار من متعدد
                    </button>
                    <button type="button" class="composer-type-btn ${state.composerType === QUESTION_TYPES.TRUE_FALSE ? 'active' : ''}"
                        data-type="${QUESTION_TYPES.TRUE_FALSE}" role="tab" aria-selected="${state.composerType === QUESTION_TYPES.TRUE_FALSE}">
                        <i class="fas fa-check-double" aria-hidden="true"></i> صح / خطأ
                    </button>
                </div>

                <div class="composer-edit-banner" id="composer-edit-banner" style="${isEditing ? '' : 'display:none;'}">
                    <span><i class="fas fa-pen" aria-hidden="true"></i> بتعدّل السؤال رقم <strong id="composer-edit-index">${isEditing ? state.composerEditIndex + 1 : ''}</strong></span>
                    <button type="button" class="link-btn" id="composer-cancel-edit">إلغاء التعديل</button>
                </div>

                <div id="composer-form-slot">${buildComposerFormFieldsHTML()}</div>

                <div class="composer-actions">
                    <button type="button" class="btn btn-primary composer-save-btn" id="composer-save-btn">
                        <i class="fas fa-check" aria-hidden="true"></i>
                        <span id="composer-save-label">${isEditing ? 'حفظ التعديل' : 'إضافة السؤال'}</span>
                    </button>
                </div>
            </div>

            <div class="questions-list" id="questions-list"></div>
        </div>
    `;
}

function buildComposerFormFieldsHTML() {
    const isMCQ = state.composerType === QUESTION_TYPES.MCQ;
    const editingQuestion = state.composerEditIndex !== null ? state.questions[state.composerEditIndex] : null;
    const q = editingQuestion || (isMCQ
        ? { text: '', image: '', options: ['', '', '', ''], correct: 0 }
        : { text: '', image: '', correct: true });

    let html = `
        <form id="composer-form">
            <div class="form-group">
                <label>نص السؤال <span class="required" aria-label="مطلوب">*</span></label>
                <textarea name="text" rows="2" required placeholder="اكتب نص السؤال هنا...">${escapeHtml(q.text)}</textarea>
            </div>
            <div class="form-group">
                <label>رابط الصورة (اختياري)</label>
                <input type="url" name="image" value="${escapeHtml(q.image || '')}" placeholder="https://...">
            </div>
    `;

    if (isMCQ) {
        const options = q.options && q.options.length ? q.options : ['', '', '', ''];
        html += `<div class="options-container">`;
        options.forEach((opt, idx) => {
            html += `
                <div class="option-row">
                    <input type="radio" name="correct" value="${idx}" ${idx === q.correct ? 'checked' : ''} required>
                    <input type="text" name="option_${idx}" value="${escapeHtml(opt)}" placeholder="الخيار ${String.fromCharCode(97 + idx)}" required>
                    <button type="button" class="remove-option-btn" ${options.length <= 2 ? 'disabled' : ''}><i class="fas fa-times"></i></button>
                </div>
            `;
        });
        html += `
                <button type="button" class="btn btn-sm btn-outline add-option-btn"><i class="fas fa-plus"></i> إضافة خيار</button>
            </div>
        `;
    } else {
        html += `
            <div class="form-group">
                <label>الإجابة الصحيحة</label>
                <div class="tf-radio-group">
                    <label><input type="radio" name="correct" value="true" ${q.correct ? 'checked' : ''}> صح</label>
                    <label><input type="radio" name="correct" value="false" ${!q.correct ? 'checked' : ''}> خطأ</label>
                </div>
            </div>
        `;
    }
    html += `</form>`;
    return html;
}
function buildPreviewHTML() {
    const meta = state.examMeta;
    const isComprehensive = meta.exam_scope === 'comprehensive';
    const unitName = !isComprehensive
        ? state.availableUnits.find(u => u.id == meta.unit_id)?.name
        : null;
    const scopeBadge = meta.lesson_id
        ? ''
        : isComprehensive
        ? '<span class="badge comprehensive"><i class="fas fa-globe" aria-hidden="true"></i> امتحان شامل</span>'
        : `<span class="badge unit-scope"><i class="fas fa-layer-group" aria-hidden="true"></i> وحدة: ${escapeHtml(unitName || 'غير محددة')}</span>`;

    return `
        <div class="exam-preview">
            <div class="preview-meta">
                <h4>${escapeHtml(meta.title)}</h4>
                <p>${escapeHtml(meta.stage)} - الصف ${escapeHtml(String(meta.grade))} - ${escapeHtml(meta.semester)}</p>
                <p>الوقت: ${meta.duration} دقيقة | الأسئلة: ${state.questions.length}</p>
                <div class="preview-badges">
                    ${scopeBadge}
                    ${meta.is_challenge ? '<span class="badge challenge"><i class="fas fa-trophy" aria-hidden="true"></i> امتحان المتفوقين</span>' : ''}
                    ${meta.lesson_id ? `<span class="badge lesson-linked"><i class="fas fa-link" aria-hidden="true"></i> مرتبط بالدرس: ${escapeHtml(meta.lesson_title || '')}</span>` : ''}
                </div>
                ${meta.cover_image_url ? `<img src="${escapeHtml(meta.cover_image_url)}" alt="غلاف الامتحان" class="preview-cover-img">` : ''}
            </div>
            <div class="preview-questions">
                ${state.questions.map((q, idx) => renderQuestionPreview(q, idx + 1)).join('')}
            </div>
        </div>
    `;
}

function renderQuestionPreview(question, index) {
    const imageHtml = question.image
        ? `<img src="${escapeHtml(question.image)}" alt="صورة السؤال" class="preview-question-img">`
        : '';

    if (question.type === QUESTION_TYPES.MCQ) {
        return `
            <div class="preview-question">
                <p><strong>${index}. ${escapeHtml(question.text)}</strong></p>
                ${imageHtml}
                <ul>
                    ${question.options.map((opt, i) => `<li ${i === question.correct ? 'class="correct-answer"' : ''}>${String.fromCharCode(97 + i)}) ${escapeHtml(opt)}</li>`).join('')}
                </ul>
            </div>
        `;
    }
    return `
        <div class="preview-question">
            <p><strong>${index}. ${escapeHtml(question.text)}</strong></p>
            ${imageHtml}
            <p>الإجابة الصحيحة: <span class="correct-answer">${question.correct ? 'صح' : 'خطأ'}</span></p>
        </div>
    `;
}

// ==== 9. دوال مساعدة للتعامل مع الأسئلة ====

function renderQuestionsList(container) {
    const listEl = container.querySelector('#questions-list');
    if (!listEl) return;

    listEl.innerHTML = state.questions.map((q, index) => renderQuestionEditorRow(q, index, index === state.composerEditIndex)).join('')
        || '<p class="text-muted">لا توجد أسئلة بعد. اكتب أول سؤال في النموذج فوق وابدأ ⬆️</p>';

    listEl.querySelectorAll('.delete-question').forEach(btn => {
        btn.addEventListener('click', () => {
            removeQuestion(parseInt(btn.dataset.index, 10), container);
        });
    });

    listEl.querySelectorAll('.edit-question').forEach(btn => {
        btn.addEventListener('click', () => {
            editQuestion(parseInt(btn.dataset.index, 10), container);
        });
    });
}

function renderQuestionEditorRow(question, index, isEditing = false) {
    let detailsHtml = '';
    if (question.type === QUESTION_TYPES.MCQ) {
        detailsHtml = `
            <div class="question-options">
                ${question.options.map((opt, i) => `
                    <div class="option ${i === question.correct ? 'correct' : ''}">
                        ${String.fromCharCode(97 + i)}) ${escapeHtml(opt)}
                    </div>
                `).join('')}
            </div>
        `;
    } else {
        detailsHtml = `<div class="true-false-answer ${question.correct ? 'correct' : ''}">الإجابة: ${question.correct ? 'صح' : 'خطأ'}</div>`;
    }

    return `
        <div class="question-editor-row ${isEditing ? 'is-editing' : ''}">
            <div class="question-header">
                <span class="question-number">${index + 1}.</span>
                <span class="question-type-badge">${question.type === QUESTION_TYPES.MCQ ? 'اختيار' : 'صح/خطأ'}</span>
                <div class="question-actions">
                    <button type="button" class="icon-btn edit-question" data-index="${index}" title="تعديل"><i class="fas fa-edit"></i></button>
                    <button type="button" class="icon-btn delete-question" data-index="${index}" title="حذف"><i class="fas fa-trash-alt"></i></button>
                </div>
            </div>
            <div class="question-text">${escapeHtml(question.text)}</div>
            ${question.image ? `<img src="${escapeHtml(question.image)}" class="question-thumb">` : ''}
            ${detailsHtml}
        </div>
    `;
}

function saveComposerQuestion(container) {
    const form = container.querySelector('#composer-form');
    if (!form) return;

    const isMCQ = state.composerType === QUESTION_TYPES.MCQ;
    const formData = new FormData(form);
    const text = (formData.get('text') || '').trim();
    const image = (formData.get('image') || '').trim();

    if (!text) {
        showToast('نص السؤال مطلوب', 'warning');
        return;
    }

    const editingExisting = state.composerEditIndex !== null;
    const questionData = {
        id: editingExisting ? state.questions[state.composerEditIndex].id : ('temp_' + Date.now()),
        type: state.composerType,
        text,
        image,
        difficulty: editingExisting ? (state.questions[state.composerEditIndex].difficulty || 'easy') : 'easy'
    };

    if (isMCQ) {
        const optionRows = Array.from(form.querySelectorAll('.option-row'));
        const options = optionRows.map(row => row.querySelector('input[type="text"]')?.value.trim() || '');
        const correctIndex = optionRows.findIndex(row => row.querySelector('input[type="radio"]')?.checked);

        if (options.length < 2 || options.some(o => !o)) {
            showToast('يجب إدخال خيارين على الأقل، ولا يمكن ترك خيار فارغاً', 'warning');
            return;
        }
        if (correctIndex < 0) {
            showToast('حدد الإجابة الصحيحة', 'warning');
            return;
        }
        questionData.options = options;
        questionData.correct = correctIndex;
    } else {
        questionData.correct = formData.get('correct') === 'true';
    }

    if (editingExisting) {
        state.questions[state.composerEditIndex] = questionData;
    } else {
        state.questions.push(questionData);
    }

    state.composerEditIndex = null;
    showToast(editingExisting ? 'تم حفظ تعديل السؤال ✅' : 'تمت إضافة السؤال ✅', 'success');

    refreshComposer(container);
    refreshQuestionsListAndCount(container);
}

function refreshComposer(container) {
    const slot = container.querySelector('#composer-form-slot');
    if (slot) slot.innerHTML = buildComposerFormFieldsHTML();

    container.querySelectorAll('.composer-type-btn').forEach(btn => {
        const isActive = btn.dataset.type === state.composerType;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
    });

    const isEditing = state.composerEditIndex !== null;
    const banner = container.querySelector('#composer-edit-banner');
    const editIdxEl = container.querySelector('#composer-edit-index');
    const saveLabel = container.querySelector('#composer-save-label');
    if (banner) banner.style.display = isEditing ? '' : 'none';
    if (editIdxEl) editIdxEl.textContent = isEditing ? state.composerEditIndex + 1 : '';
    if (saveLabel) saveLabel.textContent = isEditing ? 'حفظ التعديل' : 'إضافة السؤال';

    bindComposerOptionEvents(container);
    container.querySelector('#composer-form textarea[name="text"]')?.focus();
}

function bindComposerOptionEvents(container) {
    if (state.composerType !== QUESTION_TYPES.MCQ) return;
    bindOptionsEvents(container);
}

function refreshQuestionsListAndCount(container) {
    renderQuestionsList(container);
    const progressEl = container.querySelector('#questions-progress');
    if (progressEl) {
        const target = state.examMeta.questionsCount || EXAM_DEFAULTS.questionsCount;
        progressEl.textContent = `${state.questions.length} / ${target}`;
    }
}

function removeQuestion(index, container) {
    const wasEditingThis = state.composerEditIndex === index;
    state.questions.splice(index, 1);

    if (wasEditingThis) {
        state.composerEditIndex = null;
        refreshComposer(container);
    } else if (state.composerEditIndex !== null && index < state.composerEditIndex) {
        state.composerEditIndex -= 1;
    }
    refreshQuestionsListAndCount(container);
}

function editQuestion(index, container) {
    const question = state.questions[index];
    if (!question) return;

    state.composerType = question.type;
    state.composerEditIndex = index;
    refreshComposer(container);
    renderQuestionsList(container);
    container.querySelector('#question-composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindOptionsEvents(container) {
    container.querySelector('.add-option-btn')?.addEventListener('click', () => {
        const optionsContainer = container.querySelector('.options-container');
        const currentOptions = optionsContainer.querySelectorAll('.option-row').length;
        if (currentOptions >= 6) {
            showToast('الحد الأقصى 6 خيارات', 'warning');
            return;
        }
        const newRow = document.createElement('div');
        newRow.className = 'option-row';
        newRow.innerHTML = `
            <input type="radio" name="correct" value="${currentOptions}">
            <input type="text" name="option_${currentOptions}" placeholder="الخيار ${String.fromCharCode(97 + currentOptions)}" required>
            <button type="button" class="remove-option-btn"><i class="fas fa-times"></i></button>
        `;
        optionsContainer.insertBefore(newRow, container.querySelector('.add-option-btn'));
        bindRemoveOption(newRow.querySelector('.remove-option-btn'), container);
        updateRemoveButtonsState(container);
    });

    container.querySelectorAll('.remove-option-btn').forEach(btn => bindRemoveOption(btn, container));
}

function bindRemoveOption(btn, container) {
    btn.addEventListener('click', () => {
        const row = btn.closest('.option-row');
        const optionsContainer = row?.closest('.options-container');
        if (!row || !optionsContainer) return;

        const remainingRows = optionsContainer.querySelectorAll('.option-row').length;
        if (remainingRows <= 2) {
            showToast('يجب أن يحتوي السؤال على خيارين اثنين على الأقل', 'warning');
            return;
        }
        row.remove();
        if (container) updateRemoveButtonsState(container);
    });
}

function updateRemoveButtonsState(container) {
    const rows = container.querySelectorAll('.option-row');
    const disable = rows.length <= 2;
    rows.forEach(row => {
        const btn = row.querySelector('.remove-option-btn');
        if (btn) btn.disabled = disable;
    });
}

// ==== 10. دوال حفظ واستدعاء API ====

function buildExamPayload() {
    return {
        title: state.examMeta.title,
        stage: state.examMeta.stage,
        grade: state.examMeta.grade,
        semester: state.examMeta.semester,
        exam_scope: state.examMeta.exam_scope,
        unit_id: state.examMeta.unit_id,
        lesson_id: state.examMeta.lesson_id,
        duration: state.examMeta.duration,
        description: state.examMeta.description,
        is_challenge: state.examMeta.is_challenge,
        cover_image_url: state.examMeta.cover_image_url,
        ...(state.examMeta.lesson_id ? { type: 'lesson_exam' } : {})
    };
}

function buildQuestionsPayload() {
    return state.questions.map(q => ({
        text: q.text,
        type: q.type,
        options: q.options,
        correct: q.correct,
        image: q.image,
        difficulty: q.difficulty || 'easy'
    }));
}

async function saveNewExam() {
    const newId = await createExam(buildExamPayload(), buildQuestionsPayload());
    state.currentExamId = newId;
    return newId;
}

async function saveExamChanges() {
    await updateExam(state.currentExamId, buildExamPayload(), buildQuestionsPayload());
}

// ==== 11. دوال جمع وتعبئة بيانات النموذج ====

function collectFormData(container) {
    const form = container?.querySelector('#exam-meta-form');
    if (!form) return false;

    const formData = new FormData(form);
    const examScope = formData.get('exam_scope') === 'comprehensive' ? 'comprehensive' : 'unit';
    const unitIdRaw = formData.get('unit_id');

    // امتحان الدرس يحتفظ بنطاقه من الدرس ولا يقرأه من النموذج
    const linked = !!state.examMeta.lesson_id;
    const scopeFields = linked ? {} : {
        stage: formData.get('stage') || '',
        grade: formData.get('grade') ? parseInt(formData.get('grade')) : '',
        semester: formData.get('semester') || '',
        exam_scope: examScope,
        unit_id: (examScope === 'unit' && unitIdRaw) ? parseInt(unitIdRaw) : null
    };

    state.examMeta = {
        ...state.examMeta,
        title: (formData.get('title') || '').trim(),
        ...scopeFields,
        duration: parseInt(formData.get('duration')) || EXAM_DEFAULTS.duration,
        questionsCount: parseInt(formData.get('questionsCount')) || EXAM_DEFAULTS.questionsCount,
        is_challenge: formData.get('is_challenge') === 'on',
        description: (formData.get('description') || '').trim(),
        cover_image_url: (formData.get('cover_image_url') || '').trim()
    };

    return true;
}

function populateFormFields(container) {
    const meta = state.examMeta;
    const form = container?.querySelector('#exam-meta-form');
    if (!form) return;

    const set = (id, val) => {
        const el = form.querySelector(`#${id}`);
        if (el) el.value = val ?? '';
    };

    set('exam-title', meta.title);
    set('exam-stage', meta.stage);
    set('exam-grade', meta.grade);
    set('exam-semester', meta.semester);
    set('exam-duration', meta.duration || EXAM_DEFAULTS.duration);
    set('exam-questions-count', meta.questionsCount || EXAM_DEFAULTS.questionsCount);
    set('exam-cover-image', meta.cover_image_url);

    const challengeBox = form.querySelector('#exam-challenge');
    if (challengeBox) challengeBox.checked = !!meta.is_challenge;

    const descriptionField = form.querySelector('#exam-description');
    if (descriptionField) descriptionField.value = meta.description || '';

    const isComprehensive = meta.exam_scope === 'comprehensive';
    const scopeRadio = form.querySelector(`input[name="exam_scope"][value="${isComprehensive ? 'comprehensive' : 'unit'}"]`);
    if (scopeRadio) scopeRadio.checked = true;
    const unitSelect = form.querySelector('#exam-unit');
    if (unitSelect) unitSelect.value = meta.unit_id || '';
    const unitRow = container.querySelector('#exam-unit-row');
    if (unitRow) unitRow.style.display = isComprehensive ? 'none' : '';
}

// ==== 12. التحقق من صحة البيانات ====

function validateExamMeta() {
    const meta = state.examMeta;
    const baseValid = meta.title.trim() !== '' && meta.stage !== '' && meta.grade !== '' && meta.semester !== '';
    if (!baseValid) return false;
    // الدرس قد يكون بلا وحدة فلا نشترطها لامتحان الدرس
    if (!meta.lesson_id && meta.exam_scope === 'unit' && !meta.unit_id) return false;
    return true;
}

// ==== 13. دوال مساعدة عامة ====
// يُعاد جلب الوحدات دون الفصل لأن بقية النظام يفلتر بالمرحلة والصف فقط

async function fetchUnitsForSelect(stage = '', grade = '', semester = '') {
    try {
        const options = {};
        if (stage) options.stage = stage;
        if (grade) options.grade = parseInt(grade);
        if (semester) options.semester = semester;

        let units = await getUnits(options);

        if (units.length === 0 && options.semester) {
            const { semester: _drop, ...withoutSemester } = options;
            units = await getUnits(withoutSemester);
        }

        return units;
    } catch {
        return [];
    }
}

function bindFormEvents(container) {
    const stageSelect = container.querySelector('#exam-stage');
    const gradeSelect = container.querySelector('#exam-grade');
    const semesterSelect = container.querySelector('#exam-semester');
    const unitSelect = container.querySelector('#exam-unit');
    const unitRow = container.querySelector('#exam-unit-row');
    const scopeToggle = container.querySelector('#exam-scope-toggle');

    scopeToggle?.querySelectorAll('input[name="exam_scope"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const isComprehensive = radio.value === 'comprehensive' && radio.checked;
            if (unitRow) unitRow.style.display = isComprehensive ? 'none' : '';
            if (unitSelect) {
                unitSelect.required = !isComprehensive;
                if (isComprehensive) unitSelect.value = '';
            }
        });
    });

    const updateUnitsDropdown = async () => {
        if (!unitSelect) return;
        const stage = stageSelect?.value;
        const grade = gradeSelect?.value;
        const semester = semesterSelect?.value;
        const hintEl = container.querySelector('#exam-units-hint');

        if (!stage || !grade) {
            unitSelect.innerHTML = '<option value="">اختر المرحلة والصف أولاً</option>';
            if (hintEl) hintEl.textContent = 'اختر المرحلة والصف لعرض الوحدات المتاحة';
            state.availableUnits = [];
            return;
        }

        unitSelect.disabled = true;
        unitSelect.innerHTML = '<option value="">جاري التحميل...</option>';
        try {
            const units = await fetchUnitsForSelect(stage, grade, semester);
            state.availableUnits = units;
            unitSelect.innerHTML = '<option value="">اختر الوحدة</option>' +
                units.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
            if (hintEl) {
                hintEl.textContent = units.length === 0
                    ? 'لا توجد وحدات لهذا الاختيار'
                    : `${units.length} وحدة متاحة`;
            }
        } catch (_) {
            unitSelect.innerHTML = '<option value="">تعذر تحميل الوحدات</option>';
        } finally {
            unitSelect.disabled = false;
        }
    };

    stageSelect?.addEventListener('change', updateUnitsDropdown);
    gradeSelect?.addEventListener('change', updateUnitsDropdown);
    semesterSelect?.addEventListener('change', updateUnitsDropdown);
}

function bindQuestionsEditorEvents(container) {
    container.querySelectorAll('.composer-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.type;
            if (type === state.composerType && state.composerEditIndex === null) return;

            if (state.composerEditIndex !== null) {
                showToast('تم إلغاء تعديل السؤال السابق', 'info');
            }
            state.composerType = type;
            state.composerEditIndex = null;
            refreshComposer(container);
            renderQuestionsList(container);
        });
    });

    container.querySelector('#composer-cancel-edit')?.addEventListener('click', () => {
        state.composerEditIndex = null;
        refreshComposer(container);
        renderQuestionsList(container);
    });

    container.querySelector('#composer-save-btn')?.addEventListener('click', () => saveComposerQuestion(container));

    bindComposerOptionEvents(container);
    renderQuestionsList(container);
}

// ==== 14. تصدير الدوال العامة ====

export {
    openAddExamModal,
    openEditExamModal,
    confirmDeleteExam,
    openMoveExamModal
};

window.examManager = {
    openAddExamModal,
    openEditExamModal,
    confirmDeleteExam,
    openMoveExamModal
};
