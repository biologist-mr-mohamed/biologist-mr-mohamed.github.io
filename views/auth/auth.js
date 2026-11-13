/* نظام المصادقة: تسجيل الدخول وإنشاء الحساب - v5.0.0 */

import {
  setSession,
  getCurrentUser,
  getRememberedPhone,
  setRememberedPhone
} from '../../js/core/session.js';

import {
  loginUser,
  registerUser,
  checkPhoneExists
} from '../../js/core/api.js';

// ==== 1. الثوابت ====

const AUTH_CONFIG = Object.freeze({
  PHONE_PATTERN: /^01[0125]\d{8}$/,
  PASSWORD_PATTERN: /^\d{6,10}$/,
  AGE_MIN: 10,
  AGE_MAX: 80,
  SUPPORT_PHONE: '01208388529'
});

const MESSAGES = Object.freeze({
  phoneRequired: 'رقم الهاتف مطلوب',
  phoneInvalid: 'رقم الهاتف يجب أن يكون 11 رقمًا ويبدأ بـ 01',
  phoneExists: 'رقم الهاتف مسجل بالفعل',
  phoneNotFound: 'رقم الهاتف غير مسجل',
  passwordRequired: 'كلمة المرور مطلوبة',
  passwordFormat: 'كلمة المرور يجب أن تكون 6-10 أرقام فقط',
  passwordWrong: 'كلمة المرور غير صحيحة',
  confirmRequired: 'تأكيد كلمة المرور مطلوب',
  passwordMismatch: 'كلمة المرور غير متطابقة',
  termsRequired: 'يجب الموافقة على شروط الاستخدام',
  ageRequired: 'العمر مطلوب',
  ageInvalid: 'العمر يجب أن يكون بين 10 و80 سنة',
  genderRequired: 'يرجى اختيار الجنس',
  firstNameRequired: 'الاسم الأول مطلوب',
  lastNameRequired: 'اسم العائلة مطلوب',
  stageRequired: 'يرجى اختيار المرحلة الدراسية',
  gradeRequired: 'يرجى اختيار الصف الدراسي',
  loginFieldsRequired: 'يجب إدخال رقم الهاتف وكلمة المرور قبل تسجيل الدخول',
  reviewFields: 'يرجى مراجعة الحقول المظللة',
  offline: 'لا يوجد اتصال بالإنترنت، حاول مجددًا بعد عودة الاتصال',
  registeredLoginFailed: 'تم إنشاء حسابك بنجاح، سجّل الدخول الآن للمتابعة'
});

const LOGIN_FIELDS = Object.freeze(['phone', 'password']);

const REGISTER_FIELDS = Object.freeze([
  'first-name', 'last-name', 'gender', 'age', 'phone',
  'password', 'confirm-password', 'stage', 'grade', 'terms'
]);

const GRADE_PLACEHOLDER_IDLE = 'اختر الصف أولاً';
const GRADE_PLACEHOLDER_READY = 'اختر الصف الدراسي';

const GRADES_BY_STAGE = Object.freeze({
  preparatory: ['1', '2', '3'].map(v => ({ value: v, label: `الصف ${v} الإعدادي` })),
  secondary: ['1', '2', '3'].map(v => ({ value: v, label: `الصف ${v} الثانوي` }))
});

const SOCIAL_PROVIDERS = Object.freeze({ facebook: 'فيسبوك', google: 'جوجل' });

// ==== 2. الحالة الداخلية ====

function createInitialState() {
  return {
    currentPage: 'login',
    container: null,
    isInitialized: false,
    isSubmitting: false,
    abortController: null,
    touched: new Set(),
    phoneCheck: { phone: null, exists: false },
    phoneCheckSeq: 0
  };
}

let $authState = createInitialState();

// ==== 3. أدوات مساعدة للواجهة ====
// الراوتر يوجّه عند userStateChanged، وهذا احتياط لا يعمل أثناء تنقل جارٍ

