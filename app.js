'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- Speicher (localStorage, mit Fallback) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privates Fenster o. Ä. */ }
  },
};

let lists = store.get('vd.lists', []);
let currentListId = store.get('vd.current', null);

function newList(name) {
  const list = { id: Date.now().toString(36), name: name || `Liste ${lists.length + 1}`, entries: [] };
  lists.push(list);
  currentListId = list.id;
  saveLists();
  return list;
}
function currentList() {
  return lists.find((l) => l.id === currentListId) || lists[0] || newList();
}
function saveLists() {
  store.set('vd.lists', lists);
  store.set('vd.current', currentListId);
}

// ---------- Tabs ----------
function showTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'list') renderList();
  if (name === 'dictate') renderCheckList();
}
$$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- Import ----------
const statusEl = $('#ocr-status');
function setStatus(text) { statusEl.hidden = !text; statusEl.textContent = text || ''; }

$$('input[name=ocr]').forEach((r) => r.addEventListener('change', () => {
  $('#claude-settings').hidden = ocrMethod() !== 'claude';
}));
function ocrMethod() { return $('input[name=ocr]:checked').value; }

$('#api-key').value = store.get('vd.apikey', '');
$('#api-key').addEventListener('change', (e) => store.set('vd.apikey', e.target.value.trim()));

$('#camera-input').addEventListener('change', (e) => handleFiles(e.target.files));
$('#file-input').addEventListener('change', (e) => handleFiles(e.target.files));

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const list = $('#append').checked ? currentList() : newList();
  let added = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const prefix = files.length > 1 ? `Bild ${i + 1}/${files.length}: ` : '';
      const canvas = await loadImage(files[i]);
      $('#preview').src = canvas.toDataURL('image/jpeg', 0.8);
      $('#preview-wrap').hidden = false;
      const entries = ocrMethod() === 'claude'
        ? await recognizeWithClaude(canvas, (s) => setStatus(prefix + s))
        : await recognizeWithTesseract(canvas, (s) => setStatus(prefix + s));
      entries.forEach((e) => list.entries.push({
        en: e.en || '', de: e.de || '', note: cleanNote(e.note || ''), on: !e.optional,
      }));
      added += entries.length;
    }
    saveLists();
    setStatus(`${added} Vokabeln erkannt. Bitte im nächsten Schritt prüfen.`);
    showTab('list');
  } catch (err) {
    console.error(err);
    setStatus(`Fehler: ${err.message || err}`);
  } finally {
    $('#camera-input').value = '';
    $('#file-input').value = '';
  }
}

// Bild laden, auf sinnvolle Größe skalieren
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxSide = 2200;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht geladen werden.')); };
    img.src = url;
  });
}

