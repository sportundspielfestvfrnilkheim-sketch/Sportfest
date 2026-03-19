// app.js – Sportfest Hauptlogik

// ===== INIT =====
window.addEventListener('DOMContentLoaded', async () => {
  const cfg = getStoredConfig();
  if (!cfg || !cfg.apiKey) {
    showScreen('screen-setup');
    return;
  }
  if (!window.firebaseReady) {
    showScreen('screen-setup');
    return;
  }
  // Check URL params for deep links
  const params = new URLSearchParams(window.location.search);
  const riegeToken = params.get('riege');
  if (riegeToken) {
    await openRiegeByToken(riegeToken);
    return;
  }
  showScreen('screen-home');
  buildSprintConfig();
});

// ===== SCREEN ROUTER =====
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ===== SETUP =====
async function saveConfig() {
  const config = {
    apiKey: document.getElementById('cfg-apiKey').value.trim(),
    authDomain: document.getElementById('cfg-authDomain').value.trim(),
    projectId: document.getElementById('cfg-projectId').value.trim(),
    storageBucket: document.getElementById('cfg-storageBucket').value.trim(),
    messagingSenderId: document.getElementById('cfg-messagingSenderId').value.trim(),
    appId: document.getElementById('cfg-appId').value.trim(),
  };
  const pw = document.getElementById('cfg-password').value;
  const err = document.getElementById('setup-error');

  if (!config.apiKey || !config.projectId) {
    err.textContent = 'Bitte API Key und Project ID eintragen.';
    err.style.display = 'block'; return;
  }
  if (!pw || pw.length < 4) {
    err.textContent = 'Bitte ein Passwort mit mindestens 4 Zeichen wählen.';
    err.style.display = 'block'; return;
  }

  localStorage.setItem('sportfest_firebase_config', JSON.stringify(config));
  const ok = initFirebase(config);
  if (!ok) {
    err.textContent = 'Firebase konnte nicht initialisiert werden. Konfiguration prüfen.';
    err.style.display = 'block'; return;
  }

  // Save password hash to Firestore
  try {
    await db.collection('config').doc('admin').set({ passwordHash: simpleHash(pw) });
    await db.collection('config').doc('settings').set({ minRiegeSize: 6 });
    showScreen('screen-home');
    buildSprintConfig();
  } catch(e) {
    err.textContent = 'Fehler beim Speichern: ' + e.message;
    err.style.display = 'block';
  }
}

function resetConfig() {
  if (confirm('Firebase-Konfiguration wirklich zurücksetzen? Die App muss neu eingerichtet werden.')) {
    localStorage.removeItem('sportfest_firebase_config');
    location.reload();
  }
}

// ===== SIMPLE HASH (not cryptographic, sufficient for local use) =====
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

// ===== KIND ANMELDEN =====
async function registerChild() {
  const vorname = document.getElementById('reg-vorname').value.trim();
  const nachname = document.getElementById('reg-nachname').value.trim();
  const jahrgang = document.getElementById('reg-jahrgang').value;
  const geschlecht = document.querySelector('input[name="geschlecht"]:checked')?.value;
  const datenschutz = document.getElementById('reg-datenschutz').checked;
  const msg = document.getElementById('register-msg');

  if (!vorname || !nachname) { showMsg(msg, 'Bitte Vor- und Nachname eintragen.', 'error'); return; }
  if (!jahrgang) { showMsg(msg, 'Bitte Jahrgang wählen.', 'error'); return; }
  if (!geschlecht) { showMsg(msg, 'Bitte Geschlecht wählen.', 'error'); return; }
  if (!datenschutz) { showMsg(msg, 'Bitte der Datenverarbeitung zustimmen.', 'error'); return; }

  try {
    await db.collection('kinder').add({
      vorname, nachname, jahrgang, geschlecht,
      angemeldetAm: new Date().toISOString(),
      riegeId: null,
      ergebnisse: {}
    });
    showMsg(msg, `✓ ${vorname} ${nachname} wurde erfolgreich angemeldet!`, 'success');
    document.getElementById('reg-vorname').value = '';
    document.getElementById('reg-nachname').value = '';
    document.getElementById('reg-jahrgang').value = '';
    document.querySelectorAll('input[name="geschlecht"]').forEach(r => r.checked = false);
    document.getElementById('reg-datenschutz').checked = false;
  } catch(e) {
    showMsg(msg, 'Fehler: ' + e.message, 'error');
  }
}