function safeToast(message, type = 'info') {
  if (window.modals?.toast) {
    window.modals.toast(message, type);
  } else {
    console.log(`[${type}] ${message}`);
  }
}

function isOffline() {
  return navigator.onLine === false;
}

function ensureRedirect() {
  window.router?.redirectAfterLogin?.();
}

async function getModals() {
  if (window.modals?.showModal) return window.modals;
  try {
    const module = await import('../../js/ui/modals.js');
    return module.default ?? window.modals ?? null;
  } catch (error) {
    console.error('❌ [Auth] فشل تحميل modals.js:', error);
    return null;
  }
}

// ==== 4. عرض حالة الحقول ====
// يتبع عقد components.css: .show وhas-error وhas-success

function renderField(container, name, message, visible) {
  const errorEl = container.querySelector(`[data-error="${name}"]`);
  if (!errorEl) return;

  const shownMessage = visible ? message : '';
  errorEl.textContent = shownMessage;
  errorEl.classList.toggle('show', Boolean(shownMessage));

  const group = errorEl.closest('.form-group, .form-checkbox');
  if (!group) return;

  const control = group.querySelector('.form-control, .checkbox');
  const isFilled = control?.type === 'checkbox' ? control.checked : Boolean(control?.value?.trim());

  group.classList.toggle('has-error', Boolean(shownMessage));
  group.classList.toggle('has-success', visible && !message && isFilled);
}

function renderForm(state, errors, fieldNames, showAll = false) {
  fieldNames.forEach(name => {
    renderField(state.container, name, errors[name] || '', showAll || state.touched.has(name));
  });
}

function hasErrors(errors) {
  return Object.values(errors).some(Boolean);
}

function focusFirstInvalid(form) {
  form.querySelector('.has-error .form-control, .has-error .checkbox')?.focus();
}

// ==== 5. التحقق ====

function getLoginErrors({ phone, password }) {
  return {
    phone: !phone
      ? MESSAGES.phoneRequired
      : (!AUTH_CONFIG.PHONE_PATTERN.test(phone) ? MESSAGES.phoneInvalid : ''),
    password: !password
      ? MESSAGES.passwordRequired
      : (!AUTH_CONFIG.PASSWORD_PATTERN.test(password) ? MESSAGES.passwordFormat : '')
  };
}

function getRegisterErrors(values, phoneCheck) {
  const age = Number(values.age);
  const ageOutOfRange = !Number.isInteger(age) || age < AUTH_CONFIG.AGE_MIN || age > AUTH_CONFIG.AGE_MAX;
  const phoneTaken = phoneCheck.phone === values.phone && phoneCheck.exists;

  return {
    'first-name': values.firstName ? '' : MESSAGES.firstNameRequired,
    'last-name': values.lastName ? '' : MESSAGES.lastNameRequired,
    gender: values.gender ? '' : MESSAGES.genderRequired,
    age: !values.age ? MESSAGES.ageRequired : (ageOutOfRange ? MESSAGES.ageInvalid : ''),
    phone: !values.phone
      ? MESSAGES.phoneRequired
      : (!AUTH_CONFIG.PHONE_PATTERN.test(values.phone)
        ? MESSAGES.phoneInvalid
        : (phoneTaken ? MESSAGES.phoneExists : '')),
    password: !values.password
      ? MESSAGES.passwordRequired
      : (!AUTH_CONFIG.PASSWORD_PATTERN.test(values.password) ? MESSAGES.passwordFormat : ''),
    'confirm-password': !values.confirmPassword
      ? MESSAGES.confirmRequired
      : (values.password !== values.confirmPassword ? MESSAGES.passwordMismatch : ''),
    stage: values.stage ? '' : MESSAGES.stageRequired,
    grade: values.grade ? '' : MESSAGES.gradeRequired,
    terms: values.terms ? '' : MESSAGES.termsRequired
  };
}

function readLoginValues(form) {
  return {
    phone: form.querySelector('#login-phone')?.value.trim() ?? '',
    password: form.querySelector('#login-password')?.value ?? ''
  };
}

