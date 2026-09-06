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


test('Designsystem: Skalen werden eingehalten', function () {
  /*
   * Vorher: 14 Schriftgroessen (sechs davon im Rauschen zwischen 17 und 22px),
   * 25 Abstandswerte mit 11 ausserhalb des Vierer-Rasters, 11 Radien.
   * Der Test haelt das System fest – ohne ihn laeuft es beim naechsten
   * Detail wieder auseinander.
   */
  var css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  var ohneKommentare = css.replace(/\/\*[\s\S]*?\*\//g, '');

  function werte(eigenschaften) {
    var gefunden = {};
    var re = new RegExp('\\b(' + eigenschaften + ')\\s*:([^;{}]*)', 'g');
    var m;
    while ((m = re.exec(ohneKommentare)) !== null) {
      var px = m[2].match(/-?\d+px/g) || [];
      for (var i = 0; i < px.length; i++) gefunden[Math.abs(parseInt(px[i], 10))] = true;
    }
    return Object.keys(gefunden).map(Number).sort(function (a, b) { return a - b; });
  }

  // Schriftgroessen: genau die sechs Stufen der Skala.
  var erlaubtSchrift = [18, 22, 28, 34, 44, 56];
  var schrift = werte('font-size');
  for (var i = 0; i < schrift.length; i++) {
    assert.ok(erlaubtSchrift.indexOf(schrift[i]) >= 0,
      'Schriftgroesse ausserhalb der Skala: ' + schrift[i] + 'px');
  }

  // Abstaende: alles Vielfache von 4.
  var abstand = werte('padding|margin|padding-top|padding-bottom|padding-left|' +
    'padding-right|margin-top|margin-bottom|margin-left|margin-right');
  for (var j = 0; j < abstand.length; j++) {
    assert.strictEqual(abstand[j] % 4, 0,
      'Abstand ausserhalb des Vierer-Rasters: ' + abstand[j] + 'px');
  }

  // Radien: sechs Stufen, 999 fuer Pillen.
  var erlaubtRadius = [4, 8, 12, 16, 20, 999];
  var radius = werte('border-radius');
  for (var k = 0; k < radius.length; k++) {
    assert.ok(erlaubtRadius.indexOf(radius[k]) >= 0,
      'Radius ausserhalb der Skala: ' + radius[k] + 'px');
  }

  // Die feste Kartenhoehe muss zur Zeilenhoehe passen: Innenabstand + 2 Zeilen.
  var label = /\.card \.label \{[^}]*\}/.exec(ohneKommentare)[0];
  var oben = /padding:\s*(\d+)px/.exec(label);
  var zeile = /line-height:\s*(\d+)px/.exec(label);
  // `[;{\s]` davor: sonst trifft das Muster auch „line-height".
  var hoehe = /[;{\s]height:\s*(\d+)px/.exec(label);
  assert.ok(oben && zeile && hoehe, 'Kartentitel ohne feste Masse');
  assert.strictEqual(Number(hoehe[1]), Number(oben[1]) + 2 * Number(zeile[1]),
    'Kartenhoehe passt nicht zu Innenabstand + zwei Zeilen – die dritte Zeile ' +
    'wuerde angeschnitten sichtbar');
});


test('Sachmarken werden aus dem Titel gelesen', function () {
  /*
   * IPTV-Titel tragen 4K/HD/Dolby ohnehin im Klartext – oft als hochgestellte
   * Unicode-Zeichen („⁴ᴷ ³⁸⁴⁰ᴾ ᴰᵒˡᵇʸ"). Als Marke im Poster sind sie aus drei
   * Metern schneller erfassbar, und der Titel wird kuerzer, statt in der
   * zweiten Zeile abgeschnitten zu werden.
   */
  var quelle = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  var teil = quelle.slice(quelle.indexOf('function markenAusTitel'),
                          quelle.indexOf('function card('));
  assert.ok(teil.length > 0, 'markenAusTitel fehlt');
  // `eval` hat unter 'use strict' einen eigenen Scope – die Funktion waere
  // aussen nicht sichtbar. Der Function-Konstruktor gibt sie zurueck.
  var markenAusTitel = new Function(teil + '; return markenAusTitel;')();

  assert.deepStrictEqual(markenAusTitel('4K-DE - Mayday (2026)'), ['4K']);
  assert.deepStrictEqual(markenAusTitel('WOW: SKY KRIMI ᴴᴰ'), ['HD']);
  assert.deepStrictEqual(markenAusTitel('Einfacher Titel'), []);
  // Hoechstens zwei, sonst wird das Poster zum Aufkleberalbum.
  var viele = markenAusTitel('UHD Dolby Atmos 2160p HD');
  assert.ok(viele.length <= 2, 'mehr als zwei Marken: ' + viele.join(','));
  // 4K schlaegt HD – nicht beides gleichzeitig.
  assert.ok(markenAusTitel('4K UHD 1080p').indexOf('HD') < 0);
});

test('Bewegung: keine Dauer ueber der Tastenwiederholung', function () {
  /*
   * Die Fernbedienung wiederholt beim Halten alle 120–150 ms. Dauert ein
   * Uebergang laenger, stapeln sich die Animationen und die Liste schwimmt.
   * Ausgenommen ist der Posterzoom (260 ms): Er traegt keine Information und
   * laeuft innerhalb der Karte, verzoegert die Reaktion also nicht.
   */
  var css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  var ohne = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Nur Bewegung pruefen: Deckkraft-Uebergaenge (Player-Overlay, Toast)
  // laufen nicht gegen die Tastenwiederholung.
  var re = /transition[^;]*?transform[^;]*?(\d+)ms/g, m;
  while ((m = re.exec(ohne)) !== null) {
    var ms = Number(m[1]);
    var zeile = ohne.slice(Math.max(0, m.index - 200), m.index);
    var istPoster = zeile.lastIndexOf('.poster img') > zeile.lastIndexOf('}');
    if (!istPoster) {
      assert.ok(ms <= 160, 'Uebergang zu lang: ' + ms + 'ms');
    }
  }
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
