/* طبقة API الموحدة للتعامل مع Firestore - v5.0.0 */

// ==== 1. الاستيراد ====
import { initializeFirebase, getFirestoreInstance } from './firebase.js';
import { getCurrentUser, isAuthenticated, isTeacher, isModerator } from './session.js';
import { EventBus } from './event-bus.js';
import {
  collection, query, where, getDocs, getDoc, addDoc,
  updateDoc, deleteDoc, doc, setDoc, orderBy, limit as firestoreLimit,
  serverTimestamp, increment, Timestamp, writeBatch, arrayUnion, arrayRemove,
  runTransaction, startAfter, getCountFromServer, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js";

// ==== 2. الثوابت وأسماء المجموعات ====
const COLLECTIONS = {
  LESSONS: 'Biologist_Lessons',
  QUIZZES: 'Biologist_Quizzes',
  USERS: 'Users',
  EXAM_RESULTS: 'Exam_Results',
  USER_PROGRESS: 'User_Progress',
  COMMENTS: 'biologist_comments',
  NOTIFICATIONS: 'Notifications',
  GROUPS: 'Groups',
  GROUP_MESSAGES: 'Group_Messages',
  UNITS: 'Biologist_Units',
  SEMESTER_SETTINGS:'Semester_Settings',
  COMPLAINTS: 'Complaints',
  ANNOUNCEMENTS: 'Biologist_Announcements'
};

const WEEKDAY_LABELS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const CACHE_TTL = {
  LONG: 10 * 60 * 1000,
  MEDIUM: 2 * 60 * 1000,
  SHORT: 30 * 1000
};

const generateUniqueId = () => {
  return Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 10000);
};

let apiInitialized = false;

// ==== 3. دوال التهيئة والمساعدة ====
async function initializeApi() {
  try {
    await ensureApiInitialized();
    console.log('✅ API layer initialized successfully');
    
    setTimeout(() => {
      updateLegacyUsers().catch(err => console.warn('⚠️ Legacy update skipped:', err));
    }, 3000);
    
    return true;
  } catch (error) {
    console.error('❌ API initialization failed:', error);
    return false;
  }
}

async function ensureApiInitialized() {
  if (!apiInitialized) {
    await initializeFirebase();
    apiInitialized = true;
  }
}

function getDb() {
  return getFirestoreInstance();
}

function safeParseInt(value, defaultValue = 0) {
  if (value === undefined || value === null) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function normalizeStageValue(stage) {
  const stageMap = { preparatory: 'إعدادي', secondary: 'ثانوي' };
  return stageMap[stage] || stage || null;
}

function normalizeSemesterValue(semester) {
  const semesterMap = { first: 'أول', second: 'ثاني' };
  return semesterMap[semester] || semester || null;
}

function translateUserType(type) {
  const map = {
    student: 'طالب',
    teacher: 'معلم',
    moderator: 'مشرف'
  };
  return map[type] || 'طالب';
}


// ==== 4. دوال التشفير ====
const SALT = 'biologist_salt_2024';

async function hashPassword(password) {
  try {
    if (!window.crypto?.subtle) {
      console.warn("⚠️ crypto.subtle غير متوفر — fallback");
      return btoa(password + SALT);
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(password + SALT);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) {
    console.warn("⚠️ hashing failed — fallback");
    return btoa(password + SALT);
  }
}


function isHashedPassword(str) {
  return typeof str === 'string' && /^[a-f0-9]{64}$/i.test(str);
}

// ==== 5. ثوابت وصلاحيات التعليقات ====
const COMMENT_EDIT_WINDOW_MIN = 5;
const COMMENT_MAX_LENGTH = 500;

function toCommentDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  if (ts.seconds) return new Date(ts.seconds * 1000);
  const d = new Date(ts);
  return isNaN(d) ? null : d;
}

// التعديل لصاحب التعليق فقط خلال المهلة؛ المعلم والمشرف يحذفان أو يثبّتان فقط
function canEditComment(comment, userId) {
  if (!comment || !userId) return false;
  if (comment.is_deleted) return false;
  if (String(comment.user_id) !== String(userId)) return false;
  const createdAt = toCommentDate(comment.created_at || comment.date);
  if (!createdAt) return false;
  const diffMinutes = (Date.now() - createdAt.getTime()) / 60000;
  return diffMinutes <= COMMENT_EDIT_WINDOW_MIN;
}

function requireCommentUser() {
  const user = getCurrentUser();
  if (!user || !user.id) throw new Error('يجب تسجيل الدخول');
  return user;
}

function isCommentStaff(user) {
  return !!user && (isTeacher(user) || isModerator(user));
}

async function findCommentDocById(db, commentId) {
  const snap = await getDocs(
    query(collection(db, COLLECTIONS.COMMENTS), where('id', '==', safeParseInt(commentId)))
  );
  if (snap.empty) throw new Error('التعليق غير موجود');
  return snap.docs[0];
}


// ==== 6. دوال المستخدمين ====
async function loginUser(phone, password) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const hashedInput = await hashPassword(password);

    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(usersRef, where('phone', '==', phone));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      throw new Error('رقم الهاتف غير مسجل');
    }

    const userDoc = querySnapshot.docs[0];
    const userData = userDoc.data();
    const storedPassword = userData.password;

    let passwordMatch = storedPassword === hashedInput;

    if (!passwordMatch && storedPassword === password) {
      await updateDoc(userDoc.ref, { password: hashedInput });
      console.log(`🔐 Password upgraded for user ID: ${userData.id}`);
      passwordMatch = true;
    }

    if (!passwordMatch) {
      throw new Error('كلمة المرور غير صحيحة');
    }

    await updateDoc(userDoc.ref, {
      last_login: serverTimestamp(),
      last_activity: serverTimestamp()
    });

    return {
      id: userData.id,
      docId: userDoc.id,
      username: userData.username,
      full_name: userData.full_name,
      user_type: userData.user_type || 'student',
      gender: userData.gender,
      age: userData.age || 0,
      phone: userData.phone,
      last_login: userData.last_login,
      last_activity: userData.last_activity,
      total_score: userData.total_score || 0,
      likes_given: userData.likes_given || 0,
      comments_count: userData.comments_count || 0,
      email: userData.email || '',
      stage: userData.stage || '',
      grade: userData.grade || '',
      avatar_url: userData.avatar_url || '',
      avatar_job_index: userData.avatar_job_index ?? -1,
      preferred_theme: userData.preferred_theme || 'light',
      preferred_color_theme: userData.preferred_color_theme || '',
      badges: userData.badges || [],
      favorites: userData.favorites || [],
      is_verified: userData.is_verified || false
    };
  } catch (error) {
    console.error('❌ Login failed:', error.message);
    throw error;
  }
}

async function registerUser(userData) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const phoneExists = await checkPhoneExists(userData.phone);
    if (phoneExists) {
      throw new Error('رقم الهاتف مسجل بالفعل');
    }

    const hashedPassword = await hashPassword(userData.password);

    const newUser = {
      id: generateUniqueId(),
      username: `user_${Date.now()}`,
      full_name: `${userData.firstName || ''} ${userData.lastName || ''}`.trim(),
      user_type: userData.user_type || 'student',
      gender: userData.gender,
      age: safeParseInt(userData.age, 0),
      phone: userData.phone,
      password: hashedPassword,
      created_at: serverTimestamp(),
      last_login: serverTimestamp(),
      last_activity: serverTimestamp(),
      total_score: 0,
      likes_given: 0,
      comments_count: 0,
      badges: [],
      favorites: [],
      avatar_url: '',
      avatar_job_index: 0,
      streak: 0,
      preferred_theme: 'light',
      is_verified: false
    };

    const usersRef = collection(db, COLLECTIONS.USERS);
    await addDoc(usersRef, newUser);

    console.log(`✅ User registered with ID: ${newUser.id}`);
    return newUser.id;
  } catch (error) {
    console.error('❌ Registration failed:', error.message);
    throw error;
  }
}

async function checkPhoneExists(phone) {
  await ensureApiInitialized();
  const db = getDb();
  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('phone', '==', phone));
  const querySnapshot = await getDocs(q);
  return !querySnapshot.empty;
}

async function updateUserPreferences(userId, preferences) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(usersRef, where('id', '==', safeParseInt(userId)));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      throw new Error('المستخدم غير موجود');
    }

    const viewer = getCurrentUser();
    if (viewer && String(viewer.id) !== String(userId) && !isCommentStaff(viewer)) {
      throw new Error('غير مصرّح بتعديل هذا الحساب');
    }

    const docRef = querySnapshot.docs[0].ref;
    const allowedFields = ['preferred_theme', 'preferred_color_theme', 'avatar_url', 'favorites', 'badges', 'avatar_job_index'];
    const updates = { last_activity: serverTimestamp() };

    Object.keys(preferences).forEach(key => {
      if (allowedFields.includes(key)) {
        updates[key] = preferences[key];
      }
    });

    await updateDoc(docRef, updates);
    invalidateProfileCache(userId);
    return true;
  } catch (error) {
    console.error('❌ Failed to update user preferences:', error.message);
    throw error;
  }
}
async function getUserFavorites(userId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(usersRef, where('id', '==', safeParseInt(userId)));
    const querySnapshot = await getDocs(q);
    if (querySnapshot.empty) return [];

    const data = querySnapshot.docs[0].data();
    return Array.isArray(data.favorites) ? data.favorites.map(String) : [];
  } catch (error) {
    console.error('❌ Failed to get user favorites:', error.message);
    return [];
  }
}

async function syncUserFavorites(userId, favoritesArray) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(usersRef, where('id', '==', safeParseInt(userId)));
    const querySnapshot = await getDocs(q);
    if (querySnapshot.empty) throw new Error('المستخدم غير موجود');

    const docRef = querySnapshot.docs[0].ref;
    const cleanFavorites = Array.isArray(favoritesArray) ? favoritesArray.map(String) : [];

    await updateDoc(docRef, {
      favorites: cleanFavorites,
      last_activity: serverTimestamp()
    });

    return cleanFavorites;
  } catch (error) {
    console.error('❌ Failed to sync user favorites:', error.message);
    throw error;
  }
}
async function updateUserLikesGiven(userId, incrementBy = 1) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(usersRef, where('id', '==', safeParseInt(userId)));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      throw new Error('المستخدم غير موجود');
    }

    const docRef = querySnapshot.docs[0].ref;
    await updateDoc(docRef, {
      likes_given: increment(incrementBy),
      last_activity: serverTimestamp()
    });
    return true;
  } catch (error) {
    console.error('❌ Failed to update user likes count:', error.message);
    throw error;
  }
}

async function incrementUserCommentsCount(userId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(usersRef, where('id', '==', safeParseInt(userId)));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      throw new Error('المستخدم غير موجود');
    }

    const docRef = querySnapshot.docs[0].ref;
    await updateDoc(docRef, {
      comments_count: increment(1),
      last_activity: serverTimestamp()
    });
    return true;
  } catch (error) {
    console.error('❌ Failed to increment user comments count:', error.message);
    throw error;
  }
}

 
async function getUserById(userId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(usersRef, where('id', '==', safeParseInt(userId)));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) return null;

    const userDoc = querySnapshot.docs[0];
    const userData = userDoc.data();

    return {
      id: userData.id,
      docId: userDoc.id,
      username: userData.username,
      full_name: userData.full_name,
      user_type: userData.user_type,
      gender: userData.gender,
      age: userData.age || 0,
      phone: userData.phone,
      email: userData.email || '',
      stage: userData.stage || '',
      grade: userData.grade || '',
      avatar_url: userData.avatar_url || '',
      avatar_job_index: userData.avatar_job_index ?? -1,
      preferred_theme: userData.preferred_theme || 'light',
      preferred_color_theme: userData.preferred_color_theme || '',
      total_score: userData.total_score || 0,
      likes_given: userData.likes_given || 0,
      comments_count: userData.comments_count || 0,
      streak: userData.streak || 0,
      badges: userData.badges || [],
      favorites: userData.favorites || [],
      is_verified: userData.is_verified || false,
      created_at: userData.created_at,
      last_login: userData.last_login,
      last_activity: userData.last_activity
    };
  } catch (error) {
    console.error('❌ Failed to get user:', error.message);
    throw error;
  }
}

async function updateUserProfile(userId, profileData) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(usersRef, where('id', '==', safeParseInt(userId)));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      throw new Error('المستخدم غير موجود');
    }

    const docRef = querySnapshot.docs[0].ref;
    const updates = { last_activity: serverTimestamp() };

    if (profileData.full_name !== undefined) updates.full_name = profileData.full_name;
    if (profileData.age !== undefined) updates.age = safeParseInt(profileData.age, 0);
    if (profileData.gender !== undefined) updates.gender = profileData.gender;
    if (profileData.user_type !== undefined) updates.user_type = profileData.user_type;
    if (profileData.avatar_url !== undefined) updates.avatar_url = profileData.avatar_url;
    if (profileData.avatar_job_index !== undefined) updates.avatar_job_index = profileData.avatar_job_index;
    if (profileData.preferred_theme !== undefined) updates.preferred_theme = profileData.preferred_theme;
    if (profileData.email !== undefined) updates.email = profileData.email;
    if (profileData.stage !== undefined) updates.stage = profileData.stage;
    if (profileData.grade !== undefined) updates.grade = safeParseInt(profileData.grade);

    await updateDoc(docRef, updates);
    invalidateProfileCache(userId);
    return true;
  } catch (error) {
    console.error('❌ Failed to update user profile:', error.message);
    throw error;
  }
}

async function updateLegacyUsers() {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const snapshot = await getDocs(usersRef);
    const batch = writeBatch(db);
    let updatedCount = 0;

    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const updates = {};

      if (data.comments_count === undefined) updates.comments_count = 0;
      if (data.likes_given === undefined) updates.likes_given = 0;
      if (data.badges === undefined) updates.badges = [];
      if (data.favorites === undefined) updates.favorites = [];
      if (data.avatar_url === undefined) updates.avatar_url = '';
      if (data.preferred_theme === undefined) updates.preferred_theme = 'light';
      if (data.is_verified === undefined) updates.is_verified = false;
      if (data.created_at === undefined) updates.created_at = serverTimestamp();

      if (data.password && !isHashedPassword(data.password)) {
        console.warn(`⚠️ Legacy plain password detected for user ${data.id}, skipping auto-upgrade.`);
      }

      if (Object.keys(updates).length > 0) {
        batch.update(docSnap.ref, updates);
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      await batch.commit();
      console.log(`✅ Updated ${updatedCount} legacy users`);
    }
    return updatedCount;
  } catch (error) {
    console.error('❌ Failed to update legacy users:', error.message);
    throw error;
  }
}

// ==== 7. دوال إجمالي النقاط ====
async function recalculateUserTotalScore(userId) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedUserId = safeParseInt(userId);

  try {
    const progressRef = collection(db, COLLECTIONS.USER_PROGRESS);
    const q = query(progressRef, where('user_id', '==', parsedUserId));
    const snapshot = await getDocs(q);

    let total = 0;
    snapshot.forEach(doc => {
      const data = doc.data();
      total += data.exam_score || 0;
    });

    const usersRef = collection(db, COLLECTIONS.USERS);
    const userQuery = query(usersRef, where('id', '==', parsedUserId));
    const userSnap = await getDocs(userQuery);
    if (!userSnap.empty) {
      const userRef = userSnap.docs[0].ref;
      await updateDoc(userRef, {
        total_score: total,
        last_activity: serverTimestamp()
      });
      console.log(`✅ Recalculated total_score for user ${parsedUserId}: ${total}`);
    }
    invalidateProfileCache(parsedUserId);

    return total;
  } catch (error) {
    console.error('❌ Failed to recalculate total_score:', error.message);
    throw error;
  }
}

// ==== 8. دوال الدروس ====
async function getAllLessons(options = {}) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const {
      stage,
      grade,
      semester,
      limit = 20,
      startAfterDoc,
      startAfterCreatedAt,
      lastId
    } = options;

    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    let constraints = [];

    // المجموعة مشتركة مع الامتحانات المرتبطة (type: 'lesson_exam') فيجب استبعادها
    constraints.push(where('type', '==', 'lesson'));

    const normalizedStage = normalizeStageValue(stage);
    if (normalizedStage) {
      constraints.push(where('stage', '==', normalizedStage));
    }

    if (grade !== undefined) {
      constraints.push(where('grade', '==', safeParseInt(grade)));
    }

    const normalizedSemester = normalizeSemesterValue(semester);
    if (normalizedSemester) {
      constraints.push(where('semester', '==', normalizedSemester));
    }

    constraints.push(orderBy('created_at', 'desc'));
    constraints.push(orderBy('id', 'desc'));

if (startAfterDoc) {
  constraints.push(startAfter(startAfterDoc));
} else if (startAfterCreatedAt && lastId !== undefined && lastId !== null) {
  constraints.push(startAfter(startAfterCreatedAt, safeParseInt(lastId)));
}

    constraints.push(firestoreLimit(limit));

    const q = query(lessonsRef, ...constraints);
    const querySnapshot = await getDocs(q);
    const lessons = [];

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      lessons.push({
        docId: doc.id,
        id: data.id,
        stage: data.stage,
        semester: data.semester,
        grade: data.grade,
        unit_id: data.unit_id ?? null,
        title: data.title,
        description: data.description,
        video_url: data.video_url,
        pdf_url: data.pdf_url,
        cover_image_url: data.cover_image_url || '',
        duration: data.duration || 0,
        likes: data.likes || 0,
        liked_by: data.liked_by || [],
        average_rating: data.average_rating || 0,
        ratings_count: Array.isArray(data.ratings) ? data.ratings.length : (data.ratings_count || 0),
        created_at: data.created_at,
        updated_at: data.updated_at
      });
    });

    return lessons;
  } catch (error) {
    console.error('❌ Failed to get lessons:', error.message);
    throw error;
  }
}
async function getLessonsCount(options = {}) {
  await ensureApiInitialized();
  const db = getDb();
  
  try {
    const { stage, grade, semester } = options;
    const constraints = [where('type', '==', 'lesson'), where('deleted_at', '==', null)];
    
    if (stage) constraints.push(where('stage', '==', stage));
    if (grade !== undefined) constraints.push(where('grade', '==', safeParseInt(grade)));
    if (semester) constraints.push(where('semester', '==', semester));
    
    // البحث والتصنيف يعتمدان على بيانات المستخدم فلا يُفلتران على مستوى العد
    
    const q = query(collection(db, COLLECTIONS.LESSONS), ...constraints);
    const snapshot = await getDocs(q);
    return snapshot.size;
  } catch (error) {
    console.error('❌ Failed to get lessons count:', error.message);
    return 0;
  }
}
// يتطلب فهارس مركّبة في Firestore عند أول تشغيل
async function searchLessons(searchText, options = {}) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const { stage, grade, semester, unitId, limit = 20 } = options;
    const text = (searchText || '').trim();
    if (!text) return [];

    const baseConstraints = [where('type', '==', 'lesson')];
    const normalizedStage = normalizeStageValue(stage);
    const normalizedSemester = normalizeSemesterValue(semester);
    if (normalizedStage) baseConstraints.push(where('stage', '==', normalizedStage));
    if (grade !== undefined) baseConstraints.push(where('grade', '==', safeParseInt(grade)));
    if (normalizedSemester) baseConstraints.push(where('semester', '==', normalizedSemester));
    if (unitId !== undefined && unitId !== null) baseConstraints.push(where('unit_id', '==', safeParseInt(unitId)));

    const lessonsRef = collection(db, COLLECTIONS.LESSONS);

    const titleQuery = query(
      lessonsRef, ...baseConstraints,
      where('title', '>=', text), where('title', '<=', text + '\uf8ff'),
      firestoreLimit(limit)
    );
    const descQuery = query(
      lessonsRef, ...baseConstraints,
      where('description', '>=', text), where('description', '<=', text + '\uf8ff'),
      firestoreLimit(limit)
    );

    const [titleSnap, descSnap] = await Promise.all([
      getDocs(titleQuery).catch(() => ({ docs: [] })),
      getDocs(descQuery).catch(() => ({ docs: [] }))
    ]);

    const map = new Map();
    [...titleSnap.docs, ...descSnap.docs].forEach(docSnap => {
      const data = docSnap.data();
      if (!map.has(data.id)) {
        map.set(data.id, {
          docId: docSnap.id,
          id: data.id,
          stage: data.stage,
          semester: data.semester,
          grade: data.grade,
          unit_id: data.unit_id,
          title: data.title,
          description: data.description,
          video_url: data.video_url,
          pdf_url: data.pdf_url,
          cover_image_url: data.cover_image_url || '',
          duration: data.duration || 0,
          likes: data.likes || 0,
          liked_by: data.liked_by || [],
          average_rating: data.average_rating || 0,
          ratings_count: Array.isArray(data.ratings) ? data.ratings.length : 0,
          created_at: data.created_at,
          updated_at: data.updated_at
        });
      }
    });

    return Array.from(map.values())
      .sort((a, b) => (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0))
      .slice(0, limit);
  } catch (error) {
    console.error('❌ Failed to search lessons:', error.message);
    return [];
  }
}

