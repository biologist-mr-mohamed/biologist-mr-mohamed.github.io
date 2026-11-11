/* إدارة جلسة المستخدم المشفّرة - v5.0.0 */

// ==== 1. الاستيراد ====
import { EventBus } from './event-bus.js';

// ==== 2. الثوابت والتكوين ====
const SESSION_CONFIG = {
  STORAGE_KEY: 'biologist_session',
  KEY_STORAGE_KEY: 'biologist_key',
  REMEMBER_KEY_STORAGE: 'biologist_remember_key',
  MASTER_KEY_SALT: 'biologist_master_salt_v5',
  ALGORITHM: 'AES-GCM',
  KEY_LENGTH: 256,
  IV_LENGTH: 12,
  REMEMBER_PHONE_KEY: 'biologist_remember_phone',
  SESSION_EXPIRY_DAYS: 7,
  MAX_IDLE_TIME: 30 * 60 * 1000
};

// ==== 3. الحالة الداخلية ====
let $sessionState = {
  currentUser: null,
  refreshTokenCallback: null,
  isInitialized: false,
  lastActivity: Date.now()
};

// ==== 4. دوال التشفير ====

function isCryptoAvailable() {
  return !!(window.crypto && window.crypto.subtle);
}

async function deriveMasterKey() {
  if (!isCryptoAvailable()) {
    throw new Error('Web Crypto API غير متوفر');
  }
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode('biologist_master_secret_' + SESSION_CONFIG.MASTER_KEY_SALT),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(SESSION_CONFIG.MASTER_KEY_SALT),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: SESSION_CONFIG.ALGORITHM, length: SESSION_CONFIG.KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  );
}

async function generateAESKey() {
  if (!isCryptoAvailable()) {
    throw new Error('Web Crypto API غير متوفر');
  }
  return crypto.subtle.generateKey(
    { name: SESSION_CONFIG.ALGORITHM, length: SESSION_CONFIG.KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  );
}

async function encryptWithKey(plaintext, key) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(SESSION_CONFIG.IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: SESSION_CONFIG.ALGORITHM, iv },
    key,
    enc.encode(plaintext)
  );
  return { ciphertext, iv };
}

