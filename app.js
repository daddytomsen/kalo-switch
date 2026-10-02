// kalo'switch – Lebensmittel über Kilokalorien ineinander umrechnen
// Vanilla JS, läuft in iOS Safari (auch als Home-Bildschirm-App).

const APP_VERSION = '1.0.0';

// Externe Bausteine – werden erst bei Bedarf geladen (Foto-Funktion)
// SDK braucht iOS 16.4+. Safaris eingebauter BarcodeDetector ist auf iOS defekt (WebKit-Bug 281848) → immer die WASM-Variante.
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';
const BARCODE_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/es/ponyfill.min.js';
// Open Food Facts: Barcode über API v3; Volltextsuche nur über die alte search.pl
// (search.openfoodfacts.org sendet für fremde Domains keine CORS-Freigabe).
const OFF_PRODUKT = 'https://world.openfoodfacts.org/api/v3/product/';
const OFF_SUCHE = 'https://de.openfoodfacts.org/cgi/search.pl';
const OFF_APP = 'app_name=kaloswitch&app_version=1.0';
const OFF_FELDER = ['code', 'product_name', 'product_name_de', 'brands', 'nutriments.energy-kcal_100g', 'nutriments.energy-kj_100g',
  'nutriments.energy_100g', 'nutrition_data_per', 'quantity', 'product_quantity', 'product_quantity_unit', 'serving_quantity',
  'serving_quantity_unit', 'image_front_small_url', 'categories_tags'].join(',');
const MODELLE = {
  'claude-opus-5-5': 'Claude Opus 5.5 – genauer (Standard)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 – schneller & günstiger',
};

/* ---------- Kleine Helfer ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// Element bauen – Texte immer als Textknoten (keine HTML-Injektion aus Fremddaten)
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
// Für Eingabefelder: nie mit Tausenderpunkt vorbelegen ("1.000" würde sonst als 1 gelesen)
const nf2 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2, useGrouping: false });
const zahl = (s) => {
  let t = String(s ?? '').replace(/\s/g, '');
  if (/^[1-9]\d{0,2}(\.\d{3})+(,\d*)?$/.test(t)) t = t.replace(/\./g, ''); // selbst getipptes "1.000" / "1.234,5"
  const n = parseFloat(t.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Suchtext normalisieren: "Gummibärchen" findet man mit "gummibaer", "gummibar" und "Gummibär"
function falte(s, ae = true) {
  let t = String(s || '').toLowerCase();
  if (ae) t = t.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}

const LS = {
  get(k, d) { try { const v = localStorage.getItem('ks:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ks:' + k, JSON.stringify(v)); } catch { /* privater Modus o. ä. */ } },
  del(k) { try { localStorage.removeItem('ks:' + k); } catch { /* egal */ } },
};