// ===== RIEGENFÜHRER LOGIN =====
async function loginRiege() {
  const token = document.getElementById('riege-token').value.trim().toUpperCase();
  const err = document.getElementById('riege-login-error');
  if (!token) { err.textContent = 'Bitte Code eingeben.'; err.style.display = 'block'; return; }
  await openRiegeByToken(token);
}

async function openRiegeByToken(token) {
  try {
    const snap = await db.collection('riegen').where('token', '==', token).get();
    if (snap.empty) {
      const err = document.getElementById('riege-login-error');
      if (err) { err.textContent = 'Riege nicht gefunden. Code prüfen.'; err.style.display = 'block'; }
      showScreen('screen-riege-login');
      return;
    }
    const riegeDoc = snap.docs[0];
    await renderRiege(riegeDoc.id, riegeDoc.data());
    showScreen('screen-riege');
  } catch(e) {
    const err = document.getElementById('riege-login-error');
    if (err) { err.textContent = 'Fehler: ' + e.message; err.style.display = 'block'; }
    showScreen('screen-riege-login');
  }
}

// ===== RIEGE RENDER =====
async function renderRiege(riegeId, riegeData) {
  document.getElementById('riege-header-name').textContent = riegeData.name || 'Riege';
  const jg = riegeData.jahrgaenge ? riegeData.jahrgaenge.join(', ') : (riegeData.jahrgang || '');
  const gesch = riegeData.geschlechter ? riegeData.geschlechter.join('/') : (riegeData.geschlecht === 'm' ? 'Männlich' : riegeData.geschlecht === 'w' ? 'Weiblich' : riegeData.geschlecht || '');
  document.getElementById('riege-header-sub').textContent = `Jahrgang ${jg} · ${gesch}`;

  // Load sprint config
  const sprintCfg = await getSprintConfig();

  // Load children for this Riege
  const kindSnap = await db.collection('kinder').where('riegeId', '==', riegeId).get();
  const kinder = kindSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Sort by name
  kinder.sort((a, b) => a.nachname.localeCompare(b.nachname));

  const liste = document.getElementById('riege-kinder-liste');
  if (kinder.length === 0) {
    liste.innerHTML = '<p style="color:var(--gray-500);text-align:center;padding:32px">Noch keine Kinder in dieser Riege.</p>';
    return;
  }

  liste.innerHTML = kinder.map(kind => {
    const sprint = sprintCfg[kind.jahrgang] || '50m';
    const e = kind.ergebnisse || {};
    return `
    <div class="kind-karte" id="karte-${kind.id}">
      <div class="kind-karte-header">
        <div>
          <div class="kind-name">${kind.vorname} ${kind.nachname}</div>
          <div class="kind-meta">Jg. ${kind.jahrgang} · ${kind.geschlecht === 'm' ? '♂' : '♀'}</div>
        </div>
        <span class="kind-saved-badge" id="badge-${kind.id}" style="display:none">✓ Gespeichert</span>
      </div>

      <div class="disziplin-section">
        <div class="disziplin-title">🎯 Wurf (3 Versuche) — bester zählt</div>
        ${[1,2,3].map(v => `
        <div class="versuch-row">
          <span class="versuch-label">Versuch ${v}</span>
          <input class="versuch-input" type="number" step="0.01" min="0" placeholder="0.00 m"
            id="wurf-${kind.id}-${v}" value="${(e.wurf && e.wurf['v'+v]) || ''}"
            oninput="updateBest('wurf','${kind.id}')">
        </div>`).join('')}
        <div style="text-align:right;font-size:12px;color:var(--primary);font-weight:600;margin-top:4px">
          Bester: <span id="best-wurf-${kind.id}">${getBestValue(e.wurf) || '—'}</span> m
        </div>
      </div>

      <div class="disziplin-section">
        <div class="disziplin-title">🏃 Sprint (${sprint}) — Zeit in Sekunden</div>
        <div class="versuch-row">
          <span class="versuch-label">Zeit</span>
          <input class="versuch-input" type="number" step="0.01" min="0" placeholder="0.00 s"
            id="sprint-${kind.id}" value="${e.sprint || ''}">
        </div>
      </div>

      <div class="disziplin-section">
        <div class="disziplin-title">↔️ Weitsprung (3 Versuche) — bester zählt</div>
        ${[1,2,3].map(v => `
        <div class="versuch-row">
          <span class="versuch-label">Versuch ${v}</span>
          <input class="versuch-input" type="number" step="0.01" min="0" placeholder="0.00 m"
            id="weitsprung-${kind.id}-${v}" value="${(e.weitsprung && e.weitsprung['v'+v]) || ''}"
            oninput="updateBest('weitsprung','${kind.id}')">
        </div>`).join('')}
        <div style="text-align:right;font-size:12px;color:var(--primary);font-weight:600;margin-top:4px">
          Bester: <span id="best-weitsprung-${kind.id}">${getBestValue(e.weitsprung) || '—'}</span> m
        </div>
      </div>

      <button class="save-kind-btn" onclick="saveKindErgebnisse('${kind.id}')">💾 Ergebnisse speichern</button>
    </div>`;
  }).join('');

  // Init best values display
  kinder.forEach(kind => {
    updateBest('wurf', kind.id);
    updateBest('weitsprung', kind.id);
  });
}

