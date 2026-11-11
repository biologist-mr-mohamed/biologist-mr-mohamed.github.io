/* الشخصية التوجيهية الذكية - v5.0.0 */

// ==== 1. الاستيراد ====
import { getCurrentUser } from '../core/session.js';
import { EventBus } from '../core/event-bus.js';

// ==== 2. التكوين والثوابت ====
const CONFIG = {
  CONTAINER_ID: 'directing-character',
  DEFAULT_DURATION: 5000,
  AUTO_HIDE: true,
  POSITION: 'bottom-left',
  MEMORY_STORAGE_KEY: 'biologist_directing_memory',
  SPRITE: {
    URL: '/assets/avatars/directing/avatars_directing.png',
    WIDTH: 1642,
    HEIGHT: 656,
    COLS: 5,
    ROWS: 2
  }
};

const EXPRESSIONS = {
  MALE: ['smile', 'think', 'surprised', 'thumbs_up', 'explain'],
  FEMALE: ['smile', 'explain', 'confused', 'celebrate', 'point']
};

// ==== 3. محرك المشاعر ====
const EMOTION_STATES = {
  HAPPY: 'happy',
  SAD: 'sad',
  PROUD: 'proud',
  THINKING: 'thinking',
  SURPRISED: 'surprised',
  ENCOURAGING: 'encouraging',
  CELEBRATING: 'celebrating',
  CONFUSED: 'confused',
  NEUTRAL: 'neutral'
};

const EMOTION_CONFIG = {
  [EMOTION_STATES.HAPPY]: { expression: 'smile', tone: 'friendly', animation: 'bounce', priority: 2 },
  [EMOTION_STATES.SAD]: { expression: 'confused', tone: 'soft', animation: 'gentle', priority: 2 },
  [EMOTION_STATES.PROUD]: { expression: 'thumbs_up', tone: 'excited', animation: 'celebrate', priority: 3 },
  [EMOTION_STATES.THINKING]: { expression: 'think', tone: 'calm', animation: 'idle', priority: 1 },
  [EMOTION_STATES.SURPRISED]: { expression: 'surprised', tone: 'alert', animation: 'pop', priority: 3 },
  [EMOTION_STATES.ENCOURAGING]: { expression: 'explain', tone: 'motivational', animation: 'point', priority: 2 },
  [EMOTION_STATES.CELEBRATING]: { expression: 'celebrate', tone: 'joyful', animation: 'jump', priority: 4 },
  [EMOTION_STATES.CONFUSED]: { expression: 'confused', tone: 'questioning', animation: 'tilt', priority: 2 },
  [EMOTION_STATES.NEUTRAL]: { expression: 'smile', tone: 'neutral', animation: 'idle', priority: 0 }
};

function detectEmotion(context) {
  const { event, score, passed, attempts, streak, levelUp, medal } = context;
  
  if (medal) return EMOTION_STATES.CELEBRATING;
  if (levelUp) return EMOTION_STATES.PROUD;
  
  if (event === 'exam_complete') {
    if (passed && score >= 90) return EMOTION_STATES.CELEBRATING;
    if (passed && score >= 70) return EMOTION_STATES.HAPPY;
    if (!passed && score < 50 && attempts > 1) return EMOTION_STATES.SAD;
    if (!passed && score >= 50) return EMOTION_STATES.ENCOURAGING;
    return passed ? EMOTION_STATES.HAPPY : EMOTION_STATES.THINKING;
  }
  
  if (event === 'exam_start') return EMOTION_STATES.THINKING;
  if (event === 'lesson_complete') return EMOTION_STATES.HAPPY;
  if (event === 'error') return EMOTION_STATES.SURPRISED;
  if (event === 'streak_milestone' && streak >= 5) return EMOTION_STATES.PROUD;
  if (event === 'welcome_back' && streak > 0) return EMOTION_STATES.HAPPY;
  
  return EMOTION_STATES.NEUTRAL;
}

// ==== 4. نظام الذاكرة ====
class DirectingMemory {
  constructor(userId) {
    this.userId = userId;
    this.data = this.load();
  }
  
  load() {
    try {
      const stored = localStorage.getItem(`${CONFIG.MEMORY_STORAGE_KEY}_${this.userId}`);
      return stored ? JSON.parse(stored) : this.getDefaultMemory();
    } catch {
      return this.getDefaultMemory();
    }
  }
  