let toastTimer;
function toast(text) {
  const t = $('#toast');
  // Ein modales Sheet liegt im Top Layer – z-index hilft dort nicht, also den Toast hineinhängen
  const host = $('dialog[open]') || document.body;
  if (t.parentNode !== host) host.append(t);
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- Handvoll ---------- */

// Modell (Recherche 10/2026): Handvoll_g = Handvolumen × Schüttdichte × Formfaktor k
// Handvolumen 70 ml = locker gegriffen, ohne Häufung (kalibriert an Brown et al. 2021: Nüsse, Median 36 g).
// k: 1,0 kleine kompakte Stücke · 1,3 mittlere (2–4 cm) · 1,5 große/flache/luftige Stücke, die sich auftürmen.
const HANDVOLUMEN_ML = 70;
const HAND_FAKTOR = { klein: 0.9, mittel: 1, gross: 1.1 };
// Schüttdichten (g/ml) je Gruppe, kalibriert an den geprüften Handvoll-Werten der eigenen Datenbank
// (Handvoll = 70 ml × rho × k) – so ergibt ein gescanntes Produkt dasselbe wie der Datenbank-Eintrag.
// Muster passen auf Open-Food-Facts-categories_tags (z. B. "en:salted-peanuts") und auf Produktnamen.
// Reihenfolge zählt: Spezielles (Walnüsse, Tortillachips) steht vor Allgemeinem (Nüsse, Chips).
const SCHUETT = [
  { gruppe: 'Walnüsse', muster: /walnut|walnuss|walnuesse/, rho: 0.44, k: 1.0 }, // DB walnuesse 31 g
  { gruppe: 'Studentenfutter', muster: /trail[- ]?mix|studenten ?futter|nuts-and-dried-fruits/, rho: 0.50, k: 1.0 }, // DB 35 g
  { gruppe: 'Schokolinsen', muster: /chocolate-candies|dragee|schokolinsen|m-m/, rho: 0.76, k: 1.0 }, // DB M&M's 53 g
  // geschmack: "Erdnuss" ist oft nur die Sorte (Erdnuss-Flips, Flips Erdnuss) – passt noch eine andere Gruppe, gewinnt die
  { gruppe: 'Nüsse', muster: /nuts|peanut|almond|cashew|hazelnut|pistachio|macadamia|nuesse|erdnuss|mandel/, rho: 0.55, k: 1.0, geschmack: true }, // DB 33–41 g
  { gruppe: 'Salzstangen', muster: /salt-sticks|pretzel-sticks|salzstangen|sticks/, rho: 0.20, k: 1.3 }, // DB 18 g
  { gruppe: 'Mini-Brezeln', muster: /pretzel|brezel/, rho: 0.27, k: 1.3 },      // DB salzbrezeln 25 g
  { gruppe: 'Tortillachips', muster: /tortilla(?:[- ]?chips)?|nachos|nachips/, rho: 0.19, k: 1.5 }, // DB 20 g
  { gruppe: 'Flips', muster: /puff|flips|locken|extruded/, rho: 0.11, k: 1.5 },  // DB erdnussflips 12 g
  { gruppe: 'Chips', muster: /crisps|chips/, rho: 0.14, k: 1.5 },              // DB kartoffelchips 15 g
  { gruppe: 'Popcorn', muster: /popcorn/, rho: 0.07, k: 1.5 },                 // DB 7–9 g
  { gruppe: 'Fruchtgummi', muster: /gumm|jelly-candies|jellies|wine-gums|fruchtgummi|baeren/, rho: 0.64, k: 1.0 }, // DB 39–45 g
  { gruppe: 'Cornflakes', muster: /corn-flakes|cornflakes/, rho: 0.12, k: 1.5 }, // DB 13 g
  { gruppe: 'Haferflocken', muster: /oat-flakes|rolled-oats|haferflocken/, rho: 0.36, k: 1.0 }, // DB 25 g
  { gruppe: 'Müsli', muster: /muesli|granola|musli/, rho: 0.43, k: 1.0 },       // DB 30 g
  { gruppe: 'Trauben/Tomaten', muster: /grapes|trauben|cherry-tomato|cherrytomat/, rho: 0.77, k: 1.3 }, // DB 70 g
  { gruppe: 'Erdbeeren/Kirschen', muster: /strawberr|cherries|erdbeer|kirsch/, rho: 0.71, k: 1.3 }, // DB 65 g
  { gruppe: 'Beeren', muster: /berries|blueberr|raspberr|beeren/, rho: 0.57, k: 1.0 }, // DB heidelbeeren 40 g
  { gruppe: 'Cracker', muster: /crackers|cracker/, rho: 0.24, k: 1.3 },        // Modell (USDA), kein DB-Wert
  { gruppe: 'Trockenobst', muster: /raisins|dried-fruits|rosinen|trockenobst/, rho: 0.61, k: 1.0 }, // Modell (USDA)
];

// Schätzt die Gramm einer Handvoll für Produkte ohne kuratierten Wert – aufgerufen von vorbereiten()
// nur für Open-Food-Facts-Produkte mit basis 'g'. Rückgabe 0 = "Handvoll" wird nicht angeboten.
// food.kategorienOff: OFF-categories_tags, z. B. ["en:snacks", "en:salty-snacks", "en:pretzels"]
// food.name:          Produktname, z. B. "Mini Brezeln" oder "Studentenfutter Classic"
// Bausteine: SCHUETT (Gruppen mit muster/rho/k, Reihenfolge = Priorität) und HANDVOLUMEN_ML.
// Die Handgröße (klein/mittel/groß) rechnet vorbereiten() danach selbst ein – hier NICHT berücksichtigen.
// Keine losen Stücke – auch wenn "Nuss" oder "Brezel" drinsteckt (Nuss-Nougat-Creme, Müsliriegel, Laugenbrezel vom Bäcker)
// Kategorie muss am ENDE passen ("en:hazelnut-spreads"), sonst greifen zufällige Wortteile. OFF-Kategorien sind
// nicht immer sauber (Erdnussflips stehen teils unter "en:meals") – darum nur eindeutige Formen ausschließen.
const NICHT_LOSE_KAT = /(spreads|butters|oils|flours|pastes|bars|cakes|ice-creams|sauces|yogurts|breads|viennoiseries|pastries)$/;
const NICHT_LOSE_NAME = /aufstrich|creme|nussbutter|mandelbutter|mehl|riegel|paste|kuchen|laugenbrezel|laugenstange|laugenbroetchen|brot\b/;

function schaetzeHandvoll(food) {
  const kats = Array.isArray(food.kategorienOff) ? food.kategorienOff : [];
  const name = falte(food.name);
  if (kats.some((t) => NICHT_LOSE_KAT.test(t)) || NICHT_LOSE_NAME.test(name)) return 0;
  // Erst der Name, dann die OFF-Kategorien von speziell nach allgemein (OFF listet allgemein → speziell)
  const texte = [name, ...kats.slice().reverse().map((t) => t.toLowerCase().replace(/^[a-z]{2}:/, ''))];
  for (const text of texte) {
    const g = besteGruppe(text);
    if (g) return Math.round(HANDVOLUMEN_ML * g.rho * g.k);
  }
  return 0; // kein Treffer → keine Handvoll anbieten
}

// Innerhalb eines Textes gewinnt das Grundwort – es steht im Deutschen wie im Englischen hinten:
// "Erdnuss-Flips" sind Flips, "peanut-puffs" auch. Enden zwei Treffer fast gleich ("walnuts" → Walnüsse
// und Nüsse), gewinnt der längere, also speziellere Treffer. Zusätze ("… mit Rosinen", "…-with-peanuts")
// zählen nicht, und eine reine Geschmacks-Gruppe tritt zurück, wenn noch etwas anderes passt.
function besteGruppe(text) {
  const kern = text.split(/ mit | with |-with-| made from |-made-from-/)[0];
  const passend = SCHUETT.filter((g) => g.muster.test(kern));
  const kandidaten = passend.some((g) => !g.geschmack) ? passend.filter((g) => !g.geschmack) : passend;
  let beste = null;
  for (const g of kandidaten) {
    for (const m of kern.matchAll(new RegExp(g.muster.source, 'g'))) {
      const ende = m.index + m[0].length;
      const spaeter = !beste || ende > beste.ende + 2;
      const gleichAberLaenger = beste && Math.abs(ende - beste.ende) <= 2 && m[0].length > beste.laenge;
      if (spaeter || gleichAberLaenger) beste = { g, ende, laenge: m[0].length };
    }
  }
  return beste ? beste.g : null;
}

/* ---------- Daten ---------- */

const MEHRZAHL = {
  portion: 'Portionen', packung: 'Packungen', scheibe: 'Scheiben', flasche: 'Flaschen', dose: 'Dosen', tafel: 'Tafeln',
  tasse: 'Tassen', kugel: 'Kugeln', schale: 'Schalen', glas: 'Gläser', keks: 'Kekse', becher: 'Becher', riegel: 'Riegel',
  stueck: 'Stück', tuete: 'Tüten', schachtel: 'Schachteln', waffel: 'Waffeln', loeffel: 'Löffel', essloeffel: 'Esslöffel',
  teeloeffel: 'Teelöffel', praline: 'Pralinen', brezel: 'Brezeln', broetchen: 'Brötchen', ecke: 'Ecken', rippe: 'Rippen',
};
function mehrzahlVon(s) {
  const t = MEHRZAHL[falte(s).replace(/ /g, '')];
  if (t) return t;
  if (/^ei$/i.test(s)) return 'Eier';
  if (/(el|er|en|chen|lein)$/i.test(s)) return s; // Riegel, Becher, Brötchen bleiben
  if (/e$/i.test(s)) return s + 'n'; // Stange → Stangen, Schnitte → Schnitten
  return s;
}

const BASIS_EINHEIT = {
  g: { key: 'g', singular: 'g', plural: 'g', menge: 1, basis: true },
  ml: { key: 'ml', singular: 'ml', plural: 'ml', menge: 1, basis: true },
};

function vorbereiten(raw, herkunft) {
  const f = { ...raw };
  f.herkunft = f.herkunft || herkunft || 'db';
  f.name = String(f.name || 'Unbenannt').slice(0, 80);
  f.basis = f.basis === 'ml' ? 'ml' : 'g';
  f.kcal100 = Math.max(0, num(f.kcal100));
  f.emoji = f.emoji || '🍽️';

  const seen = new Set();
  const einheiten = [];
  for (const u of Array.isArray(f.einheiten) ? f.einheiten : []) {
    const menge = num(u && u.menge);
    const key = falte(u && (u.key || u.singular)).replace(/ /g, '-') || 'portion';
    if (!(menge > 0) || key === 'g' || key === 'ml' || key === 'handvoll' || seen.has(key)) continue;
    seen.add(key);
    const singular = String(u.singular || key);
    const plural = u.plural && u.plural !== singular ? String(u.plural) : mehrzahlVon(singular);
    einheiten.push({ key, singular, plural, menge });
  }

  // Handvoll: genau eine Quelle der Wahrheit – das Feld "handvoll" (Gramm)
  let hv = num(f.handvoll);
  if (!(hv > 0) && f.herkunft === 'off' && f.basis === 'g') hv = num(schaetzeHandvoll(f));
  f.handvoll = f.basis === 'g' && hv > 0 ? hv : 0;
  if (f.handvoll) {
    const hvU = { key: 'handvoll', singular: 'Handvoll', plural: 'Handvoll', menge: Math.round(f.handvoll * handFaktor() * 10) / 10 };
    // Für lose Lebensmittel steht die Handvoll vorn, sofern die Datenbank sie dort hatte
    const warVorn = Array.isArray(raw.einheiten) && raw.einheiten[0] && raw.einheiten[0].key === 'handvoll';
    if (warVorn) einheiten.unshift(hvU); else einheiten.push(hvU);
  }
  einheiten.push({ ...BASIS_EINHEIT[f.basis] });
  f.einheiten = einheiten;

  const such = [f.name, f.marke, ...(f.aliase || [])].filter(Boolean).join(' ');
  f._such = ' ' + falte(such) + ' ' + falte(such, false) + ' ';
  return f;
}

const handFaktor = () => HAND_FAKTOR[LS.get('hand', 'mittel')] || 1;
let DB = [];
let eigene = [];
function ladeDaten() {
  DB = (window.KS_DATEN || []).map((f) => vorbereiten(f, 'db'));
  eigene = LS.get('eigene', []).map((f) => vorbereiten(f));
}
ladeDaten();
let zuletzt = LS.get('zuletzt', []);

const alle = () => [...eigene, ...DB];
const finde = (id) => eigene.find((f) => f.id === id) || DB.find((f) => f.id === id);
const einheit = (food, key) => food.einheiten.find((u) => u.key === key) || food.einheiten[0];

function eigeneSpeichern() {
  LS.set('eigene', eigene.map(({ _such, ...rest }) => rest));
}
function merkeZuletzt(id) {
  zuletzt = [id, ...zuletzt.filter((x) => x !== id)].slice(0, 12);
  LS.set('zuletzt', zuletzt);
}

const KATEGORIEN = [
  ['alle', 'Alle'], ['suess', 'Süßes'], ['salzig', 'Salziges'], ['obst', 'Obst & Gemüse'],
  ['backwaren', 'Backwaren'], ['mahlzeit', 'Essen'], ['getraenk', 'Getränke'], ['milch', 'Milch & Co.'], ['alkohol', 'Alkohol'],
];
// Vergleichsliste "Gleich viel wie …" – die ersten 6, die gerade nicht oben gewählt sind
const BELIEBT = ['apfelsaft', 'banane', 'haribo-goldbaeren', 'bier', 'apfel', 'doener', 'cola', 'kartoffelchips', 'weintrauben', 'laugenbrezel', 'hafermilch', 'duplo', 'salzbrezeln', 'pizza-margherita'];

/* ---------- Zustand ---------- */

const START = { a: { id: 'duplo', unit: '', amount: 1 }, b: { id: 'salzbrezeln', unit: 'handvoll' } };
// Liefert jedes Mal ein neues Objekt – START selbst wird nie verändert
const startSlot = (k) => ({ ...START[k], id: (finde(START[k].id) || DB[k === 'a' ? 0 : 1] || {}).id });
const S = LS.get('state', null) || { a: startSlot('a'), b: startSlot('b') };
if (!S.a || !finde(S.a.id)) S.a = startSlot('a');
if (!S.b || !finde(S.b.id)) S.b = startSlot('b');
if (!(S.a.amount > 0)) S.a.amount = 1;

const kcalVon = (food, u, menge) => (menge * u.menge * food.kcal100) / 100;
const mengeFuer = (food, u, kcal) => {
  const pro = (u.menge * food.kcal100) / 100;
  return pro > 0 ? kcal / pro : NaN;
};

// Menge lesbar runden: 1¾ Handvoll · 2 Gläser · ½ Riegel · 154 g
// Viertel statt Dezimalstellen: Bei ±30 % Streuung einer Handvoll wäre "1,73" Scheingenauigkeit.
const BRUCH = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
const rundeMenge = (x) => (x >= 10 ? Math.round(x) : x >= 0.25 ? Math.round(x * 4) / 4 : Math.round(x * 10) / 10);
function fmtMenge(x, u) {
  if (!Number.isFinite(x)) return '–';
  if (u.basis) {
    if (x >= 1000) return nf0.format(Math.round(x / 10) * 10);
    if (x >= 200) return nf0.format(Math.round(x / 5) * 5);
    return nf0.format(Math.round(x));
  }
  if (x >= 10) return nf0.format(Math.round(x));
  if (x <= 0) return '0';
  if (x < 0.05) return '< 0,1';
  if (x < 0.25) return nf1.format(Math.round(x * 10) / 10);
  const q = rundeMenge(x);
  const ganz = Math.floor(q);
  return (ganz ? String(ganz) : '') + (BRUCH[q - ganz] || '');
}
const einheitText = (x, u) => (u.basis || rundeMenge(x) > 1 ? u.plural : u.singular);
// Die eigene Eingabe wird nicht gerundet – nur echte Viertel unter 10 erscheinen als Bruch
const fmtEingabe = (x, u) => (!u.basis && x < 10 && Number.isInteger(x * 4) ? fmtMenge(x, u) : nf2.format(x));
const eingabeWort = (x, u) => (u.basis || x <= 1 ? u.singular : u.plural);
const kcalProEinheit = (food, u) => kcalVon(food, u, 1);

// Steckt die Einheit schon im Namen? Deutsche Komposita enden auf das Grundwort (Laugen-brezel, Wein-trauben,
// Mc-nuggets) – geprüft wird das letzte Wort von Ein- und Mehrzahl; kurze Einheiten ("EL", "Ei") nur exakt.
function steckeImNamen(u, food) {
  if (u.basis) return false;
  const formen = [u.singular, u.plural].map((t) => falte(t).split(' ').pop()).filter(Boolean);
  return falte(food.name).split(' ').some((w) => formen.some((e) => w === e || (e.length >= 3 && w.endsWith(e))));
}
// Vollständige Angabe: "1 Riegel Duplo" · "2 × Laugenbrezel" · "1 halbe Avocado" · "100 g Duplo"
function phrase(zahlText, wort, u, food) {
  const vorn = zahlText ? zahlText + ' ' : '';
  if (!steckeImNamen(u, food)) return `${vorn}${wort} ${food.name}`;
  const teile = wort.split(' ');
  return teile.length > 1 ? `${vorn}${teile.slice(0, -1).join(' ')} ${food.name}` : `${vorn}× ${food.name}`;
}
const bezeichnung = (x, u, food) => phrase('', einheitText(x, u), u, food);

/* ---------- Darstellung ---------- */

function setzeFoodKnopf(card, food, u) {
  const em = $('[data-f="emoji"]', card);
  em.replaceChildren(food.bild ? h('img', { src: food.bild, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : food.emoji);
  $('[data-f="name"]', card).textContent = food.name;
  const pro100 = `${nf0.format(food.kcal100)} kcal / 100 ${food.basis}`;
  $('[data-f="meta"]', card).textContent = u.basis
    ? pro100
    : `${nf0.format(kcalProEinheit(food, u))} kcal pro ${u.singular} (${nf1.format(u.menge)} ${food.basis}) · ${pro100}`;
}

function setzeChips(slot, food, aktiv) {
  const box = $(`[data-units="${slot}"]`);
  box.replaceChildren(...food.einheiten.map((u) => h('button', {
    class: 'chip', role: 'radio', 'aria-checked': String(u.key === aktiv.key),
    onclick: () => waehleEinheit(slot, u.key),
  }, u.basis ? (food.basis === 'ml' ? 'Milliliter' : 'Gramm') : u.singular,
  // "Flasche (1 l)" trägt die Größe schon im Namen → keine doppelte Mengenangabe
  u.basis || /\d/.test(u.singular) ? null : h('small', {}, `${nf1.format(u.menge)} ${food.basis}`))));
}

function zeichnePicto(food, u, x) {
  const box = $('#picto');
  box.replaceChildren();
  if (u.basis || !Number.isFinite(x) || x <= 0) return;
  const e = food.emoji || '🍽️';
  if (x > 12) {
    box.append(h('span', { class: 'p' }, e), h('span', { class: 'more' }, `× ${fmtMenge(x, u)}`));
    return;
  }
  const voll = Math.floor(x + 1e-6);
  const rest = x - voll;
  for (let i = 0; i < voll; i++) box.append(h('span', { class: 'p' }, e));
  if (rest >= 0.05) {
    box.append(h('span', { class: 'p part', style: `--p:${Math.round(rest * 100)}%` },
      h('span', { class: 'ghost' }, e), h('span', { class: 'fill' }, e)));
  }
}

function render(anim) {
  const A = finde(S.a.id);
  const B = finde(S.b.id);
  if (!A || !B) return;
  const uA = einheit(A, S.a.unit);
  const uB = einheit(B, S.b.unit);
  S.a.unit = uA.key;
  S.b.unit = uB.key;

  setzeFoodKnopf($('#card-a'), A, uA);
  setzeFoodKnopf($('#card-b'), B, uB);
  setzeChips('a', A, uA);
  setzeChips('b', B, uB);

  const inp = $('#amount-a');
  if (document.activeElement !== inp) inp.value = nf2.format(S.a.amount);
  inp.classList.toggle('lang', inp.value.length > 4);
  inp.classList.toggle('sehr-lang', inp.value.length > 6);

  const kcal = kcalVon(A, uA, S.a.amount);
  const x = mengeFuer(B, uB, kcal);

  $('#result-num').textContent = fmtMenge(x, uB);
  $('#result-unit').textContent = bezeichnung(x, uB, B);
  $('#kcal').textContent = nf0.format(kcal);
  zeichnePicto(B, uB, x);

  // Unter 0,05 steht "< 0,1" – ein "≈" davor wäre doppelt gemoppelt
  const winzig = Number.isFinite(x) && x > 0 && x < 0.05 && !uB.basis;
  $('.result .approx').hidden = winzig;
  const satz = $('#sentence');
  satz.replaceChildren(
    h('span', { class: 'a' }, phrase(fmtEingabe(S.a.amount, uA), eingabeWort(S.a.amount, uA), uA, A)),
    winzig ? ' entspricht ' : ' ≈ ',
    h('span', { class: 'b' }, phrase(fmtMenge(x, uB), einheitText(x, uB), uB, B)),
  );

  const hint = $('#hint');
  const hinweise = [];
  if (B.kcal100 === 0) hinweise.push(`${B.name} hat 0 kcal – da lässt sich nichts umrechnen.`);
  else if (A.kcal100 === 0) hinweise.push(`${A.name} hat 0 kcal – das entspricht 0 von allem anderen.`);
  if ([A, B].some((f) => f.sicherheit === 'niedrig')) hinweise.push('Mindestens ein Wert ist nur grob geschätzt.');
  if (uB.key === 'handvoll' && Number.isFinite(x) && x > 0) {
    // Eine echte Handvoll liegt meist beim 0,75- bis 1,35-Fachen des Mittelwerts → Anzahl umgekehrt
    const von = fmtMenge(x / 1.35, uB);
    const bis = fmtMenge(x / 0.75, uB);
    if (von !== bis) hinweise.push(`Je nach Hand und Griff etwa ${von} bis ${bis} Handvoll.`);
  } else if (uA.key === 'handvoll') {
    hinweise.push('Handvoll = gemittelte Erwachsenenhand, locker gegriffen – echte Hände streuen um etwa ±30 %.');
  }
  hint.hidden = !hinweise.length;
  hint.className = 'hint' + ([A, B].some((f) => f.sicherheit === 'niedrig' || f.kcal100 === 0) ? ' warn' : '');
  hint.textContent = hinweise.join(' ');

  zeichneAuchListe(kcal, A, B);

  if (anim) for (const el of [$('#result-num'), $('#picto')]) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  LS.set('state', S);
}

function zeichneAuchListe(kcal, A, B) {
  const ids = BELIEBT.filter((id) => id !== A.id && id !== B.id && finde(id));
  const liste = $('#also');
  liste.replaceChildren(...ids.slice(0, 6).map((id) => {
    const f = finde(id);
    const u = f.einheiten[0];
    const x = mengeFuer(f, u, kcal);
    return h('li', {}, h('button', { class: 'also-item', onclick: () => { S.b = { id: f.id, unit: u.key }; merkeZuletzt(f.id); render(true); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
      h('span', { class: 'e' }, f.emoji),
      h('span', { class: 't' }, h('span', { class: 'n' }, fmtMenge(x, u)), h('span', { class: 'l' }, bezeichnung(x, u, f)))));
  }));
}

/* ---------- Bedienung ---------- */

function waehleEinheit(slot, key) {
  if (S[slot].unit === key) return; // aktiven Chip nochmal getippt: Menge nicht zurücksetzen
  if (slot === 'a') {
    // Beim Einheitenwechsel die Kalorien grob beibehalten wäre verwirrend – lieber eine runde Menge
    const A = finde(S.a.id);
    const u = einheit(A, key);
    S.a.amount = u.basis ? 100 : 1;
  }
  S[slot].unit = key;
  render(true);
}

function waehleFood(slot, food) {
  const u = food.einheiten[0];
  if (slot === 'a') S.a = { id: food.id, unit: u.key, amount: u.basis ? 100 : 1 };
  else S.b = { id: food.id, unit: u.key };
  merkeZuletzt(food.id);
  render(true);
}

function schritt(dir) {
  const A = finde(S.a.id);
  const u = einheit(A, S.a.unit);
  const step = u.basis ? (A.basis === 'ml' ? 50 : 10) : (S.a.amount < 1 || (S.a.amount === 1 && dir < 0) ? 0.25 : 1);
  // Auf das Raster einrasten (15 g → 10 g → 20 g), Minus darf nie erhöhen
  const k = S.a.amount / step;
  const v = Math.round((dir < 0 ? Math.ceil(k - 1e-9) - 1 : Math.floor(k + 1e-9) + 1) * step * 100) / 100;
  if (v <= 0) return;
  S.a.amount = v;
  render(true);
}

function tauschen() {
  $('#btn-switch').classList.toggle('spin');
  const altA = { ...S.a };
  const B = finde(S.b.id);
  const uB = einheit(B, S.b.unit);
  // Neues "Ich habe" startet mit einer runden Menge – so liest man das Verhältnis direkt ab
  S.a = { id: B.id, unit: uB.key, amount: uB.basis ? 100 : 1 };
  S.b = { id: altA.id, unit: altA.unit };
  render(true);
}

/* ---------- Auswahl-Sheet ---------- */

let pickSlot = 'a';
let pickKat = 'alle';
let offTreffer = null;
let offSucheLaeuft = false;

function oeffnePicker(slot) {
  pickSlot = slot;
  pickKat = 'alle';
  offTreffer = null;
  $('#pick-q').value = '';
  $('#pick-title').textContent = slot === 'a' ? 'Was hast du?' : 'Umrechnen in …';
  zeichneKategorien();
  zeichneTreffer();
  $('#sheet-pick').showModal();
}

function zeichneKategorien() {
  $('#pick-cats').replaceChildren(...KATEGORIEN.map(([k, label]) => h('button', {
    class: 'chip', 'aria-pressed': String(k === pickKat),
    onclick: () => { pickKat = k; zeichneKategorien(); zeichneTreffer(); },
  }, label)));
}

function zeile(food, onclick) {
  const u = food.einheiten[0];
  const meta = u.basis
    ? `${nf0.format(food.kcal100)} kcal / 100 ${food.basis}`
    : `${nf0.format(kcalProEinheit(food, u))} kcal pro ${u.singular} · ${nf0.format(food.kcal100)} kcal / 100 ${food.basis}`;
  const badge = { off: h('span', { class: 'badge off' }, 'OFF'), ki: h('span', { class: 'badge ki' }, 'KI'), eigen: h('span', { class: 'badge' }, 'eigen') }[food.herkunft];
  return h('li', {}, h('button', { class: 'row', onclick },
    h('span', { class: 'food-emoji' }, food.bild ? h('img', { src: food.bild, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : food.emoji),
    h('span', { class: 't' }, h('span', { class: 'n' }, food.name), h('span', { class: 'm' }, [food.marke, meta].filter(Boolean).join(' · '))),
    badge || null));
}

function suche(q) {
  const a = falte(q);
  const b = falte(q, false);
  if (!a) return [];
  const woerter = [...new Set([...a.split(' '), ...b.split(' ')])];
  return alle()
    .map((f) => {
      let score = 0;
      for (const w of woerter) {
        if (f._such.includes(' ' + w)) score += 2;
        else if (f._such.includes(w)) score += 1;
      }
      if (falte(f.name) === a) score += 5;
      else if (falte(f.name).startsWith(a)) score += 3;
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.f.name.localeCompare(y.f.name, 'de'))
    .map((x) => x.f);
}

const sichtbare = (liste) => (pickKat === 'alle' ? liste : liste.filter((f) => f.kategorie === pickKat));

function zeichneTreffer() {
  const q = $('#pick-q').value.trim();
  const box = $('#pick-results');
  const waehle = (f) => () => { $('#sheet-pick').close(); waehleFood(pickSlot, f); };
  const teile = [];

  if (q) {
    const alleTreffer = suche(q);
    const treffer = sichtbare(alleTreffer);
    const versteckt = alleTreffer.length - treffer.length;
    if (treffer.length) {
      teile.push(h('ul', { class: 'list' }, treffer.slice(0, 40).map((f) => zeile(f, waehle(f)))));
    } else if (versteckt) {
      teile.push(h('p', { class: 'empty' }, `Nichts unter „${KATEGORIEN.find(([k]) => k === pickKat)[1]}“.`));
      teile.push(h('button', { class: 'online-btn', onclick: () => { pickKat = 'alle'; zeichneKategorien(); zeichneTreffer(); } },
        `${versteckt} Treffer in anderen Kategorien anzeigen`));
    } else {
      teile.push(h('p', { class: 'empty' }, 'Nichts in der eigenen Datenbank gefunden.'));
    }

    if (offTreffer && offTreffer.q === q) {
      teile.push(h('p', { class: 'list-title' }, 'Open Food Facts'));
      teile.push(offTreffer.liste.length
        ? h('ul', { class: 'list' }, offTreffer.liste.map((f) => zeile(f, () => { uebernehmeFremd(f); $('#sheet-pick').close(); waehleFood(pickSlot, finde(f.id)); })))
        : h('p', { class: 'empty' }, offTreffer.fehler || 'Keine Produkte mit Kalorienangabe gefunden.'));
      if (offTreffer.fehler) {
        teile.push(h('button', { class: 'online-btn', disabled: offSucheLaeuft, onclick: () => onlineSuche(q) },
          offSucheLaeuft ? 'Suche läuft …' : 'Nochmal online suchen'));
      }
    } else if (q.length >= 2) {
      teile.push(h('button', { class: 'online-btn', disabled: offSucheLaeuft, onclick: () => onlineSuche(q) },
        offSucheLaeuft ? 'Suche läuft …' : `„${q}“ online bei Open Food Facts suchen`));
    }
  } else {
    const zul = zuletzt.map(finde).filter(Boolean).filter((f) => pickKat === 'alle' || f.kategorie === pickKat);
    if (zul.length && pickKat === 'alle') {
      teile.push(h('p', { class: 'list-title' }, 'Zuletzt'));
      teile.push(h('ul', { class: 'list' }, zul.slice(0, 6).map((f) => zeile(f, waehle(f)))));
    }
    const liste = alle().filter((f) => pickKat === 'alle' || f.kategorie === pickKat)
      .sort((x, y) => x.name.localeCompare(y.name, 'de'));
    teile.push(h('p', { class: 'list-title' }, pickKat === 'alle' ? 'Alle Lebensmittel' : KATEGORIEN.find(([k]) => k === pickKat)[1]));
    teile.push(h('ul', { class: 'list' }, liste.map((f) => zeile(f, waehle(f)))));
  }
  box.replaceChildren(...teile);
}

async function onlineSuche(q) {
  const status = $('#pick-status');
  offSucheLaeuft = true;
  status.textContent = 'Online-Suche läuft …';
  zeichneTreffer();
  try {
    offTreffer = { q, liste: await offSuchen(q) };
    status.textContent = `${offTreffer.liste.length} Treffer bei Open Food Facts`;
  } catch (e) {
    console.warn(e);
    offTreffer = { q, liste: [], fehler: 'Open Food Facts ist gerade überlastet oder nicht erreichbar – bitte gleich nochmal versuchen.' };
    status.textContent = offTreffer.fehler;
  }
  offSucheLaeuft = false;
  if ($('#pick-q').value.trim() === q) zeichneTreffer();
}

// Fremdes Produkt (Open Food Facts / KI) dauerhaft unter "eigene" ablegen
function uebernehmeFremd(food) {
  const f = vorbereiten({ ...food, _such: undefined }, food.herkunft);
  eigene = [f, ...eigene.filter((x) => x.id !== f.id)];
  eigeneSpeichern();
  return f;
}

/* ---------- Open Food Facts ---------- */

const OFF_EMOJI = [
  ['beverages', '🥤'], ['juices', '🧃'], ['plant-based-milks', '🥛'], ['milks', '🥛'], ['beers', '🍺'], ['wines', '🍷'],
  ['chocolates', '🍫'], ['candies', '🍬'], ['gummies', '🍬'], ['biscuits', '🍪'], ['cakes', '🍰'], ['ice-creams', '🍦'],
  ['chips', '🥔'], ['crisps', '🥔'], ['pretzels', '🥨'], ['nuts', '🥜'], ['breads', '🍞'], ['cheeses', '🧀'],
  ['yogurts', '🥣'], ['breakfast-cereals', '🥣'], ['pizzas', '🍕'], ['fruits', '🍎'], ['vegetables', '🥕'], ['meats', '🥩'], ['sausages', '🌭'],
];

// "0,33 l" · "33 cl" · "10 x 22 g = 220 g" → { wert, einheit: 'g' | 'ml' }
function parseMenge(s) {
  if (!s) return null;
  const t = String(s).toLowerCase().replace(/,/g, '.');
  const teil = t.includes('=') ? t.split('=').pop() : t;
  const m = teil.match(/(\d+(?:\.\d+)?)\s*(?:x\s*(\d+(?:\.\d+)?)\s*)?(kg|mg|g|ml|cl|l(?:iter|itre)?)\b/);
  if (!m) return null;
  const faktor = { kg: 1000, mg: 0.001, g: 1, ml: 1, cl: 10 }[m[3]] ?? 1000;
  return { wert: parseFloat(m[1]) * (m[2] ? parseFloat(m[2]) : 1) * faktor, einheit: /^(ml|cl|l)/.test(m[3]) ? 'ml' : 'g' };
}

function offKcal(p) {
  const n = p.nutriments || {};
  const z = (v) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : null);
  let kcal = z(n['energy-kcal_100g']);
  const kj = z(n['energy-kj_100g']) ?? z(n.energy_100g); // energy_100g ist bei OFF immer kJ
  if (kcal == null && kj != null) kcal = kj / 4.184;
  return kcal != null && kcal > 0 && kcal <= 900 ? Math.round(kcal * 10) / 10 : null;
}

function offZuFood(p) {
  if (!p) return null;
  const kcal = offKcal(p);
  if (kcal == null) return null;

  const kats = Array.isArray(p.categories_tags) ? p.categories_tags : [];
  const packTxt = parseMenge(p.quantity);
  // nutrition_data_per ist oft falsch ("100g" bei Getränken) → mehrere Hinweise in fester Reihenfolge
  const basis = (p.nutrition_data_per === '100ml' || p.product_quantity_unit === 'ml' || p.serving_quantity_unit === 'ml'
    || (packTxt && packTxt.einheit === 'ml')) ? 'ml' : 'g';

  const einheiten = [];
  const portion = num(p.serving_quantity);
  const portionPasst = !p.serving_quantity_unit || p.serving_quantity_unit === basis;
  if (portion > 0 && portion < 5000 && portionPasst) einheiten.push({ key: 'portion', singular: 'Portion', plural: 'Portionen', menge: portion });
  let packung = num(p.product_quantity);
  if (!(packung > 0) && packTxt && packTxt.einheit === basis) packung = packTxt.wert;
  if (packung > 0 && packung < 20000 && Math.abs(packung - portion) > 0.5) {
    einheiten.push(basis === 'ml'
      ? { key: 'flasche', singular: 'Flasche/Packung', plural: 'Flaschen/Packungen', menge: packung }
      : { key: 'packung', singular: 'Packung', plural: 'Packungen', menge: packung });
  }
  if (basis === 'ml') einheiten.push({ key: 'glas', singular: 'Glas', plural: 'Gläser', menge: 200 });

  const emoji = (OFF_EMOJI.find(([k]) => kats.some((t) => t.includes(k))) || [, basis === 'ml' ? '🥤' : '🛒'])[1];
  const hat = (re) => kats.some((t) => re.test(t));
  const kategorie = hat(/alcoholic|beers|wines|spirits/) ? 'alkohol'
    : hat(/plant-based-milks|milks|dairy-drinks/) ? 'milch'
      : basis === 'ml' ? 'getraenk'
        : hat(/chocolates|candies|confectioner|biscuits|cakes|ice-creams|sweet-snacks|desserts/) ? 'suess'
          : hat(/chips|crisps|pretzels|nuts|salty-snacks|crackers/) ? 'salzig'
            : hat(/fruits|vegetables/) ? 'obst'
              : hat(/breads|pastries|viennoiseries/) ? 'backwaren'
                : 'mahlzeit';
  const marke = Array.isArray(p.brands) ? p.brands[0] : String(p.brands || '').split(',')[0];
  return {
    id: 'off:' + p.code,
    name: String(p.product_name_de || p.product_name || '').trim() || 'Unbekanntes Produkt',
    marke: String(marke || '').trim(),
    emoji,
    bild: typeof p.image_front_small_url === 'string' && p.image_front_small_url.startsWith('https://') ? p.image_front_small_url : undefined,
    kategorie,
    basis,
    kcal100: kcal,
    einheiten,
    kategorienOff: kats.slice(0, 30),
    quelle: `https://world.openfoodfacts.org/product/${p.code}`,
    sicherheit: 'mittel',
    herkunft: 'off',
  };
}

// OFF erlaubt 15 Produkt- bzw. 10 Suchanfragen pro Minute und IP → selbst drosseln
function drossel(maxProMin) {
  const zeiten = [];
  return async function warte() {
    for (;;) {
      const jetzt = Date.now();
      while (zeiten.length && jetzt - zeiten[0] > 60000) zeiten.shift();
      if (zeiten.length < maxProMin) { zeiten.push(jetzt); return; }
      await new Promise((r) => setTimeout(r, 60050 - (jetzt - zeiten[0])));
    }
  };
}
const warteProdukt = drossel(12);
const warteSuche = drossel(8);

// Keine eigenen Header (sonst CORS-Preflight, der mitzählt). 503/429 kommen ohne CORS-Header
// an – Safari meldet dann nur "TypeError: Load failed" → wie "nochmal versuchen" behandeln.
async function holeJson(url, warte, versuche = 3) {
  let fehler;
  for (let i = 0; i < versuche; i++) {
    await warte();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      fehler = new Error('HTTP ' + res.status);
    } catch (e) {
      fehler = e;
    } finally {
      clearTimeout(timer);
    }
    if (i < versuche - 1) await new Promise((r) => setTimeout(r, 800 * 2 ** i));
  }
  throw fehler;
}

const offCache = new Map();

async function offProdukt(ean) {
  const code = String(ean).replace(/\D/g, '');
  if (offCache.has(code)) return offCache.get(code);
  const d = await holeJson(`${OFF_PRODUKT}${code}?lc=de&fields=${OFF_FELDER}&${OFF_APP}`, warteProdukt);
  const food = d && d.product ? offZuFood({ code, ...d.product }) : null;
  offCache.set(code, food);
  return food;
}

async function offSuchen(q) {
  const key = 's:' + q.toLowerCase();
  if (offCache.has(key)) return offCache.get(key);
  const url = `${OFF_SUCHE}?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1`
    + `&sort_by=unique_scans_n&page_size=20&fields=${OFF_FELDER}&${OFF_APP}`;
  const d = await holeJson(url, warteSuche);
  const liste = ((d && d.products) || []).map(offZuFood).filter(Boolean).map((f) => vorbereiten(f, 'off'));
  offCache.set(key, liste);
  return liste;
}

/* ---------- Foto: Bild laden, Barcode, KI ---------- */

// Datei (JPEG/PNG/HEIC) → verkleinertes, richtig gedrehtes Canvas.
// iOS: nie ein 24-MP-Foto in Originalgröße auf ein Canvas legen (Speicherlimit).
async function ladeBild(file, maxKante = 1600) {
  let src;
  let w;
  let hgt;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width;
    hgt = src.height;
  } catch {
    src = new Image();
    const url = URL.createObjectURL(file);
    try { src.src = url; await src.decode(); } finally { URL.revokeObjectURL(url); }
    w = src.naturalWidth;
    hgt = src.naturalHeight;
  }
  const s = Math.min(1, maxKante / Math.max(w, hgt));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(hgt * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  return c;
}
const gibCanvasFrei = (c) => { if (c) { c.width = 0; c.height = 0; } };

// Ein gescheiterter import() bleibt in WebKit bis zum Neuladen "kaputt" gemerkt, ein gescheiterter fetch() nicht.
// Darum zuerst alle statischen Abhängigkeiten per fetch holen (füllt nebenbei die Caches), dann importieren.
async function ladeModul(url, abhaengig = []) {
  for (const u of [url, ...abhaengig]) {
    const r = await fetch(u);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u);
    await r.arrayBuffer();
  }
  return import(url);
}
const BARCODE_ABH = [new URL('./zxing-exported.js', BARCODE_URL).href];
const SDK_ABH = [
  'https://cdn.jsdelivr.net/npm/standardwebhooks@1.1.1/+esm',
  'https://cdn.jsdelivr.net/npm/@stablelib/base64@1.0.1/+esm',
  'https://cdn.jsdelivr.net/npm/fast-sha256@1.3.0/+esm',
];

let detectorPromise;
function barcodeLeser() {
  detectorPromise ??= (async () => {
    const mod = await ladeModul(BARCODE_URL, BARCODE_ABH);
    const wasm = `https://cdn.jsdelivr.net/npm/zxing-wasm@${mod.ZXING_WASM_VERSION}/dist/reader/zxing_reader.wasm`;
    await mod.prepareZXingModule({
      overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? wasm : prefix + p) },
      fireImmediately: true,
    });
    return new mod.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
  })();
  detectorPromise.catch(() => { detectorPromise = null; }); // bei Netzfehler später neu versuchen
  return detectorPromise;
}

async function leseBarcode(canvas) {
  const det = await barcodeLeser();
  const codes = await det.detect(canvas);
  const c = codes.find((x) => /^(\d{8}|\d{12,14})$/.test(x.rawValue));
  return c ? c.rawValue : null;
}

// Beispiele aus der eigenen Datenbank – so passen KI-Schätzung, Info-Text und Datenbank zusammen
const HV_BEISPIELE = ['erdnuesse', 'haribo-goldbaeren', 'salzbrezeln', 'kartoffelchips', 'weintrauben'];
function handvollBeispiele() {
  return HV_BEISPIELE.map((id) => (window.KS_DATEN || []).find((f) => f.id === id))
    .filter((f) => f && f.handvoll > 0)
    .map((f) => `${f.name} ≈ ${Math.round(f.handvoll)} g`).join(', ');
}

const KI_SYSTEM = `Du bist der Nährwert-Assistent der App kalo'switch (Nutzer in Deutschland). Die App rechnet Lebensmittel über gleiche Kilokalorien ineinander um.
Aufgabe:
1. Erkenne auf dem Foto das Lebensmittel bzw. Produkt (Marke, Sorte, Packungsgröße). Ist eine Nährwerttabelle lesbar, nutze deren Werte direkt.
2. Sonst recherchiere mit web_search die Energieangabe in kcal pro 100 g bzw. 100 ml – bevorzugt Herstellerseite oder Open Food Facts, deutsche Produktversion. Höchstens wenige gezielte Suchen.
3. Ermittle 1–3 typische Portionseinheiten mit Menge in g bzw. ml: Stückgewicht (z. B. 1 Riegel = 18,2 g), Packungsinhalt, bei Getränken Glas (200 ml), Flasche oder Dose. Deutsche Einzahl/Mehrzahl (Glas/Gläser, Riegel/Riegel, Stück/Stück, Packung/Packungen).
4. Bei losen, stückigen Lebensmitteln (Nüsse, Chips, Brezeln, Gummibärchen, Beeren, Trauben …) schätze die Gramm einer Handvoll: leicht gewölbte Hand eines durchschnittlichen Erwachsenen, locker gegriffen, nicht aufgetürmt (≈ ${HANDVOLUMEN_ML} ml × Schüttdichte). Richtwerte aus der App-Datenbank: ${handvollBeispiele()}. Sonst handvoll = 0.
5. Rufe am Ende genau einmal das Tool produkt_melden auf. Erkennst du nichts Essbares: erkannt=false und in hinweis kurz der Grund. Erfinde keine Werte – wenn du schätzen musst, sicherheit="niedrig".`;

const PRODUKT_TOOL = {
  name: 'produkt_melden',
  description: 'Meldet das erkannte Lebensmittel mit recherchierten Nährwerten an die App. Genau einmal am Ende aufrufen.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['erkannt', 'name', 'marke', 'emoji', 'kategorie', 'basis', 'kcal100', 'einheiten', 'handvoll', 'quelle', 'sicherheit', 'hinweis'],
    properties: {
      erkannt: { type: 'boolean', description: 'false, wenn kein Lebensmittel erkennbar ist' },
      name: { type: 'string', description: 'kurzer deutscher Produktname, z. B. "Duplo" oder "Haferdrink Barista"' },
      marke: { type: 'string', description: 'Marke oder leer' },
      emoji: { type: 'string', description: 'ein passendes Emoji' },
      kategorie: { type: 'string', enum: ['suess', 'salzig', 'obst', 'backwaren', 'mahlzeit', 'milch', 'getraenk', 'alkohol'] },
      basis: { type: 'string', enum: ['g', 'ml'], description: 'g für Feste, ml für Getränke' },
      kcal100: { type: 'number', description: 'kcal pro 100 g bzw. 100 ml' },
      einheiten: {
        type: 'array',
        description: '1–3 typische Portionseinheiten, natürlichste zuerst (ohne Handvoll, ohne g/ml)',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['singular', 'plural', 'menge'],
          properties: {
            singular: { type: 'string' },
            plural: { type: 'string' },
            menge: { type: 'number', description: 'g bzw. ml pro 1 Einheit' },
          },
        },
      },
      handvoll: { type: 'number', description: 'Gramm pro Handvoll, 0 wenn nicht sinnvoll' },
      quelle: { type: 'string', description: 'URL oder "Nährwerttabelle auf dem Foto"' },
      sicherheit: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
      hinweis: { type: 'string', description: 'kurzer Hinweis für den Nutzer oder leer' },
    },
  },
};

function kiFehlerText(e) {
  const st = e && e.status;
  const apiMsg = e && e.error && e.error.error && e.error.error.message; // Klartext aus dem API-Fehler (SDK)
  const msg = String(apiMsg || (e && e.message) || '');
  if (e && e.name === 'AbortError') return 'Abgebrochen.';
  if (st == null && /timed out|timeout/i.test(msg)) return 'Zeitüberschreitung beim KI-Dienst – bitte nochmal versuchen.';
  if (st == null && /importing a module|module script|HTTP \d+ https:\/\/cdn/i.test(msg)) return 'KI-Baustein konnte nicht geladen werden – Internetverbindung prüfen.';
  if (st == null && /connection|fetch|network|load failed/i.test(msg)) return 'Keine Verbindung zum KI-Dienst.';
  if (st === 401) return 'API-Schlüssel ungültig – bitte in den Einstellungen prüfen.';
  if (st === 403) return 'Der API-Schlüssel hat keine Berechtigung dafür.';
  if (st === 404) return 'Das gewählte Modell ist für diesen Schlüssel nicht verfügbar.';
  if (st === 413) return 'Das Foto ist zu groß für den KI-Dienst.';
  if (st === 429) return 'Gerade zu viele Anfragen – bitte kurz warten.';
  if (st === 400 && /credit|balance|billing/i.test(msg)) return 'Kein Guthaben auf dem Anthropic-Konto – bitte Abrechnung prüfen.';
  if (st === 400 && /web.?search/i.test(msg)) return 'Die Websuche ist für diesen API-Schlüssel abgeschaltet (Anthropic Console).';
  if (st === 529 || st >= 500) return 'Der KI-Dienst ist gerade überlastet – bitte gleich nochmal.';
  return ((st ? st + ': ' : '') + msg).slice(0, 160) || 'Unbekannter Fehler.';
}

async function kiProdukt(canvas, ean, signal) {
  const apiKey = LS.get('apikey', '');
  if (!apiKey) throw Object.assign(new Error('Kein API-Schlüssel'), { status: 401 });
  const modell = LS.get('modell', 'claude-opus-5-5');
  const { default: Anthropic } = await ladeModul(SDK_URL, SDK_ABH);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });

  const daten = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: daten } },
      { type: 'text', text: ean ? `Welches Lebensmittel ist das? Der Barcode lautet ${ean} (war nicht in Open Food Facts).` : 'Welches Lebensmittel ist das?' },
    ],
  }];
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'DE', timezone: 'Europe/Berlin' } },
    PRODUKT_TOOL,
  ];

  for (let runde = 0; runde < 4; runde++) {
    const res = await client.beta.messages.create({
      model: modell,
      max_tokens: 16000,
      system: KI_SYSTEM,
      tools,
      messages,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    }, { signal }); // Sheet geschlossen → Anfrage abbrechen, keine weiteren Kosten
    if (res.stop_reason === 'refusal') throw new Error('Die KI hat die Anfrage abgelehnt.');
    const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'produkt_melden');
    if (call) return kiZuFood(call.input);
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue; // Websuche läuft serverseitig weiter
    if (res.stop_reason === 'max_tokens') throw new Error('Antwort wurde abgeschnitten.');
    messages.push({ role: 'user', content: 'Bitte melde dein Ergebnis jetzt mit dem Tool produkt_melden.' });
  }
  throw new Error('Die KI hat kein Ergebnis geliefert.');
}