function getBestValue(obj) {
  if (!obj) return null;
  const vals = [obj.v1, obj.v2, obj.v3].filter(v => v !== undefined && v !== null && v !== '').map(Number);
  if (vals.length === 0) return null;
  return Math.max(...vals).toFixed(2);
}

function updateBest(disziplin, kindId) {
  const vals = [1,2,3].map(v => {
    const el = document.getElementById(`${disziplin}-${kindId}-${v}`);
    return el ? parseFloat(el.value) : NaN;
  }).filter(v => !isNaN(v));
  const bestEl = document.getElementById(`best-${disziplin}-${kindId}`);
  if (bestEl) {
    bestEl.textContent = vals.length > 0 ? Math.max(...vals).toFixed(2) : '—';
  }
}

async function saveKindErgebnisse(kindId) {
  const wurf = {
    v1: parseFloatOrNull(document.getElementById(`wurf-${kindId}-1`)?.value),
    v2: parseFloatOrNull(document.getElementById(`wurf-${kindId}-2`)?.value),
    v3: parseFloatOrNull(document.getElementById(`wurf-${kindId}-3`)?.value),
  };
  const weitsprung = {
    v1: parseFloatOrNull(document.getElementById(`weitsprung-${kindId}-1`)?.value),
    v2: parseFloatOrNull(document.getElementById(`weitsprung-${kindId}-2`)?.value),
    v3: parseFloatOrNull(document.getElementById(`weitsprung-${kindId}-3`)?.value),
  };
  const sprint = parseFloatOrNull(document.getElementById(`sprint-${kindId}`)?.value);

  try {
    await db.collection('kinder').doc(kindId).update({
      ergebnisse: { wurf, weitsprung, sprint }
    });
    const badge = document.getElementById(`badge-${kindId}`);
    if (badge) { badge.style.display = 'inline'; setTimeout(() => badge.style.display = 'none', 2000); }
  } catch(e) {
    alert('Fehler beim Speichern: ' + e.message);
  }
}