function readRegisterValues(form) {
  return {
    firstName: form.querySelector('#register-first-name')?.value.trim() ?? '',
    lastName: form.querySelector('#register-last-name')?.value.trim() ?? '',
    gender: form.querySelector('#register-gender')?.value ?? '',
    age: form.querySelector('#register-age')?.value ?? '',
    phone: form.querySelector('#register-phone')?.value.trim() ?? '',
    password: form.querySelector('#register-password')?.value ?? '',
    confirmPassword: form.querySelector('#register-confirm-password')?.value ?? '',
    stage: form.querySelector('#register-stage')?.value ?? '',
    grade: form.querySelector('#register-grade')?.value ?? '',
    terms: form.querySelector('#terms-agree')?.checked ?? false,
    notifications: form.querySelector('#notifications-agree')?.checked ?? false
  };
}

// ==== 6. تحديث النماذج وحالة زر الإرسال ====

function syncSubmitState(state, form) {
  const submitBtn = form.querySelector('[type="submit"]');
  if (!submitBtn) return;

  const termsPending = state.currentPage === 'register'
    && !form.querySelector('#terms-agree')?.checked;

  submitBtn.disabled = state.isSubmitting || termsPending;
}

function refreshLogin(state, showAll = false) {
  const form = state.container?.querySelector('#login-form');
  if (!form) return null;

  const errors = getLoginErrors(readLoginValues(form));
  renderForm(state, errors, LOGIN_FIELDS, showAll);
  syncSubmitState(state, form);
  return errors;
}

function refreshRegister(state, showAll = false) {
  const form = state.container?.querySelector('#register-form');
  if (!form) return null;

  const errors = getRegisterErrors(readRegisterValues(form), state.phoneCheck);
  renderForm(state, errors, REGISTER_FIELDS, showAll);
  syncSubmitState(state, form);
  return errors;
}

// ==== 7. فحص توفر رقم الهاتف ====
// النتيجة مخزّنة لتفادي قراءات Firestore المتكررة

async function checkPhoneAvailability(state, phone) {
  if (!AUTH_CONFIG.PHONE_PATTERN.test(phone) || state.phoneCheck.phone === phone) return;

  const seq = ++state.phoneCheckSeq;
  const wrapper = state.container?.querySelector('#register-phone')?.closest('.input-wrapper');
  wrapper?.classList.add('is-checking');
  if (wrapper && !wrapper.querySelector('.auth-field-loader')) {
    const loader = createBioLoader(18, 'جاري فحص رقم الهاتف');
    loader.classList.add('auth-field-loader');
    wrapper.appendChild(loader);
  }

  try {
    const exists = await checkPhoneExists(phone);
    if (seq === state.phoneCheckSeq) {
      state.phoneCheck = { phone, exists };
    }
  } catch (error) {
    console.warn('⚠️ [Auth] تعذّر فحص توفر الرقم');
  } finally {
    if (seq === state.phoneCheckSeq) {
      wrapper?.classList.remove('is-checking');
      wrapper?.querySelector('.auth-field-loader')?.remove();
    }
  }
}

// ==== 8. حالة التحميل للزر ====

const submitLabels = new WeakMap();

// مؤشر التحميل الموحد للمنصة (.bio-loader من components.css)
function createBioLoader(size, label) {
  const loader = document.createElement('span');
  loader.className = 'bio-loader bio-loader--auto';
  loader.setAttribute('role', 'status');
  loader.setAttribute('aria-label', label);
  loader.style.setProperty('--bio-size', `${size}px`);
  return loader;
}