// Erste gültige https-Adresse aus einem Text ("https://a.de, https://b.de (Hersteller)")
function ersteUrl(s) {
  for (const t of String(s || '').split(/[\s,;()]+/)) {
    try { const u = new URL(t); if (u.protocol === 'https:') return u.href; } catch { /* weiter */ }
  }
  return '';
}

function kiZuFood(r) {
  if (!r || !r.erkannt || !(num(r.kcal100) > 0)) {
    throw new Error((r && r.hinweis) || 'Kein Lebensmittel erkannt.');
  }
  if (num(r.kcal100) > 900) throw new Error('Die KI hat einen unmöglichen kcal-Wert geliefert – bitte nochmal.');
  const slug = falte(`${r.marke || ''} ${r.name}`).replace(/ /g, '-').slice(0, 40) || 'produkt';
  return {
    id: 'ki:' + slug,
    name: String(r.name).slice(0, 60),
    marke: String(r.marke || '').slice(0, 40),
    emoji: String(r.emoji || '🍽️').slice(0, 8),
    kategorie: KATEGORIEN.some(([k]) => k === r.kategorie && k !== 'alle') ? r.kategorie : (r.basis === 'ml' ? 'getraenk' : 'mahlzeit'),
    basis: r.basis === 'ml' ? 'ml' : 'g',
    kcal100: num(r.kcal100),
    einheiten: (r.einheiten || []).slice(0, 3).map((u) => ({ key: falte(u.singular).replace(/ /g, '-'), singular: u.singular, plural: u.plural, menge: num(u.menge) })),
    handvoll: num(r.handvoll),
    quelle: (ersteUrl(r.quelle) || String(r.quelle || '')).slice(0, 300),
    sicherheit: ['hoch', 'mittel', 'niedrig'].includes(r.sicherheit) ? r.sicherheit : 'niedrig',
    hinweis: String(r.hinweis || '').slice(0, 300),
    herkunft: 'ki',
  };
}

