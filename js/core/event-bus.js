/* ناقل الأحداث المركزي (نشر/اشتراك) لتواصل المكوّنات - v5.0.0 */

// ==== 1. الإعدادات ====
const EVENT_BUS_CONFIG = {
  MAX_LISTENERS_PER_EVENT: 25,
  MEMORY_LEAK_THRESHOLD: 50,
  WARN_ON_MAX_LISTENERS: true,
  THROW_ON_ERROR: false,
  DEFAULT_PRIORITY: 0,
  EMIT_TIMEOUT_DEFAULT: 5000,
  ERROR_EVENT_NAME: 'event-bus:error',
  OFFLINE_QUEUE_ENABLED: true,
  OFFLINE_RETRY_INTERVAL: 30000,
  OFFLINE_MAX_RETRIES: 3,
  MAX_OFFLINE_QUEUE_SIZE: 100,
  EVENT_HISTORY_LIMIT: 500,
  DEBUG_STORAGE_KEY: 'event_bus_debug',
  STICKY_EVENTS: ['modals:ready', 'navbar:ready', 'routerInitialized', 'app:ready'],
  DOM_BRIDGE_EVENTS: []
};

// ==== 2. الحالة الداخلية ====
const events = new Map();
const interceptors = [];
const warnedEvents = new Set();
const patternCache = new Map();
const stickyEvents = new Set(EVENT_BUS_CONFIG.STICKY_EVENTS);
const stickyStore = new Map();
const domBridgeHandlers = new Map();
const CANCEL = Symbol('event-bus:cancel');
let offlineQueue = [];
let isProcessingOfflineQueue = false;
let offlineRetryTimer = null;
let globalMaxListeners = EVENT_BUS_CONFIG.MAX_LISTENERS_PER_EVENT;
let debugMode = false;
let storageDebug = false;
let eventHistory = [];
let totalListenersCount = 0;
let leakWarned = false;
let isReportingError = false;

// ==== 3. أدوات مساعدة ====
function assertEventName(event) {
  if (typeof event !== 'string' || !event) {
    throw new TypeError('[EventBus] اسم الحدث يجب أن يكون نصاً غير فارغ');
  }
}

function isPattern(name) {
  return name.includes('*');
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function readStorageDebugFlag() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(EVENT_BUS_CONFIG.DEBUG_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function isTracking() {
  return debugMode || storageDebug;
}

function matchesPattern(pattern, event) {
  if (pattern === '*' || pattern === '**') return true;

  if (pattern.endsWith(':*') && !pattern.slice(0, -2).includes('*')) {
    return event.startsWith(`${pattern.slice(0, -2)}:`);
  }

  let regex = patternCache.get(pattern);
  if (!regex) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    regex = new RegExp(`^${escaped}$`);
    patternCache.set(pattern, regex);
  }
  return regex.test(event);
}

function serializeArg(arg) {
  if (typeof arg !== 'object' || arg === null) return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg).slice(0, 200);
  } catch {
    return '[Complex Object]';
  }
}

// ==== 4. سجل الأحداث ====
function addToHistory(event, args, duration, listenerCount, error = null) {
  if (!isTracking()) return;

  eventHistory.unshift({
    event,
    args: args.map(serializeArg),
    duration: duration ? `${duration.toFixed(2)}ms` : 'N/A',
    listenerCount,
    timestamp: Date.now(),
    error: error ? error.message : null
  });

  if (eventHistory.length > EVENT_BUS_CONFIG.EVENT_HISTORY_LIMIT) eventHistory.pop();
}

// ==== 5. إدارة المستمعين ====
function dropEvent(name) {
  events.delete(name);
  warnedEvents.delete(name);
  patternCache.delete(name);
}

function removeListener(name, callback) {
  const callbacksMap = events.get(name);
  if (!callbacksMap || !callbacksMap.delete(callback)) return false;

  totalListenersCount--;
  if (callbacksMap.size === 0) dropEvent(name);
  return true;
}