async function getLessonById(lessonId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(lessonsRef, where('id', '==', safeParseInt(lessonId)));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) return null;

    const docSnap = querySnapshot.docs[0];
    const data = docSnap.data();

    return {
      docId: docSnap.id,
      id: data.id,
      stage: data.stage,
      semester: data.semester,
      grade: data.grade,
      unit_id: data.unit_id ?? null,
      title: data.title,
      description: data.description,
      video_url: data.video_url,
      pdf_url: data.pdf_url,
      cover_image_url: data.cover_image_url || '',
      duration: data.duration || 0,
      likes: data.likes || 0,
      liked_by: data.liked_by || [],
      average_rating: data.average_rating || 0,
      ratings_count: Array.isArray(data.ratings) ? data.ratings.length : (data.ratings_count || 0),
      ratings: data.ratings || [],
      created_at: data.created_at,
      
      
      updated_at: data.updated_at
    };
  } catch (error) {
    console.error('❌ Failed to get lesson:', error.message);
    throw error;
  }
}

async function getLessonsByIds(lessonIds) {
  await ensureApiInitialized();
  const db = getDb();

  const ids = [...new Set((Array.isArray(lessonIds) ? lessonIds : [])
    .map((id) => safeParseInt(id, NaN))
    .filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return [];

  try {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));

    const snapshots = await Promise.all(
      chunks.map((chunk) => getDocs(query(lessonsRef, where('id', 'in', chunk))))
    );

    const lessons = [];
    snapshots.forEach((snapshot) => {
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if ((data.type ?? 'lesson') !== 'lesson' || data.deleted_at) return;
        lessons.push({
          docId: docSnap.id,
          id: data.id,
          stage: data.stage,
          semester: data.semester,
          grade: data.grade,
          unit_id: data.unit_id ?? null,
          title: data.title,
          description: data.description,
          video_url: data.video_url,
          pdf_url: data.pdf_url,
          cover_image_url: data.cover_image_url || '',
          duration: data.duration || 0,
          likes: data.likes || 0,
          average_rating: data.average_rating || 0,
          created_at: data.created_at,
          updated_at: data.updated_at
        });
      });
    });
    return lessons;
  } catch (error) {
    console.error('❌ Failed to get lessons by ids:', error.message);
    throw error;
  }
}

async function toggleLessonLike(lessonId, userId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const parsedLessonId = safeParseInt(lessonId);
    const parsedUserId = safeParseInt(userId);

    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const lessonQuery = query(lessonsRef, where('id', '==', parsedLessonId));
    const lessonSnap = await getDocs(lessonQuery);
    if (lessonSnap.empty) throw new Error('الدرس غير موجود');
    const lessonRef = lessonSnap.docs[0].ref;

    const usersRef = collection(db, COLLECTIONS.USERS);
    const userQuery = query(usersRef, where('id', '==', parsedUserId));
    const userSnap = await getDocs(userQuery);
    if (userSnap.empty) throw new Error('المستخدم غير موجود');
    const userRef = userSnap.docs[0].ref;

    await runTransaction(db, async (transaction) => {
      const lessonDoc = await transaction.get(lessonRef);
      if (!lessonDoc.exists) throw new Error('الدرس غير موجود');

      const currentLikedBy = lessonDoc.data().liked_by || [];
      const alreadyLiked = currentLikedBy.includes(parsedUserId);

      if (alreadyLiked) {
        transaction.update(lessonRef, {
          liked_by: arrayRemove(parsedUserId),
          likes: increment(-1)
        });
        transaction.update(userRef, {
          likes_given: increment(-1),
          last_activity: serverTimestamp()
        });
      } else {
        transaction.update(lessonRef, {
          liked_by: arrayUnion(parsedUserId),
          likes: increment(1)
        });
        transaction.update(userRef, {
          likes_given: increment(1),
          last_activity: serverTimestamp()
        });
      }
    });

    return true;
  } catch (error) {
    console.error('❌ Failed to toggle lesson like:', error.message);
    throw error;
  }
}

async function rateLesson(lessonId, userId, rating) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedLessonId = safeParseInt(lessonId);
  const parsedUserId = safeParseInt(userId);
  const parsedRating = Math.min(5, Math.max(1, safeParseInt(rating, 0)));

  try {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(lessonsRef, where('id', '==', parsedLessonId), where('type', '==', 'lesson'));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('الدرس غير موجود');

    const docRef = snapshot.docs[0].ref;
    const data = snapshot.docs[0].data();
    const ratings = Array.isArray(data.ratings) ? [...data.ratings] : [];

    const existingIndex = ratings.findIndex(r => safeParseInt(r.userId) === parsedUserId);
    const newEntry = { userId: parsedUserId, rating: parsedRating, timestamp: Timestamp.now() };

    if (existingIndex > -1) {
      ratings[existingIndex] = newEntry;
    } else {
      ratings.push(newEntry);
    }

    const averageRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;

    await updateDoc(docRef, {
      ratings,
      average_rating: parseFloat(averageRating.toFixed(2)),
      ratings_count: ratings.length,
      updated_at: serverTimestamp()
    });

    return {
      average_rating: parseFloat(averageRating.toFixed(2)),
      ratings_count: ratings.length
    };
  } catch (error) {
    console.error('❌ Failed to rate lesson:', error.message);
    throw error;
  }
}

// ==== 9. دوال الامتحانات ====
async function getExamById(examId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const quizzesRef = collection(db, COLLECTIONS.QUIZZES);
    const q = query(quizzesRef, where('exam_id', '==', safeParseInt(examId)));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) return null;

    const questions = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      questions.push({
        docId: doc.id,
        id: data.id,
        lesson_id: data.lesson_id,
        question: data.question,
        option_a: data.option_a,
        option_b: data.option_b,
        option_c: data.option_c,
        option_d: data.option_d,
        correct: data.correct,
        exam_id: data.exam_id,
        difficulty_level: data.difficulty_level || 'Easy',
        question_type: data.question_type || 'MCQ'
      });
    });

    return {
      exam_id: safeParseInt(examId),
      questions,
      total_questions: questions.length
    };
  } catch (error) {
    console.error('❌ Failed to get exam:', error.message);
    throw error;
  }
}

async function saveExamResult(userId, examResult) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const resultsRef = collection(db, COLLECTIONS.EXAM_RESULTS);
    const total = safeParseInt(examResult.totalQuestions, 0);
    const correct = safeParseInt(examResult.correctAnswers, 0);
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    const resultData = {
      id: generateUniqueId(),
      user_id: safeParseInt(userId),
      exam_id: safeParseInt(examResult.examId),
      score: safeParseInt(examResult.score, 0),
      total_questions: total,
      correct_answers: correct,
      time_taken: safeParseInt(examResult.timeTaken, 0),
      passed: examResult.passed || false,
      accuracy: parseFloat(accuracy.toFixed(2)),
      date: serverTimestamp(),
      feedback: examResult.feedback || ''
    };

    await addDoc(resultsRef, resultData);
    await recalculateUserTotalScore(userId);
    console.log(`✅ Exam result saved with ID: ${resultData.id}`);
    return resultData.id;
  } catch (error) {
    console.error('❌ Failed to save exam result:', error.message);
    throw error;
  }
}

// ==== 10. دوال تقدم المستخدم ====
async function updateUserProgress(userId, lessonId, progress, totalTimeSpent = null) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const parsedUserId = safeParseInt(userId);
    const parsedLessonId = safeParseInt(lessonId);
    const parsedProgress = Math.min(100, Math.max(0, safeParseInt(progress, 0)));
    const parsedTotalTime = totalTimeSpent !== null ? safeParseInt(totalTimeSpent, 0) : null;

    const progressRef = collection(db, COLLECTIONS.USER_PROGRESS);
    const q = query(
      progressRef,
      where('user_id', '==', parsedUserId),
      where('lesson_id', '==', parsedLessonId)
    );

    const querySnapshot = await getDocs(q);
    
    const updateData = {
      progress: parsedProgress,
      completed: parsedProgress >= 100,
      last_accessed: serverTimestamp()
    };
    if (parsedTotalTime !== null) {
      updateData.total_time_spent = parsedTotalTime;
    }

    if (querySnapshot.empty) {
      await addDoc(progressRef, {
        id: generateUniqueId(),
        user_id: parsedUserId,
        lesson_id: parsedLessonId,
        progress: parsedProgress,
        completed: parsedProgress >= 100,
        last_accessed: serverTimestamp(),
        exam_score: 0,
        total_time_spent: parsedTotalTime !== null ? parsedTotalTime : 0,
        exam_date: null
      });
    } else {
      const docRef = querySnapshot.docs[0].ref;
      await updateDoc(docRef, updateData);
    }

    console.log('✅ User progress updated');
    invalidateProfileCache(parsedUserId);
    return true;
  } catch (error) {
    console.error('❌ Failed to update progress:', error.message);
    throw error;
  }
}

async function updateUserExamScore(userId, lessonId, score) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const parsedUserId = safeParseInt(userId);
    const parsedLessonId = safeParseInt(lessonId);
    const parsedScore = safeParseInt(score, 0);

    const progressRef = collection(db, COLLECTIONS.USER_PROGRESS);
    const q = query(
      progressRef,
      where('user_id', '==', parsedUserId),
      where('lesson_id', '==', parsedLessonId)
    );

    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      await addDoc(progressRef, {
        id: generateUniqueId(),
        user_id: parsedUserId,
        lesson_id: parsedLessonId,
        progress: 0,
        completed: false,
        last_accessed: serverTimestamp(),
        exam_score: parsedScore,
        total_time_spent: 0,
        exam_date: serverTimestamp()
      });
    } else {
      const docRef = querySnapshot.docs[0].ref;
      await updateDoc(docRef, {
        exam_score: parsedScore,
        last_accessed: serverTimestamp(),
        exam_date: serverTimestamp()
      });
    }

    await recalculateUserTotalScore(parsedUserId);

    return true;
  } catch (error) {
    console.error('❌ Failed to update exam score:', error.message);
    throw error;
  }
}

async function getUserProgress(userId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const progressRef = collection(db, COLLECTIONS.USER_PROGRESS);
    const q = query(progressRef, where('user_id', '==', safeParseInt(userId)));
    const querySnapshot = await getDocs(q);

    const progress = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      progress.push({
        docId: doc.id,
        id: data.id,
        user_id: data.user_id,
        lesson_id: data.lesson_id,
        progress: data.progress || 0,
        completed: data.completed || false,
        last_accessed: data.last_accessed,
        exam_score: data.exam_score || 0,
        total_time_spent: data.total_time_spent || 0,
        exam_date: data.exam_date || null
      });
    });
    return progress;
  } catch (error) {
    console.error('❌ Failed to get user progress:', error.message);
    throw error;
  }
}

// ==== 11. إدارة الامتحانات ====

async function createExam(examData, questions) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const examId = generateUniqueId();
    const batch = writeBatch(db);

    // الامتحان ذو unit_id صريح يخص وحدة، وما عداه شامل
    const examScope = examData.exam_scope === 'unit' ? 'unit' : 'comprehensive';
    const examUnitId = (examScope === 'unit' && examData.unit_id) ? safeParseInt(examData.unit_id) : null;

    const examMeta = {
      id: examId,
      type: 'exam',
      lesson_id: examData.lesson_id ? safeParseInt(examData.lesson_id) : null,
      exam_scope: examScope,
      unit_id: examUnitId,
      stage: examData.stage,
      grade: safeParseInt(examData.grade),
      semester: examData.semester,
      title: examData.title,
      description: examData.description || '',
      duration: safeParseInt(examData.duration, 30),
      questions_count: questions.length,
      is_challenge: examData.is_challenge || false,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      order: examData.order || 0,
      cover_image_url: examData.cover_image_url || '',
      deleted_at: null
    };
    
    const examsRef = collection(db, COLLECTIONS.LESSONS);
    const examDocRef = doc(examsRef);
    batch.set(examDocRef, examMeta);
    
    const quizzesRef = collection(db, COLLECTIONS.QUIZZES);
    questions.forEach((q, index) => {
      const questionData = {
        id: generateUniqueId() + index,
        exam_id: examId,
        question: q.text,
        question_type: q.type,
        difficulty_level: q.difficulty || 'easy',
        image_url: q.image || '',
        created_at: serverTimestamp()
      };
      
      if (q.type === 'multiple_choice') {
        questionData.option_a = q.options[0] || '';
        questionData.option_b = q.options[1] || '';
        questionData.option_c = q.options[2] || '';
        questionData.option_d = q.options[3] || '';
        questionData.correct = String.fromCharCode(97 + q.correct);
      } else if (q.type === 'true_false') {
        questionData.correct = q.correct ? 'true' : 'false';
      }
      
      const qDocRef = doc(quizzesRef);
      batch.set(qDocRef, questionData);
    });
    
    await batch.commit();

    if (examUnitId) {
      try {
        await incrementUnitExamsCount(examUnitId, 1);
      } catch (countError) {
        console.error('⚠️ فشل تحديث عداد امتحانات الوحدة (لن يمنع نجاح الإنشاء):', countError.message);
      }
    }

    console.log(`✅ Exam created with ID: ${examId}`);
    return examId;
  } catch (error) {
    console.error('❌ Failed to create exam:', error.message);
    throw error;
  }
}

async function updateExam(examId, examData, questions) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedExamId = safeParseInt(examId);

  try {
    const batch = writeBatch(db);
    
    const examsRef = collection(db, COLLECTIONS.LESSONS);
    const examQuery = query(examsRef, where('id', '==', parsedExamId), where('type', '==', 'exam'));
    const examSnapshot = await getDocs(examQuery);
    
    if (examSnapshot.empty) throw new Error('الامتحان غير موجود');
    
    const examDoc = examSnapshot.docs[0];
    const examRef = examDoc.ref;
    const oldUnitId = examDoc.data().unit_id ?? null;

    const examScope = examData.exam_scope === 'unit' ? 'unit' : 'comprehensive';
    const newUnitId = (examScope === 'unit' && examData.unit_id) ? safeParseInt(examData.unit_id) : null;

    const updates = {
      title: examData.title,
      exam_scope: examScope,
      unit_id: newUnitId,
      stage: examData.stage,
      grade: safeParseInt(examData.grade),
      semester: examData.semester,
      duration: safeParseInt(examData.duration),
      description: examData.description || '',
      is_challenge: examData.is_challenge || false,
      questions_count: questions.length,
      updated_at: serverTimestamp()
    };
    if (examData.cover_image_url !== undefined) updates.cover_image_url = examData.cover_image_url;
    
    batch.update(examRef, updates);
    
    const quizzesRef = collection(db, COLLECTIONS.QUIZZES);
    const oldQuestionsQuery = query(quizzesRef, where('exam_id', '==', parsedExamId));
    const oldQuestionsSnapshot = await getDocs(oldQuestionsQuery);
    oldQuestionsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    
    questions.forEach((q, index) => {
      const questionData = {
        id: generateUniqueId() + index,
        exam_id: parsedExamId,
        question: q.text,
        question_type: q.type,
        difficulty_level: q.difficulty || 'easy',
        image_url: q.image || '',
        created_at: serverTimestamp()
      };
      
      if (q.type === 'multiple_choice') {
        questionData.option_a = q.options[0] || '';
        questionData.option_b = q.options[1] || '';
        questionData.option_c = q.options[2] || '';
        questionData.option_d = q.options[3] || '';
        questionData.correct = String.fromCharCode(97 + q.correct);
      } else if (q.type === 'true_false') {
        questionData.correct = q.correct ? 'true' : 'false';
      }
      
      const qDocRef = doc(quizzesRef);
      batch.set(qDocRef, questionData);
    });
    
    await batch.commit();

    if (oldUnitId !== newUnitId) {
      try {
        if (oldUnitId) await incrementUnitExamsCount(oldUnitId, -1);
        if (newUnitId) await incrementUnitExamsCount(newUnitId, 1);
      } catch (countError) {
        console.error('⚠️ فشل تحديث عداد امتحانات الوحدة (لن يمنع نجاح التحديث):', countError.message);
      }
    }

    console.log(`✅ Exam ${examId} updated successfully`);
    return true;
  } catch (error) {
    console.error('❌ Failed to update exam:', error.message);
    throw error;
  }
}

async function deleteExam(examId, softDelete = true) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedExamId = safeParseInt(examId);

  try {
    const examsRef = collection(db, COLLECTIONS.LESSONS);
    const examQuery = query(examsRef, where('id', '==', parsedExamId), where('type', '==', 'exam'));
    const examSnapshot = await getDocs(examQuery);
    
    if (examSnapshot.empty) throw new Error('الامتحان غير موجود');
    
    const examDoc = examSnapshot.docs[0];
    const examUnitId = examDoc.data().unit_id ?? null;
    
    if (softDelete) {
      await updateDoc(examDoc.ref, {
        deleted_at: serverTimestamp(),
        updated_at: serverTimestamp()
      });
      console.log(`✅ Exam ${examId} moved to trash`);
    } else {
      await deleteDoc(examDoc.ref);
      const quizzesRef = collection(db, COLLECTIONS.QUIZZES);
      const questionsQuery = query(quizzesRef, where('exam_id', '==', parsedExamId));
      const questionsSnapshot = await getDocs(questionsQuery);
      const batch = writeBatch(db);
      questionsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`✅ Exam ${examId} permanently deleted`);
    }

    if (examUnitId) {
      try {
        await incrementUnitExamsCount(examUnitId, -1);
      } catch (countError) {
        console.error('⚠️ فشل تحديث عداد امتحانات الوحدة (لن يمنع نجاح الحذف):', countError.message);
      }
    }

    return true;
  } catch (error) {
    console.error('❌ Failed to delete exam:', error.message);
    throw error;
  }
}

async function getExamByLessonId(lessonId) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedLessonId = safeParseInt(lessonId);

  try {
    const examsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(
      examsRef,
      where('type', '==', 'exam'),
      where('lesson_id', '==', parsedLessonId),
      where('deleted_at', '==', null),
      firestoreLimit(1)
    );
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;

    const doc = snapshot.docs[0];
    const data = doc.data();
    return {
      id: data.id,
      title: data.title,
      duration: data.duration,
      questions_count: data.questions_count,
      is_challenge: data.is_challenge || false
    };
  } catch (error) {
    console.error('❌ Failed to get exam by lesson id:', error.message);
    return null;
  }
}
async function getExams(options = {}) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const {
      stage,
      grade,
      semester,
      limit = 20,
      startAfterDoc,
      includeDeleted = false
    } = options;

    const examsRef = collection(db, COLLECTIONS.LESSONS);
    let constraints = [where('type', '==', 'exam')];
    
    if (!includeDeleted) {
      constraints.push(where('deleted_at', '==', null));
    }

    const stageMap = { preparatory: 'إعدادي', secondary: 'ثانوي' };
    if (stage && stageMap[stage]) {
      constraints.push(where('stage', '==', stageMap[stage]));
    }

    if (grade !== undefined) {
      constraints.push(where('grade', '==', safeParseInt(grade)));
    }

    const semesterMap = { first: 'أول', second: 'ثاني' };
    if (semester && semesterMap[semester]) {
      constraints.push(where('semester', '==', semesterMap[semester]));
    }

    constraints.push(orderBy('order', 'asc'));
    constraints.push(orderBy('created_at', 'desc'));

    if (startAfterDoc) {
      constraints.push(startAfter(startAfterDoc));
    }

    constraints.push(firestoreLimit(limit));

    const q = query(examsRef, ...constraints);
    const querySnapshot = await getDocs(q);
    const exams = [];

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      // الامتحانات القديمة بلا unit_id/exam_scope تُعامل كـ "شامل" بدل أن تختفي
      const unitId = data.unit_id ?? null;
      const examScope = data.exam_scope || (unitId ? 'unit' : 'comprehensive');

      exams.push({
        docId: doc.id,
        id: data.id,
        lesson_id: data.lesson_id ?? null,
        unit_id: unitId,
        exam_scope: examScope,
        stage: data.stage,
        semester: data.semester,
        grade: data.grade,
        title: data.title,
        description: data.description,
        duration: data.duration || 30,
        questions_count: data.questions_count || 0,
        is_challenge: data.is_challenge || false,
        created_at: data.created_at,
        updated_at: data.updated_at,
        order: data.order || 0,
        cover_image_url: data.cover_image_url || ''
      });
    });

    return exams;
  } catch (error) {
    console.error('❌ Failed to get exams:', error.message);
    throw error;
  }
}