function setSubmitting(state, form, isLoading) {
  state.isSubmitting = isLoading;
  form.classList.toggle('loading', isLoading);

  const btn = form.querySelector('[type="submit"]');
  if (!btn) return;

  const textEl = btn.querySelector('.btn-text');

  if (isLoading) {
    if (textEl) {
      submitLabels.set(btn, textEl.textContent);
      textEl.textContent = 'جاري التحميل...';
    }
    btn.disabled = true;
    btn.setAttribute('data-loading', '');
    btn.setAttribute('aria-busy', 'true');
    if (!btn.querySelector('.bio-loader')) {
      btn.prepend(createBioLoader(24, 'جاري التحميل'));
    }
    return;
  }

  btn.removeAttribute('data-loading');
  btn.removeAttribute('aria-busy');
  btn.querySelector('.bio-loader')?.remove();
  if (textEl && submitLabels.has(btn)) {
    textEl.textContent = submitLabels.get(btn);
    submitLabels.delete(btn);
  }
  syncSubmitState(state, form);
}

// ==== 9. معالجة تسجيل الدخول ====

async function handleLoginSubmit(event) {
  event.preventDefault();

  const state = $authState;
  if (state.isSubmitting || !state.container) return;

  const form = event.currentTarget;
  const values = readLoginValues(form);

  LOGIN_FIELDS.forEach(name => state.touched.add(name));
  const errors = getLoginErrors(values);
  renderForm(state, errors, LOGIN_FIELDS, true);

  if (hasErrors(errors)) {
    safeToast(!values.phone || !values.password ? MESSAGES.loginFieldsRequired : MESSAGES.reviewFields, 'warning');
    focusFirstInvalid(form);
    return;
  }

  if (isOffline()) {
    safeToast(MESSAGES.offline, 'error');
    return;
  }

  const rememberMe = form.querySelector('#remember-me')?.checked ?? false;

  setSubmitting(state, form, true);
  safeToast('جاري تسجيل الدخول...', 'info');

  try {
    const userData = await loginUser(values.phone, values.password);
    await setSession(userData, rememberMe);
    setRememberedPhone(rememberMe ? values.phone : null);

    safeToast(`مرحباً ${userData.full_name || 'بك'}! تم تسجيل الدخول بنجاح`, 'success');
    ensureRedirect();
  } catch (error) {
    console.error('❌ [Auth] فشل تسجيل الدخول:', error);
    const message = error?.message || '';

    if (message.includes('غير مسجل')) {
      state.touched.add('phone');
      renderField(state.container, 'phone', MESSAGES.phoneNotFound, true);
      safeToast('رقم الهاتف غير صحيح أو غير مسجل', 'error');
    } else if (message.includes('غير صحيحة')) {
      state.touched.add('password');
      renderField(state.container, 'password', MESSAGES.passwordWrong, true);
      safeToast('كلمة المرور غير صحيحة، حاول مرة أخرى', 'error');
    } else {
      safeToast(message || 'حدث خطأ أثناء تسجيل الدخول', 'error');
    }
  } finally {
    setSubmitting(state, form, false);
  }
}

// ==== 10. معالجة إنشاء الحساب ====

async function handleRegisterSubmit(event) {
  event.preventDefault();

  const state = $authState;
  if (state.isSubmitting || !state.container) return;

  const form = event.currentTarget;
  const values = readRegisterValues(form);

  await checkPhoneAvailability(state, values.phone);

  REGISTER_FIELDS.forEach(name => state.touched.add(name));
  const errors = getRegisterErrors(values, state.phoneCheck);
  renderForm(state, errors, REGISTER_FIELDS, true);

  if (hasErrors(errors)) {
    safeToast(MESSAGES.reviewFields, 'warning');
    focusFirstInvalid(form);
    return;
  }

  if (isOffline()) {
    safeToast(MESSAGES.offline, 'error');
    return;
  }

  setSubmitting(state, form, true);
  safeToast('جاري إنشاء الحساب...', 'info');

  let accountCreated = false;

  try {
    await registerUser({
      firstName: values.firstName,
      lastName: values.lastName,
      gender: values.gender,
      age: parseInt(values.age, 10),
      phone: values.phone,
      password: values.password,
      user_type: 'student',
      stage: values.stage,
      grade: parseInt(values.grade, 10),
      notifications: values.notifications
    });
    accountCreated = true;

    const loggedInUser = await loginUser(values.phone, values.password);
    await setSession(loggedInUser, true);

    safeToast('تم إنشاء الحساب بنجاح! مرحباً بك في بيولوجست', 'success');
    ensureRedirect();
  } catch (error) {
    console.error('❌ [Auth] فشل إنشاء الحساب:', error);
    const message = error?.message || '';

    if (accountCreated) {
      safeToast(MESSAGES.registeredLoginFailed, 'info');
      window.router?.navigateTo?.('login', {}, { replace: true });
    } else if (message.includes('مسجل بالفعل')) {
      state.phoneCheck = { phone: values.phone, exists: true };
      state.touched.add('phone');
      renderField(state.container, 'phone', MESSAGES.phoneExists, true);
      focusFirstInvalid(form);
    } else {
      safeToast(message || 'حدث خطأ أثناء إنشاء الحساب', 'error');
    }
  } finally {
    setSubmitting(state, form, false);
  }
}