/* ---------- Scan-Ablauf ---------- */

let camSlot = 'a';
let scanLauf = 0;
let scanAbbruch = null;
let scanBildUrl = null;

function starteKamera(slot) {
  camSlot = slot;
  barcodeLeser().catch(() => { /* Meldung kommt im Scan-Ablauf */ });
  const f = $('#file');
  f.value = '';
  f.click();
}

function scanSchritt(liste, text) {
  const li = h('li', { class: 'run' }, h('span', { class: 'dot' }), h('span', {}, text));
  liste.append(li);
  const setz = (cls) => (t) => { li.className = cls; if (t) li.lastChild.textContent = t; };
  return { ok: setz('ok'), fail: setz('fail'), skip: setz('skip') };
}

async function scanne(file) {
  const lauf = ++scanLauf;
  const slot = camSlot;
  if (scanAbbruch) scanAbbruch.abort(); // ein evtl. noch laufender KI-Aufruf kostet sonst weiter
  scanAbbruch = new AbortController();
  const signal = scanAbbruch.signal;
  const body = $('#scan-body');
  if (scanBildUrl) URL.revokeObjectURL(scanBildUrl);
  scanBildUrl = URL.createObjectURL(file);
  const steps = h('ul', { class: 'steps', 'aria-live': 'polite' });
  const unten = h('div');
  body.replaceChildren(h('img', { class: 'scan-photo', src: scanBildUrl, alt: 'Dein Foto' }), steps, unten);
  if ($('#sheet-pick').open) $('#sheet-pick').close();
  const sheet = $('#sheet-scan');
  if (!sheet.open) sheet.showModal(); // "Nochmal fotografieren": Sheet ist schon offen (iOS 16 wirft sonst)
  const aktiv = () => lauf === scanLauf && sheet.open && !signal.aborted;

  let canvas;
  try {
    canvas = await ladeBild(file);
  } catch {
    scanSchritt(steps, '').fail('Das Foto ließ sich nicht öffnen.');
    zeigeAlternativen(unten, slot, false);
    return;
  }

  let food = null;
  let ean = null;
  const s1 = scanSchritt(steps, 'Barcode suchen …');
  let leserFehlt = false;
  try { ean = await leseBarcode(canvas); } catch (e) { console.warn('Barcode', e); leserFehlt = true; }
  if (!aktiv()) { gibCanvasFrei(canvas); return; }

  if (leserFehlt) {
    s1.fail('Barcode-Leser nicht geladen – Internetverbindung prüfen');
  } else if (ean) {
    s1.ok(`Barcode ${ean} erkannt`);
    const s2 = scanSchritt(steps, 'Bei Open Food Facts nachschlagen …');
    try { food = await offProdukt(ean); } catch (e) { console.warn('OFF', e); }
    if (!aktiv()) { gibCanvasFrei(canvas); return; }
    if (food) s2.ok(`Gefunden: ${food.name}`); else s2.fail('Nicht in Open Food Facts oder ohne Kalorienangabe');
  } else {
    s1.skip('Kein Barcode im Bild');
  }

  if (!food) {
    if (LS.get('apikey', '')) {
      const s3 = scanSchritt(steps, 'KI erkennt das Produkt und sucht im Web … (ca. 10–40 s)');
      try {
        food = await kiProdukt(canvas, ean, signal);
        if (aktiv()) s3.ok(`Erkannt: ${food.name}`);
      } catch (e) {
        console.warn('KI', e);
        if (aktiv()) s3.fail(kiFehlerText(e));
      }
      if (!aktiv()) { gibCanvasFrei(canvas); return; }
    } else {
      scanSchritt(steps, '').skip('Foto-Erkennung ohne Barcode braucht einen API-Schlüssel');
      unten.append(h('div', { class: 'box' },
        h('b', {}, 'Kein Barcode-Treffer. '),
        'Für die Erkennung per Foto (Obst, Backwaren, Packungs-Vorderseite) kannst du in den Einstellungen einen eigenen Claude-API-Schlüssel hinterlegen.'));
    }
  }

  gibCanvasFrei(canvas);
  if (food) {
    zeigeVorschau(unten, vorbereiten(food, food.herkunft), slot);
  } else {
    zeigeAlternativen(unten, slot, !LS.get('apikey', ''));
  }
}