function parseFloatOrNull(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// ===== ADMIN =====
let adminLoggedIn = false;

function showAdminLogin() { showScreen('screen-admin-login'); }

async function adminLogin() {
  const pw = document.getElementById('admin-pw-input').value;
  const err = document.getElementById('admin-login-error');
  try {
    const doc = await db.collection('config').doc('admin').get();
    if (!doc.exists) { err.textContent = 'Admin nicht konfiguriert.'; err.style.display = 'block'; return; }
    if (doc.data().passwordHash === simpleHash(pw)) {
      adminLoggedIn = true;
      showScreen('screen-admin');
      adminTab('anmeldungen');
      loadAdminAnmeldungen();
      loadAdminRiegen();
      buildSprintConfig();
    } else {
      err.textContent = 'Falsches Passwort.'; err.style.display = 'block';
    }
  } catch(e) { err.textContent = 'Fehler: ' + e.message; err.style.display = 'block'; }
}

function adminLogout() {
  adminLoggedIn = false;
  document.getElementById('admin-pw-input').value = '';
  showScreen('screen-home');
}

function adminTab(name) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.admin-tab[onclick="adminTab('${name}')"]`).classList.add('active');
  document.getElementById(`admin-tab-${name}`).classList.add('active');
  if (name === 'anmeldungen') loadAdminAnmeldungen();
  if (name === 'riegen') loadAdminRiegen();
  if (name === 'auswertung') calcAuswertung();
  if (name === 'einstellungen') loadSettings();
}

async function loadAdminAnmeldungen() {
  const liste = document.getElementById('admin-anmeldungen-liste');
  liste.innerHTML = '<p style="color:var(--gray-500);font-size:14px">Lädt…</p>';
  try {
    const snap = await db.collection('kinder').orderBy('nachname').get();
    if (snap.empty) { liste.innerHTML = '<p style="color:var(--gray-500)">Noch keine Anmeldungen.</p>'; return; }
    const rows = snap.docs.map(d => {
      const k = d.data();
      return `<tr>
        <td>${k.nachname}, ${k.vorname}</td>
        <td>${k.jahrgang}</td>
        <td>${k.geschlecht === 'm' ? 'Männlich' : 'Weiblich'}</td>
        <td>${k.riegeId ? '✓ Riege' : '—'}</td>
        <td><button class="btn btn-sm btn-danger" style="padding:4px 10px" onclick="deleteKind('${d.id}')">✕</button></td>
      </tr>`;
    }).join('');
    liste.innerHTML = `<div class="table-wrap"><table class="anmeldung-table">
      <thead><tr><th>Name</th><th>Jahrgang</th><th>Geschlecht</th><th>Riege</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div><p style="font-size:12px;color:var(--gray-500);margin-top:8px">${snap.size} Kinder angemeldet</p>`;
  } catch(e) { liste.innerHTML = '<p class="error-msg">Fehler: ' + e.message + '</p>'; }
}

async function deleteKind(id) {
  if (!confirm('Kind wirklich löschen?')) return;
  await db.collection('kinder').doc(id).delete();
  loadAdminAnmeldungen();
}

// ===== RIEGEN VERWALTUNG =====
async function autoGenerateRiegen() {
  if (!confirm('Riegen automatisch aus den Anmeldungen generieren? Bestehende Riegen werden dabei neu befüllt.')) return;
  try {
    const kindSnap = await db.collection('kinder').get();
    const kinder = kindSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Group by jahrgang + geschlecht
    const groups = {};
    kinder.forEach(k => {
      const key = `${k.jahrgang}-${k.geschlecht}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(k);
    });

    // Check existing riegen
    const riegenSnap = await db.collection('riegen').get();
    const existingRiegen = {};
    riegenSnap.docs.forEach(d => {
      const data = d.data();
      const key = `${data.jahrgang}-${data.geschlecht}`;
      existingRiegen[key] = { id: d.id, ...data };
    });

    const batch = db.batch();

    for (const [key, kidsInGroup] of Object.entries(groups)) {
      const [jahrgang, geschlecht] = key.split('-');
      let riegeId;
      if (existingRiegen[key]) {
        riegeId = existingRiegen[key].id;
      } else {
        const riegeRef = db.collection('riegen').doc();
        riegeId = riegeRef.id;
        const token = generateToken();
        batch.set(riegeRef, {
          name: `Riege ${jahrgang} ${geschlecht === 'm' ? 'Knaben' : 'Mädchen'}`,
          jahrgang, geschlecht,
          jahrgaenge: [jahrgang],
          geschlechter: [geschlecht === 'm' ? 'Männlich' : 'Weiblich'],
          token,
          createdAt: new Date().toISOString()
        });
      }
      kidsInGroup.forEach(k => {
        batch.update(db.collection('kinder').doc(k.id), { riegeId });
      });
    }

    await batch.commit();
    await loadAdminRiegen();
    alert('Riegen wurden erfolgreich generiert!');
  } catch(e) { alert('Fehler: ' + e.message); }
}