  getDefaultMemory() {
    return {
      lastScore: null,
      lastExamPassed: null,
      weakTopics: [],
      strongTopics: [],
      streak: 0,
      totalExams: 0,
      totalLessons: 0,
      lastLogin: null,
      consecutiveFails: 0,
      lastEmotion: null,
      tipsGiven: []
    };
  }
  
  save() {
    try {
      localStorage.setItem(`${CONFIG.MEMORY_STORAGE_KEY}_${this.userId}`, JSON.stringify(this.data));
    } catch (e) {
      console.warn('[Directing] فشل حفظ الذاكرة:', e);
    }
  }
  
  update(updates) {
    this.data = { ...this.data, ...updates };
    this.save();
  }
  
  recordExam(score, passed, topic = null) {
    this.data.totalExams++;
    this.data.lastScore = score;
    this.data.lastExamPassed = passed;
    
    if (!passed) {
      this.data.consecutiveFails++;
      if (topic) this.data.weakTopics.push(topic);
    } else {
      this.data.consecutiveFails = 0;
      if (topic) this.data.strongTopics.push(topic);
    }
    
    this.data.weakTopics = [...new Set(this.data.weakTopics)].slice(-5);
    this.data.strongTopics = [...new Set(this.data.strongTopics)].slice(-5);
    
    this.save();
  }
  
  recordLesson(topic = null) {
    this.data.totalLessons++;
    if (topic) this.data.strongTopics.push(topic);
    this.data.strongTopics = [...new Set(this.data.strongTopics)].slice(-5);
    this.save();
  }
  
  updateStreak(streak) {
    this.data.streak = streak;
    this.save();
  }

  hasGivenTip(tipId) {
    return this.data.tipsGiven.includes(tipId);
  }

  markTipGiven(tipId) {
    if (!this.data.tipsGiven.includes(tipId)) {
      this.data.tipsGiven.push(tipId);
      if (this.data.tipsGiven.length > 10) this.data.tipsGiven.shift();
      this.save();
    }
  }
}