async function getExamFullData(examId) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedExamId = safeParseInt(examId);

  try {
    const examsRef = collection(db, COLLECTIONS.LESSONS);
    const examQuery = query(examsRef, where('id', '==', parsedExamId), where('type', '==', 'exam'));
    const examSnapshot = await getDocs(examQuery);
    
    if (examSnapshot.empty) return null;
    
    const examDoc = examSnapshot.docs[0];
    const examData = examDoc.data();
    
    const quizzesRef = collection(db, COLLECTIONS.QUIZZES);
    const questionsQuery = query(quizzesRef, where('exam_id', '==', parsedExamId), orderBy('id', 'asc'));
    const questionsSnapshot = await getDocs(questionsQuery);
    
    const questions = [];
    questionsSnapshot.forEach((doc) => {
      const q = doc.data();
      let questionObj = {
        id: q.id,
        text: q.question,
        type: q.question_type,
        image: q.image_url || '',
        difficulty: q.difficulty_level || 'easy'
      };
      
      if (q.question_type === 'multiple_choice') {
        questionObj.options = [q.option_a, q.option_b, q.option_c, q.option_d].filter(opt => opt !== undefined);
        questionObj.correct = q.correct.charCodeAt(0) - 97;
      } else if (q.question_type === 'true_false') {
        questionObj.correct = q.correct === 'true';
      }
      
      questions.push(questionObj);
    });
    
    const unitId = examData.unit_id ?? null;
    const examScope = examData.exam_scope || (unitId ? 'unit' : 'comprehensive');

    return {
      meta: {
        title: examData.title,
        lesson_id: examData.lesson_id ?? null,
        unit_id: unitId,
        exam_scope: examScope,
        stage: examData.stage,
        grade: examData.grade,
        semester: examData.semester,
        duration: examData.duration,
        is_challenge: examData.is_challenge || false,
        description: examData.description || '',
        cover_image_url: examData.cover_image_url || ''
      },
      questions: questions
    };
  } catch (error) {
    console.error('❌ Failed to get exam full data:', error.message);
    throw error;
  }
}

async function moveExam(examId, direction) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedExamId = safeParseInt(examId);

  try {
    const examsRef = collection(db, COLLECTIONS.LESSONS);
    const currentQuery = query(examsRef, where('id', '==', parsedExamId), where('type', '==', 'exam'));
    const currentSnapshot = await getDocs(currentQuery);
    if (currentSnapshot.empty) throw new Error('الامتحان غير موجود');
    
    const currentDoc = currentSnapshot.docs[0];
    const currentData = currentDoc.data();
    const currentOrder = currentData.order || 0;
    
    const filters = {
      stage: currentData.stage,
      grade: currentData.grade,
      semester: currentData.semester
    };
    const allExams = await getExams({ ...filters, limit: 100 });
    
    allExams.sort((a, b) => a.order - b.order);
    const currentIndex = allExams.findIndex(e => e.id === parsedExamId);
    
    let swapExam = null;
    if (direction === 'up' && currentIndex > 0) {
      swapExam = allExams[currentIndex - 1];
    } else if (direction === 'down' && currentIndex < allExams.length - 1) {
      swapExam = allExams[currentIndex + 1];
    }
    
    if (!swapExam) return false;
    
    const batch = writeBatch(db);
    
    const currentRef = currentDoc.ref;
    batch.update(currentRef, { order: swapExam.order, updated_at: serverTimestamp() });
    
    const swapQuery = query(examsRef, where('id', '==', swapExam.id), where('type', '==', 'exam'));
    const swapSnapshot = await getDocs(swapQuery);
    if (!swapSnapshot.empty) {
      batch.update(swapSnapshot.docs[0].ref, { order: currentOrder, updated_at: serverTimestamp() });
    }
    
    await batch.commit();
    console.log(`✅ Exam ${examId} moved ${direction}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to move exam:', error.message);
    throw error;
  }
}

// ==== 12. دوال التعليقات ====
async function addComment(commentData) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    // الهوية من الجلسة وليس من معطيات الواجهة
    const currentUser = requireCommentUser();
    const text = String(commentData.comment || '').trim();
    if (!text) throw new Error('نص التعليق فارغ');
    if (text.length > COMMENT_MAX_LENGTH) throw new Error('نص التعليق أطول من المسموح');

    const commentsRef = collection(db, COLLECTIONS.COMMENTS);
    const userId = safeParseInt(currentUser.id);
    const parentId = commentData.parentId ? safeParseInt(commentData.parentId) : null;

    // الردود بمستوى واحد فقط مع التأكد من وجود التعليق الأب
    let parentRef = null;
    if (parentId) {
      const parentDoc = await findCommentDocById(db, parentId);
      const parentData = parentDoc.data();
      if (parentData.is_deleted) throw new Error('لا يمكن الرد على تعليق محذوف');
      if (parentData.parent_id) throw new Error('الردود على الردود غير مسموحة');
      parentRef = parentDoc.ref;
    }

    const newComment = {
      id: generateUniqueId(),
      user_id: userId,
      full_name: currentUser.full_name || currentUser.username || '',
      user_type: translateUserType(currentUser.user_type),
      comment: text,
      date: serverTimestamp(),
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      parent_id: parentId,
      likes: 0,
      replies_count: 0,
      is_deleted: false,
      is_edited: false,
      pinned: false,
      liked_by: []
    };

    await addDoc(commentsRef, newComment);

    if (parentRef) await updateDoc(parentRef, { replies_count: increment(1) });

    if (userId) await incrementUserCommentsCount(userId);

    console.log(`✅ Comment added with ID: ${newComment.id}`);
    return newComment.id;
  } catch (error) {
    console.error('❌ Failed to add comment:', error.message);
    throw error;
  }
}

async function getComments(limit = 10, startAfterDoc = null, options = {}) {
  await ensureApiInitialized();
  const db = getDb();
  const direction = options.sort === 'oldest' ? 'asc' : 'desc';
  const excludePinned = options.excludePinned === true;

  try {
    const commentsRef = collection(db, COLLECTIONS.COMMENTS);
    const SCAN_BATCH = 25;
    const wanted = limit + 1;
    const found = [];
    let cursor = startAfterDoc;
    let exhausted = false;

    while (found.length < wanted && !exhausted) {
      const constraints = [
        where('is_deleted', '==', false),
        orderBy('date', direction),
        firestoreLimit(SCAN_BATCH)
      ];
      if (cursor) constraints.push(startAfter(cursor));

      const snap = await getDocs(query(commentsRef, ...constraints));
      if (snap.empty) break;

      for (const d of snap.docs) {
        const data = d.data();
        const isRoot = !data.parent_id;
        const skipPinned = excludePinned && data.pinned === true;
        if (isRoot && !skipPinned) {
          found.push(d);
          if (found.length >= wanted) break;
        }
      }

      cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < SCAN_BATCH) exhausted = true;
    }

    const hasMore = found.length > limit;
    const pageDocs = found.slice(0, limit);
    const lastDoc = pageDocs[pageDocs.length - 1] || null;

    const userCache = new Map();
    const comments = [];
    for (const d of pageDocs) {
      comments.push(await enrichCommentWithUserData(d, userCache));
    }

    return { comments, lastDoc, hasMore };
  } catch (error) {
    console.error('❌ Failed to get comments:', error.message);
    return { comments: [], lastDoc: null, hasMore: false };
  }
}

async function getPinnedComment() {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const q = query(
      collection(db, COLLECTIONS.COMMENTS),
      where('pinned', '==', true),
      where('is_deleted', '==', false),
      firestoreLimit(5)
    );
    const snap = await getDocs(q);
    const rootDoc = snap.docs.find(d => !d.data().parent_id);
    return rootDoc ? await enrichCommentWithUserData(rootDoc, new Map()) : null;
  } catch (error) {
    console.error('❌ Failed to get pinned comment:', error.message);
    return null;
  }
}

async function getRootCommentsCount() {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const q = query(
      collection(db, COLLECTIONS.COMMENTS),
      where('is_deleted', '==', false),
      where('parent_id', '==', null)
    );
    const snap = await getCountFromServer(q);
    return snap.data().count;
  } catch (error) {
    console.warn('⚠️ Failed to count comments:', error.message);
    return null;
  }
}

async function enrichCommentWithUserData(doc, userCache = null) {
  const data = doc.data();
  const userId = data.user_id;
  let userExtra = { avatar_url: '', gender: 'male', user_type: 'student', total_score: 0, avatar_job_index: 0, is_verified: false };

  if (userId) {
    let found = userCache ? userCache.get(userId) : null;
    if (!found) {
      const usersRef = collection(getDb(), COLLECTIONS.USERS);
      const userSnap = await getDocs(query(usersRef, where('id', '==', userId)));
      if (!userSnap.empty) {
        const userData = userSnap.docs[0].data();
        found = {
          avatar_url: userData.avatar_url || '',
          gender: userData.gender || 'male',
          user_type: userData.user_type || 'student',
          total_score: userData.total_score || 0,
          avatar_job_index: userData.avatar_job_index ?? 0,
          is_verified: userData.is_verified || false
        };
        if (userCache) userCache.set(userId, found);
      }
    }
    if (found) userExtra = found;
  }

  return {
    docId: doc.id,
    id: data.id,
    user_id: data.user_id,
    full_name: data.full_name,
    user_type: data.user_type,
    comment: data.comment,
    date: data.date,
    created_at: data.created_at || data.date,
    parent_id: data.parent_id,
    likes: data.likes || 0,
    replies_count: data.replies_count || 0,
    is_deleted: data.is_deleted || false,
    is_edited: data.is_edited === true,
    liked_by: data.liked_by || [],
    avatar_url: userExtra.avatar_url,
    gender: userExtra.gender,
    commenter_user_type: userExtra.user_type,
    commenter_total_score: userExtra.total_score,
    commenter_avatar_job_index: userExtra.avatar_job_index,
    commenter_is_verified: userExtra.is_verified,
    pinned: data.pinned || false
  };
}

// الأحدث أولاً حتى يظهر الرد الجديد فور إرساله
async function getCommentReplies(commentId, limit = 5, startAfterDoc = null) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedCommentId = safeParseInt(commentId);

  try {
    const commentsRef = collection(db, COLLECTIONS.COMMENTS);
    const constraints = [
      where('parent_id', '==', parsedCommentId),
      where('is_deleted', '==', false),
      orderBy('date', 'desc'),
      firestoreLimit(limit + 1)
    ];
    if (startAfterDoc) constraints.push(startAfter(startAfterDoc));

    const querySnapshot = await getDocs(query(commentsRef, ...constraints));
    const hasMore = querySnapshot.docs.length > limit;
    const pageDocs = querySnapshot.docs.slice(0, limit);
    const lastDoc = pageDocs[pageDocs.length - 1] || null;

    const userCache = new Map();
    const replies = [];
    for (const d of pageDocs) {
      replies.push(await enrichCommentWithUserData(d, userCache));
    }

    return { replies, lastDoc, hasMore };
  } catch (error) {
    console.error('❌ Failed to get comment replies:', error.message);
    return { replies: [], lastDoc: null, hasMore: false };
  }
}

async function toggleCommentLike(commentId, userId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    // الإعجاب يُنسب لصاحب الجلسة الحالية
    const currentUser = requireCommentUser();
    if (String(currentUser.id) !== String(userId)) throw new Error('هوية المستخدم غير مطابقة');

    const parsedCommentId = safeParseInt(commentId);
    const parsedUserId = safeParseInt(userId);

    const usersRef = collection(db, COLLECTIONS.USERS);
    const userQuery = query(usersRef, where('id', '==', parsedUserId));
    const userSnap = await getDocs(userQuery);
    if (userSnap.empty) throw new Error('المستخدم غير موجود');
    const userRef = userSnap.docs[0].ref;

    const commentsRef = collection(db, COLLECTIONS.COMMENTS);
    const commentQuery = query(commentsRef, where('id', '==', parsedCommentId));
    const commentSnap = await getDocs(commentQuery);
    if (commentSnap.empty) throw new Error('التعليق غير موجود');
    const commentRef = commentSnap.docs[0].ref;

    await runTransaction(db, async (transaction) => {
      const commentDoc = await transaction.get(commentRef);
      if (!commentDoc.exists) throw new Error('التعليق غير موجود');

      const likedBy = commentDoc.data().liked_by || [];

      let userLikesDelta = 0;

      if (likedBy.includes(parsedUserId)) {
        transaction.update(commentRef, {
          liked_by: arrayRemove(parsedUserId),
          likes: increment(-1)
        });
        userLikesDelta = -1;
      } else {
        transaction.update(commentRef, {
          liked_by: arrayUnion(parsedUserId),
          likes: increment(1)
        });
        userLikesDelta = 1;
      }

      if (userLikesDelta !== 0) {
        transaction.update(userRef, {
          likes_given: increment(userLikesDelta),
          last_activity: serverTimestamp()
        });
      }
    });

    return true;
  } catch (error) {
    console.error('❌ Failed to toggle comment like:', error.message);
    throw error;
  }
}

async function softDeleteComment(commentId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const currentUser = requireCommentUser();
    const commentDoc = await findCommentDocById(db, commentId);
    const commentData = commentDoc.data();
    const commentRef = commentDoc.ref;

    const isOwner = String(commentData.user_id) === String(currentUser.id);
    if (!isOwner && !isCommentStaff(currentUser)) {
      throw new Error('ليست لديك صلاحية حذف هذا التعليق');
    }
    if (commentData.is_deleted) return true;

    const userId = commentData.user_id;
    let userRef = null;
    if (userId) {
      const userQuery = query(collection(db, COLLECTIONS.USERS), where('id', '==', userId));
      const userSnap = await getDocs(userQuery);
      if (!userSnap.empty) userRef = userSnap.docs[0].ref;
    }

    let parentRef = null;
    if (commentData.parent_id) {
      try {
        parentRef = (await findCommentDocById(db, commentData.parent_id)).ref;
      } catch {
        parentRef = null;
      }
    }

    await runTransaction(db, async (transaction) => {
      transaction.update(commentRef, { is_deleted: true, pinned: false });

      if (userRef) {
        transaction.update(userRef, {
          comments_count: increment(-1),
          last_activity: serverTimestamp()
        });
      }
      if (parentRef) {
        transaction.update(parentRef, { replies_count: increment(-1) });
      }
    });

    return true;
  } catch (error) {
    console.error('❌ Failed to soft delete comment:', error.message);
    throw error;
  }
}


// ==== 13. إدارة التعليقات المتقدمة ====
async function updateComment(commentId, newText) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const currentUser = requireCommentUser();
    const text = String(newText || '').trim();
    if (!text) throw new Error('نص التعليق فارغ');
    if (text.length > COMMENT_MAX_LENGTH) throw new Error('نص التعليق أطول من المسموح');

    const commentDoc = await findCommentDocById(db, commentId);
    const data = commentDoc.data();
    if (data.is_deleted) throw new Error('التعليق محذوف');
    if (!canEditComment(data, currentUser.id)) {
      throw new Error('انتهت مدة التعديل أو ليست لديك صلاحية');
    }

    await updateDoc(commentDoc.ref, {
      comment: text,
      is_edited: true,
      updated_at: serverTimestamp()
    });
    console.log(`✅ Comment ${commentId} updated`);
    return true;
  } catch (error) {
    console.error('❌ Failed to update comment:', error.message);
    throw error;
  }
}

async function pinComment(commentId, pinned) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const currentUser = requireCommentUser();
    if (!isCommentStaff(currentUser)) throw new Error('التثبيت للمعلم والمشرف فقط');

    const target = await findCommentDocById(db, commentId);
    const data = target.data();
    if (data.is_deleted) throw new Error('التعليق محذوف');
    if (data.parent_id) throw new Error('لا يمكن تثبيت رد');

    const batch = writeBatch(db);

    if (pinned) {
      const pinnedSnap = await getDocs(
        query(collection(db, COLLECTIONS.COMMENTS), where('pinned', '==', true))
      );
      pinnedSnap.docs.forEach(d => {
        if (d.id !== target.id) batch.update(d.ref, { pinned: false });
      });
    }

    batch.update(target.ref, { pinned: !!pinned, updated_at: serverTimestamp() });
    await batch.commit();

    console.log(`✅ Comment ${commentId} pinned = ${pinned}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to pin comment:', error.message);
    throw error;
  }
}
async function addTestimonial(commentData) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const currentUser = getCurrentUser();
    if (!currentUser) {
      throw new Error('يجب تسجيل الدخول لإضافة تعليق');
    }

    const userTypeArabic = translateUserType(currentUser.user_type);

    const newComment = {
      id: generateUniqueId(),
      user_id: safeParseInt(currentUser.id),
      full_name: currentUser.full_name || currentUser.username,
      user_type: userTypeArabic,
      comment: commentData.comment,
      date: serverTimestamp(),
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      parent_id: null,
      likes: 0,
      replies_count: 0,
      is_deleted: false,
      liked_by: []
    };

    const commentsRef = collection(db, COLLECTIONS.COMMENTS);
    await addDoc(commentsRef, newComment);
    console.log(`✅ Testimonial added with ID: ${newComment.id}`);
    return newComment.id;
  } catch (error) {
    console.error('❌ Failed to add testimonial:', error.message);
    throw error;
  }
}

// ==== 14. دوال الإشعارات ====
async function createNotification(userId, {
  title,
  message,
  type = 'info',
  related_exam,
  related_lesson,
  related_id,
  sender = 'system'
}) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const notification = {
      id: generateUniqueId(),
      user_id: safeParseInt(userId),
      title: title || '',
      message: message || '',
      type: type,
      read: false,
      created_at: serverTimestamp(),
      sender: sender
    };

    if (related_exam !== undefined) notification.related_exam = safeParseInt(related_exam);
    if (related_lesson !== undefined) notification.related_lesson = safeParseInt(related_lesson);
    if (related_id !== undefined) notification.related_id = related_id;

    const notificationsRef = collection(db, COLLECTIONS.NOTIFICATIONS);
    await addDoc(notificationsRef, notification);
    console.log(`✅ Notification created for user ${userId}, ID: ${notification.id}`);
    return notification.id;
  } catch (error) {
    console.error('❌ Failed to create notification:', error.message);
    throw error;
  }
}

async function getUserNotifications(userId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const notificationsRef = collection(db, COLLECTIONS.NOTIFICATIONS);
    const q = query(
      notificationsRef,
      where('user_id', '==', safeParseInt(userId)),
      orderBy('created_at', 'desc'),
      firestoreLimit(50)
    );

    const querySnapshot = await getDocs(q);
    const notifications = [];

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      notifications.push({
        docId: doc.id,
        id: data.id,
        user_id: data.user_id,
        title: data.title,
        message: data.message,
        read: data.read || false,
        type: data.type || 'info',
        created_at: data.created_at,
        sender: data.sender || 'system',
        related_lesson: data.related_lesson || 0,
        related_exam: data.related_exam || 0,
        related_id: data.related_id || null
      });
    });
    return notifications;
  } catch (error) {
    console.error('❌ Failed to get notifications:', error.message);
    throw error;
  }
}

async function sendNotification(notificationData) {
  return createNotification(
    notificationData.userId,
    {
      title: notificationData.title,
      message: notificationData.message,
      type: notificationData.type || 'info',
      related_exam: notificationData.relatedExam,
      related_lesson: notificationData.relatedLesson,
      related_id: notificationData.relatedId,
      sender: notificationData.sender || 'system'
    }
  );
}

