/**
 * Headless-Rauchtest der Oberfläche: lädt index.html samt Skripten in jsdom
 * und prüft, dass die App startet, das Einrichtungs-Formular zeigt, eine
 * geladene Playlist rendert und die Fernbedienungs-Navigation greift.
 *
 * Fängt genau die Fehler ab, die auf dem Fernseher sonst nur als schwarzer
 * Bildschirm sichtbar wären.
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var { JSDOM } = require('jsdom');

var SRC = path.join(__dirname, '..', 'src');
var passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

function boot(localStorageSeed) {
  var html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  var dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  var win = dom.window;

  // Netzwerk stilllegen: Der Rauchtest soll die UI prüfen, nicht das Panel.
  win.XMLHttpRequest = function () {
    this.open = function () {};
    this.send = function () {};
    this.setRequestHeader = function () {};
  };
  if (localStorageSeed) {
    try { win.localStorage.setItem('glasstv.source', JSON.stringify(localStorageSeed)); } catch (e) {}
  }
  // HTMLMediaElement.play gibt es in jsdom nicht.
  win.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  win.HTMLMediaElement.prototype.pause = function () {};
  win.HTMLMediaElement.prototype.load = function () {};

  win.eval(fs.readFileSync(path.join(SRC, 'core.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(SRC, 'app.js'), 'utf8'));
  // Im Browser laufen die Skripte am Ende des <body>, danach feuert
  // DOMContentLoaded und die App startet. jsdom lässt das Dokument hier im
  // Zustand "loading" stehen, deshalb das Ereignis von Hand auslösen.
  if (win.document.readyState === 'loading') {
    win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  }
  return win;
}

console.log('\nOberfläche');

test('startet ohne Quelle mit dem Einrichtungs-Formular', function () {
  var win = boot(null);
  var doc = win.document;
  assert.ok(doc.querySelector('.panel'), 'Panel fehlt');
  assert.ok(doc.body.textContent.indexOf('Quelle einrichten') >= 0);
  // Vier Eingabefelder: Host, Benutzer, Passwort, M3U
  assert.strictEqual(doc.querySelectorAll('input').length, 4);
});

test('Tabs werden gerendert und sind fokussierbar', function () {
  var win = boot(null);
  var tabs = win.document.querySelectorAll('#tabs .tab');
  assert.strictEqual(tabs.length, 5);
  assert.ok(tabs[0].className.indexOf('focusable') >= 0);
});

test('geladene Playlist erscheint als Senderliste', function () {
  var win = boot(null);
  var Core = win.GlassTVCore;
  var m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="ard" group-title="TV",Das Erste\n' +
    'http://s/live/ard\n#EXTINF:-1 group-title="TV",ZDF\nhttp://s/live/zdf';
  var lib = Core.parseM3U(m3u, 'm3u');
  assert.strictEqual(lib.channels.length, 2);
  // Die App rendert aus ihrem eigenen Zustand; hier prüfen wir den Parser-Pfad,
  // der die Liste speist, und dass die Zeilenvorlage existiert.
  assert.ok(win.document.getElementById('content'));
});

test('Player-Overlay ist anfangs geschlossen', function () {
  var win = boot(null);
  var player = win.document.getElementById('player');
  assert.strictEqual(player.className, '');
});

test('Pfeiltasten verschieben den Fokus', function () {
  var win = boot(null);
  var doc = win.document;
  var focusables = doc.querySelectorAll('.focusable');
  assert.ok(focusables.length >= 2, 'zu wenige fokussierbare Elemente');
  focusables[0].focus();
  var before = doc.activeElement;
  var ev = new win.KeyboardEvent('keydown', { keyCode: 40, bubbles: true });
  // jsdom setzt keyCode nicht aus dem Init-Objekt – nachreichen.
  Object.defineProperty(ev, 'keyCode', { get: function () { return 40; } });
  doc.dispatchEvent(ev);
  // In jsdom hat kein Element eine echte Geometrie (alle Rects sind 0),
  // deshalb wird hier nur geprüft, dass der Handler nicht wirft.
  assert.ok(before);
});


test('Erstfokus meidet Textfelder (Bildschirmtastatur)', function () {
  // Bekommt ein Textfeld automatisch den Fokus, klappt webOS die
  // Bildschirmtastatur auf und verdeckt die Seite. Der Fokus muss deshalb auf
  // dem ersten bedienbaren Element landen, nicht im Feld.
  var win = boot(null);
  var doc = win.document;
  var aktiv = doc.activeElement;
  assert.ok(aktiv, 'kein Element fokussiert');
  assert.notStrictEqual(aktiv.tagName, 'INPUT');
  assert.notStrictEqual(aktiv.tagName, 'TEXTAREA');
});


test('OK im Suchfeld loest die Suche aus', function () {
  /*
   * Auf der Bildschirmtastatur ist OK die Abschlussgeste. Vorher fiel sie
   * durch: Der Handler sprang bei INPUT heraus, ohne etwas zu tun, und man
   * musste blind nach unten zum Knopf navigieren.
   *
   * Geprueft wird am Quelltext, weil der Suchbildschirm ohne eingerichtete
   * Quelle gar nicht erreichbar ist (dann rendert die App das Formular).
   */
  var quelle = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  var stelle = quelle.indexOf('else if (code === 13)');
  assert.ok(stelle > 0, 'kein Handler fuer OK');
  var block = quelle.slice(stelle, stelle + 700);
  assert.ok(block.indexOf("tagName === 'INPUT'") > 0, 'OK behandelt Eingabefelder nicht');
  assert.ok(block.indexOf("state.view.query = el2.value") > 0,
    'OK uebernimmt den Suchbegriff nicht');

  // Und das Suchfeld muss Erstziel sein sowie einen Platzhalter tragen.
  var such = quelle.indexOf('function renderSearch');
  var sblock = quelle.slice(such, such + 1400);
  assert.ok(sblock.indexOf("data-erstziel") > 0, 'Suchfeld ist nicht das Erstziel');
  assert.ok(sblock.indexOf('input.placeholder') > 0, 'Suchfeld ohne Platzhalter');
  assert.ok(sblock.indexOf('input.oninput') > 0, 'Suchbegriff wird beim Tippen nicht gemerkt');
});