// ==== 5. مولد الرسائل ====
const MESSAGE_TEMPLATES = {
  welcome: {
    default: '🌟 أهلاً بك في بيولوجست!',
    variants: [
      { condition: (ctx) => ctx.streak >= 5, text: '🔥 ماشاء الله! بقالك {streak} أيام متواصلة!', emotion: EMOTION_STATES.PROUD },
      { condition: (ctx) => ctx.timeOfDay === 'night', text: '🌙 مساء الخير! ليلة هادية ومذاكرة مفيدة', emotion: EMOTION_STATES.NEUTRAL },
      { condition: () => true, text: '🎓 أهلاً يا بطل! جهز نفسك نبدأ رحلة النهاردة!' }
    ]
  },
  welcome_back: {
    default: '👋 نورتنا تاني!',
    variants: [
      { condition: (ctx) => ctx.streak > 0, text: '👋 رجعت يا وحش! مستمر {streak} أيام ورا بعض!', emotion: EMOTION_STATES.HAPPY },
      { condition: (ctx) => ctx.memory?.consecutiveFails > 1, text: '💪 رجوعك النهاردة قوة! نعوض اللي فات سوا', emotion: EMOTION_STATES.ENCOURAGING },
      { condition: () => true, text: '👋 أهلاً بعودتك! جاهز تكمل من حيث وقفت؟' }
    ]
  },
  exam_start: {
    default: '📝 بالتوفيق في الامتحان!',
    variants: [
      { condition: (ctx) => ctx.memory?.consecutiveFails > 0, text: '🎯 ركّز كويس المرة دي، أنت قدها!', emotion: EMOTION_STATES.ENCOURAGING },
      { condition: (ctx) => ctx.attempts > 1, text: '📚 حاول تاني، كل مرة بتتعلّم حاجة جديدة', emotion: EMOTION_STATES.THINKING },
      { condition: () => true, text: '📝 جهز نفسك! اقرا كل سؤال كويس قبل ما تختار' }
    ]
  },
  exam_success: {
    default: '🎉 مبروك النجاح!',
    variants: [
      { condition: (ctx) => ctx.score >= 95, text: '🏆 ياااه! درجة خرافية! إنت بطل بجد', emotion: EMOTION_STATES.CELEBRATING },
      { condition: (ctx) => ctx.score >= 80, text: '🎯 أداء ممتاز! شغل عالي أوي', emotion: EMOTION_STATES.PROUD },
      { condition: (ctx) => ctx.medal, text: '🥇 ميدالية {medal}! إنت من المتفوقين', emotion: EMOTION_STATES.CELEBRATING },
      { condition: (ctx) => ctx.levelUp, text: '⬆️ وLevel Up كمان! إنت بتطير النهاردة', emotion: EMOTION_STATES.PROUD },
      { condition: () => true, text: '🎉 مبروك! نجحت في الامتحان وكملت خطوة جديدة' }
    ]
  },
  exam_fail: {
    default: '💪 متزعلش، حاول تاني!',
    variants: [
      { condition: (ctx) => ctx.score >= 60, text: '😅 قربت أوي! راجع الدرس وهتعدي بسهولة', emotion: EMOTION_STATES.ENCOURAGING },
      { condition: (ctx) => ctx.attempts >= 2, text: '📖 عارف إنها صعبة شوية، بس إنت قربت تفهمها. نراجع سوا؟', emotion: EMOTION_STATES.THINKING },
      { condition: (ctx) => ctx.memory?.weakTopics?.length > 0, text: '💡 نركز على "{topic}" المرّة الجاية، هتفرق كتير', emotion: EMOTION_STATES.THINKING },
      { condition: () => true, text: '💪 متزعلش! المذاكرة هي المفتاح، أنت تقدر!' }
    ]
  },
  lesson_complete: {
    default: '📖 أحسنت! خلصت الدرس',
    variants: [
      { condition: (ctx) => ctx.streak >= 3, text: '📚 درس جديد اتعلم! بقالك {streak} أيام متواصل، عاش!', emotion: EMOTION_STATES.HAPPY },
      { condition: () => true, text: '📖 أحسنت! خلصت الدرس. جاهز للامتحان بتاعه؟' }
    ]
  },
  encouragement: {
    default: '💪 أنت قدها!',
    variants: [
      { condition: (ctx) => ctx.streak >= 5, text: '🔥 إنت ماكنة! بقالك {streak} أيام متواصلة!', emotion: EMOTION_STATES.PROUD },
      { condition: () => true, text: '💪 أنت قدها! المثابرة بتوصلك للنجاح. كمل!' }
    ]
  },
  study_tip: {
    default: '💡 نصيحة: خد راحة 5 دقائق كل نص ساعة',
    variants: [
      { condition: (ctx) => ctx.timeOfDay === 'night', text: '🌙 متسهرش كتير، نام بدري عشان تركز الصبح', emotion: EMOTION_STATES.NEUTRAL },
      { condition: () => true, text: '💡 نصيحة: ذاكر في مكان هادي ومرتب عشان تركّز أكتر' }
    ]
  },
  error: {
    default: '⚠️ حصل خطأ',
    variants: [
      { condition: () => true, text: '⚠️ حصل خطأ بسيط، حاول تاني أو كلم الدعم لو تكرر' }
    ]
  },
  success: {
    default: '✅ تم بنجاح!',
    variants: [
      { condition: () => true, text: '🎉 يا سلام! عملية ناجحة. استمر في التألق' }
    ]
  }
};

function generateMessage(messageKey, context) {
  const templateGroup = MESSAGE_TEMPLATES[messageKey];
  if (!templateGroup) {
    console.warn(`[Directing] Unknown messageKey: ${messageKey}`);
    return { text: '✨ بيولوجست هنا لمساعدتك', emotion: EMOTION_STATES.NEUTRAL };
  }
  
  for (const variant of templateGroup.variants) {
    if (variant.condition(context)) {
      let text = variant.text;
      text = text.replace('{streak}', context.streak || 0);
      text = text.replace('{score}', context.score || 0);
      text = text.replace('{medal}', context.medal || '');
      text = text.replace('{topic}', context.memory?.weakTopics?.[0] || 'الدرس');
      return { text, emotion: variant.emotion || EMOTION_STATES.NEUTRAL };
    }
  }
  
  return { text: templateGroup.default, emotion: EMOTION_STATES.NEUTRAL };
}