async function decryptWithKey(encryptedData, key) {
  const decrypted = await crypto.subtle.decrypt(
    { name: SESSION_CONFIG.ALGORITHM, iv: encryptedData.iv },
    key,
    encryptedData.ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function storeSessionKey(key) {
  const exportedKey = await crypto.subtle.exportKey('raw', key);
  sessionStorage.setItem(SESSION_CONFIG.KEY_STORAGE_KEY, arrayBufferToBase64(exportedKey));
}

async function loadSessionKey() {
  const keyBase64 = sessionStorage.getItem(SESSION_CONFIG.KEY_STORAGE_KEY);
  if (!keyBase64) return null;
  try {
    const keyBuffer = base64ToArrayBuffer(keyBase64);
    return crypto.subtle.importKey('raw', keyBuffer, SESSION_CONFIG.ALGORITHM, true, ['encrypt', 'decrypt']);
  } catch {
    return null;
  }
}

async function storeRememberedKey(aesKey) {
  const masterKey = await deriveMasterKey();
  const exportedKey = await crypto.subtle.exportKey('raw', aesKey);
  const keyString = arrayBufferToBase64(exportedKey);
  const { ciphertext, iv } = await encryptWithKey(keyString, masterKey);
  const encryptedKey = {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv)
  };
  localStorage.setItem(SESSION_CONFIG.REMEMBER_KEY_STORAGE, JSON.stringify(encryptedKey));
}

async function loadRememberedKey() {
  const stored = localStorage.getItem(SESSION_CONFIG.REMEMBER_KEY_STORAGE);
  if (!stored) return null;
  try {
    const encryptedKey = JSON.parse(stored);
    const encryptedData = {
      ciphertext: base64ToArrayBuffer(encryptedKey.ciphertext),
      iv: base64ToArrayBuffer(encryptedKey.iv)
    };
    const masterKey = await deriveMasterKey();
    const keyString = await decryptWithKey(encryptedData, masterKey);
    const keyBuffer = base64ToArrayBuffer(keyString);
    return crypto.subtle.importKey('raw', keyBuffer, SESSION_CONFIG.ALGORITHM, true, ['encrypt', 'decrypt']);
  } catch {
    return null;
  }
}

function emitUserStateChanged(detail) {
  EventBus.emit('userStateChanged', detail);
}

// ==== 5. دوال الجلسة الأساسية ====

export async function initializeSession() {
  if ($sessionState.isInitialized) return;

  console.log('🔐 تهيئة نظام الجلسة (v5.0.0)...');
  try {
    if (!isCryptoAvailable()) {
      console.warn('⚠️ Web Crypto API غير متوفر، سيتم استخدام وضع التوافق (غير آمن للإنتاج)');
      initializeFallbackSession();
      return;
    }

    let cryptoKey = await loadSessionKey();
    let usedPersistent = false;
    if (!cryptoKey) {
      cryptoKey = await loadRememberedKey();
      usedPersistent = true;
    }
    if (!cryptoKey) {
      $sessionState.currentUser = null;
      window.$currentUser = null;
      $sessionState.isInitialized = true;
      console.log('🔓 لا توجد جلسة نشطة');
      return;
    }

    const encryptedSession = localStorage.getItem(SESSION_CONFIG.STORAGE_KEY);
    if (!encryptedSession) {
      clearSession();
      $sessionState.isInitialized = true;
      return;
    }

    const sessionData = JSON.parse(encryptedSession);
    const encrypted = {
      ciphertext: base64ToArrayBuffer(sessionData.ciphertext),
      iv: base64ToArrayBuffer(sessionData.iv)
    };
    const decrypted = await decryptWithKey(encrypted, cryptoKey);
    const user = JSON.parse(decrypted);

    if (user.expiresAt && Date.now() > user.expiresAt) {
      console.log('⏰ انتهت صلاحية الجلسة');
      clearSession();
      $sessionState.isInitialized = true;
      return;
    }

    delete user.password;

    if (user?.id) {
      try {
        const { getUserFavorites } = await import('./api.js');
        user.favorites = await getUserFavorites(user.id);
      } catch (e) {
        console.warn('⚠️ تعذر جلب المفضلة من الخادم، سيتم استخدام النسخة المحلية إن وجدت', e);
        user.favorites = Array.isArray(user.favorites) ? user.favorites : [];
      }
    } else {
      user.favorites = Array.isArray(user.favorites) ? user.favorites : [];
    }

    $sessionState.currentUser = user;
    window.$currentUser = user;
    $sessionState.lastActivity = Date.now();

    if (usedPersistent) {
      await storeSessionKey(cryptoKey);
    }

    $sessionState.isInitialized = true;
    console.log(`✅ تم استعادة الجلسة للمستخدم: ${user.full_name || user.username}`);

    emitUserStateChanged({ action: 'login', user: user });

    updateLastActivity();

  } catch (error) {
    console.error('❌ فشل تهيئة الجلسة:', error);
    clearSession();
    $sessionState.isInitialized = true;
    window.$currentUser = null;
  }
}

function initializeFallbackSession() {
  try {
    const stored = localStorage.getItem('biologist_session_fallback');
    if (stored) {
      const user = JSON.parse(stored);
      $sessionState.currentUser = user;
      window.$currentUser = user;
      console.warn('⚠️ استخدام جلسة غير مشفرة (وضع التطوير)');
      emitUserStateChanged({ action: 'login', user });
    }
    $sessionState.isInitialized = true;
  } catch (e) {
    console.error('فشل تهيئة وضع fallback', e);
  }
}

export async function setSession(user, rememberMe = false, favorites = null) {
  if (!user || !user.id) {
    throw new Error('بيانات المستخدم غير صالحة');
  }

  const cleanUser = { ...user };
  delete cleanUser.password;

  cleanUser.favorites = Array.isArray(favorites)
    ? favorites.map(String)
    : (Array.isArray(cleanUser.favorites) ? cleanUser.favorites.map(String) : []);
  if (rememberMe) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + SESSION_CONFIG.SESSION_EXPIRY_DAYS);
    cleanUser.expiresAt = expiry.getTime();
  } else {
    delete cleanUser.expiresAt;
  }

  try {
    if (!isCryptoAvailable()) {
      localStorage.setItem('biologist_session_fallback', JSON.stringify(cleanUser));
      $sessionState.currentUser = cleanUser;
      window.$currentUser = cleanUser;
      console.warn('⚠️ تم حفظ الجلسة بدون تشفير (وضع التطوير)');
      emitUserStateChanged({ action: 'login', user: cleanUser });
      return;
    }

    const aesKey = await generateAESKey();
    
    const jsonUser = JSON.stringify(cleanUser);
    const { ciphertext, iv } = await encryptWithKey(jsonUser, aesKey);
    
    const sessionData = {
      ciphertext: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv)
    };
    localStorage.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(sessionData));

    await storeSessionKey(aesKey);

    if (rememberMe) {
      await storeRememberedKey(aesKey);
    } else {
      localStorage.removeItem(SESSION_CONFIG.REMEMBER_KEY_STORAGE);
    }

    $sessionState.currentUser = cleanUser;
    window.$currentUser = cleanUser;
    $sessionState.lastActivity = Date.now();

    console.log(`🔒 تم إنشاء جلسة للمستخدم: ${cleanUser.full_name || cleanUser.username}`);

    emitUserStateChanged({ action: 'login', user: cleanUser });

  } catch (error) {
    console.error('❌ فشل حفظ الجلسة:', error);
    throw error;
  }
}