function zeigeAlternativen(box, slot, mitSchluessel) {
  box.append(...[
    h('button', { class: 'btn', onclick: () => starteKamera(slot) }, 'Nochmal fotografieren'),
    h('button', { class: 'btn secondary', onclick: () => { $('#sheet-scan').close(); oeffnePicker(slot); } }, 'Stattdessen nach Namen suchen'),
    mitSchluessel ? h('button', { class: 'btn secondary', onclick: () => { $('#sheet-scan').close(); oeffneEinstellungen(); } }, 'API-Schlüssel eintragen') : null,
  ].filter(Boolean)
  );
}

function zeigeVorschau(box, food, slot) {
  const kcalIn = h('input', { inputmode: 'decimal', value: nf2.format(food.kcal100) });
  const ersteEinheit = food.einheiten.find((u) => !u.basis && u.key !== 'handvoll');
  const hvEinheit = food.einheiten.find((u) => u.key === 'handvoll');
  const mengeIn = ersteEinheit ? h('input', { inputmode: 'decimal', value: nf2.format(ersteEinheit.menge) }) : null;
  let link = null;
  try { const u = new URL(String(food.quelle || '')); if (u.protocol === 'https:') link = u; } catch { /* als Text zeigen */ }
  const quelleLink = link
    ? h('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer' }, link.hostname)
    : (food.quelle || '–');

  box.replaceChildren(...[
    h('div', { class: 'preview' },
      h('span', { class: 'food-emoji' }, food.bild ? h('img', { src: food.bild, alt: '', referrerpolicy: 'no-referrer' }) : food.emoji),
      h('span', {}, h('span', { class: 'n' }, food.name), h('span', { class: 'm' }, [food.marke, food.herkunft === 'ki' ? `KI · Sicherheit ${food.sicherheit}` : 'Open Food Facts'].filter(Boolean).join(' · ')))),
    h('p', { class: 'src' }, 'Quelle: ', quelleLink),
    food.hinweis ? h('div', { class: 'box' }, food.hinweis) : null,
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, `kcal pro 100 ${food.basis}`), kcalIn),
      mengeIn ? h('label', { class: 'field' }, h('span', {}, `1 ${ersteEinheit.singular} in ${food.basis}`), mengeIn) : null),
    hvEinheit ? h('p', { class: 'note' }, `1 Handvoll ≈ ${nf1.format(hvEinheit.menge)} g${handFaktor() !== 1 ? ' (deine Hand)' : ''}`) : null,
    h('button', {
      class: 'btn',
      onclick: () => {
        const k = zahl(kcalIn.value);
        if (!(k >= 0)) { toast('Bitte gültige kcal eingeben'); return; }
        food.kcal100 = k;
        if (mengeIn) {
          const m = zahl(mengeIn.value);
          if (m > 0) ersteEinheit.menge = m;
        }
        const f = uebernehmeFremd(food);
        $('#sheet-scan').close();
        waehleFood(slot, f);
        toast(`${f.name} übernommen`);
      },
    }, 'Übernehmen'),
  ].filter(Boolean)
  );
}

