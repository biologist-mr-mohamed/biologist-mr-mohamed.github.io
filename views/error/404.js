/**
 * 🚫 views/error/404.js - مدير صفحة الخطأ 404 المتكامل v5.0.0
 * ============================================================================
 * 📝 المسؤولية: عرض صفحة جذابة عند الوصول لمسار غير موجود مع اقتراحات مفيدة.
 * ✅ متوافق مع router (initializePage / cleanupPage).
 * ✅ يستخدم api.js لجلب أحدث الدروس.
 * ✅ يتكامل مع theme، session، modals، animations، directing، و search.
 * ✅ RTL بالكامل.
 * ✅ يدعم صلاحيات المعلم والمشرف (زر بحث إضافي).
 * ✅ يعرض skeleton loading أثناء جلب الاقتراحات.
 * ============================================================================
 */

import { getCurrentUser, isTeacher, isModerator } from '../../js/core/session.js';
import { getAllLessons } from '../../js/core/api.js';
import { EventBus } from '../../js/core/event-bus.js';

// ====== 1. الحالة الداخلية ======
let state = {
  initialized: false,
  container: null,
  currentUser: null,
  isLoading: false,
  suggestedLessons: []
};

let elements = {};

// ====== 2. دوال التهيئة والتنظيف (لـ Router) ======

export async function initializePage(container, params = {}) {
  if (state.initialized && state.container === container) {
    console.log('🚫 [404] الصفحة مهيأة مسبقاً');
    return;
  }

  console.log('🚫 [404] تهيئة صفحة الخطأ...');
  state.container = container;
  state.currentUser = getCurrentUser();

  try {
    cacheElements(container);
    setupUIBasedOnRole();
    bindEvents();
    
    // ==== إظهار شخصية التوجيه بتعبير "متفاجئ" (surprised) ====
    if (window.directingAPI?.show) {
      window.directingAPI.show('error', { 
        customMessage: 'مش لاقي الصفحة دي! تعالى نرجع للبيت 🏠',
        expression: 'surprised',
        autoHide: true,
        duration: 6000
      });
    }

    // ==== تحميل الاقتراحات مع تأثير دخول ====
    if (window.animations?.enterPage) {
      window.animations.enterPage('not-found', container);
    }
    
    await loadSuggestedLessons();
    
    state.initialized = true;
    EventBus.emit('page:ready', { page: 'not-found' });
  } catch (error) {
    console.error('❌ [404] فشل التهيئة:', error);
    showToast('حدث خطأ أثناء تحميل الصفحة', 'error');
  }
}

export function cleanupPage() {
  console.log('🧹 [404] تنظيف صفحة الخطأ...');
  if (window.animations?.exitPage) {
    window.animations.exitPage('not-found', state.container);
  }
  // إعادة تعيين الحالة بالكامل
  state = {
    initialized: false,
    container: null,
    currentUser: null,
    isLoading: false,
    suggestedLessons: []
  };
  elements = {};
}

// ====== 3. دوال مساعدة DOM ======

function cacheElements(container) {
  elements = {
    loading: container.querySelector('.loading-state'),
    suggestionsGrid: document.getElementById('suggestions-grid'),
    goHomeBtn: container.querySelector('[data-action="go-home"]'),
    goBackBtn: container.querySelector('[data-action="go-back"]'),
    goLessonsBtn: container.querySelector('[data-action="go-lessons"]'),
    openSearchBtn: container.querySelector('[data-action="open-search"]'),
    teacherOnlyElements: container.querySelectorAll('.teacher-only')
  };
}

function setupUIBasedOnRole() {
  const user = state.currentUser;
  const isAdmin = user && (isTeacher(user) || isModerator(user));
  
  elements.teacherOnlyElements?.forEach(el => {
    el.style.display = isAdmin ? 'flex' : 'none';
  });
}