export async function updateSessionUser(partial = {}) {
  const current = $sessionState.currentUser;
  if (!current || !current.id) {
    throw new Error('لا توجد جلسة نشطة للتحديث');
  }

  const merged = { ...current, ...partial, id: current.id };
  delete merged.password;
  merged.favorites = Array.isArray(merged.favorites) ? merged.favorites.map(String) : [];

  try {
    if (!isCryptoAvailable()) {
      localStorage.setItem('biologist_session_fallback', JSON.stringify(merged));
    } else {
      const cryptoKey = (await loadSessionKey()) || (await loadRememberedKey());
      if (!cryptoKey) {
        throw new Error('تعذر العثور على مفتاح الجلسة');
      }
      const { ciphertext, iv } = await encryptWithKey(JSON.stringify(merged), cryptoKey);
      localStorage.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify({
        ciphertext: arrayBufferToBase64(ciphertext),
        iv: arrayBufferToBase64(iv)
      }));
    }

    $sessionState.currentUser = merged;
    window.$currentUser = merged;
    $sessionState.lastActivity = Date.now();

    emitUserStateChanged({ action: 'update', user: merged });
    return merged;
  } catch (error) {
    console.error('❌ فشل تحديث بيانات الجلسة:', error);
    throw error;
  }
}

export async function clearSession() {
  localStorage.removeItem(SESSION_CONFIG.STORAGE_KEY);
  localStorage.removeItem(SESSION_CONFIG.REMEMBER_KEY_STORAGE);
  sessionStorage.removeItem(SESSION_CONFIG.KEY_STORAGE_KEY);
  localStorage.removeItem('biologist_session_fallback');

  const previousUser = $sessionState.currentUser;
  $sessionState.currentUser = null;
  window.$currentUser = null;

  if (previousUser) {
    emitUserStateChanged({ action: 'logout' });
  }

  console.log('🚪 تم مسح الجلسة');
}

export function getCurrentUser() {
  if (!$sessionState.currentUser) return null;
  return { favorites: [], ...$sessionState.currentUser };
}

export const getSession = getCurrentUser;

export function isAuthenticated() {
  return !!$sessionState.currentUser;
}

export function isTeacher(user = $sessionState.currentUser) {
  return user && user.user_type === 'teacher';
}

export function isModerator(user = $sessionState.currentUser) {
  return user && user.user_type === 'moderator';
}

export function isStudent(user = $sessionState.currentUser) {
  return user && user.user_type === 'student';
}


export async function updateLastActivity() {
  if (!$sessionState.currentUser) return;
  
  $sessionState.lastActivity = Date.now();
  
  if (window.api && typeof window.api.updateUserActivity === 'function') {
    try {
      await window.api.updateUserActivity($sessionState.currentUser.id);
    } catch (e) {
    }
  }
}

export function setRefreshTokenCallback(callback) {
  if (typeof callback === 'function') {
    $sessionState.refreshTokenCallback = callback;
  }
}

export async function refreshSession() {
  if (!$sessionState.refreshTokenCallback) {
    throw new Error('لم يتم تعيين دالة إنعاش الجلسة');
  }
  const user = await $sessionState.refreshTokenCallback();
  if (user) {
    const rememberMe = localStorage.getItem(SESSION_CONFIG.REMEMBER_KEY_STORAGE) !== null;
    await setSession(user, rememberMe);
  }
  return user;
}

// ==== 6. دوال تذكر رقم الهاتف ====

export function setRememberedPhone(phone) {
  if (phone) {
    localStorage.setItem(SESSION_CONFIG.REMEMBER_PHONE_KEY, phone);
  } else {
    localStorage.removeItem(SESSION_CONFIG.REMEMBER_PHONE_KEY);
  }
}

export function getRememberedPhone() {
  return localStorage.getItem(SESSION_CONFIG.REMEMBER_PHONE_KEY) || '';
}

// ==== 7. التصدير الإضافي ====
export default {
  initialize: initializeSession,
  setSession,
  updateSessionUser,
  clearSession,
  getCurrentUser,
  getSession,
  isAuthenticated,
  isTeacher,
  isModerator,
  isStudent,
  updateLastActivity,
  setRefreshTokenCallback,
  refreshSession,
  setRememberedPhone,
  getRememberedPhone
};

if (typeof window !== 'undefined') {
  window.$session = {
    getCurrentUser,
    isAuthenticated,
    clearSession,
    isTeacher,
    isModerator
  };
}

console.log('✅ [session.js] نظام إدارة الجلسة v5.0.0 جاهز');