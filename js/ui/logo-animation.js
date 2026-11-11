/* دورة حركة اللوجو الديناميكي - v5.0.0 */

// ==== 1. الثوابت ====
const STATE_COMPACT = 'compact';
const STATE_FULL = 'full';
const PHASE_CLOSING = 'closing';

const STEP_MS = 900;
const HOLD_MS = 3000;
const LOOP_GAP_MS = 1;
const RETRY_DELAY_MS = 1000;

// ==== 2. الحالة ====
let $logo = null;
let motionQuery = null;
let timerId = null;
let isRunning = false;

// ==== 3. دوال مساعدة ====
function clearPendingTimer() {
  if (!timerId) return;
  clearTimeout(timerId);
  timerId = null;
}

function prefersReducedMotion() {
  return Boolean(motionQuery?.matches);
}

function after(delay, action) {
  timerId = setTimeout(action, delay);
}

function setPhase(state, phase) {
  if (!$logo) return;
  $logo.dataset.state = state;

  if (phase) $logo.dataset.phase = phase;
  else delete $logo.dataset.phase;
}

function runSteps(steps) {
  const [current, ...rest] = steps;
  if (!current) return;

  const [delay, action] = current;
  after(delay, () => {
    if (!isRunning || !$logo) return;
    action();
    runSteps(rest);
  });
}

// ==== 4. دورة الحركة ====
function runCycle() {
  if (!isRunning || !$logo) return;

  if (prefersReducedMotion() || document.hidden) {
    setPhase(STATE_COMPACT);
    after(RETRY_DELAY_MS, runCycle);
    return;
  }

  setPhase(STATE_FULL);

  runSteps([
    [STEP_MS + HOLD_MS, () => setPhase(STATE_COMPACT, PHASE_CLOSING)],
    [STEP_MS, () => setPhase(STATE_COMPACT)],
    [STEP_MS + LOOP_GAP_MS, runCycle]
  ]);
}

// ==== 5. المستمعات ====
function handleMotionPreferenceChange() {
  if (!prefersReducedMotion() || !$logo) return;

  clearPendingTimer();
  setPhase(STATE_COMPACT);
  after(RETRY_DELAY_MS, runCycle);
}

function handleVisibilityChange() {
  if (document.hidden || !isRunning) return;

  clearPendingTimer();
  runCycle();
}

// ==== 6. الواجهة العامة ====
export function startLogoAnimation(logoEl) {
  if (!logoEl) {
    console.warn('⚠️ عنصر اللوجو غير موجود');
    return;
  }

  stopLogoAnimation();

  $logo = logoEl;
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  motionQuery.addEventListener('change', handleMotionPreferenceChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  isRunning = true;
  setPhase(STATE_COMPACT);
  runCycle();
}

export function stopLogoAnimation() {
  isRunning = false;
  clearPendingTimer();

  if (motionQuery) {
    motionQuery.removeEventListener('change', handleMotionPreferenceChange);
    motionQuery = null;
  }
  document.removeEventListener('visibilitychange', handleVisibilityChange);

  if ($logo) setPhase(STATE_COMPACT);
  $logo = null;
}

export default { startLogoAnimation, stopLogoAnimation };