// ==== 6. الحالة الداخلية والعناصر ====
let state = {
  initialized: false,
  isVisible: false,
  currentUser: null,
  memory: null,
  hideTimeout: null,
  elements: {
    container: null,
    sprite: null,
    messageBox: null,
    messageText: null,
    closeBtn: null
  },
  currentExpression: 'smile',
  currentGender: 'male',
  currentAnimation: null,
  eventUnsubscribers: []
};

// ==== 7. دوال Sprite ====

function getSpritePosition(gender, expression) {
  const expressionsList = gender === 'male' ? EXPRESSIONS.MALE : EXPRESSIONS.FEMALE;
  let colIndex = expressionsList.indexOf(expression);
  if (colIndex === -1) colIndex = 0;

  const rowIndex = gender === 'male' ? 0 : 1;

  const xPercent = colIndex * 25;
  const yPercent = rowIndex * 100;

  return `${xPercent}% ${yPercent}%`;
}


function resolveExpression(gender, expression) {
  if (gender === 'female' && expression === 'thumbs_up') {
    return 'celebrate';
  }
  return expression;
}

function updateSprite(expression = state.currentExpression) {
  const sprite = state.elements.sprite;
  if (!sprite) return;
  
  const finalExpression = resolveExpression(state.currentGender, expression);
  state.currentExpression = finalExpression;
  
  sprite.style.willChange = 'background-position';
  sprite.style.backgroundPosition = getSpritePosition(state.currentGender, finalExpression);
}

// ==== 8. طابور الرسائل ====
let messageQueue = [];
let isShowing = false;
let queueTimer = null;

const PRIORITY = {
  ERROR: 5,
  EXAM: 4,
  CELEBRATION: 3,
  DEFAULT: 2,
  TIP: 1
};

function enqueueMessage(messageKey, options = {}) {
  let priority = PRIORITY.DEFAULT;
  if (messageKey === 'error' || messageKey === 'app:error') priority = PRIORITY.ERROR;
  else if (messageKey.includes('exam')) priority = PRIORITY.EXAM;
  else if (messageKey === 'study_tip') priority = PRIORITY.TIP;
  else if (messageKey === 'exam_success' && options.medal) priority = PRIORITY.CELEBRATION;

  messageQueue.push({ key: messageKey, options, priority });
  messageQueue.sort((a, b) => b.priority - a.priority);
  processQueue();
}

function processQueue() {
  if (isShowing || messageQueue.length === 0) return;
  
  const { key, options } = messageQueue.shift();
  isShowing = true;
  
  _showDirectingMessage(key, options);
  
  const duration = (options.duration || CONFIG.DEFAULT_DURATION) + 300;
  queueTimer = setTimeout(() => {
    isShowing = false;
    queueTimer = null;
    processQueue();
  }, duration);
}

// ==== 9. عرض الرسالة ====
function _showDirectingMessage(messageKey, options = {}) {
  const user = getCurrentUser();
  state.currentUser = user;
  state.currentGender = user?.gender === 'female' ? 'female' : 'male';
  
  if (user?.id) {
    if (!state.memory || state.memory.userId !== user.id) {
      state.memory = null;
      state.memory = new DirectingMemory(user.id);
    }
  }
  
  const hour = new Date().getHours();
  let timeOfDay = 'morning';
  if (hour >= 12 && hour < 18) timeOfDay = 'afternoon';
  else if (hour >= 18 && hour < 22) timeOfDay = 'evening';
  else if (hour >= 22 || hour < 5) timeOfDay = 'night';
  
  const context = {
    event: messageKey,
    score: options.score,
    passed: options.passed,
    attempts: options.attempts || 1,
    streak: user?.streak || state.memory?.data?.streak || 0,
    levelUp: options.levelUp || false,
    medal: options.medal || null,
    timeOfDay,
    memory: state.memory?.data || null,
    ...options.context
  };
  
  const emotionState = detectEmotion(context);
  const emotionConfig = EMOTION_CONFIG[emotionState];
  
  let messageData;
  if (options.customMessage) {
    messageData = { text: options.customMessage, emotion: emotionState };
  } else {
    messageData = generateMessage(messageKey, context);
  }
  
  const finalExpression = resolveExpression(state.currentGender, options.expression || emotionConfig.expression);
  
  updateSprite(finalExpression);
  
  if (state.elements.messageText) {
    state.elements.messageText.textContent = messageData.text;
  }
  
  showCharacter();
  
  playAnimation(emotionConfig.animation);
  
  if (state.memory) {
    if (messageKey === 'exam_success' || messageKey === 'exam_fail') {
      state.memory.recordExam(context.score, context.passed, context.topic);
    } else if (messageKey === 'lesson_complete') {
      state.memory.recordLesson(context.topic);
    }
    state.memory.updateStreak(context.streak);
  }
  
  const autoHide = options.autoHide !== undefined ? options.autoHide : CONFIG.AUTO_HIDE;
  const duration = options.duration || CONFIG.DEFAULT_DURATION;
  
  if (state.hideTimeout) clearTimeout(state.hideTimeout);
  if (autoHide) {
    state.hideTimeout = setTimeout(() => hideCharacter(), duration);
  }
}