function checkMaxListeners(event, count) {
  if (!EVENT_BUS_CONFIG.WARN_ON_MAX_LISTENERS) return;

  if (count > globalMaxListeners && !warnedEvents.has(event)) {
    warnedEvents.add(event);
    console.warn(`[EventBus] تجاوز الحد الأقصى للمستمعين للحدث "${event}" (${count}/${globalMaxListeners})`);
    EventBus.emit('event-bus:max-listeners-warning', { event, count });
  }

  if (totalListenersCount > EVENT_BUS_CONFIG.MEMORY_LEAK_THRESHOLD && !leakWarned) {
    leakWarned = true;
    console.warn(`[EventBus] إجمالي المستمعين مرتفع (${totalListenersCount}) — استخدم getStats() للفحص`);
  }
}

function collectListeners(event) {
  const collected = [];
  for (const [name, callbacksMap] of events) {
    if (name !== event && !(isPattern(name) && matchesPattern(name, event))) continue;
    for (const [callback, listener] of callbacksMap) {
      collected.push({ name, callback, listener });
    }
  }
  return collected.sort((a, b) => b.listener.priority - a.listener.priority);
}

function invokeListener({ name, callback, listener }, event, args) {
  if (listener.once) removeListener(name, callback);
  const callArgs = isPattern(name) ? [event, ...args] : args;
  return listener.context ? callback.apply(listener.context, callArgs) : callback(...callArgs);
}

// ==== 6. الـ Interceptors ====
function applyInterceptors(event, args) {
  let modifiedArgs = [...args];
  for (const interceptor of interceptors) {
    try {
      const result = interceptor(event, modifiedArgs);
      if (result === CANCEL) return CANCEL;
      if (Array.isArray(result)) modifiedArgs = result;
      else if (result !== undefined) modifiedArgs = [result];
    } catch (error) {
      console.warn('[EventBus] فشل Interceptor:', error);
    }
  }
  return modifiedArgs;
}

// ==== 7. معالجة أخطاء المستمعين ====
function reportListenerError(event, error, args) {
  console.error(`[EventBus] خطأ في معالج الحدث "${event}":`, error);
  addToHistory(event, args, null, 0, error);

  if (isReportingError) return;
  isReportingError = true;
  try {
    if (event !== EVENT_BUS_CONFIG.ERROR_EVENT_NAME) {
      EventBus.emit(EVENT_BUS_CONFIG.ERROR_EVENT_NAME, { event, error, args });
    }
    if (typeof window !== 'undefined') {
      window.ErrorTracker?.capture?.(error, { context: `event-bus:${event}` });
    }
  } catch (trackerError) {
    console.warn('[EventBus] فشل الإبلاغ عن الخطأ:', trackerError);
  } finally {
    isReportingError = false;
  }
}

// ==== 8. الأحداث الثابتة ====
function rememberSticky(event, args) {
  if (stickyEvents.has(event)) stickyStore.set(event, { args, at: Date.now() });
}

function replaySticky(event, callback, context) {
  let cancelled = false;
  const { args } = stickyStore.get(event);

  queueMicrotask(() => {
    if (cancelled) return;
    try {
      const result = context ? callback.apply(context, args) : callback(...args);
      if (result && typeof result.then === 'function') {
        result.then(undefined, (error) => reportListenerError(event, error, args));
      }
    } catch (error) {
      reportListenerError(event, error, args);
    }
  });

  return () => {
    cancelled = true;
  };
}

// ==== 9. تشغيل المستمعين ====
function runListenerAsync(entry, event, finalArgs) {
  try {
    return Promise.resolve(invokeListener(entry, event, finalArgs)).catch((error) => {
      reportListenerError(entry.name, error, finalArgs);
      throw error;
    });
  } catch (error) {
    reportListenerError(entry.name, error, finalArgs);
    return Promise.reject(error);
  }
}