async function loadAdminRiegen() {
  const liste = document.getElementById('admin-riegen-liste');
  const warnDiv = document.getElementById('riegen-warnungen');
  liste.innerHTML = '<p style="color:var(--gray-500);font-size:14px">Lädt…</p>';
  warnDiv.innerHTML = '';

  try {
    const settingsDoc = await db.collection('config').doc('settings').get();
    const minSize = settingsDoc.exists ? (settingsDoc.data().minRiegeSize || 6) : 6;

    const riegenSnap = await db.collection('riegen').orderBy('jahrgang').get();
    if (riegenSnap.empty) { liste.innerHTML = '<p style="color:var(--gray-500)">Noch keine Riegen. Klicke "Riegen automatisch generieren".</p>'; return; }

    const riegenHTML = [];
    for (const doc of riegenSnap.docs) {
      const r = doc.data();
      const kindSnap = await db.collection('kinder').where('riegeId', '==', doc.id).get();
      const kinder = kindSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const appUrl = `${window.location.origin}${window.location.pathname}?riege=${r.token}`;

      if (kinder.length < minSize) {
        warnDiv.innerHTML += `<div class="warning-badge">⚠️ ${r.name}: Nur ${kinder.length} Kind(er) — Minimum ist ${minSize}</div>`;
      }

      riegenHTML.push(`
      <div class="riege-karte">
        <div class="riege-karte-header">
          <div>
            <div class="riege-karte-title">${r.name}</div>
            <div class="riege-karte-meta">Jg. ${r.jahrgang || (r.jahrgaenge||[]).join(', ')} · ${r.geschlecht === 'm' ? 'Knaben' : r.geschlecht === 'w' ? 'Mädchen' : (r.geschlechter||[]).join('/')} · ${kinder.length} Kinder</div>
          </div>
          <div class="riege-actions">
            <button class="btn btn-sm btn-outline" onclick="printQR('${doc.id}')">Drucken</button>
            <button class="btn btn-sm btn-danger" onclick="deleteRiege('${doc.id}')">Löschen</button>
          </div>
        </div>
        <div class="qr-container">
          <div class="qr-code-wrap" id="qr-${doc.id}"></div>
          <div class="qr-info">
            <div class="qr-token">${r.token}</div>
            <div style="font-size:12px;color:var(--gray-500);margin-top:4px">Code für Riegenführer</div>
          </div>
        </div>
        <div class="riege-kind-liste">
          ${kinder.length === 0 ? '<p style="color:var(--gray-500);font-size:13px">Keine Kinder zugeordnet</p>' :
            kinder.map(k => `<div class="riege-kind-item">
              <span>${k.nachname}, ${k.vorname} (${k.jahrgang})</span>
              <button style="font-size:12px;background:none;border:none;color:var(--danger);cursor:pointer" onclick="removeFromRiege('${k.id}')">Entfernen</button>
            </div>`).join('')}
        </div>
      </div>`);
    }
    liste.innerHTML = riegenHTML.join('');

    // Render QR codes
    riegenSnap.docs.forEach(doc => {
      const r = doc.data();
      const appUrl = `${window.location.origin}${window.location.pathname}?riege=${r.token}`;
      const qrEl = document.getElementById(`qr-${doc.id}`);
      if (qrEl && typeof QRCode !== 'undefined') {
        qrEl.innerHTML = '';
        new QRCode(qrEl, { text: appUrl, width: 80, height: 80, correctLevel: QRCode.CorrectLevel.M });
      }
    });

    // Populate merge selects
    const selects = ['merge-r1', 'merge-r2'];
    selects.forEach(selId => {
      const sel = document.getElementById(selId);
      sel.innerHTML = riegenSnap.docs.map(d => `<option value="${d.id}">${d.data().name}</option>`).join('');
    });

  } catch(e) { liste.innerHTML = '<p class="error-msg">Fehler: ' + e.message + '</p>'; }
}