async function sendBulkNotifications(userIds, notificationData) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const batch = writeBatch(db);
    const notificationsRef = collection(db, COLLECTIONS.NOTIFICATIONS);

    userIds.forEach(userId => {
      const newNotification = {
        id: generateUniqueId(),
        user_id: safeParseInt(userId),
        title: notificationData.title || '',
        message: notificationData.message || '',
        type: notificationData.type || 'info',
        read: false,
        created_at: serverTimestamp(),
        sender: notificationData.sender || 'system'
      };

      if (notificationData.relatedLesson !== undefined) {
        newNotification.related_lesson = safeParseInt(notificationData.relatedLesson);
      }
      if (notificationData.relatedExam !== undefined) {
        newNotification.related_exam = safeParseInt(notificationData.relatedExam);
      }
      if (notificationData.relatedId !== undefined) {
        newNotification.related_id = notificationData.relatedId;
      }

      const docRef = doc(notificationsRef);
      batch.set(docRef, newNotification);
    });

    await batch.commit();
    console.log(`✅ Bulk notifications sent to ${userIds.length} users`);
    return true;
  } catch (error) {
    console.error('❌ Failed to send bulk notifications:', error.message);
    throw error;
  }
}

async function markNotificationRead(notificationDocId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const notifRef = doc(db, COLLECTIONS.NOTIFICATIONS, notificationDocId);
    await updateDoc(notifRef, { read: true });
    return true;
  } catch (error) {
    console.error('❌ Failed to mark notification as read:', error.message);
    throw error;
  }
}

async function deleteNotification(notificationDocId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const notifRef = doc(db, COLLECTIONS.NOTIFICATIONS, notificationDocId);
    await deleteDoc(notifRef);
    return true;
  } catch (error) {
    console.error('❌ Failed to delete notification:', error.message);
    throw error;
  }
}

async function clearAllUserNotifications(userId) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const notificationsRef = collection(db, COLLECTIONS.NOTIFICATIONS);
    const q = query(notificationsRef, where('user_id', '==', safeParseInt(userId)));
    const snapshot = await getDocs(q);

    const batch = writeBatch(db);
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    return true;
  } catch (error) {
    console.error('❌ Failed to clear notifications:', error.message);
    throw error;
  }
}

// ==== 15. دوال التقييمات والإحصائيات ====
async function getTopStudents(count = 5) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(
      usersRef,
      where('user_type', '==', 'student'),
      where('total_score', '>', 0),
      orderBy('total_score', 'desc'),
      firestoreLimit(count)
    );

    const querySnapshot = await getDocs(q);
    const topStudents = [];

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      topStudents.push({
        id: data.id,
        docId: doc.id,
        username: data.username,
        full_name: data.full_name,
        gender: data.gender,
        total_score: data.total_score || 0,
        likes_given: data.likes_given || 0,
        comments_count: data.comments_count || 0,
        user_type: 'student',
        avatar_url: data.avatar_url || '',
        avatar_job_index: data.avatar_job_index ?? -1,
        is_verified: data.is_verified || false
      });
    });
    return topStudents;
  } catch (error) {
    console.error('❌ Failed to get top students:', error.message);
    throw error;
  }
}

async function getPlatformStats() {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const studentsQuery = query(collection(db, COLLECTIONS.USERS), where('user_type', '==', 'student'));
    const studentsSnapshot = await getDocs(studentsQuery);
    const studentsCount = studentsSnapshot.size;

    const teachersQuery = query(collection(db, COLLECTIONS.USERS), where('user_type', '==', 'teacher'));
    const teachersSnapshot = await getDocs(teachersQuery);
    const teachersCount = teachersSnapshot.size;

    const lessonsQuery = query(collection(db, COLLECTIONS.LESSONS));
    const lessonsSnapshot = await getDocs(lessonsQuery);

    const examsQuery = query(collection(db, COLLECTIONS.QUIZZES));
    const examsSnapshot = await getDocs(examsQuery);
    const examIds = new Set();

    examsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.exam_id) examIds.add(data.exam_id);
    });

    const resultsQuery = query(collection(db, COLLECTIONS.EXAM_RESULTS));
    const resultsSnapshot = await getDocs(resultsQuery);

    const commentsQuery = query(collection(db, COLLECTIONS.COMMENTS));
    const commentsSnapshot = await getDocs(commentsQuery);

    return {
      students: studentsCount,
      teachers: teachersCount,
      lessons: lessonsSnapshot.size,
      exams: examIds.size,
      exam_results: resultsSnapshot.size,
      comments: commentsSnapshot.size
    };
  } catch (error) {
    console.error('❌ Failed to get platform stats:', error.message);
    return {
      students: 0,
      teachers: 0,
      lessons: 0,
      exams: 0,
      exam_results: 0,
      comments: 0
    };
  }
}

// ==== 16. دوال مساعدة إضافية ====
function convertUserType(userType, toEnglish = true) {
  if (toEnglish) {
    switch (userType) {
      case 'طالب': return 'student';
      case 'معلم': return 'teacher';
      case 'مشرف': return 'moderator';
      default: return userType;
    }
  } else {
    switch (userType) {
      case 'student': return 'طالب';
      case 'teacher': return 'معلم';
      case 'moderator': return 'مشرف';
      default: return userType;
    }
  }
}

async function checkDatabaseCompatibility() {
  await ensureApiInitialized();
  const db = getDb();

  try {
    console.log('🔍 فحص توافق API مع قاعدة البيانات...');
    const collections = Object.values(COLLECTIONS);
    const results = {};

    for (const collectionName of collections) {
      const ref = collection(db, collectionName);
      const snapshot = await getDocs(query(ref, firestoreLimit(1)));
      results[collectionName] = {
        exists: !snapshot.empty,
        count: snapshot.size
      };
    }
    console.log('📊 نتائج الفحص:', results);
    return results;
  } catch (error) {
    console.error('❌ فشل فحص التوافق:', error.message);
    return null;
  }
}

// ==== 17. إعدادات الفصل الدراسي الظاهر للطلاب ====
// المصدر الوحيد لما يراه الطالب من فصل دراسي، منفصل عن سياق تصفح المعلم
const DEFAULT_ACTIVE_SEMESTER = 'أول';
let semesterSettingsCache = null;
let semesterSettingsCacheAt = 0;

async function getSemesterSettings(forceRefresh = false) {
  await ensureApiInitialized();
  const db = getDb();

  if (!forceRefresh && semesterSettingsCache && (Date.now() - semesterSettingsCacheAt) < CACHE_TTL.LONG) {
    return semesterSettingsCache;
  }

  try {
    const snapshot = await getDocs(collection(db, COLLECTIONS.SEMESTER_SETTINGS));
    const settings = [];
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      settings.push({
        docId: docSnap.id,
        stage: data.stage,
        grade: data.grade,
        active_semester: data.active_semester || DEFAULT_ACTIVE_SEMESTER,
        updated_by: data.updated_by || null,
        updated_at: data.updated_at || null
      });
    });
    semesterSettingsCache = settings;
    semesterSettingsCacheAt = Date.now();
    return settings;
  } catch (error) {
    console.error('❌ Failed to get semester settings:', error.message);
    // عند فشل الشبكة نرجع آخر كاش معروف بدل كسر الصفحة
    return semesterSettingsCache || [];
  }
}

async function getActiveSemesterFor(stage, grade) {
  const normalizedStage = normalizeStageValue(stage);
  if (!normalizedStage || grade === undefined || grade === null) return DEFAULT_ACTIVE_SEMESTER;
  const normalizedGrade = safeParseInt(grade);

  const settings = await getSemesterSettings();
  const match = settings.find(s => s.stage === normalizedStage && safeParseInt(s.grade) === normalizedGrade);
  return match?.active_semester || DEFAULT_ACTIVE_SEMESTER;
}

async function setActiveSemester(stage, grade, semester, teacherId) {
  await ensureApiInitialized();
  const db = getDb();

  const normalizedStage = normalizeStageValue(stage);
  const normalizedSemester = normalizeSemesterValue(semester);
  if (!normalizedStage || grade === undefined || grade === null || !normalizedSemester) {
    throw new Error('بيانات غير مكتملة لتحديد الفصل الدراسي النشط');
  }
  const normalizedGrade = safeParseInt(grade);

  try {
    const docId = `${normalizedStage}_${normalizedGrade}`;
    const settingRef = doc(db, COLLECTIONS.SEMESTER_SETTINGS, docId);

    await setDoc(settingRef, {
      stage: normalizedStage,
      grade: normalizedGrade,
      active_semester: normalizedSemester,
      updated_by: teacherId || null,
      updated_at: serverTimestamp()
    }, { merge: true });

    semesterSettingsCache = null;

    EventBus.emit('semester:active-changed', {
      stage: normalizedStage,
      grade: normalizedGrade,
      semester: normalizedSemester,
      teacherId: teacherId || null
    });

    return true;
  } catch (error) {
    console.error('❌ Failed to set active semester:', error.message);
    throw error;
  }
}

async function getUnits(options = {}) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const { stage, grade, semester } = options;
    const unitsRef = collection(db, COLLECTIONS.UNITS);
    let constraints = [];

    if (stage) {
      constraints.push(where('stage', '==', stage));
    }
    if (grade !== undefined) {
      constraints.push(where('grade', '==', safeParseInt(grade)));
    }
    if (semester) {
      constraints.push(where('semester', '==', semester));
    }

    constraints.push(orderBy('order', 'asc'));
    constraints.push(orderBy('name', 'asc'));

    const q = query(unitsRef, ...constraints);
    const snapshot = await getDocs(q);
    const units = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      units.push({
        id: data.id,
        docId: doc.id,
        name: data.name,
        stage: data.stage,
        grade: data.grade,
        semester: data.semester,
        order: data.order || 0,
        description: data.description || '',
        lessons_count: data.lessons_count || 0,
        exams_count: data.exams_count || 0,
        created_at: data.created_at
      });
    });

    return units;
  } catch (error) {
    console.error('❌ Failed to get units:', error.message);
    throw error;
  }
}

async function createUnit(unitData) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const unitId = generateUniqueId();
    const newUnit = {
      id: unitId,
      name: unitData.name,
      stage: unitData.stage,
      grade: safeParseInt(unitData.grade),
      semester: unitData.semester,
      order: safeParseInt(unitData.order, 0),
      description: unitData.description || '',
      lessons_count: 0,
      exams_count: 0,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp()
    };

    const unitsRef = collection(db, COLLECTIONS.UNITS);
    await addDoc(unitsRef, newUnit);
    console.log(`✅ Unit created with ID: ${unitId}`);
    return unitId;
  } catch (error) {
    console.error('❌ Failed to create unit:', error.message);
    throw error;
  }
}

async function updateUnit(unitId, unitData) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedUnitId = safeParseInt(unitId);

  try {
    const unitsRef = collection(db, COLLECTIONS.UNITS);
    const q = query(unitsRef, where('id', '==', parsedUnitId));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('الوحدة غير موجودة');

    const docRef = snapshot.docs[0].ref;
    const updates = {
      name: unitData.name,
      stage: unitData.stage,
      grade: safeParseInt(unitData.grade),
      semester: unitData.semester,
      order: safeParseInt(unitData.order, 0),
      description: unitData.description || '',
      updated_at: serverTimestamp()
    };

    await updateDoc(docRef, updates);
    console.log(`✅ Unit ${unitId} updated`);
    return true;
  } catch (error) {
    console.error('❌ Failed to update unit:', error.message);
    throw error;
  }
}

async function deleteUnit(unitId) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedUnitId = safeParseInt(unitId);

  try {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const lessonsQuery = query(lessonsRef, where('unit_id', '==', parsedUnitId), where('type', '!=', 'exam'));
    const lessonsSnapshot = await getDocs(lessonsQuery);
    if (!lessonsSnapshot.empty) {
      throw new Error('لا يمكن حذف الوحدة لوجود دروس مرتبطة بها');
    }

    const unitsRef = collection(db, COLLECTIONS.UNITS);
    const q = query(unitsRef, where('id', '==', parsedUnitId));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('الوحدة غير موجودة');

    await deleteDoc(snapshot.docs[0].ref);
    console.log(`✅ Unit ${unitId} deleted`);
    return true;
  } catch (error) {
    console.error('❌ Failed to delete unit:', error.message);
    throw error;
  }
}

// ==== 18. إدارة الدروس ====

async function createLesson(lessonData) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const lessonId = generateUniqueId();
    const newLesson = {
      id: lessonId,
      type: 'lesson',
      stage: lessonData.stage,
      grade: safeParseInt(lessonData.grade),
      semester: lessonData.semester,
      unit_id: lessonData.unit_id ? safeParseInt(lessonData.unit_id) : null,
      title: lessonData.title,
      description: lessonData.description || '',
      video_url: lessonData.video_url,
      pdf_url: lessonData.pdf_url || '',
      cover_image_url: lessonData.cover_image_url || '',
      duration: safeParseInt(lessonData.duration, 0),
      likes: 0,
      liked_by: [],
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      order: lessonData.order || 0,
      
      
      deleted_at: null
    };

    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    await addDoc(lessonsRef, newLesson);

    if (newLesson.unit_id) {
      await incrementUnitLessonsCount(newLesson.unit_id, 1);
    }

    console.log(`✅ Lesson created with ID: ${lessonId}`);
    return lessonId;
  } catch (error) {
    console.error('❌ Failed to create lesson:', error.message);
    throw error;
  }
}

async function updateLesson(lessonId, lessonData) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedLessonId = safeParseInt(lessonId);

  try {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(lessonsRef, where('id', '==', parsedLessonId), where('type', '==', 'lesson'));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('الدرس غير موجود');

    const docRef = snapshot.docs[0].ref;
    const oldData = snapshot.docs[0].data();
    const oldUnitId = oldData.unit_id;

    const updates = {
      stage: lessonData.stage,
      grade: safeParseInt(lessonData.grade),
      semester: lessonData.semester,
      unit_id: lessonData.unit_id ? safeParseInt(lessonData.unit_id) : null,
      title: lessonData.title,
      description: lessonData.description || '',
      video_url: lessonData.video_url,
      pdf_url: lessonData.pdf_url || '',
      cover_image_url: lessonData.cover_image_url || '',
      duration: safeParseInt(lessonData.duration, 0),
      
      updated_at: serverTimestamp()
    };

    await updateDoc(docRef, updates);

    if (oldUnitId !== updates.unit_id) {
      if (oldUnitId) await incrementUnitLessonsCount(oldUnitId, -1);
      if (updates.unit_id) await incrementUnitLessonsCount(updates.unit_id, 1);
    }

    console.log(`✅ Lesson ${lessonId} updated`);
    return true;
  } catch (error) {
    console.error('❌ Failed to update lesson:', error.message);
    throw error;
  }
}

async function deleteLesson(lessonId, softDelete = true) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedLessonId = safeParseInt(lessonId);

  try {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(lessonsRef, where('id', '==', parsedLessonId), where('type', '==', 'lesson'));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('الدرس غير موجود');

    const docRef = snapshot.docs[0].ref;
    const lessonData = snapshot.docs[0].data();

    if (softDelete) {
      await updateDoc(docRef, {
        deleted_at: serverTimestamp(),
        updated_at: serverTimestamp()
      });
    } else {
      await deleteDoc(docRef);
    }

    if (lessonData.unit_id) {
      await incrementUnitLessonsCount(lessonData.unit_id, -1);
    }

    console.log(`✅ Lesson ${lessonId} ${softDelete ? 'moved to trash' : 'deleted'}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to delete lesson:', error.message);
    throw error;
  }
}

async function getLessonFullData(lessonId) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedLessonId = safeParseInt(lessonId);

  try {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(lessonsRef, where('id', '==', parsedLessonId), where('type', '==', 'lesson'));
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;

    const data = snapshot.docs[0].data();
    return {
      title: data.title,
      stage: data.stage,
      grade: data.grade,
      semester: data.semester,
      unit_id: data.unit_id,
      video_url: data.video_url,
      pdf_url: data.pdf_url || '',
      cover_image_url: data.cover_image_url || '',
      description: data.description || '',
      
      
      duration: data.duration || 0
    };
  } catch (error) {
    console.error('❌ Failed to get lesson full data:', error.message);
    throw error;
  }
}

async function exportLesson(lessonId) {
  try {
    const lesson = await getLessonFullData(lessonId);
    if (!lesson) throw new Error('الدرس غير موجود');

    let questions = [];
    try {
      const exam = await getExamByLessonId(lessonId);
      if (exam?.id) {
        const fullExam = await getExamFullData(exam.id);
        questions = fullExam?.questions || [];
      }
    } catch (_) { }

    return {
      meta: { ...lesson, exported_at: new Date().toISOString() },
      questions
    };
  } catch (error) {
    console.error('❌ Failed to export lesson:', error.message);
    throw error;
  }
}

async function importLesson(lessonData) {
  try {
    const meta = lessonData?.meta;
    if (!meta?.title) throw new Error('بيانات الدرس غير صالحة');

    const newLessonId = await createLesson({
      title: meta.title,
      description: meta.description || '',
      stage: meta.stage,
      grade: meta.grade,
      semester: meta.semester,
      unit_id: meta.unit_id || null,
      video_url: meta.video_url || '',
      pdf_url: meta.pdf_url || '',
      cover_image_url: meta.cover_image_url || '',
      duration: meta.duration || 0
    });

    const questions = Array.isArray(lessonData?.questions) ? lessonData.questions : [];
    if (questions.length > 0) {
      await createExam({
        lesson_id: newLessonId,
        title: `امتحان: ${meta.title}`,
        stage: meta.stage,
        grade: meta.grade,
        semester: meta.semester,
        duration: 10
      }, questions);
    }

    return newLessonId;
  } catch (error) {
    console.error('❌ Failed to import lesson:', error.message);
    throw error;
  }
}

async function getLessonStats(lessonId) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedLessonId = safeParseInt(lessonId);

  try {
    const progressRef = collection(db, COLLECTIONS.USER_PROGRESS);
    const progressQuery = query(
      progressRef,
      where('lesson_id', '==', parsedLessonId),
      where('completed', '==', true)
    );
    const progressSnapshot = await getDocs(progressQuery);
    const completedCount = progressSnapshot.size;

    let averageScore = 0;
    const exam = await getExamByLessonId(parsedLessonId);
    if (exam?.id) {
      const resultsRef = collection(db, COLLECTIONS.EXAM_RESULTS);
      const resultsQuery = query(resultsRef, where('exam_id', '==', safeParseInt(exam.id)));
      const resultsSnapshot = await getDocs(resultsQuery);
      if (!resultsSnapshot.empty) {
        let totalScore = 0;
        resultsSnapshot.forEach(doc => { totalScore += (doc.data().score || 0); });
        averageScore = Math.round(totalScore / resultsSnapshot.size);
      }
    }

    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const lessonQuery = query(lessonsRef, where('id', '==', parsedLessonId), where('type', '==', 'lesson'));
    const lessonSnapshot = await getDocs(lessonQuery);
    let averageRating = 0;
    if (!lessonSnapshot.empty) {
      averageRating = lessonSnapshot.docs[0].data().average_rating || 0;
    }

    return { completedCount, averageScore, averageRating, totalStudents: completedCount };
  } catch (error) {
    console.error('❌ Failed to get lesson stats:', error.message);
    return { completedCount: 0, averageScore: 0, averageRating: 0, totalStudents: 0 };
  }
}

async function moveLesson(lessonId, direction) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedLessonId = safeParseInt(lessonId);

  try {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const currentQuery = query(lessonsRef, where('id', '==', parsedLessonId), where('type', '==', 'lesson'));
    const currentSnapshot = await getDocs(currentQuery);
    if (currentSnapshot.empty) throw new Error('الدرس غير موجود');

    const currentDoc = currentSnapshot.docs[0];
    const currentData = currentDoc.data();
const currentOrder = currentData.order !== undefined ? currentData.order : 0;
const unitId = currentData.unit_id;

// الدرس بلا وحدة لا يُحرَّك لأن ترتيبه عام
if (!unitId) {
  console.warn(`⚠️ لا يمكن تحريك درس بدون وحدة: ${lessonId}`);
  return false;
}

const allLessonsQuery = query(
  lessonsRef,
  where('type', '==', 'lesson'),
  where('unit_id', '==', unitId),
  where('deleted_at', '==', null),
  orderBy('order', 'asc')
);
    const allSnapshot = await getDocs(allLessonsQuery);
    const lessons = [];
    allSnapshot.forEach(doc => lessons.push({ id: doc.data().id, order: doc.data().order || 0, ref: doc.ref }));

    lessons.sort((a, b) => a.order - b.order);
    const currentIndex = lessons.findIndex(l => l.id === parsedLessonId);

    let swapLesson = null;
    if (direction === 'up' && currentIndex > 0) {
      swapLesson = lessons[currentIndex - 1];
    } else if (direction === 'down' && currentIndex < lessons.length - 1) {
      swapLesson = lessons[currentIndex + 1];
    }

    if (!swapLesson) return false;

    const batch = writeBatch(db);
    batch.update(currentDoc.ref, { order: swapLesson.order, updated_at: serverTimestamp() });
    batch.update(swapLesson.ref, { order: currentOrder, updated_at: serverTimestamp() });
    await batch.commit();

    console.log(`✅ Lesson ${lessonId} moved ${direction}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to move lesson:', error.message);
    throw error;
  }
}

