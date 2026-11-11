/* دورة حركة لوجو شاشة التحميل - v5.0.0 */

// ==== 1. الثوابت ====
export const PRELOADER_TIMING = Object.freeze({
  INTRO_MS: 350,
  REVEAL_MS: 1100,
  SHEEN_FIRST_DELAY_MS: 450,
  SHEEN_RUN_MS: 1100,
  SHEEN_WORD_LAG_MS: 320,
  SHEEN_GAP_MS: 2200,
  MIN_VISIBLE_MS: 1700,
  MIN_VISIBLE_REDUCED_MS: 400,
  COMPLETE_HOLD_MS: 420,
  EXIT_MS: 850
});

const STAGE_INTRO = 'intro';
const STAGE_REVEAL = 'reveal';
const STAGE_LOADING = 'loading';
const STAGE_EXIT = 'exit';
const STATE_COMPACT = 'compact';
const STATE_FULL = 'full';
const SHEEN_RUN = 'run';
const RETRY_DELAY_MS = 600;
const SHEEN_SETTLE_MS = 80;

// ==== 2. حالة الوحدة ====
let $root = null;
let $logo = null;
let motionQuery = null;
let timerId = null;
let isRunning = false;

// ==== 3. أدوات مساعدة ====
function clearPendingTimer() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
  }
}

function after(ms, fn) {
  clearPendingTimer();
  timerId = setTimeout(fn, ms);
}

function prefersReducedMotion() {
  return Boolean(motionQuery && motionQuery.matches);
}

function setStage(stage) {
  if ($root) $root.dataset.plStage = stage;
}

function setState(state) {
  if ($logo) $logo.dataset.state = state;
}

function clearSheen() {
  if ($logo) delete $logo.dataset.sheen;
}

function isActive() {
  return isRunning && Boolean($logo);
}

// ==== 4. اللمعة الدورية ====
function runSheen() {
  if (!isActive()) return;

  if (document.hidden) {
    after(RETRY_DELAY_MS, runSheen);
    return;
  }

  $logo.dataset.sheen = SHEEN_RUN;

  const duration = PRELOADER_TIMING.SHEEN_RUN_MS + PRELOADER_TIMING.SHEEN_WORD_LAG_MS + SHEEN_SETTLE_MS;
  after(duration, () => {
    if (!isActive()) return;
    clearSheen();
    after(PRELOADER_TIMING.SHEEN_GAP_MS, runSheen);
  });
}

// ==== 5. السيناريو ====
function freezeOnFullLogo() {
  clearPendingTimer();
  clearSheen();
  setState(STATE_FULL);
  setStage(STAGE_LOADING);
}

function playIntro() {
  if (!isActive()) return;

  if (prefersReducedMotion()) {
    freezeOnFullLogo();
    return;
  }

  setState(STATE_COMPACT);
  setStage(STAGE_INTRO);

  after(PRELOADER_TIMING.INTRO_MS, () => {
    if (!isActive()) return;

    setStage(STAGE_REVEAL);
    setState(STATE_FULL);

    after(PRELOADER_TIMING.REVEAL_MS + PRELOADER_TIMING.SHEEN_FIRST_DELAY_MS, () => {
      if (!isActive()) return;

      setStage(STAGE_LOADING);
      runSheen();
    });
  });
}

// ==== 6. مستمعو الأحداث ====
function handleMotionPreferenceChange() {
  if (isRunning && prefersReducedMotion()) freezeOnFullLogo();
}

// ==== 7. الواجهة العامة ====
export function initPreloaderLogo(rootEl) {
  const root = rootEl || document.getElementById('app-preloader');
  if (!root) return;
  if (isRunning && $root === root) return;

  const logo = root.querySelector('.pl-logo');
  if (!logo) {
    console.warn('[PreloaderLogo] عنصر اللوجو غير موجود');
    return;
  }

  stopPreloaderLogo();

  $root = root;
  $logo = logo;
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  motionQuery.addEventListener('change', handleMotionPreferenceChange);

  isRunning = true;
  playIntro();
}

export function finishPreloaderLogo() {
  if (!$root) return;
  isRunning = false;
  clearPendingTimer();
  clearSheen();
  setState(STATE_FULL);
  setStage(STAGE_EXIT);
}

export function stopPreloaderLogo() {
  isRunning = false;
  clearPendingTimer();

  if (motionQuery) {
    motionQuery.removeEventListener('change', handleMotionPreferenceChange);
    motionQuery = null;
  }

  if ($logo) {
    clearSheen();
    setState(STATE_FULL);
  }

  $root = null;
  $logo = null;
}

// ==== 8. البدء التلقائي ====
function autoStart() {
  initPreloaderLogo(document.getElementById('app-preloader'));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart, { once: true });
  } else {
    autoStart();
  }
}

export default { initPreloaderLogo, finishPreloaderLogo, stopPreloaderLogo, PRELOADER_TIMING };