async function removeFromRiege(kindId) {
  await db.collection('kinder').doc(kindId).update({ riegeId: null });
  loadAdminRiegen();
}

async function deleteRiege(riegeId) {
  if (!confirm('Riege löschen? Kinder werden keiner Riege mehr zugeordnet.')) return;
  const kindSnap = await db.collection('kinder').where('riegeId', '==', riegeId).get();
  const batch = db.batch();
  kindSnap.docs.forEach(d => batch.update(d.ref, { riegeId: null }));
  batch.delete(db.collection('riegen').doc(riegeId));
  await batch.commit();
  loadAdminRiegen();
}

function showMergeArea() {
  document.getElementById('merge-area').style.display = 'block';
}

async function mergeRiegen() {
  const r1 = document.getElementById('merge-r1').value;
  const r2 = document.getElementById('merge-r2').value;
  if (r1 === r2) { alert('Bitte zwei verschiedene Riegen wählen.'); return; }

  const r1Doc = await db.collection('riegen').doc(r1).get();
  const r2Doc = await db.collection('riegen').doc(r2).get();
  const r1Data = r1Doc.data();
  const r2Data = r2Doc.data();

  // Merge metadata
  const jahrgaenge = [...new Set([...(r1Data.jahrgaenge || [r1Data.jahrgang]), ...(r2Data.jahrgaenge || [r2Data.jahrgang])])].filter(Boolean).sort();
  const geschlechter = [...new Set([...(r1Data.geschlechter || [r1Data.geschlecht === 'm' ? 'Männlich' : 'Weiblich']), ...(r2Data.geschlechter || [r2Data.geschlecht === 'm' ? 'Männlich' : 'Weiblich'])])].filter(Boolean);

  const newName = `Riege ${jahrgaenge.join('/')} ${geschlechter.join('/')}`;

  const batch = db.batch();
  batch.update(db.collection('riegen').doc(r1), { name: newName, jahrgaenge, geschlechter });
  const kindSnap = await db.collection('kinder').where('riegeId', '==', r2).get();
  kindSnap.docs.forEach(d => batch.update(d.ref, { riegeId: r1 }));
  batch.delete(db.collection('riegen').doc(r2));
  await batch.commit();
  document.getElementById('merge-area').style.display = 'none';
  loadAdminRiegen();
  alert(`Riegen zusammengelegt: ${newName}`);
}

function printQR(riegeId) {
  window.print();
}