// ==== 19. دوال مساعدة داخلية ====

async function incrementUnitLessonsCount(unitId, delta) {
  const db = getDb();
  const unitsRef = collection(db, COLLECTIONS.UNITS);
  const q = query(unitsRef, where('id', '==', safeParseInt(unitId)));
  const snapshot = await getDocs(q);
  if (!snapshot.empty) {
    const docRef = snapshot.docs[0].ref;
    await updateDoc(docRef, {
      lessons_count: increment(delta),
      updated_at: serverTimestamp()
    });
  }
}

async function incrementUnitExamsCount(unitId, delta) {
  const db = getDb();
  const unitsRef = collection(db, COLLECTIONS.UNITS);
  const q = query(unitsRef, where('id', '==', safeParseInt(unitId)));
  const snapshot = await getDocs(q);
  if (!snapshot.empty) {
    const docRef = snapshot.docs[0].ref;
    await updateDoc(docRef, {
      exams_count: increment(delta),
      updated_at: serverTimestamp()
    });
  }
}

// ==== 20. إحصائيات المستخدم ====

async function getUserExamStats(userId) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedUserId = safeParseInt(userId);

  try {
    const resultsRef = collection(db, COLLECTIONS.EXAM_RESULTS);
    const resultsQuery = query(resultsRef, where('user_id', '==', parsedUserId));
    const resultsSnapshot = await getDocs(resultsQuery);

    const completedExams = resultsSnapshot.size;
    let totalScore = 0;
    resultsSnapshot.forEach(doc => {
      const data = doc.data();
      totalScore += safeParseInt(data.score, 0);
    });

    const averageScore = completedExams > 0 ? Math.round(totalScore / completedExams) : 0;

    return { totalExams: completedExams, completedExams, averageScore };
  } catch (error) {
    console.error('❌ Failed to get user exam stats:', error.message);
    return { totalExams: 0, completedExams: 0, averageScore: 0 };
  }
}

async function getUserExamResultsMap(userId) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedUserId = safeParseInt(userId);

  try {
    const resultsRef = collection(db, COLLECTIONS.EXAM_RESULTS);
    const q = query(resultsRef, where('user_id', '==', parsedUserId));
    const snapshot = await getDocs(q);

    const map = {};
    snapshot.forEach(doc => {
      const data = doc.data();
      const examId = data.exam_id;
      const existing = map[examId];
      // عند تكرار الامتحان نحتفظ بأعلى نتيجة
      if (!existing || safeParseInt(data.score, 0) > safeParseInt(existing.score, 0)) {
        map[examId] = {
          score: data.score || 0,
          passed: data.passed || false,
          time_taken: data.time_taken || 0,
          created_at: data.created_at
        };
      }
    });
    return map;
  } catch (error) {
    console.error('❌ Failed to get user exam results map:', error.message);
    return {};
  }
}

// ==== 21. إدارة كلمة المرور وحذف الحساب ====
async function updateUserPassword(userId, currentPassword, newPassword) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedUserId = safeParseInt(userId);

  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('id', '==', parsedUserId));
  const snapshot = await getDocs(q);
  if (snapshot.empty) throw new Error('المستخدم غير موجود');

  const userDoc = snapshot.docs[0];
  const userData = userDoc.data();
  const storedHash = userData.password;

  const hashedCurrent = await hashPassword(currentPassword);
  if (storedHash !== hashedCurrent) {
    throw new Error('كلمة المرور الحالية غير صحيحة');
  }

  const hashedNew = await hashPassword(newPassword);
  await updateDoc(userDoc.ref, { password: hashedNew, updated_at: serverTimestamp() });
  return true;
}

async function deleteUserAccount(userId) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedUserId = safeParseInt(userId);

  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('id', '==', parsedUserId));
  const snapshot = await getDocs(q);
  if (snapshot.empty) throw new Error('المستخدم غير موجود');
  assertCanDeleteAccount(snapshot.docs[0].data(), parsedUserId);
  const userDocRef = snapshot.docs[0].ref;

  const batch = writeBatch(db);

  const resultsRef = collection(db, COLLECTIONS.EXAM_RESULTS);
  const resultsQuery = query(resultsRef, where('user_id', '==', parsedUserId));
  const resultsSnap = await getDocs(resultsQuery);
  resultsSnap.forEach(doc => batch.delete(doc.ref));

  const progressRef = collection(db, COLLECTIONS.USER_PROGRESS);
  const progressQuery = query(progressRef, where('user_id', '==', parsedUserId));
  const progressSnap = await getDocs(progressQuery);
  progressSnap.forEach(doc => batch.delete(doc.ref));

  const commentsRef = collection(db, COLLECTIONS.COMMENTS);
  const commentsQuery = query(commentsRef, where('user_id', '==', parsedUserId));
  const commentsSnap = await getDocs(commentsQuery);
  commentsSnap.forEach(doc => batch.delete(doc.ref));

  const notifRef = collection(db, COLLECTIONS.NOTIFICATIONS);
  const notifQuery = query(notifRef, where('user_id', '==', parsedUserId));
  const notifSnap = await getDocs(notifQuery);
  notifSnap.forEach(doc => batch.delete(doc.ref));

  batch.delete(userDocRef);

  await batch.commit();
  invalidateProfileCache(parsedUserId);
  console.log(`✅ تم حذف الحساب ${parsedUserId} وجميع بياناته`);
  return true;
}

// ==== 22. إدارة المشرفين والمهملات والطلاب ====

async function getModeratorsList() {
  await ensureApiInitialized();
  const db = getDb();
  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('user_type', 'in', ['moderator', 'teacher']));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => {
    const data = doc.data();
    return {
      id: data.id,
      docId: doc.id,
      full_name: data.full_name,
      phone: data.phone,
      level: data.user_type === 'teacher' ? 'senior' : (data.moderator_level || 'normal'),
      user_type: data.user_type,
      gender: data.gender,
      avatar_url: data.avatar_url || '',
      avatar_job_index: data.avatar_job_index ?? -1,
      is_verified: data.is_verified || false
    };
  });
}

async function updateModeratorLevel(userId, level) {
  await ensureApiInitialized();
  const db = getDb();
  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('id', '==', safeParseInt(userId)));
  const snapshot = await getDocs(q);
  if (snapshot.empty) throw new Error('المستخدم غير موجود');
  const docRef = snapshot.docs[0].ref;
  const updates = level === 'senior' ? { user_type: 'teacher', moderator_level: 'senior' } : { user_type: 'moderator', moderator_level: 'normal' };
  await updateDoc(docRef, updates);
}

async function deleteModerator(userId) {
  await ensureApiInitialized();
  const db = getDb();
  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('id', '==', safeParseInt(userId)));
  const snapshot = await getDocs(q);
  if (snapshot.empty) throw new Error('المستخدم غير موجود');
  const docRef = snapshot.docs[0].ref;
  await updateDoc(docRef, { user_type: 'student' });
}

async function getTrashItems(type) {
  await ensureApiInitialized();
  const db = getDb();
  const items = [];
  if (type === 'lessons') {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(lessonsRef, where('type', '==', 'lesson'), where('deleted_at', '!=', null));
    const snapshot = await getDocs(q);
    snapshot.forEach(doc => {
      const data = doc.data();
      items.push({ id: data.id, docId: doc.id, type: 'lesson', name: data.title, deleted_at: data.deleted_at });
    });
  } else if (type === 'exams') {
    const examsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(examsRef, where('type', '==', 'exam'), where('deleted_at', '!=', null));
    const snapshot = await getDocs(q);
    snapshot.forEach(doc => {
      const data = doc.data();
      items.push({ id: data.id, docId: doc.id, type: 'exam', name: data.title, deleted_at: data.deleted_at });
    });
  } else if (type === 'comments') {
    const commentsRef = collection(db, COLLECTIONS.COMMENTS);
    const q = query(commentsRef, where('is_deleted', '==', true));
    const snapshot = await getDocs(q);
    snapshot.forEach(doc => {
      const data = doc.data();
      items.push({ id: data.id, docId: doc.id, type: 'comment', name: `تعليق من ${data.full_name}`, deleted_at: data.updated_at || data.created_at });
    });
  }
  return items;
}

async function restoreTrashItem(type, id) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedId = safeParseInt(id);
  if (type === 'lesson' || type === 'exam') {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(lessonsRef, where('id', '==', parsedId));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('العنصر غير موجود');
    const docRef = snapshot.docs[0].ref;
    await updateDoc(docRef, { deleted_at: null, updated_at: serverTimestamp() });

    // امتحان الوحدة المسترجع من المهملات يُحتسب في عداد الوحدة (مقابل خصمه عند النقل)
    if (type === 'exam') {
      const examUnitId = snapshot.docs[0].data().unit_id ?? null;
      if (examUnitId) {
        try { await incrementUnitExamsCount(examUnitId, 1); }
        catch (countError) { console.error('⚠️ فشل تحديث عداد امتحانات الوحدة عند الاسترجاع:', countError.message); }
      }
    }
  } else if (type === 'comment') {
    const commentsRef = collection(db, COLLECTIONS.COMMENTS);
    const q = query(commentsRef, where('id', '==', parsedId));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('التعليق غير موجود');
    const docRef = snapshot.docs[0].ref;
    await updateDoc(docRef, { is_deleted: false, updated_at: serverTimestamp() });
  }
}

async function permanentlyDeleteTrashItem(type, id) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedId = safeParseInt(id);
  if (type === 'lesson' || type === 'exam') {
    const lessonsRef = collection(db, COLLECTIONS.LESSONS);
    const q = query(lessonsRef, where('id', '==', parsedId));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('العنصر غير موجود');
    const docRef = snapshot.docs[0].ref;
    await deleteDoc(docRef);
    if (type === 'exam') {
      const quizzesRef = collection(db, COLLECTIONS.QUIZZES);
      const qq = query(quizzesRef, where('exam_id', '==', parsedId));
      const quizzesSnap = await getDocs(qq);
      const batch = writeBatch(db);
      quizzesSnap.forEach(qDoc => batch.delete(qDoc.ref));
      await batch.commit();
    }
  } else if (type === 'comment') {
    const commentsRef = collection(db, COLLECTIONS.COMMENTS);
    const q = query(commentsRef, where('id', '==', parsedId));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('التعليق غير موجود');
    const docRef = snapshot.docs[0].ref;
    await deleteDoc(docRef);
  }
}

async function getAllStudents() {
  await ensureApiInitialized();
  const db = getDb();
  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('user_type', '==', 'student'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => {
    const data = doc.data();
    return {
      id: data.id,
      docId: doc.id,
      full_name: data.full_name,
      stage: data.stage,
      grade: data.grade,
      total_score: data.total_score || 0,
      phone: data.phone,
      email: data.email,
      user_type: 'student',
      gender: data.gender,
      avatar_url: data.avatar_url || '',
      avatar_job_index: data.avatar_job_index ?? -1,
      is_verified: data.is_verified || false
    };
  });
}

async function updateStudentAccount(studentId, data) {
  await ensureApiInitialized();
  const db = getDb();
  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('id', '==', safeParseInt(studentId)));
  const snapshot = await getDocs(q);
  if (snapshot.empty) throw new Error('الطالب غير موجود');

  const viewer = requireProfileViewer();
  const target = snapshot.docs[0].data();
  const isSelf = String(viewer.id) === String(target.id);
  if (!isSelf && !(isProfileStaff(viewer) && (target.user_type || 'student') === 'student')) {
    throw new Error('غير مصرّح بتعديل هذا الحساب');
  }

  const docRef = snapshot.docs[0].ref;
  const updates = { last_activity: serverTimestamp() };
  if (data.full_name !== undefined) updates.full_name = data.full_name;
  if (data.stage !== undefined) updates.stage = data.stage;
  if (data.grade !== undefined) updates.grade = safeParseInt(data.grade);
  if (data.email !== undefined) updates.email = data.email;
  if (data.phone !== undefined) updates.phone = data.phone;
  await updateDoc(docRef, updates);
  invalidateProfileCache(target.id);
}

async function addModerator(userId) {
  await ensureApiInitialized();
  const db = getDb();
  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('id', '==', safeParseInt(userId)));
  const snapshot = await getDocs(q);
  if (snapshot.empty) throw new Error('المستخدم غير موجود');
  const docRef = snapshot.docs[0].ref;
  await updateDoc(docRef, { user_type: 'moderator', moderator_level: 'normal' });
}

// ==== 23. الشكاوى ====

async function getComplaints({ status = null, limitCount = 50 } = {}) {
  await ensureApiInitialized();
  const db = getDb();
  try {
    const complaintsRef = collection(db, COLLECTIONS.COMPLAINTS);
    const constraints = [];
    if (status && status !== 'all') {
      constraints.push(where('status', '==', status));
    }
    constraints.push(orderBy('date', 'desc'));
    constraints.push(firestoreLimit(limitCount));

    const q = query(complaintsRef, ...constraints);
    const snapshot = await getDocs(q);
    return snapshot.docs.map(docSnap => {
      const data = docSnap.data();
      return {
        id: data.id,
        docId: docSnap.id,
        user_id: data.user_id,
        full_name: data.full_name || '',
        comment: data.comment || '',
        status: data.status || 'pending',
        date: data.date,
        reply: data.reply || null,
        replied_at: data.replied_at || null
      };
    });
  } catch (error) {
    console.error('❌ Failed to get complaints:', error.message);
    return [];
  }
}

async function getPendingComplaintsCount() {
  await ensureApiInitialized();
  const db = getDb();
  try {
    const complaintsRef = collection(db, COLLECTIONS.COMPLAINTS);
    const q = query(complaintsRef, where('status', '==', 'pending'));
    const snapshot = await getDocs(q);
    return snapshot.size;
  } catch (error) {
    console.error('❌ Failed to count pending complaints:', error.message);
    return 0;
  }
}

async function createComplaint({ userId, fullName, comment }) {
  await ensureApiInitialized();
  const db = getDb();
  try {
    const complaintsRef = collection(db, COLLECTIONS.COMPLAINTS);
    const newComplaint = {
      id: generateUniqueId(),
      user_id: safeParseInt(userId),
      full_name: fullName || '',
      comment: comment || '',
      status: 'pending',
      date: serverTimestamp(),
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      reply: null,
      replied_at: null
    };
    await addDoc(complaintsRef, newComplaint);
    console.log(`✅ Complaint created with ID: ${newComplaint.id}`);
    return newComplaint.id;
  } catch (error) {
    console.error('❌ Failed to create complaint:', error.message);
    throw error;
  }
}

async function updateComplaintStatus(complaintId, status) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedId = safeParseInt(complaintId);
  const complaintsRef = collection(db, COLLECTIONS.COMPLAINTS);
  const q = query(complaintsRef, where('id', '==', parsedId));
  const snapshot = await getDocs(q);
  if (snapshot.empty) throw new Error('الشكوى غير موجودة');
  const docRef = snapshot.docs[0].ref;
  await updateDoc(docRef, { status, updated_at: serverTimestamp() });
}

async function replyToComplaint(complaintId, reply) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedId = safeParseInt(complaintId);
  const complaintsRef = collection(db, COLLECTIONS.COMPLAINTS);
  const q = query(complaintsRef, where('id', '==', parsedId));
  const snapshot = await getDocs(q);
  if (snapshot.empty) throw new Error('الشكوى غير موجودة');
  const docRef = snapshot.docs[0].ref;
  await updateDoc(docRef, {
    reply,
    status: 'resolved',
    replied_at: serverTimestamp(),
    updated_at: serverTimestamp()
  });
}

// ==== 24. إحصائيات رسوم لوحة التحكم ====

async function getWeeklyActivityStats() {
  await ensureApiInitialized();
  const db = getDb();
  try {
    const now = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push({ key: d.toISOString().slice(0, 10), label: WEEKDAY_LABELS_AR[d.getDay()], count: 0 });
    }
    const dayIndex = new Map(days.map(d => [d.key, d]));

    const tally = (docData) => {
      const ts = docData.date || docData.created_at;
      if (!ts || typeof ts.toDate !== 'function') return;
      const key = ts.toDate().toISOString().slice(0, 10);
      const bucket = dayIndex.get(key);
      if (bucket) bucket.count++;
    };

    const resultsQuery = query(collection(db, COLLECTIONS.EXAM_RESULTS), orderBy('date', 'desc'), firestoreLimit(300));
    const resultsSnap = await getDocs(resultsQuery);
    resultsSnap.forEach(docSnap => tally(docSnap.data()));

    const commentsQuery = query(collection(db, COLLECTIONS.COMMENTS), orderBy('date', 'desc'), firestoreLimit(300));
    const commentsSnap = await getDocs(commentsQuery);
    commentsSnap.forEach(docSnap => tally(docSnap.data()));

    return days;
  } catch (error) {
    console.error('❌ Failed to get weekly activity stats:', error.message);
    return [];
  }
}

async function getExamPerformanceStats(limitCount = 6) {
  await ensureApiInitialized();
  const db = getDb();
  try {
    const resultsQuery = query(collection(db, COLLECTIONS.EXAM_RESULTS), orderBy('date', 'desc'), firestoreLimit(300));
    const resultsSnap = await getDocs(resultsQuery);

    const byExam = new Map();
    resultsSnap.forEach(docSnap => {
      const data = docSnap.data();
      const examId = data.exam_id;
      if (examId === undefined || examId === null) return;
      const total = safeParseInt(data.total_questions, 0);
      const accuracy = typeof data.accuracy === 'number'
        ? data.accuracy
        : (total > 0 ? (safeParseInt(data.correct_answers, 0) / total) * 100 : 0);
      const entry = byExam.get(examId) || { totalAccuracy: 0, attempts: 0 };
      entry.totalAccuracy += accuracy;
      entry.attempts += 1;
      byExam.set(examId, entry);
    });

    const ranked = Array.from(byExam.entries())
      .map(([examId, entry]) => ({
        examId,
        attempts: entry.attempts,
        averageAccuracy: Math.round(entry.totalAccuracy / entry.attempts)
      }))
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, limitCount);

    if (ranked.length === 0) return [];

    const examIds = ranked.map(r => r.examId);
    const titlesMap = new Map();
    const titlesQuery = query(collection(db, COLLECTIONS.LESSONS), where('id', 'in', examIds));
    const titlesSnap = await getDocs(titlesQuery);
    titlesSnap.forEach(docSnap => {
      const data = docSnap.data();
      titlesMap.set(data.id, data.title);
    });

    return ranked.map(r => ({
      examId: r.examId,
      title: titlesMap.get(r.examId) || `امتحان #${r.examId}`,
      averageAccuracy: r.averageAccuracy,
      attempts: r.attempts
    }));
  } catch (error) {
    console.error('❌ Failed to get exam performance stats:', error.message);
    return [];
  }
}

// ==== 25. تحديث الـ Streak ====
async function updateUserStreak(userId, streakCount) {
  await ensureApiInitialized();
  const db = getDb();
  const parsedUserId = safeParseInt(userId);
  const newStreak = Math.max(0, safeParseInt(streakCount, 0));

  try {
    const usersRef = collection(db, COLLECTIONS.USERS);
    const q = query(usersRef, where('id', '==', parsedUserId));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      throw new Error('المستخدم غير موجود');
    }

    const docRef = querySnapshot.docs[0].ref;
    await updateDoc(docRef, {
      streak: newStreak,
      last_activity: serverTimestamp()
    });
    console.log(`✅ Updated streak for user ${parsedUserId} to ${newStreak}`);
    invalidateProfileCache(parsedUserId);
    return true;
  } catch (error) {
    console.error('❌ Failed to update user streak:', error.message);
    return false;
  }
}