// ==== 11. النوافذ المنبثقة ====

const TERMS_HTML = `
  <div class="auth-modal-content">
    <h3>📜 شروط استخدام منصة بيولوجست</h3>
    <p>مرحبًا بك في منصة بيولوجست التعليمية. باستخدامك للمنصة، فإنك توافق على الشروط التالية:</p>
    <ol>
      <li><strong>الاستخدام التعليمي:</strong> المنصة مخصصة للأغراض التعليمية فقط. يمنع استخدامها لأي أغراض تجارية أو غير قانونية.</li>
      <li><strong>المحتوى:</strong> جميع الدروس والامتحانات والمحتوى المرئي والمكتوب هو ملك للمنصة والأستاذ محمد إبراهيم طه. يمنع نسخه أو توزيعه دون إذن.</li>
      <li><strong>الحسابات:</strong> أنت مسؤول عن الحفاظ على سرية بيانات حسابك. أي نشاط يتم من خلال حسابك يعتبر مسؤوليتك.</li>
      <li><strong>السلوك:</strong> يمنع نشر أي محتوى مسيء أو غير لائق في التعليقات أو المجموعات. نحتفظ بحق حذف أي محتوى مخالف.</li>
      <li><strong>الخصوصية:</strong> نتعامل مع بياناتك وفقًا لسياسة الخصوصية الخاصة بنا.</li>
      <li><strong>التعديلات:</strong> قد نُجري تعديلات على هذه الشروط من وقت لآخر، وسيتم إعلامك بها.</li>
    </ol>
    <p>إذا كان لديك أي استفسار، تواصل مع الدعم الفني.</p>
  </div>
`;

const PRIVACY_HTML = `
  <div class="auth-modal-content">
    <h3>🔒 سياسة خصوصية منصة بيولوجست</h3>
    <p>خصوصيتك تهمنا. توضح هذه السياسة كيفية جمعنا واستخدامنا لمعلوماتك الشخصية.</p>
    <ul>
      <li><strong>المعلومات التي نجمعها:</strong> الاسم، رقم الهاتف، العمر، الجنس، المرحلة والصف الدراسي، وتقدمك التعليمي.</li>
      <li><strong>كيفية الاستخدام:</strong> نستخدم البيانات لتقديم تجربة تعليمية مخصصة، وتحسين أدائك، وإرسال إشعارات مهمة.</li>
      <li><strong>المشاركة:</strong> لا نشارك بياناتك مع أطراف خارجية إلا بموافقتك أو لأغراض تشغيلية أساسية (مثل Firebase).</li>
      <li><strong>الأمان:</strong> نحفظ كلمات المرور مجزّأة بخوارزمية SHA-256، ونشفّر بيانات الجلسة على جهازك بخوارزمية AES-GCM.</li>
      <li><strong>حقوقك:</strong> يمكنك طلب تعديل بياناتك أو حذف حسابك في أي وقت من خلال إعدادات الملف الشخصي.</li>
    </ul>
    <p>باستمرارك في استخدام المنصة، أنت توافق على هذه السياسة.</p>
  </div>
`;