/* ---------- Eigenes Lebensmittel ---------- */

let ownSlot = 'a';
let ownBasis = 'g';

function setzeOwnBasis(b) {
  ownBasis = b;
  $$('#own-basis button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.basis === b)));
  $$('[data-basis-label]').forEach((x) => { x.textContent = b; });
  $('[data-only-g]').hidden = b !== 'g';
}

function oeffneEigenes(slot, food) {
  ownSlot = slot;
  const form = $('#own-form');
  form.reset();
  const u = food && food.einheiten.find((x) => !x.basis && x.key !== 'handvoll');
  form.name.value = food ? food.name : ($('#pick-q').value || '');
  form.kcal100.value = food ? nf2.format(food.kcal100) : '';
  form.unit.value = u ? u.singular : '';
  form.menge.value = u ? nf2.format(u.menge) : '';
  form.handvoll.value = food && food.handvoll ? nf2.format(food.handvoll) : '';
  form.id.value = food ? food.id : '';
  setzeOwnBasis(food ? food.basis : 'g');
  $('#own-title').textContent = food ? 'Lebensmittel bearbeiten' : 'Eigenes Lebensmittel';
  $('#own-delete').hidden = !food;
  if ($('#sheet-pick').open) $('#sheet-pick').close();
  $('#sheet-own').showModal();
}

function speichereEigenes(ev) {
  ev.preventDefault();
  const form = ev.target;
  const name = form.name.value.trim();
  const kcal = zahl(form.kcal100.value);
  if (!name || !(kcal >= 0)) { toast('Name und kcal ausfüllen'); return; }
  const menge = zahl(form.menge.value);
  const unitName = form.unit.value.trim() || 'Portion';
  const alt = form.id.value && finde(form.id.value);
  // Nur die im Formular gezeigte (erste) Einheit ersetzen, alle anderen behalten
  const editierbar = alt && alt.basis === ownBasis ? alt.einheiten.filter((u) => !u.basis && u.key !== 'handvoll') : [];
  const altU = editierbar[0];
  const neu = {
    key: falte(unitName).replace(/ /g, '-'),
    singular: unitName,
    plural: altU && altU.singular === unitName ? altU.plural : mehrzahlVon(unitName),
    menge,
  };
  const rest = editierbar.slice(1).filter((u) => u.key !== neu.key);
  const food = vorbereiten({
    ...(alt || {}),
    id: form.id.value || 'eigen:' + falte(name).replace(/ /g, '-') + '-' + Date.now().toString(36),
    name,
    emoji: (alt && alt.emoji) || (ownBasis === 'ml' ? '🥤' : '🍽️'),
    kategorie: (alt && alt.kategorie) || (ownBasis === 'ml' ? 'getraenk' : 'mahlzeit'),
    basis: ownBasis,
    kcal100: kcal,
    einheiten: menge > 0 ? [neu, ...rest] : rest,
    handvoll: ownBasis === 'g' ? zahl(form.handvoll.value) || 0 : 0,
    herkunft: (alt && alt.herkunft) || 'eigen',
    // Eine KI-Schätzung bleibt "niedrig", solange die kcal nicht von Hand korrigiert wurden
    sicherheit: alt && Math.abs(alt.kcal100 - kcal) < 0.005 ? (alt.sicherheit || 'mittel') : 'mittel',
  });
  eigene = [food, ...eigene.filter((x) => x.id !== food.id)];
  eigeneSpeichern();
  $('#sheet-own').close();
  waehleFood(ownSlot, food);
}

function loescheEigenes() {
  const id = $('#own-form').id.value;
  const f = finde(id);
  if (!confirm(`„${f ? f.name : 'Lebensmittel'}“ wirklich löschen?`)) return;
  eigene = eigene.filter((x) => x.id !== id);
  eigeneSpeichern();
  zuletzt = zuletzt.filter((x) => x !== id);
  LS.set('zuletzt', zuletzt);
  if (S.a.id === id) S.a = startSlot('a');
  if (S.b.id === id) S.b = startSlot('b');
  $('#sheet-own').close();
  render(true);
  toast('Gelöscht');
}

/* ---------- Einstellungen ---------- */

function oeffneEinstellungen() {
  const key = LS.get('apikey', '');
  const keyIn = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'sk-ant-…', value: key });
  const modellSel = h('select', {}, Object.entries(MODELLE).map(([id, label]) => h('option', { value: id, selected: LS.get('modell', 'claude-opus-5-5') === id }, label)));
  const eig = eigene.slice();

  $('#settings-body').replaceChildren(...[
    h('div', { class: 'box' },
      h('b', {}, 'Foto-Erkennung'), h('br'),
      'Barcode im Foto → Nährwerte kostenlos aus Open Food Facts. ',
      'Ohne Barcode-Treffer (Obst, Backwaren, Packungs-Vorderseite) erkennt Claude das Produkt und sucht die Werte im Web. ',
      'Dafür brauchst du einen eigenen API-Schlüssel von ', h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'),
      ' (kostenpflichtig, grob 5–20 Cent pro Foto). Der Schlüssel bleibt nur auf diesem Gerät und geht direkt an api.anthropic.com.'),
    h('label', { class: 'field' }, h('span', {}, 'Claude-API-Schlüssel'), keyIn),
    h('label', { class: 'field' }, h('span', {}, 'Modell'), modellSel),
    h('button', {
      class: 'btn',
      onclick: () => {
        const v = keyIn.value.trim();
        if (v && !/^sk-ant-/.test(v)) { toast('Der Schlüssel beginnt normalerweise mit sk-ant-'); return; }
        if (v) LS.set('apikey', v); else LS.del('apikey');
        LS.set('modell', modellSel.value);
        $('#sheet-settings').close();
        toast(v ? 'Gespeichert' : 'Schlüssel entfernt');
      },
    }, 'Speichern'),
    h('p', { class: 'list-title' }, 'Was ist eine Handvoll?'),
    h('p', { class: 'note' }, HANDVOLL_INFO),
    h('div', { class: 'field' }, h('span', {}, 'Meine Hand'), handWahl()),
    eig.length ? h('p', { class: 'list-title' }, 'Eigene & gescannte Lebensmittel') : null,
    eig.length ? h('ul', { class: 'list' }, eig.map((f) => zeile(f, () => { $('#sheet-settings').close(); oeffneEigenes('a', f); }))) : null,
    h('p', { class: 'note' }, `kalo’switch ${APP_VERSION} · ${DB.length} Lebensmittel in der Datenbank · Daten von Open Food Facts stehen unter der ODbL.`),
  ].filter(Boolean)
  );
  $('#sheet-settings').showModal();
}