// ==== 26. البحث برقم الهاتف ====
async function getUserByPhone(phone) {
  await ensureApiInitialized();
  const db = getDb();
  const usersRef = collection(db, COLLECTIONS.USERS);
  const q = query(usersRef, where('phone', '==', phone));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  const userDoc = snapshot.docs[0];
  const userData = userDoc.data();
  return {
    id: userData.id,
    full_name: userData.full_name,
    phone: userData.phone,
    user_type: userData.user_type,
    gender: userData.gender,
    avatar_url: userData.avatar_url || '',
    avatar_job_index: userData.avatar_job_index ?? -1,
    is_verified: userData.is_verified || false
  };
}

// ==== 27. البحث عن المستخدمين ====
// المسح الاحتياطي في الذاكرة فقط ويعمل عند أقل من 5 نتائج مباشرة
const USERS_SCAN_MAX_DOCS = 5000;

function _searchToLatinDigits(str) {
  return String(str ?? '').replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return String(c >= 0x06F0 ? c - 0x06F0 : c - 0x0660);
  });
}

function _searchNormalize(str) {
  return _searchToLatinDigits(str)
    .replace(/[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ىئ]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function _searchCanonicalPhone(input) {
  let d = _searchToLatinDigits(input).replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('20') && d.length >= 12) return '0' + d.slice(2);
  if (d.length === 10 && d[0] === '1') return '0' + d;
  return d;
}

function _searchCanonicalQueryDigits(digits, hadPlus) {
  if (digits.startsWith('0020')) return '0' + digits.slice(4);
  if (digits.startsWith('20') && (hadPlus || digits.length >= 11)) return '0' + digits.slice(2);
  return digits;
}

function _searchMapUser(data) {
  return {
    id: data.id,
    full_name: data.full_name || '',
    username: data.username || '',
    phone: data.phone || '',
    user_type: data.user_type || 'student',
    avatar_url: data.avatar_url || '',
    avatar_job_index: data.avatar_job_index ?? 0,
    gender: data.gender,
    total_score: data.total_score ?? 0,
    is_verified: data.is_verified || false,
    stage: data.stage || '',
    grade: data.grade || ''
  };
}

function _searchPhoneVariants(digits) {
  const d = _searchCanonicalQueryDigits(digits, false);
  const variants = new Set([d]);
  if (d.startsWith('0')) {
    const noZero = d.slice(1);
    if (noZero) {
      variants.add(noZero);
      variants.add('20' + noZero);
      variants.add('+20' + noZero);
      variants.add('0020' + noZero);
    }
  } else {
    variants.add('0' + d);
    variants.add('20' + d);
    variants.add('+20' + d);
  }
  return Array.from(variants);
}

function _searchNameVariants(text) {
  const ALEFS = ['ا', 'أ', 'إ', 'آ'];
  const TAILS = { 'ي': 'ى', 'ى': 'ي', 'ه': 'ة', 'ة': 'ه' };
  const heads = new Set([text]);
  if (ALEFS.includes(text[0])) ALEFS.forEach(a => heads.add(a + text.slice(1)));
  if (/^[a-z]/i.test(text)) {
    heads.add(text[0].toUpperCase() + text.slice(1));
    heads.add(text[0].toLowerCase() + text.slice(1));
  }
  const out = new Set();
  heads.forEach((v) => {
    out.add(v);
    const last = v[v.length - 1];
    if (TAILS[last]) out.add(v.slice(0, -1) + TAILS[last]);
  });
  return Array.from(out).slice(0, 8);
}

function _searchParse(text) {
  const hadPlus = text.includes('+');
  const parts = text.split(' ').filter(Boolean).map((raw) => {
    const digits = _searchToLatinDigits(raw).replace(/[-().+]/g, '');
    return { raw, digits, numeric: /^\d+$/.test(digits) };
  });
  const allNumeric = parts.length > 0 && parts.every(p => p.numeric);
  const units = allNumeric ? [{ numeric: true, digits: parts.map(p => p.digits).join('') }] : parts;

  const tokens = [];
  units.forEach((u) => {
    if (u.numeric) {
      if (u.digits.length >= 3) tokens.push({ type: 'num', raw: u.digits, value: _searchCanonicalQueryDigits(u.digits, hadPlus) });
    } else {
      const v = _searchNormalize(u.raw.replace(/^@+/, ''));
      if (v) tokens.push({ type: 'text', value: v });
    }
  });
  return { tokens, allNumeric, digits: allNumeric ? units[0].digits : '' };
}

function _searchPrepare(user) {
  if (user._n !== undefined) return user;
  user._n = _searchNormalize(user.full_name);
  user._words = user._n ? user._n.split(' ') : [];
  user._u = _searchNormalize(user.username);
  user._p = _searchCanonicalPhone(user.phone);
  user._id = user.id === undefined || user.id === null ? '' : String(user.id);
  return user;
}

function _searchScore(user, tokens) {
  _searchPrepare(user);
  let total = 0;
  for (const tok of tokens) {
    let best = 0;
    if (tok.type === 'num') {
      const p = user._p;
      if (p) {
        if (p === tok.value) best = 120;
        else if (p.startsWith(tok.value)) best = 95;
        else if (tok.value.length >= 4 && p.endsWith(tok.value)) best = 85;
        else if (p.includes(tok.value)) best = 60;
      }
      if (user._id && user._id === tok.raw) best = Math.max(best, 110);
      if (tok.raw.length >= 4 && user._u.includes(tok.raw)) best = Math.max(best, 40);
    } else {
      const t = tok.value;
      user._words.forEach((w, i) => {
        if (w === t) best = Math.max(best, i === 0 ? 100 : 90);
        else if (w.startsWith(t)) best = Math.max(best, i === 0 ? 88 : 78);
        else if (t.length >= 3 && w.includes(t)) best = Math.max(best, 40);
      });
      if (user._u) {
        if (user._u === t) best = Math.max(best, 85);
        else if (user._u.startsWith(t)) best = Math.max(best, 70);
        else if (t.length >= 2 && user._u.includes(t)) best = Math.max(best, 42);
      }
    }
    if (best === 0) return 0;
    total += best;
  }
  const whole = tokens.filter(t => t.type === 'text').map(t => t.value).join(' ');
  if (whole.length >= 2) {
    if (user._n === whole) total += 50;
    else if (user._n.startsWith(whole)) total += 25;
  }
  return total;
}

let _usersScanCache = { data: null, ts: 0, promise: null };

async function _getUsersForScan() {
  const cache = _usersScanCache;
  if (cache.data && (Date.now() - cache.ts) < CACHE_TTL.LONG) return cache.data;
  if (cache.promise) return cache.promise;

  cache.promise = (async () => {
    const db = getDb();
    const usersRef = collection(db, COLLECTIONS.USERS);
    const snapshot = await getDocs(query(usersRef, firestoreLimit(USERS_SCAN_MAX_DOCS)));
    const users = [];
    snapshot.forEach((d) => {
      const data = d.data();
      if (data && data.id !== undefined) users.push(_searchMapUser(data));
    });
    if (snapshot.size >= USERS_SCAN_MAX_DOCS) {
      console.warn(`⚠️ searchUsers: تم الوصول للحد الأقصى للمسح (${USERS_SCAN_MAX_DOCS}) — قد لا تظهر بعض النتائج الوسطية`);
    }
    cache.data = users;
    cache.ts = Date.now();
    return users;
  })().finally(() => { cache.promise = null; });

  return cache.promise;
}

async function searchUsers(searchQuery, optionsOrLimit = 20) {
  // لا تُسمَّ أي باراميتر هنا query لأنه يحجب دالة Firestore المستوردة
  await ensureApiInitialized();

  const opts = typeof optionsOrLimit === 'number' ? { limit: optionsOrLimit } : (optionsOrLimit || {});
  const limit = Math.min(Math.max(safeParseInt(opts.limit, 20), 1), 50);
  const throwOnError = !!opts.throwOnError;

  const text = _searchToLatinDigits(searchQuery).replace(/\s+/g, ' ').trim().replace(/^@+\s*/, '');
  if (text.length < 2) return [];

  if (!(isTeacher() || isModerator())) {
    console.warn('⚠️ searchUsers: البحث متاح للمعلم والمشرف فقط');
    if (throwOnError) throw new Error('غير مصرّح بالبحث');
    return [];
  }

  const parsed = _searchParse(text);
  if (!parsed.tokens.length) return [];

  try {
    const db = getDb();
    const usersRef = collection(db, COLLECTIONS.USERS);
    const prefixQuery = (field, prefix) => query(
      usersRef,
      where(field, '>=', prefix),
      where(field, '<=', prefix + '\uf8ff'),
      firestoreLimit(limit)
    );

    const queries = [];
    if (parsed.allNumeric) {
      _searchPhoneVariants(parsed.digits).forEach(v => queries.push(prefixQuery('phone', v)));
      if (parsed.digits.length >= 5 && parsed.digits.length <= 12) {
        queries.push(query(usersRef, where('id', '==', safeParseInt(parsed.digits)), firestoreLimit(5)));
      }
    } else {
      const words = text.split(' ').filter(Boolean);
      const nameKeys = new Set(_searchNameVariants(text));
      if (words.length > 1) _searchNameVariants(words[0]).forEach(v => nameKeys.add(v));
      nameKeys.forEach(v => queries.push(prefixQuery('full_name', v)));

      const uname = words[0];
      new Set([uname, uname.toLowerCase()]).forEach(v => queries.push(prefixQuery('username', v)));
    }

    const found = new Map();
    let fulfilled = 0;
    let firstError = null;

    const settled = await Promise.allSettled(queries.map(q => getDocs(q)));
    settled.forEach((r) => {
      if (r.status === 'fulfilled') {
        fulfilled++;
        r.value.forEach((d) => {
          const data = d.data();
          if (data && data.id !== undefined && !found.has(data.id)) found.set(data.id, _searchMapUser(data));
        });
      } else if (!firstError) {
        firstError = r.reason;
      }
    });

    // فشل كل الاستعلامات خطأ حقيقي وليس لا نتائج
    if (queries.length && fulfilled === 0 && firstError) throw firstError;

    const directIds = new Set(found.keys());
    if (found.size < Math.min(limit, 5)) {
      try {
        const all = await _getUsersForScan();
        for (const u of all) {
          if (!found.has(u.id) && _searchScore(u, parsed.tokens) > 0) found.set(u.id, u);
        }
      } catch (scanErr) {
        console.warn('⚠️ searchUsers: تعذّر المسح الاحتياطي:', scanErr.message);
        if (found.size === 0 && throwOnError) throw scanErr;
      }
    }

    const ranked = Array.from(found.values()).map((u) => {
      const s = _searchScore(u, parsed.tokens);
      // نتيجة Firestore المباشرة لا تُسقَط حتى لو اختلفت قواعد التطبيع
      return { u, s: s > 0 ? s : (directIds.has(u.id) ? 1 : 0) };
    }).filter(x => x.s > 0);

    ranked.sort((a, b) => (b.s - a.s) || (a.u._n < b.u._n ? -1 : a.u._n > b.u._n ? 1 : 0));

    return ranked.slice(0, limit).map(({ u }) => _searchMapUser(u));
  } catch (error) {
    console.error('❌ Failed to search users:', error.message);
    if (throwOnError) throw error;
    return [];
  }
}

// ==== 28. نظام الملف الشخصي ====
const PROFILE_FORBIDDEN_MESSAGE = 'غير مصرّح لك بعرض هذه البيانات';

const PROFILE_CONFIG = Object.freeze({
  LEVELS: [
    { name: 'مبتدئ', min: 0 },
    { name: 'متعلم', min: 100 },
    { name: 'متقدم', min: 300 },
    { name: 'متفوق', min: 700 },
    { name: 'خبير', min: 1500 }
  ],
  MEDAL_MIN_ACCURACY: { gold: 90, silver: 75, bronze: 60 },
  STRONG_MIN: 70,
  WEAK_MAX: 60,
  FOCUS_COUNT: 3,
  TREND_POINTS: 10,
  HEAT_WEEKS: 20,
  PAGE_MAX: 50,
  IN_CHUNK: 30
});

const profileCache = new Map();

function profileCached(key, fresh, loader) {
  const hit = profileCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL.MEDIUM) return hit.promise;

  const promise = loader().catch((error) => {
    if (profileCache.get(key)?.promise === promise) profileCache.delete(key);
    throw error;
  });
  profileCache.set(key, { at: Date.now(), promise });
  return promise;
}

function invalidateProfileCache(userId) {
  if (userId === undefined || userId === null) {
    profileCache.clear();
    return;
  }
  const prefix = `profile:${safeParseInt(userId)}:`;
  [...profileCache.keys()].forEach((key) => {
    if (key.startsWith(prefix)) profileCache.delete(key);
  });
}

EventBus.on('userStateChanged', () => profileCache.clear());

function requireProfileViewer() {
  const viewer = getCurrentUser();
  if (!viewer || !viewer.id) throw new Error('يجب تسجيل الدخول');
  return viewer;
}

function isProfileStaff(viewer) {
  return isTeacher(viewer) || isModerator(viewer);
}

function resolveProfileAccess(viewer, target) {
  const subject = target.user_type || 'student';
  const own = String(viewer.id) === String(target.id);
  const mode = own ? 'own' : (isProfileStaff(viewer) && subject === 'student' ? 'staff-view' : 'public');
  return { mode, subject, detailed: mode !== 'public' };
}

function assertCanDeleteAccount(target, userId) {
  const viewer = requireProfileViewer();
  if (String(viewer.id) === String(userId)) return;
  if (isProfileStaff(viewer) && (target.user_type || 'student') === 'student') return;
  throw new Error('غير مصرّح بحذف هذا الحساب');
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
}

function profileTimeMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function profileDayKey(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function isLiveLesson(row) {
  return Boolean(row) && row.type === 'lesson' && !row.deleted_at;
}

function computeProfileLevel(score) {
  const levels = PROFILE_CONFIG.LEVELS;
  const value = Math.max(0, safeParseInt(score, 0));
  let index = 0;
  levels.forEach((level, i) => { if (value >= level.min) index = i; });

  const current = levels[index];
  const next = levels[index + 1] || null;
  const progress = next ? clampPercent(((value - current.min) / (next.min - current.min)) * 100) : 100;

  return {
    index,
    total: levels.length,
    name: current.name,
    score: value,
    next: next ? next.min : null,
    next_name: next ? next.name : null,
    progress
  };
}

async function fetchUserRecord(userId) {
  const snapshot = await getDocs(
    query(collection(getDb(), COLLECTIONS.USERS), where('id', '==', safeParseInt(userId)))
  );
  return snapshot.empty ? null : snapshot.docs[0].data();
}

async function fetchDocsByIds(collectionName, ids) {
  const unique = [...new Set(ids.map((value) => safeParseInt(value, 0)).filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < unique.length; i += PROFILE_CONFIG.IN_CHUNK) {
    chunks.push(unique.slice(i, i + PROFILE_CONFIG.IN_CHUNK));
  }

  const snapshots = await Promise.all(chunks.map((chunk) =>
    getDocs(query(collection(getDb(), collectionName), where('id', 'in', chunk)))
  ));

  const rows = [];
  snapshots.forEach((snapshot) => snapshot.forEach((docSnap) => rows.push(docSnap.data())));
  return rows;
}

function normalizeExamResult(data) {
  const total = safeParseInt(data.total_questions, 0);
  const correct = safeParseInt(data.correct_answers, 0);
  const stored = Number(data.accuracy);
  const accuracy = clampPercent(Number.isFinite(stored) ? stored : (total ? (correct / total) * 100 : 0));
  const at = data.date || data.created_at || null;

  return {
    exam_id: safeParseInt(data.exam_id, 0),
    score: safeParseInt(data.score, 0),
    total_questions: total,
    correct_answers: correct,
    accuracy,
    passed: Boolean(data.passed),
    at,
    time: profileTimeMs(at)
  };
}

function getProfileContext(targetId, fresh = false) {
  const viewer = requireProfileViewer();
  const id = safeParseInt(targetId, 0);
  if (!id) return Promise.resolve(null);

  return profileCached(`profile:${id}:${viewer.id}:context`, fresh, async () => {
    await ensureApiInitialized();
    const user = await fetchUserRecord(id);
    return user ? { user, access: resolveProfileAccess(viewer, user) } : null;
  });
}

async function getStudentContext(targetId, { fresh = false, detailed = false } = {}) {
  const context = await getProfileContext(targetId, fresh);
  if (!context || context.access.subject !== 'student') return null;
  if (detailed && !context.access.detailed) throw new Error(PROFILE_FORBIDDEN_MESSAGE);
  return context;
}

function getUserRecords(userId, fresh = false) {
  return profileCached(`profile:${userId}:records`, fresh, async () => {
    const db = getDb();
    const uid = safeParseInt(userId);

    const [progressSnap, resultsSnap] = await Promise.all([
      getDocs(query(collection(db, COLLECTIONS.USER_PROGRESS), where('user_id', '==', uid))),
      getDocs(query(collection(db, COLLECTIONS.EXAM_RESULTS), where('user_id', '==', uid)))
    ]);

    const progress = progressSnap.docs.map((docSnap) => docSnap.data());
    const results = resultsSnap.docs
      .map((docSnap) => normalizeExamResult(docSnap.data()))
      .sort((a, b) => a.time - b.time);

    const metaRows = await fetchDocsByIds(COLLECTIONS.LESSONS, [
      ...results.map((result) => result.exam_id),
      ...progress.map((row) => row.lesson_id)
    ]);
    const meta = new Map(metaRows.map((row) => [safeParseInt(row.id), row]));

    return { progress, results, meta };
  });
}

function computeMedals(records) {
  const best = new Map();
  records.results.forEach((result) => {
    const exam = records.meta.get(result.exam_id);
    if (!exam || exam.type !== 'exam' || !exam.is_challenge) return;
    const current = best.get(result.exam_id);
    if (!current || result.accuracy > current.accuracy) best.set(result.exam_id, result);
  });

  const rules = PROFILE_CONFIG.MEDAL_MIN_ACCURACY;
  const rank = { gold: 0, silver: 1, bronze: 2 };
  const entries = [];

  best.forEach((result, examId) => {
    let tier = null;
    if (result.accuracy >= rules.gold) tier = 'gold';
    else if (result.accuracy >= rules.silver) tier = 'silver';
    else if (result.accuracy >= rules.bronze) tier = 'bronze';
    if (!tier) return;

    entries.push({
      tier,
      time: result.time,
      item: {
        id: examId,
        tier,
        name: records.meta.get(examId).title || '',
        accuracy: result.accuracy,
        earned_at: result.at
      }
    });
  });

  entries.sort((a, b) => rank[a.tier] - rank[b.tier] || b.time - a.time);

  const counts = { gold: 0, silver: 0, bronze: 0 };
  entries.forEach((entry) => { counts[entry.tier] += 1; });

  return { items: entries.map((entry) => entry.item), counts };
}

async function getUserProfile(targetId, options = {}) {
  const context = await getProfileContext(targetId, options.fresh);
  if (!context) return null;

  const { user, access } = context;
  const profile = {
    id: user.id,
    full_name: user.full_name || '',
    subject: access.subject,
    user_type: access.subject,
    gender: user.gender || '',
    avatar_url: user.avatar_url || '',
    avatar_job_index: user.avatar_job_index ?? -1,
    total_score: safeParseInt(user.total_score, 0),
    created_at: user.created_at || null,
    mode: access.mode,
    permissions: {
      can_edit_avatar: access.mode === 'own',
      can_manage_student: access.mode === 'staff-view'
    }
  };

  if (access.subject === 'student') {
    profile.stage = normalizeStageValue(user.stage) || '';
    profile.grade = safeParseInt(user.grade, 0) || '';
    profile.streak = safeParseInt(user.streak, 0);
    profile.level = computeProfileLevel(profile.total_score);
  }

  if (access.detailed) {
    Object.assign(profile, {
      username: user.username || '',
      phone: user.phone || '',
      email: user.email || '',
      age: safeParseInt(user.age, 0),
      last_login: user.last_login || null,
      last_activity: user.last_activity || null,
      likes_given: safeParseInt(user.likes_given, 0),
      comments_count: safeParseInt(user.comments_count, 0)
    });
  }

  return profile;
}

async function getUserStats(targetId, options = {}) {
  const context = await getStudentContext(targetId, { fresh: options.fresh });
  if (!context) return null;

  const records = await getUserRecords(context.user.id, options.fresh);
  const lessons = records.progress.filter((row) => isLiveLesson(records.meta.get(safeParseInt(row.lesson_id))));
  const completed = lessons.filter((row) => row.completed || clampPercent(row.progress) >= 100);

  const stats = {
    completed_lessons: completed.length,
    exams_taken: new Set(records.results.map((result) => result.exam_id)).size,
    medals_count: computeMedals(records).items.length,
    total_score: safeParseInt(context.user.total_score, 0)
  };

  if (context.access.detailed) {
    const accuracies = records.results.map((result) => result.accuracy);
    stats.average_accuracy = accuracies.length
      ? Math.round(accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length)
      : 0;
    stats.best_accuracy = accuracies.length ? Math.max(...accuracies) : 0;
    stats.in_progress_lessons = lessons.length - completed.length;
  }

  return stats;
}

async function getUserMedals(targetId, options = {}) {
  const context = await getStudentContext(targetId, { fresh: options.fresh });
  if (!context) return null;
  return computeMedals(await getUserRecords(context.user.id, options.fresh));
}

async function getLearningJourney(targetId, options = {}) {
  const context = await getProfileContext(targetId, options.fresh);
  if (!context) return null;
  if (context.access.subject !== 'student') return { applicable: false };
  if (!context.access.detailed) throw new Error(PROFILE_FORBIDDEN_MESSAGE);

  const { user } = context;
  return profileCached(`profile:${user.id}:journey`, options.fresh, async () => {
    const stage = normalizeStageValue(user.stage);
    const grade = safeParseInt(user.grade, 0);
    if (!stage || !grade) return { applicable: true, needs_setup: true };

    const semester = await getActiveSemesterFor(stage, grade);
    const db = getDb();

    const [unitsSnap, lessonsSnap, records] = await Promise.all([
      getDocs(query(
        collection(db, COLLECTIONS.UNITS),
        where('stage', '==', stage), where('grade', '==', grade), where('semester', '==', semester)
      )),
      getDocs(query(
        collection(db, COLLECTIONS.LESSONS),
        where('type', '==', 'lesson'),
        where('stage', '==', stage), where('grade', '==', grade), where('semester', '==', semester)
      )),
      getUserRecords(user.id, options.fresh)
    ]);

    const units = unitsSnap.docs
      .map((docSnap) => docSnap.data())
      .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name), 'ar'));

    const lessons = lessonsSnap.docs
      .map((docSnap) => docSnap.data())
      .filter((lesson) => !lesson.deleted_at)
      .sort((a, b) => (a.order || 0) - (b.order || 0) || profileTimeMs(a.created_at) - profileTimeMs(b.created_at));

    const groups = new Map(units.map((unit) => [safeParseInt(unit.id), { id: unit.id, name: unit.name, lessons: [] }]));
    const orphans = { id: null, name: 'دروس أخرى', lessons: [] };
    lessons.forEach((lesson) => {
      (groups.get(safeParseInt(lesson.unit_id, 0)) || orphans).lessons.push(lesson);
    });

    const ordered = [...groups.values()];
    if (orphans.lessons.length) ordered.push(orphans);

    const progressByLesson = new Map(records.progress.map((row) => [safeParseInt(row.lesson_id), row]));

    const resultUnits = ordered.map((group) => {
      const items = group.lessons.map((lesson) => {
        const row = progressByLesson.get(safeParseInt(lesson.id));
        const progress = clampPercent(row?.progress);
        const completed = Boolean(row?.completed) || progress >= 100;
        return {
          id: lesson.id,
          title: lesson.title || '',
          completed,
          progress: completed ? 100 : progress,
          exam_score: safeParseInt(row?.exam_score, 0)
        };
      });
      const done = items.filter((item) => item.completed).length;
      return {
        id: group.id,
        name: group.name,
        lessons: items,
        lessons_total: items.length,
        lessons_completed: done,
        percent: items.length ? Math.round((done / items.length) * 100) : 0
      };
    });

    const total = resultUnits.reduce((sum, unit) => sum + unit.lessons_total, 0);
    const completed = resultUnits.reduce((sum, unit) => sum + unit.lessons_completed, 0);

    return {
      applicable: true,
      needs_setup: false,
      stage,
      grade,
      semester,
      overall: { total, completed, percent: total ? Math.round((completed / total) * 100) : 0 },
      units: resultUnits
    };
  });
}