function buildForgotPasswordHtml() {
  const phone = AUTH_CONFIG.SUPPORT_PHONE;
  return `
    <div class="forgot-password-modal">
      <i class="fas fa-lock lock-icon" aria-hidden="true"></i>
      <h3>🔐 نسيت كلمة المرور؟</h3>
      <p>عذراً، لا يمكن استعادة كلمة المرور تلقائياً في هذا الإصدار.</p>
      <div class="support-info">
        <p><i class="fas fa-headset" aria-hidden="true"></i>
          <strong>يرجى التواصل مباشرة مع المشرف أو الدعم الفني لحل المشكلة:</strong></p>
        <a href="tel:+2${phone}" class="support-number" dir="ltr" target="_blank" rel="noopener">${phone}</a>
        <p class="support-hint">(اضغط على الرقم للاتصال)</p>
      </div>
      <p>أو يمكنك التواصل عبر واتساب على نفس الرقم.</p>
    </div>
  `;
}

async function openAuthModal({ title, html, size = 'medium', confirmText = 'موافق' }) {
  const modals = await getModals();
  if (!modals) {
    safeToast(`عذراً، لا يمكن عرض ${title} حالياً. حاول مجدداً.`, 'error');
    return;
  }
  modals.showModal({
    title,
    html,
    size,
    buttons: [{ text: confirmText, role: 'confirm', type: 'primary' }]
  });
}

function showTermsModal() {
  return openAuthModal({ title: 'شروط الاستخدام', html: TERMS_HTML });
}

function showPrivacyModal() {
  return openAuthModal({ title: 'سياسة الخصوصية', html: PRIVACY_HTML });
}

function showForgotPasswordModal() {
  return openAuthModal({
    title: 'استعادة كلمة المرور',
    html: buildForgotPasswordHtml(),
    size: 'small',
    confirmText: 'حسنًا'
  });
}

function handleSocialLogin(providerKey) {
  const provider = SOCIAL_PROVIDERS[providerKey] || providerKey;
  safeToast(`🚀 ميزة تسجيل الدخول عبر ${provider} ستُتاح قريبًا جدًا!`, 'info');
}

// ==== 12. تفاعلات الواجهة ====

function handlePasswordToggle(button) {
  const input = button.closest('.input-with-icon')?.querySelector('.form-control');
  if (!input) return;

  const reveal = input.type === 'password';
  const fieldLabel = button.closest('.form-group')?.querySelector('.form-label')?.textContent.trim() || 'كلمة المرور';

  input.type = reveal ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(reveal));
  button.setAttribute('aria-label', `${reveal ? 'إخفاء' : 'إظهار'} ${fieldLabel}`);
}

function handleContainerClick(event) {
  const toggleBtn = event.target.closest('.toggle-password');
  if (toggleBtn) {
    handlePasswordToggle(toggleBtn);
    return;
  }

  const actionEl = event.target.closest('[data-action]');
  switch (actionEl?.dataset.action) {
    case 'forgot-password':
      event.preventDefault();
      showForgotPasswordModal();
      return;
    case 'show-terms':
      event.preventDefault();
      showTermsModal();
      return;
    case 'show-privacy':
      event.preventDefault();
      showPrivacyModal();
      return;
    default:
      break;
  }

  const socialBtn = event.target.closest('[data-social]');
  if (socialBtn) {
    event.preventDefault();
    handleSocialLogin(socialBtn.dataset.social);
  }
}

function handleStageChange(event) {
  const state = $authState;
  const gradeSelect = state.container?.querySelector('#register-grade');
  if (!gradeSelect) return;

  const grades = GRADES_BY_STAGE[event.target.value] || [];
  gradeSelect.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = grades.length ? GRADE_PLACEHOLDER_READY : GRADE_PLACEHOLDER_IDLE;
  if (grades.length) {
    placeholder.disabled = true;
    placeholder.selected = true;
  }
  gradeSelect.appendChild(placeholder);

  grades.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    gradeSelect.appendChild(option);
  });

  gradeSelect.disabled = grades.length === 0;
  state.touched.add('stage');
  state.touched.delete('grade');
  refreshRegister(state);
}