function handWahl() {
  const box = h('div', { class: 'seg' });
  const zeichne = () => box.replaceChildren(...[['klein', 'eher klein'], ['mittel', 'mittel'], ['gross', 'eher groß']].map(([k, label]) => h('button', {
    type: 'button',
    'aria-pressed': String(LS.get('hand', 'mittel') === k),
    onclick: () => { LS.set('hand', k); ladeDaten(); zeichne(); render(true); },
  }, label)));
  zeichne();
  return box;
}

const HANDVOLL_INFO = `Gemeint ist eine leicht gewölbte Hand eines durchschnittlichen Erwachsenen, locker gegriffen und nicht aufgetürmt – rund ${HANDVOLUMEN_ML} ml. Wie viel Gramm das sind, hängt vom Lebensmittel ab: ${handvollBeispiele()}. Grundlage: eine Wiege-Studie zur „Handvoll Nüsse“ (Brown et al. 2021, Median 36 g) und Handmaße aus der ANSUR-II-Erhebung. Echte Hände und Griffe streuen um etwa ±30 %.`;

/* ---------- Verdrahtung ---------- */

function init() {
  $$('[data-pick]').forEach((b) => b.addEventListener('click', () => oeffnePicker(b.dataset.pick)));
  $$('[data-cam]').forEach((b) => b.addEventListener('click', () => starteKamera(b.dataset.cam)));
  $$('[data-step]').forEach((b) => b.addEventListener('click', () => schritt(Number(b.dataset.step))));
  $('#btn-switch').addEventListener('click', tauschen);
  $('#btn-settings').addEventListener('click', oeffneEinstellungen);

  const inp = $('#amount-a');
  inp.addEventListener('focus', () => inp.select());
  inp.addEventListener('input', () => {
    const v = zahl(inp.value);
    if (v > 0 && v < 100000) { S.a.amount = v; render(false); }
  });
  inp.addEventListener('change', () => { inp.blur(); render(true); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  inp.addEventListener('blur', () => render(false));

  $('#pick-q').addEventListener('input', () => { offTreffer = null; zeichneTreffer(); });
  $('#pick-q').addEventListener('keydown', (e) => {
    const q = $('#pick-q').value.trim();
    if (e.key !== 'Enter' || q.length < 2) return;
    $('#pick-q').blur(); // Tastatur weg, Treffer sichtbar
    if (!sichtbare(suche(q)).length) onlineSuche(q);
  });
  $('#pick-photo').addEventListener('click', () => starteKamera(pickSlot));
  $('#pick-own').addEventListener('click', () => oeffneEigenes(pickSlot));
  $('#file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) scanne(f).catch((err) => { console.error('Scan', err); toast('Scan fehlgeschlagen'); });
  });

  $('#own-form').addEventListener('submit', speichereEigenes);
  $$('#own-basis button').forEach((b) => b.addEventListener('click', () => setzeOwnBasis(b.dataset.basis)));
  $('#own-delete').addEventListener('click', loescheEigenes);

  // Sheets: Schließen-Knopf und Tippen auf den abgedunkelten Hintergrund
  $$('dialog.sheet').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target !== d) return;
      // Nur echte Tipps auf den Hintergrund schließen – nicht der Rand neben dem Greifer
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    });
    $$('[data-close]', d).forEach((b) => b.addEventListener('click', () => d.close()));
  });
  $('#sheet-scan').addEventListener('close', () => { if (scanAbbruch) scanAbbruch.abort(); });

  // iOS Safari zeigt :active erst, wenn irgendein Touch-Listener existiert
  document.body.addEventListener('touchstart', () => {}, { passive: true });

  render(false);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hatteSW = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
    // Neue Version installiert: läuft ab dem nächsten Öffnen (alte Seite bleibt in sich stimmig)
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hatteSW) toast('Update geladen – aktiv ab dem nächsten Öffnen'); });
  }
}

init();