async function getPerformanceBreakdown(targetId, options = {}) {
  const context = await getProfileContext(targetId, options.fresh);
  if (!context) return null;
  if (context.access.subject !== 'student') return { applicable: false };
  if (!context.access.detailed) throw new Error(PROFILE_FORBIDDEN_MESSAGE);

  const userId = context.user.id;
  return profileCached(`profile:${userId}:performance`, options.fresh, async () => {
    const records = await getUserRecords(userId, options.fresh);
    if (!records.results.length) return { applicable: true, has_data: false };

    const attempts = records.results.length;
    const overall = Math.round(records.results.reduce((sum, result) => sum + result.accuracy, 0) / attempts);

    const trend = records.results.slice(-PROFILE_CONFIG.TREND_POINTS).map((result) => ({
      at: result.at,
      title: records.meta.get(result.exam_id)?.title || '',
      accuracy: result.accuracy
    }));

    const byUnit = new Map();
    records.results.forEach((result) => {
      const unitId = safeParseInt(records.meta.get(result.exam_id)?.unit_id, 0);
      if (!unitId) return;
      const entry = byUnit.get(unitId) || { sum: 0, count: 0 };
      entry.sum += result.accuracy;
      entry.count += 1;
      byUnit.set(unitId, entry);
    });

    const unitRows = await fetchDocsByIds(COLLECTIONS.UNITS, [...byUnit.keys()]);
    const unitNames = new Map(unitRows.map((unit) => [safeParseInt(unit.id), unit.name]));

    const units = [...byUnit.entries()]
      .filter(([id]) => unitNames.has(id))
      .map(([id, entry]) => ({
        id,
        name: unitNames.get(id),
        average_accuracy: Math.round(entry.sum / entry.count),
        attempts: entry.count
      }))
      .sort((a, b) => b.average_accuracy - a.average_accuracy);

    return {
      applicable: true,
      has_data: true,
      attempts,
      overall_accuracy: overall,
      trend,
      units,
      strengths: units.filter((unit) => unit.average_accuracy >= PROFILE_CONFIG.STRONG_MIN).slice(0, PROFILE_CONFIG.FOCUS_COUNT),
      weaknesses: [...units].reverse().filter((unit) => unit.average_accuracy < PROFILE_CONFIG.WEAK_MAX).slice(0, PROFILE_CONFIG.FOCUS_COUNT)
    };
  });
}

function getActivityFeed(userId, fresh = false) {
  return profileCached(`profile:${userId}:activity`, fresh, async () => {
    const [records, commentsSnap] = await Promise.all([
      getUserRecords(userId, fresh),
      getDocs(query(collection(getDb(), COLLECTIONS.COMMENTS), where('user_id', '==', safeParseInt(userId))))
    ]);

    const items = [];

    records.results.forEach((result) => {
      const exam = records.meta.get(result.exam_id);
      items.push({
        type: 'exam',
        at: result.at,
        time: result.time,
        title: exam?.title || 'امتحان',
        is_challenge: Boolean(exam?.is_challenge),
        accuracy: result.accuracy,
        passed: result.passed,
        correct_answers: result.correct_answers,
        total_questions: result.total_questions
      });
    });

    records.progress.forEach((row) => {
      const lesson = records.meta.get(safeParseInt(row.lesson_id));
      if (!isLiveLesson(lesson)) return;
      const progress = clampPercent(row.progress);
      const completed = Boolean(row.completed) || progress >= 100;
      if (!completed && progress <= 0) return;
      const at = row.last_accessed || null;
      items.push({
        type: 'lesson',
        at,
        time: profileTimeMs(at),
        title: lesson.title || '',
        completed,
        progress: completed ? 100 : progress,
        ref_id: lesson.id
      });
    });

    commentsSnap.forEach((docSnap) => {
      const comment = docSnap.data();
      if (comment.is_deleted) return;
      const at = comment.created_at || comment.date || null;
      items.push({ type: 'comment', at, time: profileTimeMs(at), is_reply: Boolean(comment.parent_id) });
    });

    items.sort((a, b) => b.time - a.time);

    const horizon = Date.now() - PROFILE_CONFIG.HEAT_WEEKS * 7 * 86400000;
    const daily = {};
    items.forEach((item) => {
      if (!item.time || item.time < horizon) return;
      const key = profileDayKey(item.time);
      daily[key] = (daily[key] || 0) + 1;
    });

    return { items, daily };
  });
}

async function getUserActivity(targetId, pageSize = 12, cursor = null, options = {}) {
  const context = await getStudentContext(targetId, { fresh: options.fresh, detailed: true });
  if (!context) return null;

  const feed = await getActivityFeed(context.user.id, options.fresh);
  const size = Math.min(PROFILE_CONFIG.PAGE_MAX, Math.max(1, safeParseInt(pageSize, 12)));
  const offset = Math.max(0, safeParseInt(cursor, 0));
  const end = offset + size;

  return {
    items: feed.items.slice(offset, end).map(({ time, ...item }) => item),
    total: feed.items.length,
    next_cursor: end < feed.items.length ? String(end) : null,
    daily: feed.daily
  };
}

// ==== 29. نظام الإعلانات المنبثقة ====
// تعديل المحتوى يرفع updated_at فيُعاد عرض الإعلان لمن أغلقه، أما التفعيل/التعطيل فلا يمسّه عمدًا

const ANNOUNCEMENT_ACTION_ROUTES = Object.freeze([
  'lessons', 'exams', 'groups', 'favorites', 'notifications', 'profile', 'settings', 'login', 'register'
]);

const ANNOUNCEMENT_LIMITS = Object.freeze({ TITLE: 120, TEXT: 1000, ACTION_LABEL: 30, URL: 1000 });

let announcementsCache = null;
let announcementsCacheAt = 0;
let announcementsInflight = null;

function invalidateAnnouncementsCache() {
  announcementsCache = null;
  announcementsCacheAt = 0;
}

function requireAnnouncementStaff() {
  const user = getCurrentUser();
  if (!user || !(isTeacher(user) || isModerator(user))) {
    throw new Error('غير مصرّح لك بإدارة الإعلانات');
  }
  return user;
}

function announcementTimeMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isSafeAnnouncementImageUrl(url) {
  const value = String(url || '').trim();
  return /^https?:\/\//i.test(value) || (value.startsWith('/') && !value.startsWith('//'));
}

function mapAnnouncement(docSnap) {
  const data = docSnap.data();
  const audience = data.audience || {};
  return {
    docId: docSnap.id,
    id: data.id ?? docSnap.id,
    title: data.title || '',
    text: data.text || '',
    image_url: data.image_url || '',
    action_label: data.action_label || '',
    action_route: data.action_route || '',
    audience: {
      guests: !!audience.guests,
      students: !!audience.students,
      staff: !!audience.staff,
      stages: Array.isArray(audience.stages) ? audience.stages : [],
      grades: Array.isArray(audience.grades) ? audience.grades : []
    },
    is_active: data.is_active !== false,
    order: safeParseInt(data.order, 0),
    starts_at: data.starts_at || null,
    ends_at: data.ends_at || null,
    created_by: data.created_by ?? null,
    created_at: data.created_at || null,
    updated_at: data.updated_at || null
  };
}

function compareAnnouncements(a, b) {
  if (a.order !== b.order) return a.order - b.order;
  return announcementTimeMs(b.created_at) - announcementTimeMs(a.created_at);
}

function sanitizeAnnouncementInput(input = {}) {
  const title = String(input.title ?? '').trim();
  const text = String(input.text ?? '').trim();
  if (!title) throw new Error('عنوان الإعلان مطلوب');
  if (!text) throw new Error('نص الإعلان مطلوب');
  if (title.length > ANNOUNCEMENT_LIMITS.TITLE) throw new Error(`العنوان أطول من ${ANNOUNCEMENT_LIMITS.TITLE} حرفًا`);
  if (text.length > ANNOUNCEMENT_LIMITS.TEXT) throw new Error(`النص أطول من ${ANNOUNCEMENT_LIMITS.TEXT} حرف`);

  const imageUrl = String(input.image_url ?? '').trim();
  if (imageUrl && (imageUrl.length > ANNOUNCEMENT_LIMITS.URL || !isSafeAnnouncementImageUrl(imageUrl))) {
    throw new Error('رابط الصورة غير صالح (http/https أو مسار داخلي فقط)');
  }

  const actionRoute = String(input.action_route ?? '').trim();
  const actionLabel = String(input.action_label ?? '').trim();
  if (actionRoute && !ANNOUNCEMENT_ACTION_ROUTES.includes(actionRoute)) throw new Error('مسار زر الإجراء غير مسموح');
  if (actionLabel.length > ANNOUNCEMENT_LIMITS.ACTION_LABEL) throw new Error(`نص الزر أطول من ${ANNOUNCEMENT_LIMITS.ACTION_LABEL} حرفًا`);
  if (!!actionRoute !== !!actionLabel) throw new Error('زر الإجراء يتطلب نصًا ومسارًا معًا');

  const rawAudience = input.audience || {};
  const stages = [...new Set((rawAudience.stages || []).map(normalizeStageValue).filter(Boolean))];
  const gradeKeys = new Set();
  const grades = [];
  (rawAudience.grades || []).forEach(g => {
    const stage = normalizeStageValue(g?.stage);
    const grade = safeParseInt(g?.grade, 0);
    if (!stage || !grade || gradeKeys.has(`${stage}_${grade}`)) return;
    gradeKeys.add(`${stage}_${grade}`);
    grades.push({ stage, grade });
  });
  const audience = {
    guests: !!rawAudience.guests,
    students: !!rawAudience.students,
    staff: !!rawAudience.staff,
    stages,
    grades
  };
  if (!audience.guests && !audience.students && !audience.staff && !stages.length && !grades.length) {
    throw new Error('حدّد جمهورًا واحدًا على الأقل للإعلان');
  }

  const startsAtMs = announcementTimeMs(input.starts_at);
  const endsAtMs = announcementTimeMs(input.ends_at);
  if (startsAtMs && endsAtMs && endsAtMs <= startsAtMs) throw new Error('تاريخ نهاية الإعلان يجب أن يكون بعد بدايته');

  return {
    title,
    text,
    image_url: imageUrl,
    action_label: actionLabel,
    action_route: actionRoute,
    audience,
    order: safeParseInt(input.order, 0),
    starts_at: startsAtMs ? Timestamp.fromMillis(startsAtMs) : null,
    ends_at: endsAtMs ? Timestamp.fromMillis(endsAtMs) : null
  };
}

async function findAnnouncementDocById(db, announcementId) {
  const snap = await getDocs(query(
    collection(db, COLLECTIONS.ANNOUNCEMENTS),
    where('id', '==', safeParseInt(announcementId)),
    firestoreLimit(1)
  ));
  if (snap.empty) throw new Error('الإعلان غير موجود');
  return snap.docs[0];
}

async function getActiveAnnouncements(forceRefresh = false) {
  await ensureApiInitialized();
  const db = getDb();

  if (!forceRefresh && announcementsCache && (Date.now() - announcementsCacheAt) < CACHE_TTL.MEDIUM) {
    return announcementsCache.filter(a => isAnnouncementLive(a));
  }
  if (announcementsInflight) return announcementsInflight;

  announcementsInflight = (async () => {
    try {
      // فلتر واحد فقط بدون orderBy كي لا نحتاج فهرسًا مركبًا
      const snapshot = await getDocs(query(
        collection(db, COLLECTIONS.ANNOUNCEMENTS),
        where('is_active', '==', true)
      ));
      announcementsCache = snapshot.docs.map(mapAnnouncement).sort(compareAnnouncements);
      announcementsCacheAt = Date.now();
      return announcementsCache.filter(a => isAnnouncementLive(a));
    } catch (error) {
      console.error('❌ Failed to get active announcements:', error.message);
      return (announcementsCache || []).filter(a => isAnnouncementLive(a));
    } finally {
      announcementsInflight = null;
    }
  })();
  return announcementsInflight;
}

function isAnnouncementLive(announcement, now = Date.now()) {
  const start = announcementTimeMs(announcement.starts_at);
  const end = announcementTimeMs(announcement.ends_at);
  return (!start || start <= now) && (!end || end > now);
}

async function getAllAnnouncements() {
  requireAnnouncementStaff();
  await ensureApiInitialized();
  const db = getDb();
  try {
    const snapshot = await getDocs(collection(db, COLLECTIONS.ANNOUNCEMENTS));
    return snapshot.docs.map(mapAnnouncement).sort(compareAnnouncements);
  } catch (error) {
    console.error('❌ Failed to get announcements:', error.message);
    throw error;
  }
}

async function createAnnouncement(announcementData) {
  const user = requireAnnouncementStaff();
  await ensureApiInitialized();
  const db = getDb();
  const clean = sanitizeAnnouncementInput(announcementData);

  try {
    const newAnnouncement = {
      id: generateUniqueId(),
      ...clean,
      is_active: announcementData?.is_active !== false,
      created_by: user.id,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp()
    };
    await addDoc(collection(db, COLLECTIONS.ANNOUNCEMENTS), newAnnouncement);
    invalidateAnnouncementsCache();
    EventBus.emit('announcements:changed', { action: 'create', id: newAnnouncement.id });
    console.log(`✅ Announcement created: ${newAnnouncement.id}`);
    return newAnnouncement.id;
  } catch (error) {
    console.error('❌ Failed to create announcement:', error.message);
    throw error;
  }
}

async function updateAnnouncement(announcementId, announcementData) {
  requireAnnouncementStaff();
  await ensureApiInitialized();
  const db = getDb();
  const clean = sanitizeAnnouncementInput(announcementData);

  try {
    const docSnap = await findAnnouncementDocById(db, announcementId);
    await updateDoc(docSnap.ref, { ...clean, updated_at: serverTimestamp() });
    invalidateAnnouncementsCache();
    EventBus.emit('announcements:changed', { action: 'update', id: safeParseInt(announcementId) });
    return true;
  } catch (error) {
    console.error('❌ Failed to update announcement:', error.message);
    throw error;
  }
}

async function setAnnouncementActive(announcementId, isActive) {
  requireAnnouncementStaff();
  await ensureApiInitialized();
  const db = getDb();
  try {
    const docSnap = await findAnnouncementDocById(db, announcementId);
    await updateDoc(docSnap.ref, { is_active: !!isActive, active_changed_at: serverTimestamp() });
    invalidateAnnouncementsCache();
    EventBus.emit('announcements:changed', { action: 'toggle', id: safeParseInt(announcementId), is_active: !!isActive });
    return true;
  } catch (error) {
    console.error('❌ Failed to toggle announcement:', error.message);
    throw error;
  }
}

async function deleteAnnouncement(announcementId) {
  requireAnnouncementStaff();
  await ensureApiInitialized();
  const db = getDb();
  try {
    const docSnap = await findAnnouncementDocById(db, announcementId);
    await deleteDoc(docSnap.ref);
    invalidateAnnouncementsCache();
    EventBus.emit('announcements:changed', { action: 'delete', id: safeParseInt(announcementId) });
    return true;
  } catch (error) {
    console.error('❌ Failed to delete announcement:', error.message);
    throw error;
  }
}

// ==== 30. دوال المجموعات ====
const GROUPS_LIMITS = Object.freeze({
  MAX_MEMBERS: 50,
  MAX_NAME: 60,
  MAX_DESCRIPTION: 200,
  MAX_MESSAGE: 1000,
  MESSAGES_PAGE: 40,
  CATALOG_SIZE: 500
});

function normalizeIdList(list) {
  const ids = (Array.isArray(list) ? list : []).map((v) => safeParseInt(v, NaN)).filter(Number.isFinite);
  return [...new Set(ids)];
}