export function showDirectingMessage(messageKey, options = {}) {
  enqueueMessage(messageKey, options);
}

// ==== 10. التحكم بالشخصية والحركات ====
function playAnimation(animationName) {
  const container = state.elements.container;
  if (!container) return;
  
  container.classList.remove('anim-bounce', 'anim-pop', 'anim-jump', 'anim-gentle', 'anim-idle');
  const animClass = `anim-${animationName}`;
  container.classList.add(animClass);
  state.currentAnimation = animationName;
  
  setTimeout(() => {
    container.classList.remove(animClass);
  }, 600);
}

function showCharacter() {
  const container = state.elements.container;
  if (!container) return;
  
  if (state.hideTimeout) {
    clearTimeout(state.hideTimeout);
    state.hideTimeout = null;
  }
  
  container.style.display = 'flex';
  container.classList.add('anim-enter');
  setTimeout(() => container.classList.remove('anim-enter'), 300);
  
  state.isVisible = true;
  setTimeout(() => playAnimation('idle'), 400);
}

function hideCharacter() {
  const container = state.elements.container;
  if (!container) return;
  
  container.classList.add('fade-out');
  setTimeout(() => {
    container.style.display = 'none';
    container.classList.remove('fade-out');
    state.isVisible = false;
  }, 300);
}

// ==== 11. معالجات الأحداث ====
let lastEventTime = 0;
const EVENT_THROTTLE_MS = 500;

function shouldProcessEvent() {
  const now = Date.now();
  if (now - lastEventTime < EVENT_THROTTLE_MS) return false;
  lastEventTime = now;
  return true;
}

function handleSystemEvent(eventType, detail = {}) {
  if (!shouldProcessEvent()) return;

  switch (eventType) {
    case 'exam:start':
      showDirectingMessage('exam_start', { attempts: detail.attempts });
      break;
      
    case 'exam:complete':
      showDirectingMessage(detail.passed ? 'exam_success' : 'exam_fail', {
        score: detail.score,
        passed: detail.passed,
        attempts: detail.attempts,
        medal: detail.medal,
        levelUp: detail.levelUp,
        topic: detail.topic
      });
      
      if (!detail.passed && state.memory) {
        const consecutiveFails = state.memory.data.consecutiveFails;
        if (consecutiveFails >= 3 && !state.memory.hasGivenTip('fail_3_times')) {
          state.memory.markTipGiven('fail_3_times');
          setTimeout(() => {
            showDirectingMessage('study_tip', {
              customMessage: 'واضح إنك محتاج تغير طريقة المذاكرة شوية 👀. جرب تراجع الدرس الأول بأول أو تشوف فيديو تاني!'
            });
          }, 800);
        }
      }
      break;
      
    case 'lesson:completed':
      showDirectingMessage('lesson_complete', { topic: detail.topic });
      break;
      
    case 'lesson:loaded':
      showDirectingMessage('lesson_start');
      break;
      
    case 'streak:updated':
      if (detail.streak >= 5) {
        showDirectingMessage('encouragement', { streak: detail.streak });
      }
      break;
      
    case 'level:up':
      showDirectingMessage('encouragement', { levelUp: true, newLevel: detail.level });
      break;
      
    case 'medal:earned':
      showDirectingMessage('exam_success', { medal: detail.medal });
      break;
      
    case 'app:error':
      if (!detail.silent) {
        showDirectingMessage('error');
      }
      break;
      
    case 'operation:success':
      showDirectingMessage('success');
      break;
      
    case 'user:login':
      const lastActivity = localStorage.getItem('biologist_last_activity_date');
      const today = new Date().toISOString().split('T')[0];
      const isReturningUser = lastActivity && lastActivity !== today;
      showDirectingMessage(isReturningUser ? 'welcome_back' : 'welcome');
      localStorage.setItem('biologist_last_activity_date', today);
      break;
      
    case 'study_tip:show':
      showDirectingMessage('study_tip');
      break;
      
    default:
      break;
  }
}