function prepareDispatch(event, args, listeners = null) {
  const finalArgs = applyInterceptors(event, args);
  if (finalArgs === CANCEL) return null;
  rememberSticky(event, finalArgs);
  return { finalArgs, listeners: listeners ?? collectListeners(event) };
}

// ==== 10. طابور الأحداث دون اتصال ====
function scheduleOfflineRetry() {
  clearTimeout(offlineRetryTimer);
  offlineRetryTimer = setTimeout(processOfflineQueue, EVENT_BUS_CONFIG.OFFLINE_RETRY_INTERVAL);
}

async function processOfflineQueue() {
  if (!EVENT_BUS_CONFIG.OFFLINE_QUEUE_ENABLED || !isOnline()) return;
  if (isProcessingOfflineQueue || offlineQueue.length === 0) return;

  isProcessingOfflineQueue = true;
  const pending = offlineQueue;
  offlineQueue = [];

  try {
    for (const item of pending) {
      try {
        await EventBus.emitWithTimeout(item.event, item.timeout, ...item.args);
      } catch (error) {
        if (item.retries < EVENT_BUS_CONFIG.OFFLINE_MAX_RETRIES) {
          offlineQueue.push({ ...item, retries: item.retries + 1 });
        } else {
          console.warn(`[EventBus] تم التخلي عن الحدث "${item.event}" بعد فشل المحاولات`);
          addToHistory(item.event, item.args, null, 0, new Error('انتهت محاولات إعادة الإرسال'));
        }
      }
    }
  } finally {
    isProcessingOfflineQueue = false;
    if (offlineQueue.length > 0) scheduleOfflineRetry();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', processOfflineQueue);
}

// ==== 11. جسر أحداث DOM ====
function bridgeDOMEvent(name) {
  if (typeof document === 'undefined' || domBridgeHandlers.has(name)) return false;

  const handler = (domEvent) => EventBus.emit(name, domEvent.detail);
  document.addEventListener(name, handler);
  domBridgeHandlers.set(name, handler);
  return true;
}

function unbridgeDOMEvent(name) {
  const handler = domBridgeHandlers.get(name);
  if (!handler) return false;

  document.removeEventListener(name, handler);
  domBridgeHandlers.delete(name);
  return true;
}

// ==== 12. الواجهة العامة ====
const EventBus = {
  CANCEL,

  // ==== 13. الإعداد ====
  setDebug(enabled) {
    debugMode = Boolean(enabled);
    storageDebug = readStorageDebugFlag();
  },

  setMaxListeners(limit) {
    if (Number.isInteger(limit) && limit > 0) globalMaxListeners = limit;
  },

  markSticky(event) {
    assertEventName(event);
    stickyEvents.add(event);
  },

  clearSticky(event) {
    if (event) stickyStore.delete(event);
    else stickyStore.clear();
  },

  bridgeDOM(names) {
    const list = Array.isArray(names) ? names : [names];
    return list.map((name) => {
      assertEventName(name);
      return bridgeDOMEvent(name);
    });
  },

  unbridgeDOM(names) {
    const list = Array.isArray(names) ? names : [names];
    return list.map(unbridgeDOMEvent);
  },

  // ==== 14. الاشتراك ====
  on(event, callback, options = {}) {
    assertEventName(event);
    if (typeof callback !== 'function') {
      throw new TypeError('[EventBus] callback يجب أن يكون دالة');
    }

    if (options.once && !isPattern(event) && stickyStore.has(event)) {
      return replaySticky(event, callback, options.context || null);
    }

    let callbacksMap = events.get(event);
    if (!callbacksMap) {
      callbacksMap = new Map();
      events.set(event, callbacksMap);
    }

    if (callbacksMap.has(callback)) {
      console.warn(`[EventBus] callback مسجل مسبقاً للحدث "${event}"`);
      return () => EventBus.off(event, callback);
    }

    callbacksMap.set(callback, {
      priority: options.priority ?? EVENT_BUS_CONFIG.DEFAULT_PRIORITY,
      once: Boolean(options.once),
      context: options.context || null
    });
    totalListenersCount++;
    checkMaxListeners(event, callbacksMap.size);

    return () => EventBus.off(event, callback);
  },

  once(event, callback, options = {}) {
    return EventBus.on(event, callback, { ...options, once: true });
  },

  onAny(callback, options = {}) {
    return EventBus.on('*', callback, options);
  },

  off(event, callback) {
    removeListener(event, callback);
  },

  group() {
    const unsubscribers = new Set();
    const track = (unsubscribe) => {
      unsubscribers.add(unsubscribe);
      return () => {
        unsubscribe();
        unsubscribers.delete(unsubscribe);
      };
    };

    return {
      on: (event, callback, options) => track(EventBus.on(event, callback, options)),
      once: (event, callback, options) => track(EventBus.once(event, callback, options)),
      onAny: (callback, options) => track(EventBus.onAny(callback, options)),
      dispose() {
        unsubscribers.forEach((unsubscribe) => unsubscribe());
        unsubscribers.clear();
      },
      get size() {
        return unsubscribers.size;
      }
    };
  },

  clear(event) {
    if (event) {
      const callbacksMap = events.get(event);
      if (!callbacksMap) return;
      totalListenersCount -= callbacksMap.size;
      dropEvent(event);
      return;
    }
    events.clear();
    warnedEvents.clear();
    patternCache.clear();
    totalListenersCount = 0;
    leakWarned = false;
  },

  clearNamespace(namespace) {
    if (!namespace) return;
    const prefix = namespace.endsWith(':') ? namespace : `${namespace}:`;
    for (const name of [...events.keys()]) {
      if (name === namespace || name.startsWith(prefix)) EventBus.clear(name);
    }
  },

  // ==== 15. الإرسال ====
  emit(event, ...args) {
    assertEventName(event);

    const matched = collectListeners(event);
    if (matched.length === 0 && !stickyEvents.has(event)) return;

    const startTime = isTracking() ? performance.now() : null;
    const prepared = prepareDispatch(event, args, matched);
    if (!prepared) return;

    const { finalArgs, listeners } = prepared;

    for (const entry of listeners) {
      try {
        const result = invokeListener(entry, event, finalArgs);
        if (result && typeof result.then === 'function') {
          result.then(undefined, (error) => reportListenerError(entry.name, error, finalArgs));
        }
      } catch (error) {
        reportListenerError(entry.name, error, finalArgs);
        if (EVENT_BUS_CONFIG.THROW_ON_ERROR) throw error;
      }
    }

    if (startTime !== null) {
      const duration = performance.now() - startTime;
      addToHistory(event, args, duration, listeners.length);
      if (debugMode) {
        console.log(`[EventBus] ${event} | مستمعين: ${listeners.length} | ${duration.toFixed(2)}ms`);
      }
    }
  },

  emitWhenOnline(event, ...args) {
    assertEventName(event);

    if (isOnline() || !EVENT_BUS_CONFIG.OFFLINE_QUEUE_ENABLED) {
      EventBus.emit(event, ...args);
      return true;
    }

    if (offlineQueue.length >= EVENT_BUS_CONFIG.MAX_OFFLINE_QUEUE_SIZE) {
      console.warn(`[EventBus] امتلأ طابور الأحداث، تم تجاهل "${event}"`);
      return false;
    }

    offlineQueue.push({ event, args, timeout: EVENT_BUS_CONFIG.EMIT_TIMEOUT_DEFAULT, retries: 0 });
    return false;
  },

  async emitAsync(event, ...args) {
    assertEventName(event);

    const startTime = performance.now();
    const prepared = prepareDispatch(event, args);
    if (!prepared) return [];

    const { finalArgs, listeners } = prepared;
    const settled = await Promise.allSettled(
      listeners.map((entry) => runListenerAsync(entry, event, finalArgs))
    );
    addToHistory(event, args, performance.now() - startTime, listeners.length);
    return settled;
  },

  async emitWithTimeout(event, timeout = EVENT_BUS_CONFIG.EMIT_TIMEOUT_DEFAULT, ...args) {
    assertEventName(event);

    const startTime = performance.now();
    const prepared = prepareDispatch(event, args);
    if (!prepared) return [];

    const { finalArgs, listeners } = prepared;
    const promises = listeners.map((entry) => runListenerAsync(entry, event, finalArgs));

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`انتهت مهلة الحدث "${event}" بعد ${timeout} مللي ثانية`)),
        timeout
      );
    });

    try {
      const results = await Promise.race([Promise.all(promises), timeoutPromise]);
      addToHistory(event, args, performance.now() - startTime, listeners.length);
      return results;
    } catch (error) {
      addToHistory(event, args, performance.now() - startTime, listeners.length, error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  waitFor(event, timeout = null) {
    return new Promise((resolve, reject) => {
      let timeoutId = null;

      const handler = (...args) => {
        clearTimeout(timeoutId);
        resolve(args.length === 1 ? args[0] : args);
      };

      EventBus.once(event, handler);

      if (timeout !== null && timeout > 0) {
        timeoutId = setTimeout(() => {
          EventBus.off(event, handler);
          reject(new Error(`انتهت مهلة انتظار الحدث "${event}" بعد ${timeout} مللي ثانية`));
        }, timeout);
      }
    });
  },

  // ==== 16. الـ Interceptors ====
  use(interceptor) {
    if (typeof interceptor !== 'function') {
      throw new TypeError('[EventBus] interceptor يجب أن يكون دالة');
    }
    interceptors.push(interceptor);
    return () => {
      const index = interceptors.indexOf(interceptor);
      if (index !== -1) interceptors.splice(index, 1);
    };
  },

  // ==== 17. الاستعلام والمراقبة ====
  listenerCount(event) {
    return events.get(event)?.size || 0;
  },

  eventNames() {
    return [...events.keys()];
  },

  getStats() {
    const eventsDetails = {};
    for (const [name, callbacksMap] of events) {
      eventsDetails[name] = {
        listenersCount: callbacksMap.size,
        priorities: [...callbacksMap.values()].map((listener) => listener.priority)
      };
    }

    return {
      totalEvents: events.size,
      totalListeners: totalListenersCount,
      interceptorsCount: interceptors.length,
      maxListenersConfig: globalMaxListeners,
      offlineQueueSize: offlineQueue.length,
      eventHistorySize: eventHistory.length,
      stickyEvents: [...stickyEvents],
      bridgedDOMEvents: [...domBridgeHandlers.keys()],
      events: eventsDetails
    };
  },

  getEventHistory() {
    return [...eventHistory];
  },

  clearEventHistory() {
    eventHistory = [];
  },

  // ==== 18. التحكم بطابور دون اتصال ====
  processOfflineQueue,

  disableOfflineQueue() {
    EVENT_BUS_CONFIG.OFFLINE_QUEUE_ENABLED = false;
  },

  enableOfflineQueue() {
    EVENT_BUS_CONFIG.OFFLINE_QUEUE_ENABLED = true;
    processOfflineQueue();
  }
};

// ==== 19. التهيئة ====
storageDebug = readStorageDebugFlag();

if (typeof window !== 'undefined') {
  window.EventBus = EventBus;
  EVENT_BUS_CONFIG.DOM_BRIDGE_EVENTS.forEach(bridgeDOMEvent);
  if (window.location?.hostname === 'localhost') EventBus.setDebug(true);
}

// ==== 20. التصدير ====
export { EventBus };
export default EventBus;