// ----- Tesseract (lokal im Browser) -----
let tessWorker = null;
async function recognizeWithTesseract(canvas, report) {
  if (!window.Tesseract) throw new Error('Tesseract konnte nicht geladen werden (Internetverbindung?).');
  if (!tessWorker) {
    report('Texterkennung wird geladen … (beim ersten Mal ca. 10–20 MB)');
    tessWorker = await Tesseract.createWorker(['eng', 'deu'], 1, {
      logger: (m) => { if (m.status === 'recognizing text') report(`Text wird erkannt … ${Math.round(m.progress * 100)} %`); },
    });
  }
  report('Text wird erkannt …');
  const { data } = await tessWorker.recognize(canvas, {}, { blocks: true, text: true });
  const lines = data.lines || (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  const entries = parseLayout(lines, $('#layout').value.split(','));
  if (!entries.length) throw new Error('Keine Vokabeln erkannt. Tipp: Seite gerade, hell und scharf fotografieren.');
  return entries;
}

// Zeilen in Spalten (Englisch / Merksatz / Deutsch) aufteilen.
// Idee: Innerhalb einer Zeile trennen große Lücken zwischen Wörtern die Spalten.
// Die Spaltengrenzen werden aus allen Zeilen gemeinsam geschätzt.
function parseLayout(lines, columns) {
  const segRows = [];
  const boxRows = [];
  for (const line of lines) {
    const words = (line.words || []).filter((w) => w.text.trim() && w.confidence > 20);
    if (!words.length) continue;
    // Unsichere Zeilen (Bilder, Schatten, Einleitungstext) überspringen
    if (median(words.map((w) => w.confidence)) < 60) continue;
    const h = median(words.map((w) => w.bbox.y1 - w.bbox.y0)) || 10;
    const segs = [];
    let cur = null;
    for (const w of words) {
      if (cur && w.bbox.x0 - cur.x1 < h * 1.4) {
        cur.text += ' ' + w.text; cur.x1 = w.bbox.x1;
      } else {
        cur = { text: w.text, x0: w.bbox.x0, x1: w.bbox.x1 };
        segs.push(cur);
      }
    }
    // Seitenverweis am Rand ("p. 12") entfernen
    const pageRef = /^p[.,·\-]?\s*\d+/i;
    if (segs.length && new RegExp(pageRef.source + '$', 'i').test(segs[0].text.trim())) segs.shift();
    if (segs.length) segs[0].text = segs[0].text.replace(new RegExp(pageRef.source + '\\s+', 'i'), '');
    if (!segs.length) continue;

    // Kästen (z. B. "Respect", "Jobs") haben zwei Wortpaare nebeneinander:
    // englisch [Lautschrift] | deutsch | englisch [Lautschrift] | deutsch
    const ipa = segs.map((s, i) => (s.text.includes('[') ? i : -1)).filter((i) => i >= 0);
    if (ipa.length === 2 && ipa[0] === 0 && ipa[1] >= 2) {
      const k = ipa[1];
      boxRows.push(
        { y: line.bbox.y0, en: segs[0].text, de: segs.slice(1, k).map((s) => s.text).join(' ') },
        { y: line.bbox.y0 + 0.5, en: segs[k].text, de: segs.slice(k + 1).map((s) => s.text).join(' ') },
      );
      continue;
    }
    segRows.push({ y: line.bbox.y0, segs });
  }
  const boxEntries = boxRows.map((r) => ({ y: r.y, en: r.en, de: r.de, note: '' }));
  if (!segRows.length) return finish(boxEntries);

  // Spalten-Startpunkte: Zeilen mit genau so vielen Segmenten wie Spalten liefern die Positionen.
  const n = columns.length;
  const full = segRows.filter((r) => r.segs.length === n);
  let starts;
  if (full.length >= 2) {
    starts = columns.map((_, i) => median(full.map((r) => r.segs[i].x0)));
  } else {
    const xs = segRows.flatMap((r) => r.segs.map((s) => s.x0)).sort((a, b) => a - b);
    starts = kmeans1d(xs, n);
  }
  const colOf = (x) => {
    let best = 0;
    for (let i = 1; i < starts.length; i++) if (x >= (starts[i - 1] + starts[i]) / 2) best = i;
    return best;
  };

  // Neue Vokabel beginnt, wenn in der Englisch-Spalte etwas steht; sonst Fortsetzung.
  // Ausnahme: Zeile nur mit Englisch-Spalte. Enthält sie Lautschrift-Klammern, gehört sie zum
  // vorigen Eintrag (z. B. "[ˌlʊk 'fɔ:wəd tə]" oder "dealt with ['delt wɪð]"), sonst ist es eine
  // Überschrift ("Station 1", "Way in") und wird übersprungen.
  const entries = [];
  let cur = null;
  for (const row of segRows) {
    const cells = {};
    for (const s of row.segs) {
      const key = columns[colOf(s.x0)];
      cells[key] = cells[key] ? cells[key] + ' ' + s.text : s.text;
    }
    const enOnly = cells.en && !cells.de && !cells.note;
    if (enOnly) {
      if (cur && /[[\]]/.test(cells.en)) cur.en += ' ' + cells.en.replace(/\[[^\]]*\]?|^[^[]*\]/g, '');
      continue;
    }
    if (cells.en || !cur) {
      cur = { y: row.y, en: '', de: '', note: '' };
      entries.push(cur);
    }
    for (const key of columns) if (cells[key]) cur[key] = (cur[key] ? cur[key] + ' ' : '') + cells[key];
  }
  return finish(entries.concat(boxEntries));

  function finish(list) {
    return list
      .sort((a, b) => a.y - b.y)
      .map((e) => ({ en: cleanEnglish(e.en), de: cleanText(e.de), note: cleanText(e.note) }))
      // Überschriften ("Station 1", "Way in") haben keine deutsche Bedeutung → weg
      .filter((e) => looksLikeWords(e.en) && looksLikeWords(e.de) && !/hundred|\d{3}/i.test(e.en));
  }
}