// ===== AUSWERTUNG =====
async function calcAuswertung() {
  const out = document.getElementById('auswertung-output');
  out.innerHTML = '<p style="color:var(--gray-500)">Berechne…</p>';

  try {
    const riegenSnap = await db.collection('riegen').orderBy('jahrgang').get();
    const settingsDoc = await db.collection('config').doc('settings').get();
    const sprintCfg = await getSprintConfig();
    const punkteTabelle = settingsDoc.exists ? (settingsDoc.data().punkteTabelle || {}) : {};

    if (riegenSnap.empty) { out.innerHTML = '<p style="color:var(--gray-500)">Noch keine Riegen vorhanden.</p>'; return; }

    let html = '';
    for (const riegeDoc of riegenSnap.docs) {
      const r = riegeDoc.data();
      const kindSnap = await db.collection('kinder').where('riegeId', '==', riegeDoc.id).get();
      const kinder = kindSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const results = kinder.map(k => {
        const e = k.ergebnisse || {};
        const bestWurf = getBestValueNum(e.wurf);
        const bestWeitsprung = getBestValueNum(e.weitsprung);
        const sprintZeit = e.sprint || null;
        const gesamtPunkte = calcPunkte(k.jahrgang, k.geschlecht, bestWurf, bestWeitsprung, sprintZeit, punkteTabelle);
        return { ...k, bestWurf, bestWeitsprung, sprintZeit, gesamtPunkte };
      }).sort((a, b) => b.gesamtPunkte - a.gesamtPunkte);

      const medals = ['🥇', '🥈', '🥉'];
      const rows = results.map((k, i) => {
        const rowClass = i < 3 ? `rang-${i+1}` : '';
        return `<tr class="${rowClass}">
          <td>${i < 3 ? `<span class="medal">${medals[i]}</span>` : (i+1) + '.'}</td>
          <td>${k.nachname}, ${k.vorname}</td>
          <td>${k.jahrgang} ${k.geschlecht === 'm' ? '♂' : '♀'}</td>
          <td>${k.bestWurf !== null ? k.bestWurf.toFixed(2) + ' m' : '—'}</td>
          <td>${k.bestWeitsprung !== null ? k.bestWeitsprung.toFixed(2) + ' m' : '—'}</td>
          <td>${k.sprintZeit !== null ? k.sprintZeit.toFixed(2) + ' s' : '—'}</td>
          <td><strong>${k.gesamtPunkte}</strong></td>
        </tr>`;
      }).join('');

      html += `<div class="auswertung-riege">
        <h4>${r.name}</h4>
        <div style="overflow-x:auto"><table class="auswertung-table">
          <thead><tr><th>Rang</th><th>Name</th><th>Jg.</th><th>Wurf</th><th>Weitsprung</th><th>Sprint</th><th>Punkte</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    }
    out.innerHTML = html || '<p style="color:var(--gray-500)">Keine Daten.</p>';
  } catch(e) { out.innerHTML = '<p class="error-msg">Fehler: ' + e.message + '</p>'; }
}

function getBestValueNum(obj) {
  if (!obj) return null;
  const vals = [obj.v1, obj.v2, obj.v3].filter(v => v !== null && v !== undefined).map(Number).filter(v => !isNaN(v));
  return vals.length > 0 ? Math.max(...vals) : null;
}

function calcPunkte(jahrgang, geschlecht, wurf, weitsprung, sprint, tabelle) {
  // Placeholder: when Punktetabelle is not yet configured, return raw values sum
  const key = `${jahrgang}-${geschlecht}`;
  if (tabelle && tabelle[key]) {
    const t = tabelle[key];
    const pw = lookupPunkte(t.wurf, wurf);
    const pws = lookupPunkte(t.weitsprung, weitsprung);
    const ps = lookupPunkteInv(t.sprint, sprint); // lower time = more points
    return pw + pws + ps;
  }
  // No table yet: sum of raw values (as placeholder)
  return (wurf || 0) + (weitsprung || 0) + (sprint ? 0 : 0);
}

function lookupPunkte(tableArr, value) {
  if (!tableArr || value === null || value === undefined) return 0;
  let pts = 0;
  for (const row of tableArr) {
    if (value >= row.wert) pts = row.punkte;
  }
  return pts;
}

function lookupPunkteInv(tableArr, value) {
  if (!tableArr || value === null || value === undefined) return 0;
  let pts = 0;
  for (const row of tableArr) {
    if (value <= row.wert) pts = row.punkte;
  }
  return pts;
}

// ===== SETTINGS =====
async function loadSettings() {
  try {
    const doc = await db.collection('config').doc('settings').get();
    if (doc.exists) {
      const s = doc.data();
      if (s.minRiegeSize) document.getElementById('min-riege-size').value = s.minRiegeSize;
    }
  } catch(e) {}
  buildSprintConfig();
}

async function changePassword() {
  const pw1 = document.getElementById('new-pw').value;
  const pw2 = document.getElementById('new-pw2').value;
  const msg = document.getElementById('pw-change-msg');
  if (pw1.length < 4) { showMsg(msg, 'Passwort muss mindestens 4 Zeichen haben.', 'error'); return; }
  if (pw1 !== pw2) { showMsg(msg, 'Passwörter stimmen nicht überein.', 'error'); return; }
  try {
    await db.collection('config').doc('admin').update({ passwordHash: simpleHash(pw1) });
    showMsg(msg, '✓ Passwort geändert.', 'success');
  } catch(e) { showMsg(msg, 'Fehler: ' + e.message, 'error'); }
}

async function saveMinRiegeSize() {
  const val = parseInt(document.getElementById('min-riege-size').value);
  const msg = document.getElementById('min-size-msg');
  if (isNaN(val) || val < 1) { showMsg(msg, 'Ungültiger Wert.', 'error'); return; }
  try {
    await db.collection('config').doc('settings').set({ minRiegeSize: val }, { merge: true });
    showMsg(msg, '✓ Gespeichert.', 'success');
  } catch(e) { showMsg(msg, 'Fehler: ' + e.message, 'error'); }
}

const JAHRGAENGE = ['2015','2016','2017','2018','2019','2020','2021','2022'];
const SPRINT_OPTIONS = ['30m','50m','60m','75m','100m'];
let currentSprintCfg = {};

async function getSprintConfig() {
  try {
    const doc = await db.collection('config').doc('settings').get();
    if (doc.exists && doc.data().sprintConfig) return doc.data().sprintConfig;
  } catch(e) {}
  return {};
}

async function buildSprintConfig() {
  const el = document.getElementById('sprint-config');
  if (!el) return;
  let cfg = {};
  try {
    const doc = await db.collection('config').doc('settings').get();
    if (doc.exists && doc.data().sprintConfig) cfg = doc.data().sprintConfig;
  } catch(e) {}
  el.innerHTML = JAHRGAENGE.map(jg => `
    <div class="sprint-row">
      <label>Jg. ${jg}</label>
      <select id="sprint-${jg}">
        ${SPRINT_OPTIONS.map(o => `<option value="${o}" ${(cfg[jg]||'50m')===o?'selected':''}>${o}</option>`).join('')}
      </select>
    </div>`).join('');
}

async function saveSprintConfig() {
  const msg = document.getElementById('sprint-config-msg');
  const sprintConfig = {};
  JAHRGAENGE.forEach(jg => {
    const el = document.getElementById(`sprint-${jg}`);
    if (el) sprintConfig[jg] = el.value;
  });
  try {
    await db.collection('config').doc('settings').set({ sprintConfig }, { merge: true });
    showMsg(msg, '✓ Sprintstrecken gespeichert.', 'success');
  } catch(e) { showMsg(msg, 'Fehler: ' + e.message, 'error'); }
}

// ===== HELPERS =====
function generateToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = 'R-';
  for (let i = 0; i < 6; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = 'msg-box msg-' + type;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3500);
}
