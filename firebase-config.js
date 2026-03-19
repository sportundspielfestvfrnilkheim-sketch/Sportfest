// firebase-config.js
// Lädt die Firebase-Konfiguration aus localStorage und initialisiert Firebase

window.db = null;
window.firebaseReady = false;

function getStoredConfig() {
  try {
    const raw = localStorage.getItem('sportfest_firebase_config');
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

function initFirebase(config) {
  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(config);
    }
    window.db = firebase.firestore();
    window.firebaseReady = true;
    return true;
  } catch(e) {
    console.error('Firebase init error:', e);
    return false;
  }
}

// Auto-init if config exists
(function() {
  const cfg = getStoredConfig();
  if (cfg && cfg.apiKey && cfg.projectId) {
    initFirebase(cfg);
  }
})();
