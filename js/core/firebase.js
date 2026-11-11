/* تهيئة اتصال Firebase Firestore بدون مصادقة - v5.0.0 */

// ==== 1. الاستيراد ====
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.5.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js";

// ==== 2. إعدادات Firebase ====
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBUHB1n59dPMVmAs8fbj8S6IFnUoW7xTeg",
  authDomain: "biologist-ca11b.firebaseapp.com",
  projectId: "biologist-ca11b",
  storageBucket: "biologist-ca11b.appspot.com",
  messagingSenderId: "635324645033",
  appId: "1:635324645033:web:8ee0fffacfa0cb50d7b3b8"
};

// ==== 3. الحالة الداخلية ====
let firebaseApp = null;
let firestoreDb = null;
let initializationPromise = null;

// ==== 4. التهيئة ====
async function initializeFirebase() {
  if (firestoreDb) return firestoreDb;
  
  if (!initializationPromise) {
    initializationPromise = (async () => {
      try {
        firebaseApp = initializeApp(FIREBASE_CONFIG);
        firestoreDb = getFirestore(firebaseApp);
        
        const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js");
        try {
          await getDocs(collection(firestoreDb, 'connection_test'));
        } catch (e) {
          if (e.code !== 'permission-denied') throw e;
        }
        
        console.log('✅ Firebase Firestore initialized successfully');
        return firestoreDb;
      } catch (error) {
        console.error('❌ Firebase initialization failed:', error);
        initializationPromise = null;
        throw error;
      }
    })();
  }
  
  return initializationPromise;
}

// ==== 5. الوصول إلى النسخة ====
function getFirestoreInstance() {
  if (!firestoreDb) {
    throw new Error('Firestore not initialized. Call initializeFirebase() first.');
  }
  return firestoreDb;
}

// ==== 6. التصدير ====
export { initializeFirebase, getFirestoreInstance };