// ==== 12. التهيئة وبناء الواجهة ====
function createElements() {
  let container = document.getElementById(CONFIG.CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = CONFIG.CONTAINER_ID;
    container.className = 'directing-character';
    document.body.appendChild(container);
  }
  
  let sprite = container.querySelector('.character-sprite');
  if (!sprite) {
    sprite = document.createElement('div');
    sprite.className = 'character-sprite';
    sprite.style.backgroundImage = `url('${CONFIG.SPRITE.URL}')`;
    sprite.style.backgroundSize = `${CONFIG.SPRITE.WIDTH}px ${CONFIG.SPRITE.HEIGHT}px`;
    container.appendChild(sprite);
  }
  
  let messageBox = container.querySelector('.character-message');
  if (!messageBox) {
    messageBox = document.createElement('div');
    messageBox.className = 'character-message';
    messageBox.innerHTML = `
      <div class="message-arrow"></div>
      <span class="message-text"></span>
      <button class="close-message" aria-label="إغلاق"><i class="fas fa-times"></i></button>
    `;
    container.appendChild(messageBox);
  }
  
  state.elements = {
    container,
    sprite,
    messageBox,
    messageText: messageBox.querySelector('.message-text'),
    closeBtn: messageBox.querySelector('.close-message')
  };
  
  if (state.elements.closeBtn) {
    state.elements.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideCharacter();
      if (queueTimer) {
        clearTimeout(queueTimer);
        queueTimer = null;
      }
      isShowing = false;
      processQueue();
    });
  }
}

function subscribeToEvents() {
  const events = [
    'exam:start', 'exam:complete', 'lesson:completed', 'lesson:loaded',
    'streak:updated', 'level:up', 'medal:earned', 'app:error', 'operation:success',
    'user:login', 'study_tip:show'
  ];
  
  events.forEach(eventName => {
    const unsub = EventBus.on(eventName, (detail) => handleSystemEvent(eventName, detail));
    state.eventUnsubscribers.push(unsub);
  });
  
  const unsubUser = EventBus.on('userStateChanged', (detail) => {
    if (detail.action === 'login') {
      handleSystemEvent('user:login', detail);
      if (detail.user?.id) {
        state.memory = new DirectingMemory(detail.user.id);
      }
    }
  });
  state.eventUnsubscribers.push(unsubUser);
}

export function initializeDirecting() {
  if (state.initialized) {
    console.log('[Directing] تم تهيئته مسبقاً');
    return true;
  }
  
  console.log('[Directing] بدء تهيئة نظام الشخصية الذكية...');
  try {
    createElements();
    subscribeToEvents();
    
    window.directingAPI = {
      show: showDirectingMessage,
      hide: hideCharacter,
      setExpression: (expr) => updateSprite(expr),
      playAnimation,
      getMemory: () => state.memory?.data
    };
    
    const user = getCurrentUser();
    if (user) {
      state.currentGender = user.gender === 'female' ? 'female' : 'male';
      state.memory = new DirectingMemory(user.id);
      updateSprite('smile');
      setTimeout(() => handleSystemEvent('user:login'), 500);
    }
    
    state.initialized = true;
    console.log('[Directing] تم التهيئة بنجاح ✅ (شخصية ذكية)');
    return true;
  } catch (error) {
    console.error('[Directing] فشل التهيئة:', error);
    return false;
  }
}

export function destroyDirecting() {
  state.eventUnsubscribers.forEach(unsub => unsub());
  state.eventUnsubscribers = [];
  
  if (state.hideTimeout) clearTimeout(state.hideTimeout);
  if (queueTimer) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
  
  const container = document.getElementById(CONFIG.CONTAINER_ID);
  if (container) container.remove();
  
  state.initialized = false;
  delete window.directingAPI;
  messageQueue = [];
  isShowing = false;
  console.log('[Directing] تم تنظيف النظام');
}

export default {
  initialize: initializeDirecting,
  destroy: destroyDirecting,
  show: showDirectingMessage,
  hide: hideCharacter
};