function chunkList(list, size = 10) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

function getGroupRef(db, groupId) {
  return doc(db, COLLECTIONS.GROUPS, String(safeParseInt(groupId)));
}

function mapGroupDoc(snap) {
  const data = snap.data();
  return {
    docId: snap.id,
    id: data.id,
    name: data.name || '',
    description: data.description || '',
    created_by: data.created_by,
    members: normalizeIdList(data.members),
    lessons: normalizeIdList(data.lessons),
    exams: normalizeIdList(data.exams),
    created_at: data.created_at || null,
    updated_at: data.updated_at || null,
    last_message: data.last_message || null
  };
}

function mapGroupMessage(snap) {
  const data = snap.data({ serverTimestamps: 'estimate' });
  return {
    docId: snap.id,
    id: data.id,
    group_id: data.group_id,
    user_id: data.user_id,
    message: data.deleted ? '' : (data.message || ''),
    deleted: Boolean(data.deleted),
    created_at: data.created_at || null,
    pending: snap.metadata.hasPendingWrites
  };
}

function assertCanManageGroup(group) {
  const user = getCurrentUser();
  if (!user) throw new Error('يجب تسجيل الدخول');
  const owner = String(group?.created_by) === String(user.id);
  if (!isTeacher() && !owner) throw new Error('ليس لديك صلاحية على هذه المجموعة');
  return user;
}

async function loadGroupForManage(db, groupId) {
  const snap = await getDoc(getGroupRef(db, groupId));
  if (!snap.exists()) throw new Error('المجموعة غير موجودة');
  const group = mapGroupDoc(snap);
  assertCanManageGroup(group);
  return { ref: snap.ref, group };
}

function validateGroupText({ name, description }) {
  const cleanName = String(name ?? '').trim();
  const cleanDescription = String(description ?? '').trim();
  if (!cleanName) throw new Error('اسم المجموعة مطلوب');
  if (cleanName.length > GROUPS_LIMITS.MAX_NAME) throw new Error(`اسم المجموعة أطول من ${GROUPS_LIMITS.MAX_NAME} حرفًا`);
  if (cleanDescription.length > GROUPS_LIMITS.MAX_DESCRIPTION) throw new Error(`الوصف أطول من ${GROUPS_LIMITS.MAX_DESCRIPTION} حرفًا`);
  return { name: cleanName, description: cleanDescription };
}

async function getUserGroups(userId, options = {}) {
  await ensureApiInitialized();
  const db = getDb();
  try {
    const groupsRef = collection(db, COLLECTIONS.GROUPS);
    const seeAll = options.all === true && isTeacher();
    const q = seeAll
      ? query(groupsRef)
      : query(groupsRef, where('members', 'array-contains', safeParseInt(userId)));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(mapGroupDoc);
  } catch (error) {
    console.error('❌ Failed to get groups:', error.message);
    throw error;
  }
}

async function getGroupById(groupId) {
  await ensureApiInitialized();
  const snap = await getDoc(getGroupRef(getDb(), groupId));
  return snap.exists() ? mapGroupDoc(snap) : null;
}

async function subscribeToGroup(groupId, onData, onError) {
  await ensureApiInitialized();
  return onSnapshot(
    getGroupRef(getDb(), groupId),
    (snap) => onData(snap.exists() ? mapGroupDoc(snap) : null),
    (error) => onError?.(error)
  );
}

async function createGroup(data = {}) {
  await ensureApiInitialized();
  const db = getDb();
  const user = getCurrentUser();
  if (!user || !(isTeacher() || isModerator())) throw new Error('إنشاء المجموعات للمعلم والمشرف فقط');

  const text = validateGroupText(data);
  const members = normalizeIdList([user.id, ...(data.members || [])]);
  if (members.length > GROUPS_LIMITS.MAX_MEMBERS) {
    throw new Error(`الحد الأقصى ${GROUPS_LIMITS.MAX_MEMBERS} عضوًا`);
  }

  const id = generateUniqueId();
  const payload = {
    id,
    ...text,
    created_by: safeParseInt(user.id),
    members,
    lessons: [],
    exams: [],
    last_message: null,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp()
  };

  try {
    await setDoc(getGroupRef(db, id), payload);
    EventBus.emit('groups:changed', { action: 'create', id });
    return { id, ...text, members, created_by: payload.created_by };
  } catch (error) {
    console.error('❌ Failed to create group:', error.message);
    throw error;
  }
}

async function updateGroup(groupId, data = {}) {
  await ensureApiInitialized();
  const db = getDb();
  const text = validateGroupText(data);
  const { ref } = await loadGroupForManage(db, groupId);
  await updateDoc(ref, { ...text, updated_at: serverTimestamp() });
  EventBus.emit('groups:changed', { action: 'update', id: safeParseInt(groupId) });
  return true;
}

async function deleteGroup(groupId) {
  await ensureApiInitialized();
  const db = getDb();
  const { ref } = await loadGroupForManage(db, groupId);
  const messagesRef = collection(db, COLLECTIONS.GROUP_MESSAGES);
  const gid = safeParseInt(groupId);

  for (;;) {
    const snapshot = await getDocs(query(messagesRef, where('group_id', '==', gid), firestoreLimit(400)));
    if (snapshot.empty) break;
    const batch = writeBatch(db);
    snapshot.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  await deleteDoc(ref);
  EventBus.emit('groups:changed', { action: 'delete', id: gid });
  return true;
}

async function addGroupMembers(groupId, userIds) {
  await ensureApiInitialized();
  const db = getDb();
  const ids = normalizeIdList(userIds);
  if (!ids.length) return { added: [] };

  const ref = getGroupRef(db, groupId);
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('المجموعة غير موجودة');
    const group = mapGroupDoc(snap);
    assertCanManageGroup(group);

    const fresh = ids.filter((id) => !group.members.includes(id));
    if (!fresh.length) return { added: [] };
    if (group.members.length + fresh.length > GROUPS_LIMITS.MAX_MEMBERS) {
      throw new Error(`الحد الأقصى ${GROUPS_LIMITS.MAX_MEMBERS} عضوًا`);
    }
    tx.update(ref, { members: [...group.members, ...fresh], updated_at: serverTimestamp() });
    return { added: fresh };
  });

  EventBus.emit('groups:changed', { action: 'members', id: safeParseInt(groupId) });
  return result;
}

async function removeGroupMember(groupId, userId) {
  await ensureApiInitialized();
  const db = getDb();
  const user = getCurrentUser();
  const targetId = safeParseInt(userId);
  const isSelf = user && String(user.id) === String(targetId);

  if (!isSelf && !isTeacher()) {
    const target = await getUserById(targetId);
    if (target?.user_type === 'teacher') throw new Error('لا يمكن إزالة المعلم من المجموعة');
  }

  const ref = getGroupRef(db, groupId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('المجموعة غير موجودة');
    const group = mapGroupDoc(snap);

    if (String(group.created_by) === String(targetId)) throw new Error('لا يمكن إزالة مالك المجموعة');
    if (!isSelf) assertCanManageGroup(group);
    if (!group.members.includes(targetId)) return;

    tx.update(ref, {
      members: group.members.filter((id) => id !== targetId),
      updated_at: serverTimestamp()
    });
  });

  EventBus.emit('groups:changed', { action: 'members', id: safeParseInt(groupId) });
  return true;
}

async function addContentToGroup(groupId, type, ids) {
  await ensureApiInitialized();
  const db = getDb();
  const field = type === 'lesson' ? 'lessons' : type === 'exam' ? 'exams' : null;
  if (!field) throw new Error('نوع المحتوى غير صالح');
  const list = normalizeIdList(ids);
  if (!list.length) return true;

  const { ref } = await loadGroupForManage(db, groupId);
  await updateDoc(ref, { [field]: arrayUnion(...list), updated_at: serverTimestamp() });
  EventBus.emit('groups:changed', { action: 'content', id: safeParseInt(groupId) });
  return true;
}

async function removeContentFromGroup(groupId, type, contentId) {
  await ensureApiInitialized();
  const db = getDb();
  const field = type === 'lesson' ? 'lessons' : type === 'exam' ? 'exams' : null;
  if (!field) throw new Error('نوع المحتوى غير صالح');

  const { ref } = await loadGroupForManage(db, groupId);
  await updateDoc(ref, { [field]: arrayRemove(safeParseInt(contentId)), updated_at: serverTimestamp() });
  EventBus.emit('groups:changed', { action: 'content', id: safeParseInt(groupId) });
  return true;
}

async function subscribeToGroupMessages(groupId, options, onData, onError) {
  await ensureApiInitialized();
  const db = getDb();
  const size = options?.limit || GROUPS_LIMITS.MESSAGES_PAGE;
  const q = query(
    collection(db, COLLECTIONS.GROUP_MESSAGES),
    where('group_id', '==', safeParseInt(groupId)),
    orderBy('created_at', 'desc'),
    firestoreLimit(size)
  );
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snapshot) => onData(snapshot.docs.map(mapGroupMessage).reverse(), { size }),
    (error) => onError?.(error)
  );
}

async function getGroupMessagesBefore(groupId, beforeCreatedAt, size = GROUPS_LIMITS.MESSAGES_PAGE) {
  await ensureApiInitialized();
  const db = getDb();
  const q = query(
    collection(db, COLLECTIONS.GROUP_MESSAGES),
    where('group_id', '==', safeParseInt(groupId)),
    orderBy('created_at', 'desc'),
    startAfter(beforeCreatedAt),
    firestoreLimit(size)
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(mapGroupMessage).reverse();
}

async function sendGroupMessage(groupId, userId, message) {
  await ensureApiInitialized();
  const db = getDb();
  const text = String(message ?? '').trim();
  if (!text) throw new Error('الرسالة فارغة');
  if (text.length > GROUPS_LIMITS.MAX_MESSAGE) throw new Error(`الرسالة أطول من ${GROUPS_LIMITS.MAX_MESSAGE} حرفًا`);

  const gid = safeParseInt(groupId);
  const uid = safeParseInt(userId);
  const messageRef = doc(collection(db, COLLECTIONS.GROUP_MESSAGES));
  const batch = writeBatch(db);

  batch.set(messageRef, {
    id: generateUniqueId(),
    group_id: gid,
    user_id: uid,
    message: text,
    deleted: false,
    created_at: serverTimestamp()
  });
  batch.update(getGroupRef(db, gid), {
    last_message: { text: text.slice(0, 80), user_id: uid, at: serverTimestamp() }
  });

  await batch.commit();
  return true;
}

async function deleteGroupMessage(groupId, messageDocId) {
  await ensureApiInitialized();
  const db = getDb();
  const user = getCurrentUser();
  if (!user) throw new Error('يجب تسجيل الدخول');

  const messageRef = doc(db, COLLECTIONS.GROUP_MESSAGES, String(messageDocId));
  const snap = await getDoc(messageRef);
  if (!snap.exists()) throw new Error('الرسالة غير موجودة');

  const own = String(snap.data().user_id) === String(user.id);
  if (!own) {
    const group = await getGroupById(groupId);
    assertCanManageGroup(group);
  }

  await updateDoc(messageRef, {
    deleted: true,
    message: '',
    deleted_by: safeParseInt(user.id),
    deleted_at: serverTimestamp()
  });
  return true;
}

async function getUsersByIds(userIds) {
  await ensureApiInitialized();
  const db = getDb();
  const ids = normalizeIdList(userIds);
  if (!ids.length) return [];

  const usersRef = collection(db, COLLECTIONS.USERS);
  const snapshots = await Promise.all(
    chunkList(ids).map((chunk) => getDocs(query(usersRef, where('id', 'in', chunk))))
  );

  const users = [];
  snapshots.forEach((snapshot) => {
    snapshot.forEach((d) => {
      const data = d.data();
      users.push({
        id: data.id,
        full_name: data.full_name || '',
        user_type: data.user_type || 'student',
        gender: data.gender,
        avatar_url: data.avatar_url || '',
        avatar_job_index: data.avatar_job_index ?? 0,
        total_score: data.total_score ?? 0,
        is_verified: data.is_verified || false,
        stage: data.stage || '',
        grade: data.grade || ''
      });
    });
  });
  return users;
}

async function getExamsByIds(examIds) {
  await ensureApiInitialized();
  const db = getDb();
  const ids = normalizeIdList(examIds);
  if (!ids.length) return [];

  const lessonsRef = collection(db, COLLECTIONS.LESSONS);
  const snapshots = await Promise.all(
    chunkList(ids).map((chunk) => getDocs(query(lessonsRef, where('id', 'in', chunk))))
  );

  const exams = [];
  snapshots.forEach((snapshot) => {
    snapshot.forEach((d) => {
      const data = d.data();
      if (data.type !== 'exam' || data.deleted_at) return;
      exams.push({
        docId: d.id,
        id: data.id,
        title: data.title,
        description: data.description || '',
        stage: data.stage,
        grade: data.grade,
        semester: data.semester,
        duration: data.duration || 30,
        questions_count: data.questions_count || 0,
        is_challenge: data.is_challenge || false
      });
    });
  });
  return exams;
}

async function getGroupContentCatalog(type) {
  await ensureApiInitialized();
  const db = getDb();
  if (type !== 'lesson' && type !== 'exam') throw new Error('نوع المحتوى غير صالح');

  const q = query(
    collection(db, COLLECTIONS.LESSONS),
    where('type', '==', type),
    where('deleted_at', '==', null),
    firestoreLimit(GROUPS_LIMITS.CATALOG_SIZE)
  );
  const snapshot = await getDocs(q);
  const items = snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: data.id,
      title: data.title || '',
      stage: data.stage || '',
      grade: data.grade ?? '',
      semester: data.semester || '',
      created_ms: data.created_at?.toMillis?.() || 0
    };
  });
  return items.sort((a, b) => b.created_ms - a.created_ms);
}

// ==== 31. أبطال الصفحة الرئيسية ====
const HOME_CHAMPIONS_LIMITS = Object.freeze({ MAX: 20 });

function mapChampionData(data) {
  return {
    id: data.id,
    username: data.username,
    full_name: data.full_name,
    gender: data.gender,
    total_score: data.total_score || 0,
    user_type: 'student',
    avatar_url: data.avatar_url || '',
    avatar_job_index: data.avatar_job_index ?? -1,
    is_verified: data.is_verified || false
  };
}

function assertCanManageChampions() {
  if (!(isTeacher() || isModerator())) throw new Error('اختيار الأبطال للمعلم والمشرف فقط');
}

async function getHomeChampions(count = 6) {
  await ensureApiInitialized();
  const db = getDb();

  try {
    const curatedSnap = await getDocs(query(
      collection(db, COLLECTIONS.USERS),
      where('champion_order', '>', 0),
      orderBy('champion_order', 'asc'),
      firestoreLimit(HOME_CHAMPIONS_LIMITS.MAX)
    ));

    const curated = curatedSnap.docs
      .map((d) => d.data())
      .filter((data) => data.user_type === 'student')
      .map(mapChampionData);

    if (curated.length) return { mode: 'manual', champions: curated.slice(0, count) };
    return { mode: 'auto', champions: await getTopStudents(count) };
  } catch (error) {
    console.error('❌ Failed to get home champions:', error.message);
    throw error;
  }
}

async function saveHomeChampions(userIds) {
  await ensureApiInitialized();
  assertCanManageChampions();
  const db = getDb();

  const ids = normalizeIdList(userIds);
  if (!ids.length) throw new Error('اختر بطلًا واحدًا على الأقل أو أعد الوضع التلقائي');
  if (ids.length > HOME_CHAMPIONS_LIMITS.MAX) throw new Error(`الحد الأقصى ${HOME_CHAMPIONS_LIMITS.MAX} بطلًا`);

  const usersRef = collection(db, COLLECTIONS.USERS);
  const [currentSnap, ...targetSnaps] = await Promise.all([
    getDocs(query(usersRef, where('champion_order', '>', 0))),
    ...chunkList(ids).map((chunk) => getDocs(query(usersRef, where('id', 'in', chunk))))
  ]);

  const targets = new Map();
  targetSnaps.forEach((snapshot) => snapshot.forEach((d) => {
    const data = d.data();
    if (data.user_type === 'student') targets.set(Number(data.id), d.ref);
  }));
  if (ids.some((id) => !targets.has(id))) throw new Error('بعض الطلاب المختارين غير متاحين');

  const batch = writeBatch(db);
  currentSnap.forEach((d) => {
    if (!ids.includes(Number(d.data().id))) batch.update(d.ref, { champion_order: 0 });
  });
  ids.forEach((id, index) => batch.update(targets.get(id), { champion_order: index + 1 }));

  await batch.commit();
  EventBus.emit('champions:changed', { mode: 'manual' });
  return true;
}

async function resetHomeChampions() {
  await ensureApiInitialized();
  assertCanManageChampions();
  const db = getDb();

  const snapshot = await getDocs(query(collection(db, COLLECTIONS.USERS), where('champion_order', '>', 0)));
  if (!snapshot.empty) {
    const batch = writeBatch(db);
    snapshot.forEach((d) => batch.update(d.ref, { champion_order: 0 }));
    await batch.commit();
  }

  EventBus.emit('champions:changed', { mode: 'auto' });
  return true;
}

// ==== 32. التصدير ====
export {
  initializeApi,

  loginUser,
  registerUser,
  checkPhoneExists,
  getUserById,
  updateUserPreferences,
  updateUserLikesGiven,
  incrementUserCommentsCount,
  updateUserProfile,
  updateLegacyUsers,
  convertUserType,
  checkDatabaseCompatibility,

  recalculateUserTotalScore,

  getAllLessons,
  getLessonById,
  getLessonsByIds,
  toggleLessonLike,
  getLessonsCount,
  searchLessons,
  rateLesson,
  exportLesson,
  importLesson,
  getLessonStats,
  
  getExamById,
  saveExamResult,
  createExam,
  updateExam,
  deleteExam,
  getExams,
  getExamFullData,
  moveExam,
  getExamByLessonId,

  updateUserProgress,
  updateUserExamScore,
  getUserProgress,
  updateUserStreak,

  getUserFavorites,
  syncUserFavorites,

  addComment,
  getComments,
  getPinnedComment,
  getRootCommentsCount,
  getCommentReplies,
  toggleCommentLike,
  softDeleteComment,
  updateComment,
  pinComment,
  canEditComment,

  createNotification,
  getUserNotifications,
  sendNotification,
  sendBulkNotifications,
  markNotificationRead,
  deleteNotification,
  clearAllUserNotifications,

  addTestimonial,
  getTopStudents,
  getPlatformStats,
  getUserByPhone,
  searchUsers,

  getUnits,
  createUnit,
  updateUnit,
  deleteUnit,

  getSemesterSettings,
  getActiveSemesterFor,
  setActiveSemester,

  createLesson,
  updateLesson,
  deleteLesson,
  getLessonFullData,
  moveLesson,
  
  updateUserPassword,
  deleteUserAccount,
  
  getUserExamStats,
  getUserExamResultsMap,

  getUserProfile,
  getUserStats,
  getUserMedals,
  getLearningJourney,
  getUserActivity,
  getPerformanceBreakdown,
  invalidateProfileCache,
  COLLECTIONS,
  getModeratorsList,
  updateModeratorLevel,
  deleteModerator,
  getTrashItems,
  restoreTrashItem,
  permanentlyDeleteTrashItem,
  getAllStudents,
  updateStudentAccount,
  addModerator,

  getComplaints,
  getPendingComplaintsCount,
  createComplaint,
  updateComplaintStatus,
  replyToComplaint,

  getWeeklyActivityStats,
  getExamPerformanceStats,

  ANNOUNCEMENT_ACTION_ROUTES,
  getActiveAnnouncements,
  getAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  setAnnouncementActive,
  deleteAnnouncement,

  GROUPS_LIMITS,
  getUserGroups,
  getGroupById,
  subscribeToGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  addGroupMembers,
  removeGroupMember,
  addContentToGroup,
  removeContentFromGroup,
  subscribeToGroupMessages,
  getGroupMessagesBefore,
  sendGroupMessage,
  deleteGroupMessage,
  getUsersByIds,
  getExamsByIds,
  getGroupContentCatalog,

  HOME_CHAMPIONS_LIMITS,
  getHomeChampions,
  saveHomeChampions,
  resetHomeChampions
};