// ==== 13. ربط الأحداث ====
// كل المستمعات بإشارة AbortController واحدة لتُزال عند التنظيف

function bindLoginEvents(state, signal) {
  const form = state.container.querySelector('#login-form');
  if (!form) return;

  form.addEventListener('submit', handleLoginSubmit, { signal });

  [['#login-phone', 'phone'], ['#login-password', 'password']].forEach(([selector, name]) => {
    const input = form.querySelector(selector);
    if (!input) return;

    input.addEventListener('blur', () => {
      state.touched.add(name);
      refreshLogin(state);
    }, { signal });

    input.addEventListener('input', () => {
      if (state.touched.has(name)) refreshLogin(state);
    }, { signal });
  });
}

function bindRegisterEvents(state, signal) {
  const form = state.container.querySelector('#register-form');
  if (!form) return;

  form.addEventListener('submit', handleRegisterSubmit, { signal });

  const textFields = [
    ['#register-first-name', 'first-name'],
    ['#register-last-name', 'last-name'],
    ['#register-age', 'age'],
    ['#register-password', 'password'],
    ['#register-confirm-password', 'confirm-password']
  ];

  textFields.forEach(([selector, name]) => {
    const input = form.querySelector(selector);
    if (!input) return;

    input.addEventListener('blur', () => {
      state.touched.add(name);
      refreshRegister(state);
    }, { signal });

    input.addEventListener('input', () => {
      if (state.touched.has(name) || state.touched.has('confirm-password')) refreshRegister(state);
    }, { signal });
  });

  const phoneInput = form.querySelector('#register-phone');
  phoneInput?.addEventListener('input', () => {
    if (state.touched.has('phone')) refreshRegister(state);
  }, { signal });
  phoneInput?.addEventListener('blur', async () => {
    state.touched.add('phone');
    await checkPhoneAvailability(state, phoneInput.value.trim());
    refreshRegister(state);
  }, { signal });

  form.querySelector('#register-gender')?.addEventListener('change', () => {
    state.touched.add('gender');
    refreshRegister(state);
  }, { signal });

  form.querySelector('#register-stage')?.addEventListener('change', handleStageChange, { signal });

  form.querySelector('#register-grade')?.addEventListener('change', () => {
    state.touched.add('grade');
    refreshRegister(state);
  }, { signal });

  form.querySelector('#terms-agree')?.addEventListener('change', () => {
    state.touched.add('terms');
    refreshRegister(state);
  }, { signal });

  syncSubmitState(state, form);
}

function prefillRememberedPhone(state) {
  const phone = getRememberedPhone();
  const phoneInput = state.container.querySelector('#login-phone');
  if (!phone || !phoneInput) return;

  phoneInput.value = phone;

  const rememberBox = state.container.querySelector('#remember-me');
  if (rememberBox) rememberBox.checked = true;

  if (AUTH_CONFIG.PHONE_PATTERN.test(phone)) {
    state.touched.add('phone');
    renderField(state.container, 'phone', '', true);
  }
}

// ==== 14. التهيئة والتنظيف ====

export function initializePage(container) {
  if ($authState.isInitialized) cleanupPage();

  if (getCurrentUser()) {
    setTimeout(ensureRedirect, 0);
    return;
  }

  const state = createInitialState();
  $authState = state;

  state.container = container;
  state.currentPage = container.querySelector('[data-page]')?.dataset.page || 'login';
  state.abortController = new AbortController();

  const { signal } = state.abortController;
  container.addEventListener('click', handleContainerClick, { signal });

  if (state.currentPage === 'register') {
    bindRegisterEvents(state, signal);
  } else {
    bindLoginEvents(state, signal);
    prefillRememberedPhone(state);
  }

  state.isInitialized = true;
}

export function cleanupPage() {
  $authState.abortController?.abort();
  $authState = createInitialState();
}

// ==== 15. التصدير ====

export { handleLoginSubmit, handleRegisterSubmit };