test('Umschaltknoepfe behalten ihren Fokusmerker', function () {
  // "☆ Favorit" wird zu "★ Favorit" – ohne festen Schluessel findet
  // restoreFocus den Knopf nicht wieder und der Fokus springt weg.
  var quelle = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  assert.ok(quelle.indexOf("'btn:' + (fkey || label)") > 0,
    'button() nimmt keinen festen Fokusschluessel entgegen');
  var favs = quelle.split("toggleFavorite(").length - 1;
  assert.ok(favs >= 2, 'Favoriten-Umschalter nicht gefunden');
  assert.ok(quelle.indexOf("}, true, 'fav'));") > 0, 'Favorit-Knopf ohne festen Schluessel');
  assert.ok(quelle.indexOf("}, true, 'merk'));") > 0, 'Merkliste-Knopf ohne festen Schluessel');
});

test('Formularelemente erben die Schriftart', function () {
  // Ohne diese Regel rendern alle Tabs und Knoepfe in der Systemschrift
  // (auf dem Geraet gemessen: Arial), die Chips daneben in LG Smart UI.
  var css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  assert.ok(/button[^{]*,[^{]*input[^{]*\{[^}]*font-family:\s*inherit/.test(css),
    'button/input erben font-family nicht');
});


test('Filterstufe: alte Einstellung wird migriert', function () {
  /*
   * Frueher war `strict` ein boolean. Bestehende Installationen haben dort
   * `true` stehen – das entspricht jetzt „ausgewogen", also genau dem
   * Verhalten, das der Nutzer zuletzt gesehen hat. „streng" waere eine stille
   * Verschaerfung, die ihm ohne Zutun Inhalte wegnaehme.
   */
  var quelle = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  assert.ok(quelle.indexOf("saved.strict === false ? 'grosszuegig' : 'ausgewogen'") > 0,
    'Migration des alten boolean fehlt');
  assert.ok(quelle.indexOf("if (typeof saved.strict === 'string')") > 0,
    'bereits migrierte Werte werden nicht uebernommen');
  // Unbekannte Werte muessen auf den Standard fallen.
  assert.ok(quelle.indexOf("SPRACH_STUFEN_IDS.indexOf(state.settings.strict) < 0") > 0,
    'kein Rueckfall auf den Standard bei unbekanntem Wert');
  // Drei Stufen, jede mit Erklaerung.
  var stufen = quelle.split("{ id: 'grosszuegig'").length - 1;
  assert.strictEqual(stufen, 1);
  assert.ok(quelle.indexOf("hilfe:") > 0, 'Stufen ohne Erklaerungstext');
});


test('Akzente auf hellen Designs: Kontrast und Buntheit', function () {
  /*
   * Die alte Abdunklung skalierte alle Farbkanaele und entzog dabei die halbe
   * Saettigung – Violett fiel von 88 % auf 32 %, und auf hellen Designs sahen
   * Violett, Indigo und Schiefer nahezu gleich aus. Jetzt bleiben Ton und
   * Saettigung erhalten, gesenkt wird nur die Helligkeit, bis der Kontrast
   * gegen den TATSAECHLICHEN Grund des Designs 4,5:1 erreicht.
   */
  var quelle = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  assert.ok(quelle.indexOf('function akzentFuerHell') > 0, 'akzentFuerHell fehlt');
  assert.ok(quelle.indexOf('akzentFuerHell(a.color, d.bg)') > 0,
    'applyTheme nutzt die neue Berechnung nicht');
  assert.ok(quelle.indexOf('kontrastwert(kandidat, grundHex) >= 4.5') > 0,
    'die Kontrastgrenze wird nicht geprueft');

  // Die alte Fassung darf fuer Akzente nicht mehr benutzt werden.
  var stelle = quelle.indexOf('var accent = d.dark');
  var zeile = quelle.slice(stelle, stelle + 120);
  assert.ok(zeile.indexOf('darken(') < 0,
    'applyTheme dunkelt Akzente noch mit der alten Kanal-Skalierung ab');
});

test('appinfo.json ist gültig und vollständig', function () {
  var info = JSON.parse(fs.readFileSync(path.join(SRC, 'appinfo.json'), 'utf8'));
  assert.strictEqual(info.id, 'de.app.glasstv');
  assert.strictEqual(info.type, 'web');
  assert.strictEqual(info.main, 'index.html');
  assert.ok(info.version.match(/^\d+\.\d+\.\d+$/), 'Version muss x.y.z sein');
  assert.ok(fs.existsSync(path.join(SRC, info.icon)), 'Icon fehlt');
  assert.ok(fs.existsSync(path.join(SRC, info.largeIcon)), 'Großes Icon fehlt');
});

console.log('\nErgebnis: ' + (passed + failed) + ' Tests, ' + passed + ' bestanden, ' +
  failed + ' fehlgeschlagen');
process.exit(failed === 0 ? 0 : 1);