function bindEvents() {
  elements.goHomeBtn?.addEventListener('click', () => {
    safeNavigate('home');
  });

  elements.goBackBtn?.addEventListener('click', () => {
    // ==== رجوع لآخر صفحة زارها المستخدم، أو الرئيسية لو مفيش تاريخ تصفح ====
    if (window.history.length > 1) {
      window.history.back();
    } else {
      safeNavigate('home');
    }
  });
  
  elements.goLessonsBtn?.addEventListener('click', () => {
    safeNavigate('lessons');
  });
  
  elements.openSearchBtn?.addEventListener('click', () => {
    if (window.searchAPI?.open) {
      window.searchAPI.open();
    } else {
      showToast('نظام البحث غير متاح حالياً', 'warning');
    }
  });
}

// ====== 4. جلب وعرض الاقتراحات ======

async function loadSuggestedLessons() {
  showLoading(true);
  try {
    // جلب أحدث 3 دروس (يمكن تعديل العدد لاحقاً)
    const lessons = await getAllLessons({ limit: 3 });
    state.suggestedLessons = lessons || [];
    renderSuggestions();
  } catch (error) {
    console.error('❌ فشل جلب الاقتراحات:', error);
    state.suggestedLessons = [];
    renderSuggestions(true);
  } finally {
    showLoading(false);
  }
}

function renderSuggestions(hasError = false) {
  const grid = elements.suggestionsGrid;
  if (!grid) return;

  if (hasError || state.suggestedLessons.length === 0) {
    grid.innerHTML = `
      <div class="empty-suggestions" style="grid-column: 1/-1; text-align: center; padding: var(--space-8);">
        <i class="fas fa-book-open" style="font-size: 3rem; opacity: 0.5; margin-bottom: var(--space-4);"></i>
        <p>لا توجد اقتراحات حالياً، جرب البحث أو تصفح الدروس.</p>
      </div>
    `;
    return;
  }

  const lessonsHTML = state.suggestedLessons.map(lesson => {
    return `
      <div class="suggestion-card" data-lesson-id="${lesson.id}">
        <h4 class="suggestion-title">${escapeHtml(lesson.title)}</h4>
        <div class="suggestion-meta">
          <span><i class="fas fa-layer-group"></i> ${lesson.stage || 'عام'}</span>
          <span><i class="fas fa-clock"></i> ${lesson.duration || 0} دقيقة</span>
        </div>
        <button class="btn btn-primary btn-sm suggestion-btn">
          <i class="fas fa-play"></i> مشاهدة
        </button>
      </div>
    `;
  }).join('');

  grid.innerHTML = lessonsHTML;

  // ربط حدث النقر على البطاقة أو الزر
  grid.querySelectorAll('.suggestion-card').forEach(card => {
    const lessonId = card.dataset.lessonId;
    const btn = card.querySelector('.suggestion-btn');
    const handleClick = () => {
      safeNavigate('lesson-view', { path: { id: lessonId } });
    };
    card.addEventListener('click', handleClick);
    if (btn) btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleClick();
    });
  });
}

// ====== 5. دوال مساعدة عامة ======

function showLoading(show) {
  if (elements.loading) elements.loading.style.display = show ? 'flex' : 'none';
  // إظهار/إخفاء الـ skeleton في الشبكة
  const skeletonCards = elements.suggestionsGrid?.querySelectorAll('.skeleton-card');
  if (skeletonCards) {
    skeletonCards.forEach(card => {
      card.style.display = show ? 'flex' : 'none';
    });
  }
}

function safeNavigate(route, params = {}) {
  if (window.router?.navigateTo) {
    window.router.navigateTo(route, params);
  } else {
    console.error('❌ Router غير متاح');
    showToast('نظام التنقل غير متاح حالياً', 'error');
  }
}

function showToast(message, type = 'info') {
  if (window.modals?.toast) {
    window.modals.toast(message, type);
  } else {
    console.log(`[${type}] ${message}`);
  }
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

// ====== 6. تصدير ======
export default { initializePage, cleanupPage };