function looksLikeWords(s) {
  const words = s.split(/\s+/);
  const good = words.filter((w) => /^[(\[]?[A-Za-zÄÖÜäöüß'’-]{2,}[.,;:!?)\]]?$/.test(w));
  return good.length > 0 && good.length >= words.length * 0.6;
}

// Merksatz-Spalte: Hinweise auf Russisch/Türkisch (R / T) sind fürs Diktat unnötig
function cleanNote(s) {
  s = s.replace(/[Ѐ-ӿ]+/g, ' ').replace(/\[[RT]\]/g, ' ').replace(/(^|\s)[RT](?=\s|$)/g, ' ');
  return cleanText(s);
}

function cleanEnglish(s) {
  return cleanText(s.replace(/\[[^\]]*\]?/g, ' ').replace(/\/[^/]*\//g, ' ')); // Lautschrift entfernen
}
function cleanText(s) {
  return (s || '').replace(/[|_~«»]/g, ' ').replace(/\s+/g, ' ').trim();
}
function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function kmeans1d(xs, k) {
  if (!xs.length) return Array(k).fill(0);
  let c = Array.from({ length: k }, (_, i) => xs[Math.floor((i * (xs.length - 1)) / Math.max(1, k - 1))]);
  for (let it = 0; it < 20; it++) {
    const groups = c.map(() => []);
    for (const x of xs) {
      let bi = 0;
      for (let i = 1; i < k; i++) if (Math.abs(x - c[i]) < Math.abs(x - c[bi])) bi = i;
      groups[bi].push(x);
    }
    c = groups.map((g, i) => (g.length ? Math.min(...g) * 0.5 + median(g) * 0.5 : c[i]));
  }
  return c.sort((a, b) => a - b);
}

// ----- Claude (genauer, braucht API-Schlüssel) -----
async function recognizeWithClaude(canvas, report) {
  const key = $('#api-key').value.trim();
  if (!key) throw new Error('Bitte zuerst einen API-Schlüssel eintragen.');
  store.set('vd.apikey', key);
  report('Bild wird an Claude gesendet …');
  const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  const prompt = `Das Foto zeigt eine Vokabelseite ("Vocabulary") aus einem deutschen Englisch-Schulbuch.
Aufbau: Jede Zeile hat links das englische Wort mit Lautschrift in eckigen Klammern, in der Mitte die
deutsche Bedeutung und rechts (grau hinterlegt) einen Beispielsatz oder Merkhinweis (z. B. "necessary ↔ unnecessary",
"belief → to believe"). Ein Eintrag kann über zwei Zeilen umbrechen. Es gibt umrahmte Kästen (z. B. "Respect", "Jobs")
mit ZWEI Wortpaaren nebeneinander (Englisch | Deutsch | Englisch | Deutsch) und ohne Merksatz-Spalte – dort zuerst
die linke Spalte von oben nach unten, dann die rechte.

Extrahiere alle Vokabeleinträge in Lesereihenfolge. Gib NUR ein JSON-Array zurück, ohne weiteren Text:
[{"en": "...", "de": "...", "note": "...", "optional": false}]
Regeln:
- Lautschrift weglassen. Grammatik-Hinweise im englischen Teil behalten, z. B. "to look forward to (+ -ing)".
- "de" genau wie im Buch, mehrere Bedeutungen mit "; " getrennt. Silbentrennungen am Zeilenende zusammenfügen.
- "note": Text der rechten Spalte, sonst "". Hinweise auf Russisch/Türkisch (Kästchen R oder T mit fremdem Wort) weglassen.
- "optional": true, wenn das englische Wort blau gedruckt ist (muss man nicht lernen), sonst false.
- Überschriften (z. B. "Station 1", "Way in", "Unit 1 ..."), Seitenverweise ("p. 12"), Seitenzahlen, Erklärtexte und die
  Symbol-Legende weglassen.
- Unleserliche oder abgeschnittene Einträge so gut wie möglich übernehmen, nichts erfinden.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude-API: ${body.error?.message || res.status}`);
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Antwort enthielt keine Vokabelliste.');
  return JSON.parse(match[0]);
}

// ---------- Liste bearbeiten ----------
function renderListSelect() {
  const sel = $('#list-select');
  sel.innerHTML = '';
  for (const l of lists) {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = `${l.name} (${l.entries.length})`;
    sel.appendChild(o);
  }
  sel.value = currentList().id;
}
function renderList() {
  renderListSelect();
  const tbody = $('#vocab-table tbody');
  tbody.innerHTML = '';
  currentList().entries.forEach((e, i) => {
    const tr = document.createElement('tr');
    const chk = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = e.on !== false;
    cb.addEventListener('change', () => { e.on = cb.checked; saveLists(); });
    chk.appendChild(cb);
    tr.appendChild(chk);
    for (const key of ['en', 'de', 'note']) {
      const td = document.createElement('td');
      const ta = document.createElement('textarea');
      ta.rows = 1; ta.value = e[key] || '';
      ta.lang = key === 'de' ? 'de' : 'en';
      ta.addEventListener('input', () => { e[key] = ta.value; saveLists(); });
      td.appendChild(ta);
      tr.appendChild(td);
    }
    const del = document.createElement('td');
    del.className = 'del';
    const b = document.createElement('button');
    b.textContent = '✕'; b.title = 'Zeile löschen';
    b.addEventListener('click', () => { currentList().entries.splice(i, 1); saveLists(); renderList(); });
    del.appendChild(b);
    tr.appendChild(del);
    tbody.appendChild(tr);
  });
}
$('#list-select').addEventListener('change', (e) => { currentListId = e.target.value; saveLists(); renderList(); });
$('#list-new').addEventListener('click', () => { newList(prompt('Name der Liste:') || undefined); renderList(); });
$('#list-rename').addEventListener('click', () => {
  const name = prompt('Neuer Name:', currentList().name);
  if (name) { currentList().name = name; saveLists(); renderList(); }
});
$('#list-delete').addEventListener('click', () => {
  if (!confirm(`Liste „${currentList().name}“ wirklich löschen?`)) return;
  lists = lists.filter((l) => l.id !== currentList().id);
  currentListId = lists[0]?.id || null;
  saveLists(); renderList();
});
$('#row-add').addEventListener('click', () => {
  currentList().entries.push({ en: '', de: '', note: '', on: true });
  saveLists(); renderList();
  const tas = $$('#vocab-table tbody textarea');
  tas[tas.length - 3]?.focus();
});
$('#go-dictate').addEventListener('click', () => showTab('dictate'));

// ---------- Diktat-Einstellungen ----------
const PRESETS = {
  'en-de': { en: 'write', de: 'write', note: 'off', order: 'en,de,note' },
  'en-de-note': { en: 'write', de: 'write', note: 'write', order: 'en,de,note' },
  'en-de-hearnote': { en: 'write', de: 'write', note: 'speak', order: 'en,de,note' },
  'en-only': { en: 'write', de: 'speak', note: 'off', order: 'en,de,note' },
  'de-en': { en: 'write', de: 'speak', note: 'off', order: 'de,en,note' },
};
const settingIds = ['preset', 'mode-en', 'mode-de', 'mode-note', 'order', 'rate', 'per-char', 'min-pause', 'repeats',
  'spell', 'announce', 'shuffle', 'only-checked', 'show-text'];

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  $('#mode-en').value = p.en; $('#mode-de').value = p.de; $('#mode-note').value = p.note; $('#order').value = p.order;
}
$('#preset').addEventListener('change', (e) => { applyPreset(e.target.value); saveSettings(); });
['#mode-en', '#mode-de', '#mode-note', '#order'].forEach((s) => $(s).addEventListener('change', () => {
  $('#preset').value = 'custom';
}));

function saveSettings() {
  const s = {};
  for (const id of settingIds) { const el = $('#' + id); s[id] = el.type === 'checkbox' ? el.checked : el.value; }
  s['voice-en'] = $('#voice-en').value; s['voice-de'] = $('#voice-de').value;
  store.set('vd.settings', s);
}
function loadSettings() {
  const s = store.get('vd.settings', null);
  if (!s) { applyPreset($('#preset').value); return; }
  for (const id of settingIds) {
    const el = $('#' + id);
    if (!el || s[id] === undefined) continue;
    if (el.type === 'checkbox') el.checked = s[id]; else el.value = s[id];
  }
}
settingIds.forEach((id) => $('#' + id).addEventListener('change', saveSettings));
$('#rate').addEventListener('input', () => { $('#rate-val').textContent = `${$('#rate').value}×`; });
$('#show-text').addEventListener('change', () => updateNow());

// ---------- Stimmen ----------
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
  const saved = store.get('vd.settings', {}) || {};
  fillVoices('#voice-en', 'en', ['en-GB', 'en-US'], saved['voice-en']);
  fillVoices('#voice-de', 'de', ['de-DE'], saved['voice-de']);
}
function fillVoices(sel, prefix, preferred, savedName) {
  const el = $(sel);
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
  el.innerHTML = '';
  if (!matching.length) {
    el.innerHTML = '<option value="">(keine passende Stimme gefunden)</option>';
    return;
  }
  for (const v of matching) {
    const o = document.createElement('option');
    o.value = v.name; o.textContent = `${v.name} (${v.lang})`;
    el.appendChild(o);
  }
  const pref = matching.find((v) => v.name === savedName)
    || preferred.map((p) => matching.find((v) => v.lang.replace('_', '-') === p)).find(Boolean)
    || matching[0];
  el.value = pref.name;
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}
['#voice-en', '#voice-de'].forEach((s) => $(s).addEventListener('change', saveSettings));

function voiceFor(lang) {
  const name = $(lang === 'de' ? '#voice-de' : '#voice-en').value;
  return voices.find((v) => v.name === name) || null;
}

// ---------- Diktat-Ablauf ----------
// Das Diktat wird als Liste von Schritten (sprechen / warten) vorbereitet.
// Pause bricht den aktuellen Schritt ab; Weiter setzt beim gleichen Schritt fort.
const LABEL = { en: 'Englisch', de: 'Deutsch', note: 'Merksatz' };
let steps = [];
let stepIndex = 0;
let playing = false;
let runToken = 0;
let order = [];

function buildSteps() {
  let entries = currentList().entries.filter((e) => (e.en || e.de) && (!$('#only-checked').checked || e.on !== false));
  if ($('#shuffle').checked) entries = shuffle([...entries]);
  order = entries;
  const fields = $('#order').value.split(',');
  const modes = { en: $('#mode-en').value, de: $('#mode-de').value, note: $('#mode-note').value };
  const repeats = Math.max(1, Number($('#repeats').value) || 1);
  const perChar = Number($('#per-char').value) || 0;
  const minPause = Number($('#min-pause').value) || 0;
  const announce = $('#announce').checked;
  const out = [];

  entries.forEach((e, idx) => {
    out.push({ entry: idx, type: 'speak', lang: 'de', text: `Nummer ${idx + 1}.`, field: null });
    for (const f of fields) {
      const text = (e[f] || '').trim();
      const mode = modes[f];
      if (!text || mode === 'off') continue;
      const lang = f === 'de' ? 'de' : 'en';
      const label = mode === 'speak' ? `${LABEL[f]}, nur zuhören:` : `${LABEL[f]}:`;
      if (announce) out.push({ entry: idx, type: 'speak', lang: 'de', text: label, field: f });
      const times = mode === 'write' ? repeats : 1;
      for (let r = 0; r < times; r++) {
        out.push({ entry: idx, type: 'speak', lang, text, field: f, mode });
        if (mode === 'write' && f === 'en' && r === 0 && $('#spell').checked) {
          out.push({ entry: idx, type: 'speak', lang: 'en', text: spellOut(text), field: f, mode, rate: 0.8 });
        }
        if (mode === 'write') {
          const pause = Math.max(minPause, text.length * perChar) * (r === times - 1 ? 1 : 0.6);
          out.push({ entry: idx, type: 'wait', ms: pause * 1000, field: f, mode });
        } else {
          out.push({ entry: idx, type: 'wait', ms: 700, field: f, mode });
        }
      }
    }
    out.push({ entry: idx, type: 'wait', ms: 600, field: null });
  });
  if (entries.length) out.push({ entry: entries.length - 1, type: 'speak', lang: 'de', text: 'Fertig. Jetzt kannst du kontrollieren.', field: null, end: true });
  return out;
}

function spellOut(text) {
  // Buchstaben einzeln, Leerzeichen als Pause
  return text.replace(/\(.*?\)/g, '').split(' ').filter(Boolean)
    .map((w) => w.split('').filter((c) => /[a-zA-Z']/.test(c)).join(', ')).join('. – ');
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Buchsymbole so umschreiben, dass die Sprachausgabe sie sinnvoll vorliest
function speechText(text, lang) {
  let t = text;
  if (lang === 'en') {
    t = t
      .replace(/\(\s*\+\s*-?ing\s*\)/gi, ', plus i n g,')
      .replace(/\(\s*=\s*/g, ', ').replace(/\s*=\s*/g, ', means, ')
      .replace(/\s*↔\s*/g, ', opposite: ').replace(/\s*(→|->)\s*/g, ', related to: ')
      .replace(/\bBE:/g, 'British English:').replace(/\bAE:/g, 'American English:')
      .replace(/\bsth\b/g, 'something').replace(/\bsb\b/g, 'somebody');
  } else {
    t = t.replace(/\s*↔\s*/g, ', Gegenteil: ').replace(/\s*(→|->)\s*/g, ', verwandt mit: ');
  }
  return t.replace(/[()]/g, ', ').replace(/\s*;\s*/g, '; ').replace(/[✎✐✏]/g, '').trim();
}

function speak(text, lang, rate) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(speechText(text, lang));
    const v = voiceFor(lang);
    if (v) u.voice = v;
    u.lang = v ? v.lang : (lang === 'de' ? 'de-DE' : 'en-GB');
    u.rate = (rate || 1) * Number($('#rate').value || 0.85);
    // Sicherheitsnetz: manche Browser lösen "end" nicht zuverlässig aus
    const guard = setTimeout(resolve, 2000 + text.length * 250);
    u.onend = u.onerror = () => { clearTimeout(guard); resolve(); };
    speechSynthesis.speak(u);
  });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  const token = ++runToken;
  playing = true;
  updateButtons();
  while (playing && token === runToken && stepIndex < steps.length) {
    const step = steps[stepIndex];
    updateNow(step);
    if (step.type === 'speak') await speak(step.text, step.lang, step.rate);
    else await wait(step.ms);
    if (token !== runToken) return; // abgebrochen / gesprungen
    stepIndex++;
  }
  if (token === runToken) {
    playing = false;
    if (stepIndex >= steps.length) { $('#now').textContent = 'Fertig! 🎉'; $('#now-hint').textContent = 'Klapp unten die Kontrolle auf.'; $('#check-wrap').open = true; }
    updateButtons();
  }
}

function stop() {
  runToken++;
  playing = false;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  updateButtons();
}

function jumpToEntry(entryIdx) {
  const wasPlaying = playing;
  stop();
  const i = steps.findIndex((s) => s.entry === entryIdx);
  stepIndex = i < 0 ? stepIndex : i;
  updateNow(steps[stepIndex]);
  if (wasPlaying) run();
}
function currentEntryIdx() { return steps[Math.min(stepIndex, steps.length - 1)]?.entry ?? 0; }

$('#play').addEventListener('click', () => {
  if (playing) { stop(); return; }
  if (!steps.length || stepIndex >= steps.length) {
    steps = buildSteps();
    stepIndex = 0;
    renderCheckList();
    if (!steps.length) { $('#now').textContent = 'Keine Vokabeln in der Liste.'; return; }
  }
  // Schritt neu beginnen (falls mitten im Satz pausiert)
  run();
});
$('#next').addEventListener('click', () => { if (steps.length) jumpToEntry(Math.min(currentEntryIdx() + 1, order.length - 1)); });
$('#prev').addEventListener('click', () => { if (steps.length) jumpToEntry(Math.max(currentEntryIdx() - 1, 0)); });
$('#repeat').addEventListener('click', () => { if (steps.length) jumpToEntry(currentEntryIdx()); });

// Einstellungen geändert → Diktat neu aufbauen (beim nächsten Start)
['#mode-en', '#mode-de', '#mode-note', '#order', '#preset', '#repeats', '#per-char', '#min-pause', '#spell', '#announce', '#shuffle', '#only-checked']
  .forEach((s) => $(s).addEventListener('change', () => { stop(); steps = []; stepIndex = 0; updateNow(); }));

function updateButtons() {
  $('#play').textContent = playing ? '⏸ Pause' : (steps.length && stepIndex > 0 && stepIndex < steps.length ? '▶ Weiter' : '▶ Start');
}

function updateNow(step) {
  step = step || steps[stepIndex];
  if (!step) {
    $('#progress').textContent = '–';
    $('#now').textContent = 'Drück auf Start.';
    $('#now-hint').textContent = '';
    return;
  }
  const e = order[step.entry];
  $('#progress').textContent = `Vokabel ${step.entry + 1} von ${order.length}`;
  const show = $('#show-text').checked;
  if (step.field) {
    const what = step.mode === 'speak' ? 'nur zuhören 👂' : 'schreiben ✍️';
    $('#now').textContent = show ? e[step.field] : `${LABEL[step.field]} – ${what}`;
    $('#now-hint').textContent = show ? `${LABEL[step.field]} – ${what}` : '';
  } else if (!step.end) {
    $('#now').textContent = `Nummer ${step.entry + 1}`;
    $('#now-hint').textContent = '';
  }
  $$('#check-list li').forEach((li, i) => li.classList.toggle('current', i === step.entry));
}

function renderCheckList() {
  const ol = $('#check-list');
  ol.innerHTML = '';
  const entries = order.length ? order : currentList().entries.filter((e) => e.en || e.de);
  for (const e of entries) {
    const li = document.createElement('li');
    const b = document.createElement('b'); b.textContent = e.en;
    li.append(b, ` – ${e.de}`);
    if (e.note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = e.note; li.append(n); }
    ol.appendChild(li);
  }
}

// ---------- Start ----------
if (!('speechSynthesis' in window)) {
  $('#now').textContent = 'Dieser Browser kann leider nicht vorlesen. Bitte Chrome, Edge oder Safari verwenden.';
}
loadSettings();
$('#rate-val').textContent = `${$('#rate').value}×`;
currentList();
saveLists();
renderList();
