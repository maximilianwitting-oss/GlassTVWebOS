/**
 * GlassTV für webOS – Oberfläche und Ablaufsteuerung.
 *
 * ZIELPLATTFORM: webOS 4.x (LG C9) = Chromium 53.
 * Deshalb durchgehend ES5: kein async/await (Chrome 55), kein optional
 * chaining, keine Klassen-Felder, kein `fetch` mit AbortController.
 * XMLHttpRequest ist hier der verlässliche Weg.
 *
 * Bedient wird mit der Fernbedienung: Jede Ansicht sammelt ihre fokussierbaren
 * Elemente, die Pfeiltasten schalten GEOMETRISCH weiter (nicht in DOM-
 * Reihenfolge) – sonst springt der Fokus in Rastern quer über den Bildschirm.
 */
(function () {
  'use strict';

  var Core = window.GlassTVCore;
  var APP_VERSION = '1.17.0';

  // ---------------------------------------------------------- Zustand ----

  var state = {
    tab: 'home',
    library: { channels: [], movies: [], series: [] },
    epg: {},
    source: null,
    loading: false,
    view: null,          // null | {type:'movie'|'series'|'guide'|'search', …}
    group: { live: null, movies: null, series: null },
    /*
     * Bedarfsweises Laden (nur Xtream): Die Filmliste eines großen Panels ist
     * zweistellige Megabyte groß und belegte im Speicher rund 50 MB. Die
     * Kategorienliste dagegen sind 24 KB, eine einzelne Kategorie lädt in
     * einer Viertelsekunde. Deshalb werden Filme und Serien erst geholt, wenn
     * eine Kategorie geöffnet wird.
     */
    lazyKatalog: false,
    katWahl: { movies: null, series: null },
    katSuche: { m: '', s: '' },
    authFehler: null,       // haelt den Einrichtungsbildschirm offen
    authIstNetz: false,     // Netzaussetzer statt abgelehnter Anmeldung
    setupFokusGesetzt: false,
    filmIndex: null,        // schlanker Titelindex, nur auf Wunsch
    indexLaedt: false,
    vodKategorien: [],      // [{ id, name }]
    serienKategorien: [],
    katalogCache: {},       // "m:123" -> [items]
    katalogReihe: [],       // Zugriffsreihenfolge für die Verdrängung
    katalogLaedt: null,
    favorites: {},       // id -> true
    watchlist: {},       // id -> true („Meine Liste")
    progress: {},        // id -> { position, duration, updatedAt, title, url, image, kind, group }
    profiles: [],        // [{ id, name, color }]
    activeProfile: 'default',
    gate: false,         // „Wer schaut?" wird gerade gezeigt
    settings: {
      languages: [], strict: 'ausgewogen', design: 'perl', accent: 'violet', sort: 'standard',
      pin: null, lockedGroups: [], hiddenGroups: [],
    },
    unlocked: false,     // Kindersicherung für diese Sitzung entsperrt
  };

  var el = {};
  var TABS = [
    { id: 'home', label: 'Start' },
    { id: 'live', label: 'Live TV' },
    { id: 'movies', label: 'Filme' },
    { id: 'series', label: 'Serien' },
    { id: 'favorites', label: 'Favoriten' },
  ];

  // ------------------------------------------------------- Persistenz ----

  var storageWarned = false;

  /**
   * Schreiben in den Gerätespeicher. Ein voller Speicher blieb früher stumm:
   * Der PIN wirkte gesetzt, war nach dem Neustart aber weg – ohne jeden Hinweis.
   */
  function save(key, value) {
    try {
      localStorage.setItem('glasstv.' + key, JSON.stringify(value));
      return true;
    } catch (e) {
      /*
       * Erst aufraeumen, dann aufgeben: Der Verlauf ist mit Abstand der
       * groesste Posten und der am leichtesten verzichtbare. Ohne diesen
       * Versuch war der Speicher endgueltig dicht, sobald er einmal voll war.
       */
      if (verlaufKuerzenBeiPlatznot()) {
        try {
          localStorage.setItem('glasstv.' + key, JSON.stringify(value));
          return true;
        } catch (e2) { /* weiter unten melden */ }
      }
      // Der Hinweis kommt nur einmal je Sitzung, das Scheitern meldet aber
      // JEDER Aufruf ueber den Rueckgabewert – sonst behauptete die
      // Oberflaeche Erfolg (etwa „PIN gesetzt"), obwohl nichts geschrieben war.
      if (!storageWarned && el.toast) {
        storageWarned = true;
        toast('Der Speicher des Fernsehers ist voll – Einstellungen und Verlauf ' +
          'lassen sich gerade nicht sichern.', 9000);
      }
      return false;
    }
  }

  /** Im Platznotfall den Verlauf auf ein Viertel eindampfen. */
  function verlaufKuerzenBeiPlatznot() {
    var ids = [];
    for (var k in state.progress) {
      if (Object.prototype.hasOwnProperty.call(state.progress, k)) ids.push(k);
    }
    if (ids.length <= 50) return false;
    ids.sort(function (a, b) {
      return (state.progress[a].updatedAt || 0) - (state.progress[b].updatedAt || 0);
    });
    for (var i = 0; i < ids.length - 50; i++) delete state.progress[ids[i]];
    try {
      localStorage.setItem('glasstv.' + scoped('progress'), JSON.stringify(state.progress));
      return true;
    } catch (e) { return false; }
  }

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem('glasstv.' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  /**
   * Schlüssel für profilbezogene Daten. Das Hauptprofil behält bewusst die
   * alten, unbenannten Schlüssel – so behalten bestehende Installationen ihre
   * Favoriten und ihren Verlauf, ohne dass etwas migriert werden muss.
   */
  function scoped(key) {
    return state.activeProfile === 'default' ? key : key + '.' + state.activeProfile;
  }

  function saveScoped(key, value) { return save(scoped(key), value); }
  function loadScoped(key, fallback) { return load(scoped(key), fallback); }

  /** Profildaten neu einlesen (nach Wechsel oder Anlegen). */
  function loadProfileData() {
    // `alsMap`: Ein beschaedigter Wert (String, Array) kam vorher durch. Ein
    // String liess jeden Favoritenklick werfen, ein Array verwarf beim
    // Speichern stumm alle Eintraege – der Verlauf wurde nie wieder gesichert.
    state.favorites = alsMap(loadScoped('favorites', null));
    state.progress = alsMap(loadScoped('progress', null));
    state.watchlist = alsMap(loadScoped('watchlist', null));
  }

  /** Nur ein echtes Objekt gilt; alles andere wird verworfen. */
  function alsMap(v) {
    if (!v || typeof v !== 'object') return {};
    if (Object.prototype.toString.call(v) === '[object Array]') return {};
    return v;
  }

  // ------------------------------------------------------------ Netz ----

  function httpGet(url, cb, timeoutMs) {
    var xhr = new XMLHttpRequest();
    var done = false;
    function finish(err, text) { if (!done) { done = true; cb(err, text); } }
    try {
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs || 25000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) finish(null, xhr.responseText);
        else finish(new Error('HTTP ' + xhr.status), null);
      };
      xhr.ontimeout = function () { finish(new Error('Zeitüberschreitung'), null); };
      xhr.onerror = function () { finish(new Error('Netzwerkfehler'), null); };
      xhr.send();
    } catch (e) { finish(e, null); }
    return xhr;   // damit Aufrufer eine laufende Anfrage abbrechen koennen
  }

  function httpGetJson(url, cb, timeoutMs) {
    return httpGet(url, function (err, text) {
      if (err) return cb(err, null);
      try { cb(null, JSON.parse(text)); } catch (e) { cb(new Error('Ungültige Antwort'), null); }
    }, timeoutMs);
  }

  /**
   * Zeitlimit für Katalog-Abrufe.
   *
   * Die Filmliste eines großen Panels ist zweistellige Megabyte groß – mit den
   * voreingestellten 25 s lief sie auf echten Anschlüssen in den Timeout, und
   * weil ein Fehler dort früher stumm blieb, landete man mit „0 Filme" in der
   * App, ohne zu erfahren warum.
   */
  var CATALOG_TIMEOUT = 180000;

  // ---------------------------------------------------------- Fokus ----

  var focusables = [];

  function collectFocusables() {
    focusables = Array.prototype.slice.call(document.querySelectorAll('.focusable'));
  }

  function focusFirst() {
    collectFocusables();
    var inContent = [], ersteEingabe = null, erstziel = null;
    for (var i = 0; i < focusables.length; i++) {
      if (!el.content.contains(focusables[i])) continue;
      /*
       * Eine Ansicht mit einem klaren Hauptziel markiert es mit `data-erstziel`
       * und bekommt den Fokus dorthin – auf der Detailseite „Abspielen", im
       * Suchbildschirm das Eingabefeld. Ohne das landete der Fokus auf dem
       * Zurueck-Knopf, und man musste sich zum eigentlichen Zweck der Seite
       * erst hinunternavigieren.
       */
      if (!erstziel && focusables[i].getAttribute('data-erstziel')) {
        erstziel = focusables[i];
      }
      /*
       * Textfelder werden sonst beim automatischen Erstfokus uebersprungen:
       * Bekommt ein Feld den Fokus, klappt webOS die Bildschirmtastatur auf und
       * verdeckt die halbe Seite – bei der Kategorienliste passierte das nach
       * jedem Zurueckkehren. Wer dort suchen will, waehlt das Feld selbst an.
       */
      if (focusables[i].tagName === 'INPUT' || focusables[i].tagName === 'TEXTAREA') {
        if (!ersteEingabe) ersteEingabe = focusables[i];
        continue;
      }
      inContent.push(focusables[i]);
    }
    var target = erstziel || (inContent.length ? inContent[0] : (ersteEingabe || focusables[0]));
    // Sanft: Beim Erstaufbau soll die Seite so stehen bleiben, wie sie gebaut
    // wurde – der Nutzer hat sie gerade erst geoeffnet.
    if (target) { target.focus(); revealFocus(target, true); }
  }

  /**
   * Fokus nur setzen, wenn gerade keiner auf einem bedienbaren Element liegt.
   *
   * Wichtig aus zwei Gründen: Ohne Fokus sieht man auf dem Fernseher nicht,
   * wo man ist, und muss blind eine Taste drücken. Umgekehrt darf ein
   * Neuaufbau (z. B. wenn das EPG nachlädt) den Fokus NICHT an den Anfang
   * zurückreißen, während man gerade durch die Liste wandert.
   */
  function ensureFocus() {
    collectFocusables();
    var a = document.activeElement;
    if (a && focusables.indexOf(a) >= 0) {
      var r = a.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return;
    }
    focusFirst();
  }

  /** Nächster scrollbarer Vorfahr in einer Achse (oder null). */
  function scrollParent(node, horizontal) {
    var n = node.parentNode;
    while (n && n !== document.body) {
      if (n.scrollWidth !== undefined) {
        if (horizontal && n.scrollWidth > n.clientWidth + 4) return n;
        if (!horizontal && n.scrollHeight > n.clientHeight + 4) return n;
      }
      n = n.parentNode;
    }
    return null;
  }

  /**
   * Element in den Blick holen.
   *
   * `scrollIntoView` mit Options-Objekt gibt es erst ab Chrome 61 – auf dem
   * Fernseher (53) wird das Objekt ignoriert und die Seite springt an den
   * Rand. Deshalb wird hier von Hand nur so weit gescrollt, wie nötig: die
   * Chip-Reihe waagerecht, die Seite senkrecht.
   */
  /**
   * Fokussiertes Element in den Blick holen.
   *
   * `sanft` scrollt nur, wenn das Element wirklich ausserhalb liegt – ohne
   * Komfortrand. Beim ERSTEN Aufbau einer Seite zog der grosszuegige Rand
   * sonst den Inhalt hoch, obwohl das Ziel bereits sichtbar war: Auf der
   * Detailseite verschwand dadurch der obere Bildrand samt Zurueck-Knopf
   * hinter der Kopfleiste.
   */
  function revealFocus(node, sanft) {
    var rand = sanft ? 0 : 90;
    var box = node.getBoundingClientRect();

    var row = scrollParent(node, true);
    if (row) {
      var rb = row.getBoundingClientRect();
      if (box.left < rb.left + 24) row.scrollLeft -= (rb.left + 24 - box.left);
      else if (box.right > rb.right - 24) row.scrollLeft += (box.right - rb.right + 24);
    }

    var col = scrollParent(node, false) || el.content;
    if (col) {
      var cb = col.getBoundingClientRect();
      box = node.getBoundingClientRect();
      // Großzügiger Rand: Auf dem Fernseher soll das fokussierte Element nie
      // an der Kante kleben, sonst sieht man den Kontext nicht mehr.
      if (box.top < cb.top + rand) col.scrollTop -= (cb.top + rand - box.top);
      else if (box.bottom > cb.bottom - rand) col.scrollTop += (box.bottom - cb.bottom + rand);
    }
  }

  /**
   * Fokus geometrisch weiterschalten.
   *
   * Zwei Eigenheiten, die auf dem Gerät auffielen:
   *  - Beim Sprung in eine waagerecht scrollbare Chip-Reihe landete der Fokus
   *    irgendwo in deren Mitte (das geometrisch nächste Element war zufällig
   *    ein weit rechts liegender Chip). Jetzt wird beim Wechsel der Reihe
   *    bevorzugt deren erster SICHTBARER Eintrag genommen.
   *  - Am Seitenende bewegte sich gar nichts mehr, ohne dass klar war warum.
   *    Jetzt wird in so einem Fall wenigstens weitergescrollt.
   */
  /**
   * Erster SICHTBARER Eintrag einer waagerecht scrollbaren Reihe.
   *
   * Der erste Eintrag ueberhaupt war falsch, sobald die Reihe gescrollt war:
   * Wer sich in einem Regal nach rechts gearbeitet hatte, nach oben ging und
   * wieder zurueckkam, landete bei Eintrag 1 – und `revealFocus` scrollte das
   * Regal gleich mit an den Anfang. Die Position ging bei jedem senkrechten
   * Ausflug verloren. Der erste sichtbare loest beide Faelle: Bei einer
   * ungescrollten Reihe ist er ohnehin der erste.
   */
  function ersterSichtbarerIn(reihe) {
    var kandidaten = reihe.querySelectorAll('.focusable');
    if (!kandidaten.length) return null;
    var box = reihe.getBoundingClientRect();
    for (var i = 0; i < kandidaten.length; i++) {
      var r = kandidaten[i].getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // Mindestens zur Haelfte im Sichtbereich – ein halb angeschnittener
      // Eintrag am linken Rand ist nicht der, den man meint.
      if (r.right > box.left + r.width * 0.5) return kandidaten[i];
    }
    return kandidaten[0];
  }

  function moveFocus(dx, dy) {
    collectFocusables();
    var active = document.activeElement;
    if (!active || focusables.indexOf(active) < 0) { focusFirst(); return; }
    var from = active.getBoundingClientRect();
    var best = null, bestScore = Infinity;
    var activeRow = scrollParent(active, true);

    for (var i = 0; i < focusables.length; i++) {
      var node = focusables[i];
      if (node === active) continue;
      var r = node.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      var ddx = (r.left + r.width / 2) - (from.left + from.width / 2);
      var ddy = (r.top + r.height / 2) - (from.top + from.height / 2);
      if (dx > 0 && ddx <= 8) continue;
      if (dx < 0 && ddx >= -8) continue;
      if (dy > 0 && ddy <= 8) continue;
      if (dy < 0 && ddy >= -8) continue;

      var along = Math.abs(dx ? ddx : ddy);
      var across = Math.abs(dx ? ddy : ddx);
      var score = along + across * 3;

      // Senkrechter Wechsel in eine andere waagerechte Reihe: Der seitliche
      // Versatz darf dann fast nichts kosten, sonst gewinnt ein zufällig
      // günstig stehender Chip weit außen.
      if (dy !== 0) {
        var row = scrollParent(node, true);
        if (row && row !== activeRow) score = along + across * 0.15;
      }
      if (score < bestScore) { bestScore = score; best = node; }
    }

    if (best) {
      /*
       * Beim senkrechten Wechsel in eine waagerecht scrollbare Reihe an deren
       * ANFANG einsteigen, nicht an der zufällig getroffenen Stelle: Die Reihe
       * ist breiter als der Schirm, und man sieht nicht, was links davon liegt –
       * es wirkte, als übersprünge die Navigation Einträge.
       */
      if (dy !== 0) {
        var zielReihe = scrollParent(best, true);
        if (zielReihe && zielReihe !== activeRow) {
          var erste = ersterSichtbarerIn(zielReihe);
          if (erste) best = erste;
        }
      }
      best.focus();
      revealFocus(best);
      return;
    }
    // Nichts gefunden: wenigstens die Seite bewegen, damit die Taste nicht
    // wirkungslos wirkt.
    var col = scrollParent(active, false) || el.content;
    if (col && dy !== 0) col.scrollTop += dy * 160;
  }


  // ------------------------------------------------------------ Bilder ----

  /*
   * Bilder sind der mit Abstand größte Speicherposten: Auf dem Gerät gemessen
   * belegten 120 sichtbare Poster rund 240 MB, weil ein dekodiertes Bild
   * Breite × Höhe × 4 Byte kostet – ein Poster in Originalgröße also zweistellige
   * Megabyte. Zwei Hebel:
   *   1. kleinere Fassung anfordern, wo der Anbieter das unterstützt,
   *   2. nur laden, was in der Nähe des Sichtfelds liegt, und den Rest wieder
   *      freigeben.
   */

  /** Bekannte Bilddienste auf eine bildschirmgerechte Größe bringen. */
  function bildAdresse(url, breit) {
    if (!url) return url;
    // TMDB liefert feste Größenstufen; „original" ist für eine 232-px-Kachel
    // etwa das Zwanzigfache dessen, was gebraucht wird.
    if (url.indexOf('image.tmdb.org/t/p/') >= 0) {
      return url.replace(/\/t\/p\/(original|w\d{3,4})\//, breit ? '/t/p/w780/' : '/t/p/w342/');
    }
    return url;
  }

  var lazyBilder = [];
  var lazyTimer = null;

  function lazyBildAnmelden(img) { lazyBilder.push(img); }

  /**
   * Bilder in der Nähe des Sichtfelds laden, weit entfernte entladen.
   *
   * `IntersectionObserver` gibt es auf dem Fernseher nicht (ab Chrome 51 nur
   * teilweise, hier nicht verfügbar), deshalb ein entprellter Durchlauf über
   * die angemeldeten Bilder – bei einigen hundert kostet das nichts.
   */
  function lazyPruefen() {
    var hoehe = window.innerHeight || 1080;
    var breite = window.innerWidth || 1920;
    var noch = [];
    for (var i = 0; i < lazyBilder.length; i++) {
      var img = lazyBilder[i];
      if (!img.parentNode) continue;            // Element ist weg
      noch.push(img);
      var r = img.getBoundingClientRect();
      var nah = r.bottom > -hoehe && r.top < hoehe * 2 &&
                r.right > -breite && r.left < breite * 2;
      var quelle = img.getAttribute('data-src');
      if (nah && quelle && img.getAttribute('src') !== quelle) {
        img.setAttribute('src', quelle);
      } else if (!nah && img.getAttribute('src')) {
        // Entladen gibt den dekodierten Speicher wieder frei.
        img.removeAttribute('src');
      }
    }
    lazyBilder = noch;
  }

  function lazyAnstossen() {
    if (lazyTimer) return;
    lazyTimer = setTimeout(function () { lazyTimer = null; lazyPruefen(); }, 120);
  }

  // ---------------------------------------------------------- Bausteine ----

  function toast(message, ms) {
    el.toast.textContent = message;
    el.toast.className = 'show';
    if (toast._t) clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.className = ''; }, ms || 3500);
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /**
   * Fokus über einen Neuaufbau hinweg halten.
   *
   * `render()` verwirft den gesamten Inhalt; ohne Merker landet der Fokus
   * danach wieder auf dem ersten Element. In den Einstellungen hieß das: Nach
   * jedem Klick auf ein Design sprang man an den Seitenanfang und musste sich
   * erneut hinunterhangeln – es wirkte, als ließe sich nichts umstellen.
   *
   * Der Schlüssel ist bewusst inhaltlich (Kennung des Elements), nicht der
   * Index: Nach dem Aufbau kann die Liste anders lang sein.
   */
  var pendingFocusKey = null;
  var focusWunsch = null;   // schlaegt beim naechsten Aufbau den gemerkten Fokus

  /** Fokus fuer den naechsten Aufbau vorgeben (z. B. beim Verlassen einer Ebene). */
  function focusWuenschen(key) { focusWunsch = key; }

  function rememberFocus() {
    if (focusWunsch) { pendingFocusKey = focusWunsch; focusWunsch = null; return; }
    var a = document.activeElement;
    pendingFocusKey = (a && a.getAttribute) ? a.getAttribute('data-fkey') : null;
  }

  function restoreFocus() {
    if (!pendingFocusKey) return false;
    var key = pendingFocusKey;
    pendingFocusKey = null;
    // Kein `querySelector`: Kategorienamen dürfen Anführungszeichen enthalten
    // („VOD "Neu""), was einen ungültigen Selektor ergäbe – die Ausnahme hätte
    // den Fokus danach ganz verschwinden lassen. CSS.escape gibt es hier nicht.
    var nodes = document.querySelectorAll('[data-fkey]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-fkey') === key) {
        nodes[i].focus();
        /*
         * Sanft: Beim Wiederherstellen hat der Nutzer nicht navigiert, die
         * Seite wurde nur neu gezeichnet. Mit vollem Komfortrand sprang sie
         * dabei – auf der Detailseite schob der nachgeladene Beschreibungstext
         * den Aufbau nach, und der Rand zog den Blick vom Bild weg.
         */
        revealFocus(nodes[i], true);
        return true;
      }
    }
    return false;
  }

  function element(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }
  function timeText(date) { return two(date.getHours()) + ':' + two(date.getMinutes()); }

  function durationText(seconds) {
    if (!seconds || seconds <= 0) return '';
    var h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
    return h > 0 ? h + ' Std. ' + m + ' Min.' : m + ' Min.';
  }

  function posterBox(url, wide) {
    var box = element('div', 'poster');
    if (url) {
      var img = document.createElement('img');
      // Erst `data-src`: Geladen wird, sobald die Kachel in die Nähe des
      // Sichtfelds kommt.
      img.setAttribute('data-src', bildAdresse(url, wide));
      img.onerror = function () { img.style.display = 'none'; };
      box.appendChild(img);
      lazyBildAnmelden(img);
    }
    return box;
  }

  /**
   * Sachmarken aus einem Titel lesen (4K, HD, Dolby, Jahr).
   *
   * Diese Angaben stehen bei IPTV-Playlisten ohnehin im Titel und
   * verbrauchen dort Platz, den der eigentliche Name braucht. Als Marke im
   * Poster gelesen sind sie aus drei Metern schneller erfassbar – und der
   * Titel wird kuerzer, statt in der zweiten Zeile abgeschnitten zu werden.
   * Hoechstens zwei je Eintrag, sonst wird das Bild zum Aufkleberalbum.
   */
  function markenAusTitel(titel) {
    var t = String(titel || '');
    var out = [];
    if (/(^|[^A-Za-z0-9])(4K|UHD|2160P?|\u2074\u1d37)([^A-Za-z0-9]|$)/i.test(t)) out.push('4K');
    else if (/(^|[^A-Za-z0-9])(FHD|1080P?|HD|\u1d34\u1d30)([^A-Za-z0-9]|$)/i.test(t)) out.push('HD');
    if (out.length < 2 && /dolby|atmos|\u1d30\u1d52\u02e1\u1d47\u02b8/i.test(t)) out.push('Dolby');
    return out;
  }

  function card(title, imageUrl, onSelect, wide, fkey, marken) {
    var c = element('div', 'card focusable' + (wide ? ' wide' : ''));
    c.tabIndex = 0;
    // Ohne Merker landete der Fokus nach jedem Blick in eine Detailseite
    // wieder am Rasteranfang – bei sieben Kacheln je Reihe jedes Mal neu
    // hinunterhangeln.
    if (fkey) c.setAttribute('data-fkey', 'card:' + fkey);
    var box = posterBox(imageUrl, wide);
    var liste = marken || markenAusTitel(title);
    if (liste && liste.length) {
      var leiste = element('div', 'markenleiste');
      for (var mi = 0; mi < liste.length && mi < 2; mi++) {
        var art = liste[mi] === 'LIVE' ? 'live' : 'sach';
        leiste.appendChild(element('span', 'marke ' + art, liste[mi]));
      }
      box.appendChild(leiste);
    }
    c.appendChild(box);
    c.appendChild(element('div', 'label', title));
    c.onclick = onSelect;
    return c;
  }

  function progressBar(fraction) {
    var bar = element('div', 'progress');
    var fill = element('div');
    fill.style.width = Math.max(2, Math.min(100, fraction * 100)) + '%';
    bar.appendChild(fill);
    return bar;
  }

  function button(label, onClick, ghost, fkey) {
    var b = element('button', 'focusable' + (ghost ? ' ghost' : ''), label);
    /*
     * Der Merker ist normalerweise die Beschriftung – je Seite eindeutig.
     * Knoepfe, die beim Klick ihre Beschriftung WECHSELN („☆ Favorit" →
     * „★ Favorit", „Kategorien wählen" → „Liste zuklappen"), brauchen einen
     * festen Schluessel: Sonst findet `restoreFocus` sie nicht wieder und der
     * Fokus springt an den Seitenanfang.
     */
    b.setAttribute('data-fkey', 'btn:' + (fkey || label));
    b.onclick = onClick;
    return b;
  }

  function shelf(title, items, builder) {
    if (!items.length) return null;
    var wrap = document.createElement('div');
    // Die Deckelung benennen: Sonst hielt der Nutzer die uebrigen Eintraege
    // schlicht fuer nicht vorhanden.
    wrap.appendChild(element('div', 'section-title',
      items.length > 30 ? title + ' · 30 von ' + items.length : title));
    var row = element('div', 'row');
    for (var i = 0; i < items.length && i < 30; i++) row.appendChild(builder(items[i]));
    wrap.appendChild(row);
    return wrap;
  }

  // -------------------------------------------------- Abgeleitete Daten ----

  function progressList() {
    var out = [];
    for (var id in state.progress) {
      if (!Object.prototype.hasOwnProperty.call(state.progress, id)) continue;
      var eintrag = state.progress[id];
      if (!verlaufErlaubt(eintrag)) continue;
      out.push(eintrag);
    }
    out.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    return out;
  }

  /**
   * Verlaufseintraege, die eine gesperrte oder ausgeblendete Kategorie
   * betreffen, verschwinden aus Startseite, Empfehlungen und Affinitaet.
   * Ohne das standen Titel und Poster einer gesperrten Kategorie weiter unter
   * „Weiterschauen" – die Sperre griff ueberall sonst, nur hier nicht.
   */
  function verlaufErlaubt(p) {
    return !p.group || kategorieErlaubt(p.group);
  }

  function resumable() {
    return progressList().filter(function (p) {
      return p.kind !== 'live' && p.duration > 0 &&
        p.position > 30 && (p.position / p.duration) < 0.95;
    });
  }

  /**
   * Kategorien einer Liste – gepuffert.
   *
   * Ein voller Durchlauf über 142.000 Filme, nur um 40 Chips zu zeichnen, lief
   * vorher bei JEDEM Aufbau erneut (und jeder Chip-Klick baut neu auf).
   */
  var groupCache = {};

  function groupsOf(items, cacheKey) {
    if (cacheKey && groupCache[cacheKey] && groupCache[cacheKey].len === items.length) {
      return groupCache[cacheKey].list;
    }
    var seen = Object.create(null), out = [];
    for (var i = 0; i < items.length; i++) {
      var g = items[i].group;
      if (g && !seen[g]) { seen[g] = true; out.push(g); }
    }
    if (cacheKey) groupCache[cacheKey] = { len: items.length, list: out };
    return out;
  }

  /**
   * Abspieladresse eines Eintrags.
   *
   * M3U-Einträge tragen sie selbst (sie ist dort die einzige Quelle).
   * Xtream-Einträge speichern nur die Stream-Nummer – die Adresse wird hier
   * gebaut. Das spart bei sechsstelligen Bibliotheken erheblich Speicher und
   * hält die Zugangsdaten aus Kennungen, Favoriten und Verlauf heraus.
   */
  /**
   * Abspieladresse allein aus der Kennung bauen.
   *
   * Die Kennungen tragen Art und Stream-Nummer bereits in sich
   * ("xtream|m|123", "xtream|l|123", "xtream|series|5|e|123"). Damit bleiben
   * Favoriten und „Weiterschauen" bedienbar, auch wenn die zugehoerige
   * Kategorie gerade nicht geladen ist – vorher meldete die App in genau dem
   * Fall „Dieser Titel ist in der aktuellen Quelle nicht mehr enthalten",
   * obwohl er sehr wohl vorhanden war.
   */
  /** Kurzkennung der aktuellen Quelle – unterscheidet zwei Xtream-Panels. */
  function quellenAbdruck() {
    var src = state.source;
    if (!src) return null;
    if (src.kind === 'm3u') return 'm3u:' + (src.m3u || '');
    return 'xtream:' + (src.host || '') + ':' + (src.user || '');
  }

  function streamUrlAusId(id, ext, quelle) {
    var src = state.source;
    if (!src || src.kind !== 'xtream' || !id) return '';
    // Stammt der Eintrag nachweislich von einem anderen Panel, lieber nichts
    // liefern als den falschen Film.
    if (quelle && quelle !== quellenAbdruck()) return '';
    var teile = String(id).split('|');
    if (teile.length < 3) return '';
    var sid = teile[teile.length - 1];
    var marke = teile[teile.length - 2];
    if (!/^\d+$/.test(sid)) return '';
    var art = marke === 'l' ? 'live' : (marke === 'e' ? 'series' : (marke === 'm' ? 'movie' : null));
    if (!art) return '';
    return Core.xtreamStreamUrl(art, src.host, src.user, src.pass, sid, ext || null);
  }

  /*
   * Nachschlagewerk nach Kennung. `merkListe` fragt je gemerktem Eintrag, und
   * ein Vollscan ueber Bibliothek UND alle Folgen kostete gemessen das 17- bis
   * 49-Fache (bei 200 Favoriten und einer M3U-Playlist rund 120 ms je Aufbau,
   * auf dem Fernseher entsprechend mehr) – und das bei JEDEM Neuzeichnen.
   * Der Index wird einmal je Bibliotheksstand gebaut; `idIndexStempel`
   * verwirft ihn, sobald sich Bibliothek oder Zwischenspeicher aendern.
   */
  var idIndex = null;
  var idIndexStempel = -1;
  var bibliotheksStempel = 0;

  /** Aufrufen, wenn sich Bibliothek oder Katalog-Zwischenspeicher aendern. */
  function bibliothekGeaendert() { bibliotheksStempel++; }

  function idIndexHolen() {
    if (idIndex && idIndexStempel === bibliotheksStempel) return idIndex;
    var idx = Object.create(null);
    function add(list) {
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (it && it.id !== undefined && idx[it.id] === undefined) idx[it.id] = it;
        var eps = it && it.episodes;
        if (eps) {
          for (var e = 0; e < eps.length; e++) {
            if (eps[e] && eps[e].id !== undefined && idx[eps[e].id] === undefined) {
              idx[eps[e].id] = eps[e];
            }
          }
        }
      }
    }
    add(state.library.channels); add(state.library.movies); add(state.library.series);
    for (var k in state.katalogCache) {
      if (Object.prototype.hasOwnProperty.call(state.katalogCache, k)) add(state.katalogCache[k]);
    }
    idIndex = idx;
    idIndexStempel = bibliotheksStempel;
    return idx;
  }

  /** Eintrag anhand seiner Kennung finden. */
  function findById(id) {
    if (id === undefined || id === null) return null;
    var treffer = idIndexHolen()[id];
    return treffer === undefined ? null : treffer;
  }

  /** Langsamer Vollscan – nur noch als Rueckfallebene, siehe findById. */
  function findByIdScan(id) {
    var lists = [state.library.channels, state.library.movies, state.library.series];
    // Bei bedarfsweisem Laden liegen Filme und Serien nicht in der Bibliothek,
    // sondern in den zuletzt geöffneten Kategorien.
    for (var k in state.katalogCache) {
      if (Object.prototype.hasOwnProperty.call(state.katalogCache, k)) {
        lists.push(state.katalogCache[k]);
      }
    }
    for (var l = 0; l < lists.length; l++) {
      for (var i = 0; i < lists[l].length; i++) if (lists[l][i].id === id) return lists[l][i];
    }
    /*
     * Folgen stehen in keiner dieser Listen, sondern nur in `serie.episodes` –
     * „Weiterschauen" fand deshalb NIE eine angefangene Folge wieder.
     */
    for (var m = 0; m < lists.length; m++) {
      for (var j = 0; j < lists[m].length; j++) {
        var eps = lists[m][j].episodes;
        if (!eps || !eps.length) continue;
        for (var e = 0; e < eps.length; e++) if (eps[e].id === id) return eps[e];
      }
    }
    return null;
  }

  function streamUrlOf(item) {
    if (!item) return '';
    if (item.streamURL) return item.streamURL;
    var src = state.source;
    // Aus dem Merker rekonstruierte Eintraege haben keine Stream-Nummer, wohl
    // aber eine Kennung, die sie enthaelt.
    if (item.sid === undefined && item.id) {
      return streamUrlAusId(item.id, item.ext, item.quelle);
    }
    if (!src || src.kind !== 'xtream' || item.sid === undefined) return '';
    return Core.xtreamStreamUrl(item.art || 'movie', src.host, src.user, src.pass, item.sid, item.ext);
  }

  function programsFor(ch) {
    return ch.epgID ? state.epg[ch.epgID.toLowerCase()] : null;
  }

  function isFavorite(id) { return !!state.favorites[id]; }

  /** Einträge einer Liste, deren Kennung in `map` steht – ein Durchlauf. */
  function pickByIds(list, map) {
    var out = [];
    var any = false;
    for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k)) { any = true; break; } }
    if (!any) return out;
    for (var i = 0; i < list.length; i++) if (map[list[i].id]) out.push(list[i]);
    return out;
  }

  /** Sender tragen „|l|" in der Kennung – siehe Core.parseLiveStreams. */
  function istSender(id) { return String(id).indexOf('|l|') >= 0; }

  function onWatchlist(id) { return !!state.watchlist[id]; }

  function toggleWatchlist(id, item) {
    if (state.watchlist[id]) delete state.watchlist[id];
    else { state.watchlist[id] = merkDaten(id, item); merkerDeckeln(state.watchlist); }
    saveScoped('watchlist', state.watchlist);
  }

  /**
   * Favorit umschalten. Der Eintrag speichert seine Anzeigedaten mit.
   *
   * Vorher stand dort nur `true`, und der Favoriten-Tab loeste die Kennung
   * ueber die Bibliothek auf. Seit Filme und Serien kategorieweise kommen, ist
   * die aber leer: Wer einen Film merkte, sah danach „Noch nichts gemerkt".
   */
  function toggleFavorite(id, item) {
    if (state.favorites[id]) delete state.favorites[id];
    else { state.favorites[id] = merkDaten(id, item); merkerDeckeln(state.favorites); }
    saveScoped('favorites', state.favorites);
  }

  /**
   * Merker deckeln. Favoriten und Merkliste waren die einzigen Strukturen ohne
   * Grenze; bei langen Titeln und Poster-Adressen kostet ein Eintrag rund 250
   * Zeichen, und der Geraetespeicher fasst typisch nur wenige Megabyte.
   */
  var MERKER_MAX = 500;

  function merkerDeckeln(map) {
    var ids = [];
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) ids.push(k);
    }
    if (ids.length <= MERKER_MAX) return;
    ids.sort(function (a, b) {
      return (map[a] && map[a].gemerktAm || 0) - (map[b] && map[b].gemerktAm || 0);
    });
    for (var i = 0; i < ids.length - MERKER_MAX; i++) delete map[ids[i]];
  }

  /** Das Nötigste, um einen gemerkten Eintrag ohne Bibliothek zu zeigen. */
  function merkDaten(id, item) {
    if (!item) return { id: id };
    return {
      id: id,
      title: item.title || item.name || '',
      image: item.posterURL || item.logoURL || null,
      group: item.group || null,
      art: item.art || null,
      ext: item.ext || null,
      // Ohne diese Nummern war eine gemerkte Serie eine Sackgasse („Keine
      // Folgen"), und ein gemerkter Film blieb dauerhaft ohne Beschreibung.
      sid: item.sid !== undefined ? item.sid : null,
      serienID: item.xtreamSeriesID || null,
      streamID: item.xtreamStreamID || null,
      istSerie: item.episodes !== undefined ? 1 : 0,
      gemerktAm: Date.now(),  // fuer die Verdraengung, siehe merkerDeckeln
      quelle: quellenAbdruck()
    };
  }

  /**
   * Gemerkte Eintraege zu anzeigbaren Objekten machen: bevorzugt frisch aus
   * der Bibliothek (dort sind die Daten aktuell), sonst aus dem Gespeicherten.
   */
  function merkListe(map, speichern) {
    var out = [], aufgewertet = false;
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var d = map[k];
      var frisch = findById(k);
      if (frisch) {
        /*
         * Aufwerten: Installationen vor 1.15 haben hier `true` stehen. Ohne
         * das Zurueckschreiben blieben solche Eintraege unsichtbar, sobald die
         * Kategorie nicht geladen ist – und unsichtbar heisst auch: nicht
         * abwaehlbar.
         */
        if (!d || d === true || !d.title) { map[k] = merkDaten(k, frisch); aufgewertet = true; }
        out.push(frisch);
        continue;
      }
      if (!d || d === true || !d.title) continue;
      if (d.group && !kategorieErlaubt(d.group)) continue;
      out.push({
        id: d.id || k, title: d.title, posterURL: d.image || '',
        group: d.group || '', art: d.art || null, ext: d.ext || null,
        sid: d.sid !== undefined ? d.sid : null,
        quelle: d.quelle || null,
        xtreamSeriesID: d.serienID || null,
        xtreamStreamID: d.streamID || null,
        episodes: d.istSerie ? [] : undefined, _ausMerker: true
      });
    }
    if (aufgewertet && speichern) saveScoped(speichern, map);
    return out;
  }

  /** Sender erkennen: am Eintrag selbst, nicht an der Form der Kennung. */
  function istSenderEintrag(e) {
    if (!e) return false;
    if (e.art === 'live') return true;
    if (e.streamURL !== undefined && e.name !== undefined) return true;   // M3U
    return istSender(e.id);
  }


  // --------------------------------------------------------- Designs ----

  /**
   * Designs aus der iOS-App – hell UND dunkel, wie dort. Jedes Design bringt
   * seine eigenen Flächen- und Textfarben mit: Ohne die bliebe bei einem hellen
   * Grund die dunkle Kartenfläche stehen und die Schrift wäre unlesbar.
   *
   * `dark: false` schaltet das ganze Farbschema um (Flächen, Ränder, Text).
   */
  var DESIGNS = [
    // ---- hell (Standard wie in der iOS-App: „Perl") ----
    { id: 'perl', name: 'Perl', dark: false, bg: '#f0f0f5', g1: 'rgba(219,222,235,0.85)', g2: 'rgba(230,225,220,0.7)' },
    { id: 'daylight', name: 'Hell', dark: false, bg: '#f2f2f7', g1: 'rgba(255,255,255,0.9)', g2: 'rgba(226,230,240,0.8)' },
    { id: 'sand', name: 'Sand', dark: false, bg: '#f5f0e6', g1: 'rgba(242,204,140,0.55)', g2: 'rgba(235,222,200,0.7)' },
    { id: 'jade', name: 'Jade', dark: false, bg: '#e8f4ee', g1: 'rgba(89,204,158,0.45)', g2: 'rgba(140,217,204,0.45)' },
    { id: 'arktis', name: 'Arktis', dark: false, bg: '#e8f1fb', g1: 'rgba(140,191,255,0.45)', g2: 'rgba(184,224,255,0.5)' },
    { id: 'sakura', name: 'Sakura', dark: false, bg: '#fbeef2', g1: 'rgba(255,179,209,0.5)', g2: 'rgba(242,199,230,0.5)' },
    // ---- dunkel ----
    { id: 'midnight', name: 'Mitternacht', dark: true, bg: '#0b0a17', g1: 'rgba(140,128,247,0.22)', g2: 'rgba(38,77,230,0.16)' },
    { id: 'oled', name: 'Pur Schwarz', dark: true, bg: '#000000', g1: 'rgba(140,128,247,0.10)', g2: 'rgba(0,0,0,0)' },
    { id: 'graphite', name: 'Graphit', dark: true, bg: '#131316', g1: 'rgba(255,255,255,0.05)', g2: 'rgba(140,128,247,0.12)' },
    { id: 'aurora', name: 'Aurora', dark: true, bg: '#050a17', g1: 'rgba(0,184,166,0.22)', g2: 'rgba(217,64,153,0.18)' },
    { id: 'nebula', name: 'Galaxie', dark: true, bg: '#0d0519', g1: 'rgba(140,51,217,0.30)', g2: 'rgba(230,64,153,0.22)' },
    { id: 'ocean', name: 'Ozean', dark: true, bg: '#040d1a', g1: 'rgba(0,115,217,0.24)', g2: 'rgba(0,191,184,0.18)' },
    { id: 'forest', name: 'Wald', dark: true, bg: '#06100a', g1: 'rgba(31,153,89,0.20)', g2: 'rgba(128,179,51,0.12)' },
    { id: 'sunset', name: 'Sonnenuntergang', dark: true, bg: '#170910', g1: 'rgba(255,107,51,0.26)', g2: 'rgba(217,51,102,0.20)' },
    { id: 'crimson', name: 'Purpur', dark: true, bg: '#170508', g1: 'rgba(217,31,51,0.28)', g2: 'rgba(128,13,38,0.24)' },
    { id: 'mocha', name: 'Mokka', dark: true, bg: '#140f0d', g1: 'rgba(140,97,61,0.24)', g2: 'rgba(102,66,46,0.20)' },
    { id: 'champagner', name: 'Champagner', dark: true, bg: '#161310', g1: 'rgba(219,184,107,0.24)', g2: 'rgba(184,140,77,0.18)' },
    { id: 'kupfer', name: 'Kupfer', dark: true, bg: '#170e0a', g1: 'rgba(209,115,61,0.26)', g2: 'rgba(153,77,41,0.20)' },
  ];

  var ACCENTS = [
    { id: 'violet', name: 'Violett', color: '#8c80f7' },
    { id: 'indigo', name: 'Indigo', color: '#6b5ce6' },
    { id: 'blue', name: 'Blau', color: '#4d8fff' },
    { id: 'cyan', name: 'Türkis', color: '#29c7db' },
    { id: 'teal', name: 'Petrol', color: '#21a8a1' },
    { id: 'mint', name: 'Mint', color: '#5cdba8' },
    { id: 'green', name: 'Grün', color: '#3dcc75' },
    { id: 'yellow', name: 'Gold', color: '#f2bd38' },
    { id: 'orange', name: 'Orange', color: '#ff8f40' },
    { id: 'coral', name: 'Koralle', color: '#ff7061' },
    { id: 'red', name: 'Rot', color: '#ff5454' },
    { id: 'rose', name: 'Rosé', color: '#f55c85' },
    { id: 'pink', name: 'Pink', color: '#ff5c9e' },
    { id: 'magenta', name: 'Magenta', color: '#dc4dd1' },
    { id: 'slate', name: 'Schiefer', color: '#8c99b3' },
  ];

  /**
   * Stufen des Sprachfilters. Vorher gab es nur an/aus, und die beiden Enden
   * lagen weit auseinander: „aus" liess alles Unerkannte durch, „an" warf ganze
   * Kategorien weg, die kein Sprachkuerzel tragen.
   */
  var SPRACH_STUFEN = [
    { id: 'grosszuegig', name: 'Großzügig',
      hilfe: 'Zeigt die gewählten Sprachen und alles, was keine Sprache angibt.' },
    { id: 'ausgewogen', name: 'Ausgewogen',
      hilfe: 'Filtert Kategorien mit Sprachkürzel. Kategorien ohne Angabe ' +
             'bleiben vollständig – dort steckt bei den meisten Anbietern das Meiste.' },
    { id: 'streng', name: 'Streng',
      hilfe: 'Nur Titel, deren Sprache nachweislich passt. Alles ohne Angabe ' +
             'fällt weg – das kann sehr viel sein.' }
  ];
  var SPRACH_STUFEN_IDS = ['grosszuegig', 'ausgewogen', 'streng'];

  function designById(id) {
    for (var i = 0; i < DESIGNS.length; i++) if (DESIGNS[i].id === id) return DESIGNS[i];
    return DESIGNS[0];   // Perl – der iOS-Standard
  }

  function aktuellesDesignIstDunkel() {
    return !!designById(state.settings.design).dark;
  }

  function accentById(id) {
    for (var i = 0; i < ACCENTS.length; i++) if (ACCENTS[i].id === id) return ACCENTS[i];
    return ACCENTS[0];
  }

  /**
   * Design + Akzent anwenden (CSS-Variablen, ab Chromium 49 verfügbar).
   *
   * Es reicht NICHT, nur Grundfarbe und Akzent zu tauschen: Bei einem hellen
   * Design müssen Flächen, Ränder und Textfarben mitwandern, sonst steht eine
   * dunkle Karte mit hellem Text auf hellem Grund.
   */
  function applyTheme() {
    var d = designById(state.settings.design);
    var a = accentById(state.settings.accent);
    var root = document.documentElement;
    if (!root.style.setProperty) return;

    var accent = d.dark ? a.color : akzentFuerHell(a.color, d.bg);

    root.style.setProperty('--bg', d.bg);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-dim', hexToRgba(accent, d.dark ? 0.22 : 0.16));
    // Akzent = Zustandsfarbe, Trennring = Seitengrund.
    root.style.setProperty('--marke', accent);
    root.style.setProperty('--fokus-trenn', d.bg);
    if (d.dark) {
      root.style.setProperty('--surface', 'rgba(255,255,255,0.06)');
      root.style.setProperty('--surface-strong', 'rgba(255,255,255,0.12)');
      // 0,22 statt 0,12: Aus drei Metern waren die Kartenkanten bei 1,3:1
      // praktisch unsichtbar. Immer noch dezent, aber vorhanden.
      root.style.setProperty('--border', 'rgba(255,255,255,0.22)');
      root.style.setProperty('--text', '#eae7f2');
      root.style.setProperty('--text-dim', '#a9a4bd');
      root.style.setProperty('--on-accent', '#12101f');
      // Fehlerrot muss auf dunklem Grund aufhellen: Das feste #b3261e lag auf
      // den dunklen Designs bei 2,3:1 – dunkelrote Schrift auf dunklem Grund.
      root.style.setProperty('--fehler', '#ff8a80');
      root.style.setProperty('--fokus-ring', '#eae7f2');
      /*
       * Glaswerte je Helligkeit. Auf dunklem Grund ist die Flaeche HELLER als
       * der Grund – eine weisse Kante bei 0.95 waere ein grelles Strichgitter
       * ueber den halben Schirm; 0.42 reicht. Der Schatten muss dagegen
       * kraeftiger werden, weil auf OLED-Schwarz nur ein starker Abfall
       * ueberhaupt als Kante gelesen wird.
       */
      root.style.setProperty('--glas-licht', 'rgba(255,255,255,0.42)');
      root.style.setProperty('--glas-schatten', 'rgba(0,0,0,0.45)');
      root.style.setProperty('--glas-sheen-a', 'rgba(255,255,255,0.10)');
      root.style.setProperty('--glas-sheen-b', 'rgba(255,255,255,0.03)');
      root.style.setProperty('--glas-tief', 'rgba(0,0,0,0.60)');
      root.style.setProperty('--fokus-schatten', 'rgba(0,0,0,0.55)');
    } else {
      // Auf hellem Grund tragen weiße Schleier nicht – es braucht dunkle.
      root.style.setProperty('--surface', 'rgba(0,0,0,0.045)');
      root.style.setProperty('--surface-strong', 'rgba(0,0,0,0.10)');
      root.style.setProperty('--border', 'rgba(0,0,0,0.22)');
      root.style.setProperty('--text', '#1b1926');
      root.style.setProperty('--text-dim', '#5a5670');
      root.style.setProperty('--on-accent', '#ffffff');
      root.style.setProperty('--fehler', '#b3261e');
      root.style.setProperty('--fokus-ring', '#1b1926');
      // Auf hellem Grund ist die Flaeche DUNKLER als der Grund: Eine fast
      // weisse Lichtkante hebt sich klar ab, ein echter Schatten traegt.
      root.style.setProperty('--glas-licht', 'rgba(255,255,255,0.95)');
      root.style.setProperty('--glas-schatten', 'rgba(0,0,0,0.14)');
      root.style.setProperty('--glas-sheen-a', 'rgba(255,255,255,0.60)');
      root.style.setProperty('--glas-sheen-b', 'rgba(255,255,255,0.00)');
      root.style.setProperty('--glas-tief', 'rgba(0,0,0,0.16)');
      // Auf hellem Grund traegt ein kraeftiger Schlagschatten nicht – er wirkt
      // wie Schmutz unter der Karte statt wie Hervorhebung.
      root.style.setProperty('--fokus-schatten', 'rgba(0,0,0,0.18)');
    }

    /*
     * Versetzte Kopie des Backdrops fuer die Kopfleiste. Dieselben Farben,
     * aber 72/-4/104 statt 60/0/100: dieser Versatz ist der Brechungseffekt.
     */
    root.style.setProperty('--glasgrund-versetzt',
      'radial-gradient(72% 72% at -4% -3%, ' + d.g1 + ', transparent 70%),' +
      'radial-gradient(72% 72% at 104% 103%, ' + d.g2 + ', transparent 70%)');

    document.getElementById('backdrop').style.background =
      'radial-gradient(60% 60% at 0% 0%, ' + d.g1 + ', transparent 70%),' +
      'radial-gradient(60% 60% at 100% 100%, ' + d.g2 + ', transparent 70%),' + d.bg;
    // `html` malt die Canvas – ohne das bliebe der Rand in der alten Farbe.
    document.documentElement.style.background = d.bg;
    document.body.style.background = d.bg;
    document.body.style.color = d.dark ? '#eae7f2' : '#1b1926';

    // Der Backdrop-Verlauf auf Detailseiten muss in den aktuellen Grundton
    // laufen, sonst steht dort ein Balken in der Farbe eines anderen Designs.
    var rgb = hexToRgba(d.bg, 1).replace('rgba(', '').replace(')', '').split(',');
    var base = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    var scrims = document.querySelectorAll('.detail-backdrop .scrim');
    for (var i = 0; i < scrims.length; i++) {
      scrims[i].style.background =
        'linear-gradient(to bottom, rgba(' + base + ',0) 20%, rgba(' + base + ',0.35) 45%,' +
      'rgba(' + base + ',0.88) 68%, rgba(' + base + ',0.99) 84%, rgba(' + base + ',1) 100%)';
    }
  }

  /** Farbe abdunkeln – helle Akzente sind auf hellem Grund sonst unlesbar. */
  /**
   * Akzent fuer helle Designs abdunkeln.
   *
   * Die alte Fassung skalierte alle Kanaele und entzog dabei die halbe
   * Buntheit: Violett fiel von 88 % auf 32 % Saettigung, Koralle von 100 auf
   * 41 – auf hellen Designs sahen Violett, Indigo und Schiefer nahezu gleich
   * aus. Hier bleiben Ton UND Saettigung erhalten; gesenkt wird nur die
   * Helligkeit, und zwar so weit, bis der Kontrast gegen den TATSAECHLICHEN
   * Grund des Designs 4,5:1 erreicht. (Gegen reines Weiss zu rechnen genuegt
   * nicht: Gegen „#f7f7fa" landeten sonst alle Akzente bei 4,2–4,4.)
   */
  function akzentFuerHell(hex, grundHex) {
    var hsl = hexToHsl(hex);
    if (!hsl) return hex;
    for (var l = hsl[2]; l >= 5; l -= 1) {
      var kandidat = hslToHex(hsl[0], hsl[1], l);
      if (kontrastwert(kandidat, grundHex) >= 4.5) return kandidat;
    }
    return hslToHex(hsl[0], hsl[1], 5);
  }

  function hexToHsl(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return null;
    var r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, sat = 0, l = (max + min) / 2, d = max - min;
    if (d) {
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, sat * 100, l * 100];
  }

  function hslToHex(h, sat, l) {
    sat /= 100; l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * sat;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2, r, g, b;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    function t(v) {
      var q = Math.max(0, Math.min(255, Math.round((v + m) * 255))).toString(16);
      return q.length < 2 ? '0' + q : q;
    }
    return '#' + t(r) + t(g) + t(b);
  }

  /** WCAG-Kontrast zweier Hex-Farben. */
  function kontrastwert(a, b) {
    function lum(hex) {
      var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
      if (!m) return 0;
      var teile = [], i, v;
      for (i = 1; i <= 3; i++) {
        v = parseInt(m[i], 16) / 255;
        teile.push(v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      }
      return 0.2126 * teile[0] + 0.7152 * teile[1] + 0.0722 * teile[2];
    }
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function darken(hex, factor) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    function part(h) {
      var v = Math.round(parseInt(h, 16) * factor);
      var s = Math.max(0, Math.min(255, v)).toString(16);
      return s.length < 2 ? '0' + s : s;
    }
    return '#' + part(m[1]) + part(m[2]) + part(m[3]);
  }

  function hexToRgba(hex, alpha) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' +
      parseInt(m[3], 16) + ',' + alpha + ')';
  }

  function shuffleTheme() {
    var d, a;
    do { d = DESIGNS[Math.floor(Math.random() * DESIGNS.length)]; }
    while (d.id === state.settings.design && DESIGNS.length > 1);
    do { a = ACCENTS[Math.floor(Math.random() * ACCENTS.length)]; }
    while (a.id === state.settings.accent && ACCENTS.length > 1);
    state.settings.design = d.id;
    state.settings.accent = a.id;
    save('settings', state.settings);
    applyTheme();
    toast(d.name + ' · ' + a.name, 2500);
  }

  // ---------------------------------------------------- Sortierung ----

  var sortCache = {};

  /**
   * Sortieren – gepuffert und ohne `localeCompare`.
   *
   * `localeCompare` ist auf dem Fernseher um Größenordnungen teurer als ein
   * einfacher Vergleich; bei 142.000 Titeln sind das Millionen Aufrufe, nur um
   * danach 150 Kacheln zu zeigen. Der Sortierschlüssel wird deshalb einmal je
   * Titel gebildet und am Objekt gemerkt.
   */
  function sortItems(list, titleKey, cacheKey) {
    var sort = state.settings.sort;
    if (!sort || sort === 'standard') return list;
    var key = (cacheKey || '') + '|' + sort + '|' + list.length;
    if (sortCache[key]) return sortCache[key];

    var copy = list.slice();
    if (sort === 'name') {
      for (var i = 0; i < copy.length; i++) {
        if (copy[i]._sortName === undefined) copy[i]._sortName = (copy[i][titleKey] || '').toLowerCase();
      }
      copy.sort(function (a, b) {
        return a._sortName < b._sortName ? -1 : (a._sortName > b._sortName ? 1 : 0);
      });
    } else if (sort === 'year') {
      // Titel ohne Jahr/Bewertung ans Ende statt nach vorn spülen.
      copy.sort(function (a, b) { return (parseInt(b.year, 10) || -1) - (parseInt(a.year, 10) || -1); });
    } else if (sort === 'rating') {
      copy.sort(function (a, b) { return (Number(b.rating) || -1) - (Number(a.rating) || -1); });
    }
    sortCache[key] = copy;
    return copy;
  }


  // ------------------------------------------------------ Empfehlungen ----

  /**
   * Gewichtet Kategorien nach dem Verlauf (iOS: groupAffinity).
   * Jüngeres zählt mehr – Recency-Decay 1/(1+Tage/7). Ohne den Abfall
   * bestimmt für immer, was man einmal vor einem halben Jahr gesehen hat.
   */
  function groupAffinity() {
    var scores = Object.create(null);
    var now = Date.now();
    var list = progressList();
    for (var i = 0; i < list.length; i++) {
      var g = list[i].group;
      if (!g) continue;
      var days = (now - list[i].updatedAt) / 86400000;
      scores[g] = (scores[g] || 0) + 1 / (1 + days / 7);
    }
    var pairs = [];
    for (var key in scores) {
      if (Object.prototype.hasOwnProperty.call(scores, key)) pairs.push([key, scores[key]]);
    }
    pairs.sort(function (a, b) { return b[1] - a[1]; });
    return pairs.slice(0, 6).map(function (p) { return p[0]; });
  }

  /** Titel aus den Lieblingskategorien, die noch nicht angesehen wurden. */
  function recommendations(items, idKey, limit) {
    var groups = groupAffinity();
    if (!groups.length) return [];
    var out = [];
    for (var i = 0; i < items.length && out.length < (limit || 20); i++) {
      var it = items[i];
      if (groups.indexOf(it.group) < 0) continue;
      if (state.progress[it.id]) continue;      // schon gesehen
      out.push(it);
    }
    return out;
  }

  /** „Weil du X geschaut hast" – jüngster Titel mit Kategorie, ab 3 Treffern. */
  function becauseYouWatched() {
    var list = progressList();
    var seed = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind !== 'live' && list[i].group) { seed = list[i]; break; }
    }
    if (!seed) return null;
    var quelle = state.lazyKatalog ? geladeneFilme() : state.library.movies;
    var pool = [];
    for (var j = 0; j < quelle.length && pool.length < 20; j++) {
      var m = quelle[j];
      if (m.group === seed.group && m.id !== seed.id) pool.push(m);
    }
    if (pool.length < 3) return null;
    return { title: seed.title, items: pool };
  }

  // ---------------------------------------------------------- Profile ----

  var PROFILE_COLORS = ['#8c80f7', '#3359d9', '#e0567b', '#2c9c88', '#e9a23b', '#7e57c2'];

  /**
   * Profile laden und dabei aufräumen.
   *
   * Ein Eintrag ohne Namen ließ `renderGate()` mitten in der Schleife
   * abbrechen – der Profilschirm blockiert aber alles andere, und die
   * Zurück-Taste half nicht. Die App war damit ohne Neuinstallation nicht
   * mehr bedienbar. Deshalb wird hier jeder Eintrag geprüft statt vertraut.
   */
  function loadProfiles() {
    var raw = load('profiles', null);
    var list = [];
    if (Object.prototype.toString.call(raw) === '[object Array]') {
      for (var i = 0; i < raw.length; i++) {
        var p = raw[i];
        if (!p || typeof p !== 'object') continue;
        var id = typeof p.id === 'string' && p.id ? p.id : null;
        var name = typeof p.name === 'string' && p.name ? p.name : null;
        if (!id || !name) continue;
        list.push({ id: id, name: name, color: typeof p.color === 'number' ? p.color : 0 });
      }
    }
    if (!list.length) {
      list = [{ id: 'default', name: 'Hauptprofil', color: 0 }];
      save('profiles', list);
    }
    state.profiles = list;
  }

  function addProfile(name) {
    var id = 'p' + Date.now();
    state.profiles.push({ id: id, name: name, color: state.profiles.length % PROFILE_COLORS.length });
    save('profiles', state.profiles);
    return id;
  }

  function deleteProfile(id) {
    if (id === 'default') return;      // Hauptprofil bleibt
    state.profiles = state.profiles.filter(function (p) { return p.id !== id; });
    save('profiles', state.profiles);
    try {
      localStorage.removeItem('glasstv.favorites.' + id);
      localStorage.removeItem('glasstv.progress.' + id);
      localStorage.removeItem('glasstv.watchlist.' + id);
    } catch (e) { /* egal */ }
    if (state.activeProfile === id) switchProfile('default');
  }

  function switchProfile(id) {
    state.activeProfile = id;
    save('activeProfile', id);
    loadProfileData();
    // Sonst bliebe eine im Elternprofil aufgehobene Sperre im Kinderprofil offen.
    state.unlocked = false;
    applyLanguageFilter();
  }

  function profileName(id) {
    for (var i = 0; i < state.profiles.length; i++) {
      if (state.profiles[i].id === id) return state.profiles[i].name;
    }
    return 'Profil';
  }

  /** „Wer schaut?" – Netflix-Stil, nur wenn es mehr als ein Profil gibt. */
  function renderGate() {
    var wrap = element('div', 'gate');
    wrap.appendChild(element('div', 'gate-title', 'Wer schaut?'));
    var row = element('div', 'gate-row');
    for (var i = 0; i < state.profiles.length; i++) {
      (function (p) {
        var item = element('div', 'gate-profile focusable');
        item.tabIndex = 0;
        var av = element('div', 'gate-avatar', (p.name.charAt(0) || '?').toUpperCase());
        av.style.background = PROFILE_COLORS[p.color % PROFILE_COLORS.length];
        item.appendChild(av);
        item.appendChild(element('div', 'gate-name', p.name));
        item.onclick = function () {
          switchProfile(p.id);
          state.gate = false;
          render();
        };
        row.appendChild(item);
      })(state.profiles[i]);
    }
    wrap.appendChild(row);
    el.content.appendChild(wrap);
  }


  // -------------------------------------------------------- Statistik ----

  /**
   * Auswertung des Verlaufs (wie iOS/Android).
   *
   * WAS EHRLICH GEHT – und was nicht: Ein Eintrag trägt je Titel genau EINEN
   * Stand und EINEN Zeitpunkt. Eine echte Sehzeit JE TAG gibt das nicht her
   * (wer einen Film Montag beginnt und Dienstag beendet, hinterlässt einen
   * Dienstags-Eintrag mit voller Position). Die Wochengrafik zählt deshalb
   * TITEL je Tag. Live-Sender liefern gar keine Laufzeit und zählen nur dort mit.
   */
  function computeStats() {
    var entries = progressList();
    var out = {
      count: entries.length, vodSeconds: 0, finished: 0, channels: 0,
      streak: 0, days: [], groups: [], longest: null, longestSeconds: 0,
    };
    var dayCounts = {}, groupCounts = {};

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var d = new Date(e.updatedAt);
      var key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      dayCounts[key] = (dayCounts[key] || 0) + 1;
      if (e.group) groupCounts[e.group] = (groupCounts[e.group] || 0) + 1;
      if (e.kind === 'live') { out.channels++; continue; }
      // Position bei bekannter Laufzeit deckeln – Rundungsreste sonst darüber.
      var secs = e.duration > 0 ? Math.min(e.position, e.duration) : e.position;
      out.vodSeconds += secs;
      if (e.duration > 0 && (e.position / e.duration) >= 0.95) out.finished++;
      if (secs > out.longestSeconds) { out.longestSeconds = secs; out.longest = e.title; }
    }

    // Letzte sieben Tage, älteste zuerst.
    var today = new Date();
    for (var back = 6; back >= 0; back--) {
      var dd = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      var k = dd.getFullYear() + '-' + (dd.getMonth() + 1) + '-' + dd.getDate();
      out.days.push({ date: dd, count: dayCounts[k] || 0 });
    }

    // Tage am Stück (heute oder gestern als Start).
    var cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var todayKey = cursor.getFullYear() + '-' + (cursor.getMonth() + 1) + '-' + cursor.getDate();
    if (!dayCounts[todayKey]) cursor.setDate(cursor.getDate() - 1);
    while (true) {
      var ck = cursor.getFullYear() + '-' + (cursor.getMonth() + 1) + '-' + cursor.getDate();
      if (!dayCounts[ck]) break;
      out.streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    var pairs = [];
    for (var g in groupCounts) {
      if (Object.prototype.hasOwnProperty.call(groupCounts, g)) pairs.push({ name: g, count: groupCounts[g] });
    }
    pairs.sort(function (a, b) { return b.count - a.count; });
    out.groups = pairs.slice(0, 5);
    return out;
  }

  var WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

  function renderStats() {
    el.content.appendChild(backButton());
    var st = computeStats();

    if (!st.count) {
      return renderEmpty('Noch keine Statistik',
        'Sobald du etwas ansiehst, entstehen hier Wochenübersicht, Gesamtzeiten ' +
        'und Top-Kategorien.');
    }

    var tiles = element('div', 'stat-row');
    function tile(value, label) {
      var t = element('div', 'stat-tile');
      t.appendChild(element('div', 'stat-value', value));
      t.appendChild(element('div', 'stat-label', label));
      return t;
    }
    var hours = Math.floor(st.vodSeconds / 3600);
    tiles.appendChild(hours >= 1
      ? tile(String(hours), 'Stunden gesehen')
      : tile(String(Math.floor(st.vodSeconds / 60)), 'Minuten gesehen'));
    tiles.appendChild(tile(String(st.finished), 'Zu Ende gesehen'));
    tiles.appendChild(tile(String(st.streak), 'Tage am Stück'));
    tiles.appendChild(tile(String(st.channels), 'Verschiedene Sender'));
    el.content.appendChild(tiles);

    el.content.appendChild(element('div', 'section-title', 'Diese Woche'));
    var max = 1;
    for (var i = 0; i < st.days.length; i++) max = Math.max(max, st.days[i].count);
    var week = element('div', 'week');
    for (var j = 0; j < st.days.length; j++) {
      (function (day) {
        var col = element('div', 'week-day');
        col.appendChild(element('div', 'week-count', day.count ? String(day.count) : ''));
        var bar = element('div', 'week-bar' + (day.count ? ' on' : ''));
        // Mindesthöhe, damit leere Tage als Spur sichtbar bleiben.
        bar.style.height = (14 + Math.round(96 * day.count / max)) + 'px';
        col.appendChild(bar);
        col.appendChild(element('div', 'week-label', WEEKDAYS[day.date.getDay()]));
        week.appendChild(col);
      })(st.days[j]);
    }
    el.content.appendChild(week);
    el.content.appendChild(element('div', 'detail-meta',
      'Gezählt werden Titel je Tag – Sender liefern keine Laufzeit, zählen aber mit.'));

    if (st.groups.length) {
      el.content.appendChild(element('div', 'section-title', 'Top-Kategorien'));
      var top = st.groups[0].count || 1;
      for (var k = 0; k < st.groups.length; k++) {
        (function (g) {
          var line = element('div', 'bar-line');
          line.appendChild(element('div', 'bar-head', g.name + '   ·   ' + g.count));
          var track = element('div', 'bar-track');
          var fill = element('div', 'bar-fill');
          fill.style.width = Math.round((g.count / top) * 100) + '%';
          track.appendChild(fill);
          line.appendChild(track);
          el.content.appendChild(line);
        })(st.groups[k]);
      }
    }

    el.content.appendChild(element('div', 'section-title', 'Gesamt'));
    el.content.appendChild(element('div', 'detail-meta', st.count + ' Einträge im Verlauf'));
    if (st.longest) {
      el.content.appendChild(element('div', 'detail-meta',
        'Weitester Fortschritt: ' + st.longest + ' (' + durationText(st.longestSeconds) + ')'));
    }
  }


  // ------------------------------------------- Katalog bei Bedarf ----

  /** Alle Filme aus den derzeit geladenen Kategorien. */
  function geladeneFilme() { return ausCacheSammeln('m'); }
  /** Alle Serien aus den derzeit geladenen Kategorien. */
  function geladeneSerien() { return ausCacheSammeln('s'); }

  function ausCacheSammeln(art) {
    var out = [];
    for (var k in state.katalogCache) {
      if (!Object.prototype.hasOwnProperty.call(state.katalogCache, k)) continue;
      if (k.charAt(0) !== art) continue;
      var teil = state.katalogCache[k];
      for (var i = 0; i < teil.length; i++) out.push(teil[i]);
    }
    return out;
  }


  /** Wie viele Kategorien gleichzeitig im Speicher bleiben. */
  var KATALOG_CACHE_MAX = 3;

  function katalogSchluessel(art, katID) { return art + ':' + katID; }

  function katalogAusCache(art, katID) {
    var k = katalogSchluessel(art, katID);
    var eintrag = state.katalogCache[k];
    if (eintrag) {
      // Zuletzt benutzt nach hinten – die vorderen werden verdrängt.
      var i = state.katalogReihe.indexOf(k);
      if (i >= 0) state.katalogReihe.splice(i, 1);
      state.katalogReihe.push(k);
    }
    return eintrag || null;
  }

  function katalogAblegen(art, katID, items) {
    var k = katalogSchluessel(art, katID);
    state.katalogCache[k] = items;
    bibliothekGeaendert();
    state.katalogReihe.push(k);
    while (state.katalogReihe.length > KATALOG_CACHE_MAX) {
      var alt = state.katalogReihe.shift();
      delete state.katalogCache[alt];
      delete sortCache[('movies:' + alt.slice(2))];   // Sortier-Kopien halten
      delete sortCache[('series:' + alt.slice(2))];   // sonst die Eintraege fest
      bibliothekGeaendert();
    }
  }

  /**
   * Eine Kategorie holen (oder aus dem Zwischenspeicher nehmen).
   * `art` ist 'm' für Filme oder 's' für Serien.
   */
  /** Laufenden Kategorieabruf verwerfen und zur Kategorienliste zurueck. */
  function katalogAbbrechen() {
    katalogLauf++;              // laufende Antwort wird dadurch verworfen
    if (katalogAnfrage) {
      try { katalogAnfrage.abort(); } catch (e) {}
      katalogAnfrage = null;
    }
    state.katalogLaedt = null;
    // Zurueck zur Kategorienliste: Bliebe die Wahl stehen, liefe der Aufbau
    // sofort wieder in den Nachladepfad – der Abbruch waere wirkungslos.
    state.katWahl.movies = null;
    state.katWahl.series = null;
    render();
  }

  var katalogAnfrage = null;
  // Kategorien, deren Abruf gescheitert ist – verhindert die Nachlade-Schleife.
  var katalogFehler = Object.create(null);
  // Generationszaehler: Ein Abbruch erhoeht ihn, veraltete Antworten werden
  // dadurch verworfen – `abort()` allein ist auf webOS nicht verlaesslich.
  var katalogLauf = 0;

  function katalogLaden(art, katID, katName, fertig) {
    var vorhanden = katalogAusCache(art, katID);
    if (vorhanden) { fertig(vorhanden); return; }

    var src = state.source;
    if (!src || src.kind !== 'xtream') { fertig([]); return; }

    state.katalogLaedt = katName;
    var meinLauf = ++katalogLauf;
    render();

    var aktion = art === 'm' ? 'get_vod_streams' : 'get_series';
    var url = Core.xtreamApi(src.host, src.user, src.pass, aktion, { category_id: katID });
    katalogAnfrage = httpGetJson(url, function (err, json) {
      if (meinLauf !== katalogLauf) return;   // abgebrochen oder ueberholt
      katalogAnfrage = null;
      state.katalogLaedt = null;
      if (err || !json) {
        katalogFehler[katalogSchluessel(art, katID)] = true;
        render();
        toast('Die Kategorie „' + katName + '“ kam nicht an' +
          (err ? ' (' + err.message + ')' : '') +
          '. Prüfe die Internetverbindung und versuch es noch einmal.', 8000);
        return;
      }
      var items;
      try {
        var kat = {};
        kat[String(katID)] = katName;
        items = art === 'm'
          ? Core.parseVodStreams(json, kat, src.host, src.user, src.pass, 'xtream')
          : Core.parseSeriesList(json, kat, 'xtream');
      } catch (e) {
        katalogFehler[katalogSchluessel(art, katID)] = true;
        render();
        toast('Die Kategorie „' + katName + '“ ließ sich nicht lesen: ' + e.message, 8000);
        return;
      }
      // Sprachfilter und Sperren gelten auch hier.
      items = katalogFiltern(items);
      delete katalogFehler[katalogSchluessel(art, katID)];   // Versuch geglueckt
      katalogAblegen(art, katID, items);
      fertig(items);
    }, 60000);
  }

  /** Dieselben Regeln wie für die Hauptbibliothek auf einen Nachschub anwenden. */
  function katalogFiltern(items) {
    var blockiert = state.settings.hiddenGroups.slice();
    if (state.settings.pin && !state.unlocked) {
      blockiert = blockiert.concat(state.settings.lockedGroups);
    }
    var set = Object.create(null);
    for (var b = 0; b < blockiert.length; b++) set[blockiert[b]] = true;
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (set[items[i].group]) continue;
      out.push(items[i]);
    }
    if (!state.settings.languages.length) return out;
    var hilfs = { channels: [], movies: out, series: [] };
    return Core.filterByLanguage(hilfs, state.settings.languages, state.settings.strict).movies;
  }

  /** Kategorien als Liste – der Einstieg, wenn nicht alles im Speicher liegt. */
  function renderKategorienListe(art, kategorien, onWahl, gesamt) {
    var alle = gesamt === undefined ? kategorien.length : gesamt;
    var gesucht = state.katSuche[art];

    // Ohne Kategorien UND ohne Suchbegriff: Da hat wirklich die Quelle nichts
    // geliefert. Mit Suchbegriff schoeben wir dem Anbieter zu, was der Nutzer
    // selbst getippt hat.
    if (!alle && !gesucht) {
      return renderEmpty('Keine Kategorien',
        'Die Quelle hat für diesen Bereich keine Kategorien geliefert.');
    }

    el.content.appendChild(element('div', 'section-title', kategorieUeberschrift(art, kategorien.length, alle)));
    el.content.appendChild(element('div', 'detail-meta',
      'Wähle eine Kategorie – sie wird dann geladen. So bleibt der Speicher ' +
      'des Fernsehers frei für die Wiedergabe.'));

    var box = element('div', 'katliste');
    // Die Liste immer anlegen, auch leer: Das Suchfeld tauscht nur sie aus und
    // fiele sonst auf einen vollen Seitenaufbau zurueck.
    fuelleKategorieListe(box, art, kategorien, onWahl);
    el.content.appendChild(box);
  }

  /** „12 von 299 Filmkategorien" – die Zahl muss zur gezeigten Liste passen. */
  function kategorieUeberschrift(art, gezeigt, gesamt) {
    var wort = art === 'm' ? ' Filmkategorien' : ' Serienkategorien';
    if (gezeigt === gesamt) return gesamt + wort;
    return gezeigt + ' von ' + gesamt + wort;
  }

  /** Liste fuellen oder eine ehrliche Leermeldung hineinschreiben. */
  function fuelleKategorieListe(box, art, kategorien, onWahl) {
    if (!kategorien.length) {
      var t = state.katSuche[art];
      box.appendChild(element('div', 'detail-meta', t
        ? 'Keine Kategorie enthält „' + t + '“. Suchbegriff kürzen oder leeren.'
        : 'Keine Kategorien verfügbar.'));
      return;
    }
    renderKategorieChunk(box, art, kategorien, 0, 40, onWahl);
  }

  /**
   * Erster Buchstabe eines Kategorienamens als Platzhalter.
   *
   * Kategorien haben nie ein Logo; das leere graue Feld sah in einer Liste aus
   * 299 Zeilen durchgehend nach Ladefehler aus. Fuehrende Zusaetze wie „4K -"
   * werden uebersprungen, damit nicht jede Zeile dasselbe Zeichen traegt.
   */
  function initialeVon(name) {
    var t = String(name || '').replace(/^[^A-Za-z0-9\u00C0-\u024F]+/, '');
    var m = t.match(/[A-Za-z\u00C0-\u024F0-9]/);
    return m ? m[0].toUpperCase() : '•';
  }

  function renderKategorieChunk(box, art, kategorien, from, count, onWahl) {
    for (var i = from; i < kategorien.length && i < from + count; i++) {
      (function (kat) {
        var row = element('div', 'channel focusable');
        row.tabIndex = 0;
        row.setAttribute('data-fkey', 'kat:' + art + ':' + kat.id);
        row.appendChild(element('div', 'logo initiale', initialeVon(kat.name)));
        var info = element('div', 'info');
        info.appendChild(element('div', 'name', kat.name));
        var geladen = !!state.katalogCache[katalogSchluessel(art, kat.id)];
        info.appendChild(element('div', 'sub', geladen ? 'geladen' : 'noch nicht geladen'));
        row.appendChild(info);
        row.onclick = function () { onWahl(kat); };
        box.appendChild(row);
      })(kategorien[i]);
    }
    if (from + count < kategorien.length) {
      var rest = kategorien.length - from - count;
      var mehr = button('Weitere ' + Math.min(count, rest) + ' Kategorien', function () {
        box.removeChild(mehr);
        var ersteNeue = box.childNodes.length;
        renderKategorieChunk(box, art, kategorien, from + count, count, onWahl);
        collectFocusables();
        var node = box.childNodes[ersteNeue];
        if (node && node.focus) { node.focus(); revealFocus(node); }
      }, true);
      box.appendChild(mehr);
    }
  }

  // ----------------------------------------------------------- Seiten ----

  var letzteAnsicht = undefined;

  function render() {
    rememberFocus();
    renderTabs();
    clear(el.content);

    if (state.loading) {
      el.content.appendChild(element('div', 'spinner'));
      el.content.appendChild(element('div', 'loading-text',
        state.loadingStep || 'Bibliothek wird geladen …'));
      el.content.appendChild(element('div', 'loading-sub',
        'Große Playlisten brauchen einen Moment.'));
      return;
    }
    if (state.gate) { renderGate(); setTimeout(focusFirst, 0); return; }
    if (!state.source || state.authFehler) {
      renderSetup();
      // Der Fokus-Block unten wird durch das `return` uebersprungen – ohne
      // diesen Anlauf lag nach einem Anmeldefehler gar kein Fokus, obwohl
      // „Erneut versuchen" mit `data-erstziel` dastand.
      setTimeout(function () { if (!restoreFocus()) ensureFocus(); }, 0);
      return;
    }

    if (state.view) {
      if (state.view.type === 'movie') renderMovieDetail(state.view.item);
      else if (state.view.type === 'series') renderSeriesDetail(state.view.item);
      else if (state.view.type === 'guide') renderGuide();
      else if (state.view.type === 'search') renderSearch();
      else if (state.view.type === 'settings') renderSettings();
      else if (state.view.type === 'stats') renderStats();
    } else if (state.tab === 'home') renderHome();
    else if (state.tab === 'live') renderChannels();
    else if (state.tab === 'movies') renderMovies();
    else if (state.tab === 'series') renderSeriesList();
    else renderFavorites();

    lazyAnstossen();
    /*
     * Eine neu geoeffnete Ansicht beginnt oben. Ohne das sprang die Seite in
     * den ersten Millisekunden: Solange das Backdrop-Bild noch nicht geladen
     * ist, stehen die Elemente woanders, und der Erstfokus scrollte zu einer
     * Position, die nach dem Bildaufbau nicht mehr stimmte – auf der
     * Detailseite verschwand dadurch der obere Bildrand hinter der Kopfleiste.
     */
    var neueAnsicht = state.view !== letzteAnsicht;
    letzteAnsicht = state.view;
    setTimeout(function () {
      if (!restoreFocus()) ensureFocus();
      /*
       * NACH dem Fokus zuruecksetzen: Der Fokus selbst scrollt (revealFocus),
       * und eine frisch geoeffnete Ansicht soll oben beginnen. Vorher sprang
       * die Detailseite um 65px hoch, wodurch der obere Bildrand samt
       * Zurueck-Knopf hinter der Kopfleiste verschwand.
       */
      if (neueAnsicht && el.content.scrollTop) el.content.scrollTop = 0;
    }, 0);
    // Zweiter Anlauf: Beim ersten Aufbau sind Bilder/Layout noch nicht fertig,
    // ein Fokus auf ein Element der Größe null greift nicht.
    setTimeout(ensureFocus, 350);
  }

  /**
   * Farbtasten-Hinweis. Grün/Gelb/Blau sind sonst nirgends erklaert – der
   * einzige Hinweis stand im Leerzustand der Favoriten, den man nur sieht,
   * solange man nichts gemerkt hat.
   */
  function farbtastenLeiste() {
    var box = element('div', 'farbtasten');
    var eintraege = [
      { farbe: 'gruen', text: 'Guide' },
      { farbe: 'gelb', text: 'Suche' },
      { farbe: 'blau', text: 'Favorit' }
    ];
    for (var i = 0; i < eintraege.length; i++) {
      var e = element('span', 'farbtaste');
      e.appendChild(element('span', 'punkt ' + eintraege[i].farbe));
      e.appendChild(document.createTextNode(eintraege[i].text));
      box.appendChild(e);
    }
    return box;
  }

  function renderTabs() {
    clear(el.tabs);
    for (var i = 0; i < TABS.length; i++) {
      (function (t) {
        var active = !state.view && state.tab === t.id;
        var b = element('button', 'tab focusable' + (active ? ' active' : ''), t.label);
        b.onclick = function () {
          state.tab = t.id; state.view = null;
          render();
        };
        el.tabs.appendChild(b);
      })(TABS[i]);
    }
  }

  function renderEmpty(title, message) {
    var e = element('div', 'empty');
    e.appendChild(element('strong', null, title));
    e.appendChild(document.createTextNode(message));
    el.content.appendChild(e);
  }

  // ---- Start ----

  function renderHome() {
    var lib = state.library;
    var cont = resumable();

    if (cont.length) {
      var s1 = shelf('Weiterschauen', cont, function (p) {
        var rest = Math.max(1, Math.round((p.duration - p.position) / 60));
        var c = card(p.title, p.image, function () {
          // Die Adresse steht bewusst nicht mehr im Verlauf (Zugangsdaten) –
          // hier aus der Bibliothek nachschlagen.
          // Reihenfolge: gespeicherte Adresse (M3U), sonst der Eintrag aus der
          // Bibliothek, sonst aus der Kennung gebaut – Letzteres greift, wenn
          // die Kategorie des Titels gerade nicht geladen ist.
          var url = p.url || streamUrlOf(findById(p.id)) ||
            streamUrlAusId(p.id, p.ext, p.quelle);
          if (!url) return toast('Dieser Titel lässt sich gerade nicht öffnen.', 6000);
          playItem(p.title, url, 'Noch ' + rest + ' Min.', p.kind, p.id, p.position, null,
            { image: p.image, group: p.group });
        }, true);
        c.appendChild(progressBar(p.position / p.duration));
        return c;
      });
      if (s1) el.content.appendChild(s1);
    }

    // Jetzt im TV: Sender mit laufender Sendung, Favoriten zuerst.
    var live = [];
    for (var i = 0; i < lib.channels.length && live.length < 20; i++) {
      var ch = lib.channels[i];
      if (Core.nowProgram(programsFor(ch))) live.push(ch);
    }
    live.sort(function (a, b) { return (isFavorite(b.id) ? 1 : 0) - (isFavorite(a.id) ? 1 : 0); });
    /*
     * Ohne EPG blieb dieses Regal leer, und die Startseite kam bei Xtream ganz
     * ohne Sender aus. Dann ersatzweise die ersten Sender zeigen – Favoriten
     * zuerst.
     */
    var ohneEpg = !live.length;
    if (ohneEpg) {
      var favZuerst = [];
      for (var fi = 0; fi < lib.channels.length && favZuerst.length < 20; fi++) {
        if (isFavorite(lib.channels[fi].id)) favZuerst.push(lib.channels[fi]);
      }
      for (var ci = 0; ci < lib.channels.length && favZuerst.length < 20; ci++) {
        if (!isFavorite(lib.channels[ci].id)) favZuerst.push(lib.channels[ci]);
      }
      live = favZuerst;
    }
    var s2 = shelf(ohneEpg ? 'Sender' : 'Jetzt im TV', live, function (ch) {
      var now = Core.nowProgram(programsFor(ch));
      var c = card(ch.name, ch.logoURL, function () { playChannel(ch); }, true,
        null, now ? ['LIVE'] : null);
      if (now) {
        c.appendChild(element('div', 'sub', now.title));
        var span = now.end - now.start;
        c.appendChild(progressBar(span > 0 ? (Date.now() - now.start) / span : 0));
      }
      return c;
    });
    if (s2) el.content.appendChild(s2);

    // Merkliste vor den allgemeinen Regalen – bewusst Gemerktes zuerst.
    var listItems = [];
    var merk = merkListe(state.watchlist, 'watchlist');
    for (var mi = 0; mi < merk.length; mi++) {
      if (!istSenderEintrag(merk[mi])) listItems.push(merk[mi]);
    }
    var sList = shelf('Meine Liste', listItems, function (it) {
      return card(it.title, it.posterURL, function () {
        if (it.episodes !== undefined) openSeries(it); else openMovie(it);
      });
    });
    if (sList) el.content.appendChild(sList);

    var forYou = recommendations(lib.movies, 'id', 20);
    var sFor = shelf('Für dich', forYou, function (m) {
      return card(m.title, m.posterURL, function () { openMovie(m); });
    });
    if (sFor) el.content.appendChild(sFor);

    var because = becauseYouWatched();
    if (because) {
      var sBec = shelf('Weil du „' + because.title + '“ gesehen hast', because.items, function (m) {
        return card(m.title, m.posterURL, function () { openMovie(m); });
      });
      if (sBec) el.content.appendChild(sBec);
    }

    var forYouSeries = recommendations(lib.series, 'id', 20);
    var sForS = shelf('Serien für dich', forYouSeries, function (x) {
      return card(x.title, x.posterURL, function () { openSeries(x); });
    });
    if (sForS) el.content.appendChild(sForS);

    var filme = state.lazyKatalog ? geladeneFilme() : lib.movies;
    var serien = state.lazyKatalog ? geladeneSerien() : lib.series;

    var s3 = shelf(state.lazyKatalog ? 'Zuletzt geöffnete Filme' : 'Filme',
      filme.slice(0, 30), function (m) {
        return card(m.title, m.posterURL, function () { openMovie(m); });
      });
    if (s3) el.content.appendChild(s3);

    var s4 = shelf(state.lazyKatalog ? 'Zuletzt geöffnete Serien' : 'Serien',
      serien.slice(0, 30), function (x) {
        return card(x.title, x.posterURL, function () { openSeries(x); });
      });
    if (s4) el.content.appendChild(s4);

    // Ohne geöffnete Kategorie hätte die Startseite sonst nur Live-Inhalte –
    // deshalb hier der Einstieg in die Kategorien.
    if (state.lazyKatalog && !filme.length && !serien.length &&
        (state.vodKategorien.length || state.serienKategorien.length)) {
      el.content.appendChild(element('div', 'section-title', 'Filme und Serien'));
      el.content.appendChild(element('div', 'detail-meta',
        state.vodKategorien.length + ' Film- und ' + state.serienKategorien.length +
        ' Serienkategorien stehen bereit. Sie werden einzeln geladen, damit der ' +
        'Fernseher nicht den ganzen Katalog im Speicher halten muss.'));
      var einstieg = element('div', 'detail-actions');
      einstieg.appendChild(button('Zu den Filmen', function () {
        state.tab = 'movies'; state.view = null; render();
      }, true));
      einstieg.appendChild(button('Zu den Serien', function () {
        state.tab = 'series'; state.view = null; render();
      }, true));
      el.content.appendChild(einstieg);
    }

    if (!cont.length && !live.length && !filme.length && !serien.length &&
        !state.vodKategorien.length && !state.serienKategorien.length) {
      renderEmpty('Nichts geladen', 'Die Quelle hat keine Inhalte geliefert.');
      return;
    }
    el.content.appendChild(farbtastenLeiste());
  }

  // ---- Live TV ----

  function renderChannels() {
    var all = state.library.channels;
    if (!all.length) return renderEmpty('Keine Sender', 'Die Quelle hat keine Live-Sender geliefert.');

    var groups = groupsOf(all, 'live');
    el.content.appendChild(groupChips(groups, state.group.live, function (g) {
      state.group.live = g; render();
    }));

    var list = all;
    if (state.group.live) {
      list = all.filter(function (c) { return c.group === state.group.live; });
    }
    el.content.appendChild(element('div', 'section-title', list.length + ' Sender'));

    var box = document.createElement('div');
    // Sehr lange Listen bremsen den TV-Browser aus – in Blöcken nachladen.
    renderChannelChunk(box, list, 0, 120);
    el.content.appendChild(box);
  }

  /**
   * Kachelblock zeichnen und einen Knopf für den nächsten anbieten.
   *
   * 63 = neun volle Reihen à sieben Kacheln – so bleibt das Raster bündig.
   */
  function renderGridChunk(grid, list, from, count, onSelect) {
    for (var i = from; i < list.length && i < from + count; i++) {
      (function (item) {
        grid.appendChild(card(item.title, item.posterURL,
          function () { onSelect(item); }, false, item.id));
      })(list[i]);
    }
    if (from + count < list.length) {
      var rest = list.length - from - count;
      var mehr = button('Weitere ' + Math.min(count, rest) + ' anzeigen', function () {
        grid.removeChild(mehr);
        var ersteNeue = grid.childNodes.length;
        renderGridChunk(grid, list, from + count, count, onSelect);
        collectFocusables();
        lazyAnstossen();
        var node = grid.childNodes[ersteNeue];
        if (node && node.focus) { node.focus(); revealFocus(node); }
      }, true);
      grid.appendChild(mehr);
    }
  }

  function renderChannelChunk(box, list, from, count) {
    for (var i = from; i < list.length && i < from + count; i++) {
      box.appendChild(channelRow(list[i], i + 1));
    }
    if (from + count < list.length) {
      var more = button('Weitere ' + Math.min(120, list.length - from - count) + ' Sender', function () {
        box.removeChild(more);
        var ersteNeue = box.childNodes.length;
        renderChannelChunk(box, list, from + count, 120);
        collectFocusables();
        // Der Knopf, auf dem der Fokus lag, ist weg – ohne Übergabe landet der
        // Fokus im Nichts und der nächste Tastendruck springt an den Listenanfang.
        var node = box.childNodes[ersteNeue];
        if (node && node.focus) { node.focus(); revealFocus(node); }
      }, true);
      box.appendChild(more);
    }
  }

  /**
   * Kategorie-Leiste über den Listen.
   *
   * Die ersten 40 stehen direkt da – bei mehr führt „Suchen …" zu einem Feld,
   * über das auch alphabetisch hintere Kategorien erreichbar sind. Vorher waren
   * die schlicht nicht auswählbar.
   */
  function groupChips(groups, selected, onPick) {
    var box = document.createElement('div');
    var wrap = element('div', 'chips');
    var all = element('span', 'chip focusable' + (selected ? '' : ' active'), 'Alle');
    all.tabIndex = 0;
    all.setAttribute('data-fkey', 'group:*');
    all.onclick = function () { onPick(null); };
    wrap.appendChild(all);

    // Die gewählte Kategorie immer zeigen, auch wenn sie hinter Position 40 liegt.
    var sichtbar = [];
    for (var i = 0; i < groups.length && sichtbar.length < 40; i++) sichtbar.push(groups[i]);
    if (selected && sichtbar.indexOf(selected) < 0) sichtbar.unshift(selected);

    for (var j = 0; j < sichtbar.length; j++) {
      (function (g) {
        var c = element('span', 'chip focusable' + (selected === g ? ' active' : ''), g);
        c.tabIndex = 0;
        c.setAttribute('data-fkey', 'group:' + g);
        c.onclick = function () { onPick(g); };
        wrap.appendChild(c);
      })(sichtbar[j]);
    }

    if (groups.length > sichtbar.length) {
      var mehr = element('span', 'chip focusable', 'Suchen … (' + groups.length + ')');
      mehr.tabIndex = 0;
      mehr.setAttribute('data-fkey', 'group:suchen');
      mehr.onclick = function () {
        if (box.childNodes.length > 1) { box.removeChild(box.lastChild); return; }
        box.appendChild(categoryPicker(
          groups,
          function (name) { return selected === name; },
          function (name) { onPick(name); },
          'gsearch', '●'));
        var feld = box.querySelector('input');
        if (feld) { feld.focus(); revealFocus(feld); }
      };
      wrap.appendChild(mehr);
    }

    box.appendChild(wrap);
    return box;
  }

  function channelRow(ch, number) {
    var programs = programsFor(ch);
    var now = Core.nowProgram(programs);
    var next = Core.nextProgram(programs);

    var row = element('div', 'channel focusable' + (now ? ' on-air' : ''));
    row.tabIndex = 0;
    // Ohne Merker sprang der Fokus nach der Favoritentaste aus Zeile 300 einer
    // langen Liste wieder ganz nach oben.
    row.setAttribute('data-fkey', 'ch:' + ch.id);

    if (number) row.appendChild(element('div', 'num', String(number)));

    if (ch.logoURL) {
      var logo = document.createElement('img');
      logo.className = 'logo';
      logo.setAttribute('data-src', bildAdresse(ch.logoURL));
      logo.onerror = function () { logo.style.visibility = 'hidden'; };
      lazyBildAnmelden(logo);
      row.appendChild(logo);
    } else {
      row.appendChild(element('div', 'logo'));
    }

    var info = element('div', 'info');
    info.appendChild(element('div', 'name', ch.name));
    if (now) {
      info.appendChild(element('div', 'sub', now.title +
        (next ? '   ·   danach ' + timeText(next.start) + ' ' + next.title : '')));
      var span = now.end - now.start;
      info.appendChild(progressBar(span > 0 ? (Date.now() - now.start) / span : 0));
    } else {
      info.appendChild(element('div', 'sub', ch.group));
    }
    row.appendChild(info);

    if (isFavorite(ch.id)) row.appendChild(element('span', 'badge-fav', '★'));
    if (now) row.appendChild(element('span', 'badge-live', 'LIVE'));

    row.onclick = function () { playChannel(ch); };
    // Lange OK-Taste ist auf der Fernbedienung unzuverlässig – Favorit über
    // die blaue Farbtaste (403) im Tastatur-Handler.
    row._favTarget = ch.id; row._favItem = ch;
    return row;
  }

  // ---- Filme / Serien ----

  function renderMovies() {
    if (state.lazyKatalog) return renderLazyKatalog('m');
    var all = state.library.movies;
    if (!all.length) return renderEmpty('Keine Filme', 'Die Quelle hat keine Filme geliefert.');

    var groups = groupsOf(all, 'movies');
    el.content.appendChild(groupChips(groups, state.group.movies, function (g) {
      state.group.movies = g; render();
    }));

    var list = state.group.movies
      ? all.filter(function (m) { return m.group === state.group.movies; })
      : all;
    list = sortItems(list, 'title', 'movies:' + (state.group.movies || '*'));
    el.content.appendChild(element('div', 'section-title', list.length + ' Filme'));

    var grid = element('div', 'grid');
    // In Blöcken statt alles auf einmal: Jede sichtbare Kachel kostet ein
    // dekodiertes Bild, und davon hängt der Speicherbedarf der App ab.
    renderGridChunk(grid, list, 0, 63, function (m) { openMovie(m); });
    el.content.appendChild(grid);
  }

  function renderSeriesList() {
    if (state.lazyKatalog) return renderLazyKatalog('s');
    var all = state.library.series;
    if (!all.length) return renderEmpty('Keine Serien', 'Die Quelle hat keine Serien geliefert.');

    var groups = groupsOf(all, 'series');
    el.content.appendChild(groupChips(groups, state.group.series, function (g) {
      state.group.series = g; render();
    }));

    var list = state.group.series
      ? all.filter(function (s) { return s.group === state.group.series; })
      : all;
    list = sortItems(list, 'title', 'series:' + (state.group.series || '*'));
    el.content.appendChild(element('div', 'section-title', list.length + ' Serien'));

    var grid = element('div', 'grid');
    renderGridChunk(grid, list, 0, 63, function (x) { openSeries(x); });
    el.content.appendChild(grid);
  }

  /**
   * Filme bzw. Serien, wenn der Katalog erst bei Bedarf kommt: erst die
   * Kategorien, nach der Wahl deren Inhalt.
   */
  function renderLazyKatalog(art) {
    var alle = art === 'm' ? state.vodKategorien : state.serienKategorien;
    // Ausgeblendetes und Gesperrtes darf hier gar nicht erst auftauchen –
    // sonst führte die Kindersicherung nur zu einer leeren Kategorie.
    var kategorien = [];
    for (var ki = 0; ki < alle.length; ki++) {
      if (kategorieErlaubt(alle[ki].name)) kategorien.push(alle[ki]);
    }
    var wahl = art === 'm' ? state.katWahl.movies : state.katWahl.series;

    if (state.katalogLaedt) {
      /*
       * Mit einem bedienbaren Element: Vorher hatte die Seite waehrend des
       * Ladens KEIN fokussierbares Element, der Fokus fiel auf den Start-Tab
       * in der Kopfleiste – jeder OK-Druck traf ihn, und Zurueck verliess den
       * Filme-Tab.
       */
      el.content.appendChild(element('div', 'spinner'));
      el.content.appendChild(element('div', 'loading-text',
        '„' + state.katalogLaedt + '“ wird geladen …'));
      el.content.appendChild(element('div', 'loading-sub',
        'Die Kategorie kommt direkt vom Anbieter.'));
      var abbr = button('Abbrechen', function () { katalogAbbrechen(); }, true, 'katabbruch');
      abbr.setAttribute('data-erstziel', '1');
      var box = element('div', 'detail-actions');
      box.appendChild(abbr);
      el.content.appendChild(box);
      return;
    }

    if (!wahl) {
      var frei = kategorien;
      if (state.katSuche[art]) {
        var q = state.katSuche[art].toLowerCase();
        frei = [];
        for (var i = 0; i < kategorien.length; i++) {
          if (kategorien[i].name.toLowerCase().indexOf(q) >= 0) frei.push(kategorien[i]);
        }
      }
      el.content.appendChild(katSuchfeld(art));
      return renderKategorienListe(art, frei, function (kat) {
        katalogLaden(art, kat.id, kat.name, function (items) {
          if (art === 'm') state.katWahl.movies = kat; else state.katWahl.series = kat;
          render();
        });
      }, kategorien.length);
    }

    var items = katalogAusCache(art, wahl.id);
    if (!items) {
      /*
       * Der Zwischenspeicher haelt nur drei Kategorien. Wurde diese verdraengt,
       * wird sie nachgeholt statt als „leer" gemeldet.
       *
       * Der Fehlermerker ist zwingend: Ohne ihn rief der Fehlerzweig von
       * `katalogLaden` erneut `render()`, das landete sofort wieder hier und
       * lud abermals – gemessen 1074 Anfragen in 1,5 Sekunden, ohne Ausweg,
       * weil auch „Abbrechen" und die Zurueck-Taste ueber `render()` liefen.
       */
      if (katalogFehler[katalogSchluessel(art, wahl.id)]) {
        if (art === 'm') state.katWahl.movies = null; else state.katWahl.series = null;
        return renderLazyKatalog(art);   // zurueck zur Kategorienliste
      }
      katalogLaden(art, wahl.id, wahl.name, function () { render(); });
      return renderEmpty('„' + wahl.name + '“ wird geladen …',
        'Einen Moment – die Kategorie kommt direkt vom Panel.');
    }
    var zurueck = button('◀ Alle Kategorien', function () {
      // Fokus auf die Kategorie vorbelegen, aus der wir kommen – bei 299
      // Eintraegen ist das der Unterschied zwischen Stoebern und Aufgeben.
      focusWuenschen('kat:' + art + ':' + wahl.id);
      if (art === 'm') state.katWahl.movies = null; else state.katWahl.series = null;
      render();
    });
    zurueck.setAttribute('data-fkey', 'katzurueck:' + art);
    el.content.appendChild(zurueck);

    var liste = sortItems(items, 'title', (art === 'm' ? 'movies:' : 'series:') + wahl.id);
    el.content.appendChild(element('div', 'section-title',
      wahl.name + ' · ' + liste.length + (art === 'm' ? ' Filme' : ' Serien')));

    if (!liste.length) {
      el.content.appendChild(element('div', 'detail-meta',
        'Diese Kategorie ist leer – oder alle Einträge fallen durch Sprachfilter, ' +
        'ausgeblendete Kategorien oder die Kindersicherung.'));
      return;
    }

    var grid = element('div', 'grid');
    renderGridChunk(grid, liste, 0, 63, function (x) {
      if (art === 'm') openMovie(x); else openSeries(x);
    });
    el.content.appendChild(grid);
  }

  /** Suchfeld über der Kategorienliste – 299 Kategorien sind sonst nicht erreichbar. */
  function katSuchfeld(art) {
    var wrap = element('div', 'search-wrap');
    var input = document.createElement('input');
    input.className = 'search focusable';
    input.type = 'text';
    input.placeholder = 'Kategorie suchen …';
    input.value = state.katSuche[art] || '';
    input.setAttribute('data-fkey', 'katsuche:' + art);
    var letzterKatWert = null;
    input.oninput = function () {
      // Gleiches Netz wie im categoryPicker: `oninput` fehlt auf manchen
      // TV-Tastaturen, deshalb haengt unten zusaetzlich `onkeyup` dran.
      if (input.value === letzterKatWert) return;
      letzterKatWert = input.value;
      state.katSuche[art] = input.value;
      // Nur die Liste neu bauen – ein voller Aufbau nähme dem Feld den Fokus.
      var alt = el.content.querySelector('.katliste');
      if (!alt) { render(); return; }
      var neu = element('div', 'katliste');
      var q = input.value.toLowerCase();
      var kategorien = art === 'm' ? state.vodKategorien : state.serienKategorien;
      var frei = [], erlaubt = 0;
      for (var i = 0; i < kategorien.length; i++) {
        if (!kategorieErlaubt(kategorien[i].name)) continue;
        erlaubt++;
        if (!q || kategorien[i].name.toLowerCase().indexOf(q) >= 0) frei.push(kategorien[i]);
      }
      fuelleKategorieListe(neu, art, frei, function (kat) {
        katalogLaden(art, kat.id, kat.name, function () {
          if (art === 'm') state.katWahl.movies = kat; else state.katWahl.series = kat;
          render();
        });
      });
      alt.parentNode.replaceChild(neu, alt);
      // Die Ueberschrift mitziehen – sie versprach sonst weiter 299 Kategorien,
      // waehrend darunter zwoelf oder gar keine standen.
      var titel = el.content.querySelector('.section-title');
      if (titel) titel.textContent = kategorieUeberschrift(art, frei.length, erlaubt);
      collectFocusables();
    };
    input.onkeyup = input.oninput;
    wrap.appendChild(input);
    return wrap;
  }

  // ---- Favoriten ----

  function renderFavorites() {
    var lib = state.library;
    // Aus den gemerkten IDs heraus arbeiten: Fünf Voll-Scans über die
    // Bibliothek für ein paar Dutzend Treffer waren pro Aufbau spürbar.
    var favChannels = pickByIds(lib.channels, state.favorites);
    /*
     * Filme und Serien kommen aus den gemerkten Daten selbst, nicht aus der
     * Bibliothek: Bei kategorieweisem Laden ist die leer, und der Tab meldete
     * „Noch nichts gemerkt", obwohl alles gespeichert war.
     */
    var favAlle = merkListe(state.favorites, 'favorites');
    var favMovies = [], favSeries = [];
    for (var f = 0; f < favAlle.length; f++) {
      if (istSenderEintrag(favAlle[f])) continue;   // Sender stehen in der Zeilenliste
      (favAlle[f].episodes !== undefined ? favSeries : favMovies).push(favAlle[f]);
    }

    var listAlle = merkListe(state.watchlist, 'watchlist');
    var listMoviesFav = [], listSeriesFav = [];
    for (var g = 0; g < listAlle.length; g++) {
      if (istSenderEintrag(listAlle[g])) continue;
      (listAlle[g].episodes !== undefined ? listSeriesFav : listMoviesFav).push(listAlle[g]);
    }
    var anyList = listMoviesFav.length > 0 || listSeriesFav.length > 0;
    if (!favChannels.length && !favMovies.length && !favSeries.length && !anyList) {
      return renderEmpty('Noch nichts gemerkt',
        'Markiere Sender mit der blauen Taste oder setze Titel auf der Detailseite ' +
        'auf „Meine Liste“.');
    }
    if (favChannels.length) {
      el.content.appendChild(element('div', 'section-title', 'Sender'));
      var box = document.createElement('div');
      for (var i = 0; i < favChannels.length; i++) box.appendChild(channelRow(favChannels[i], null));
      el.content.appendChild(box);
    }
    var s1 = shelf('Filme', favMovies, function (m) {
      return card(m.title, m.posterURL, function () { openMovie(m); });
    });
    if (s1) el.content.appendChild(s1);
    var s2 = shelf('Serien', favSeries, function (s) {
      return card(s.title, s.posterURL, function () { openSeries(s); });
    });
    if (s2) el.content.appendChild(s2);

    var listItems = listMoviesFav.concat(listSeriesFav);
    var s3 = shelf('Meine Liste', listItems, function (it) {
      return card(it.title, it.posterURL, function () {
        if (it.episodes !== undefined) openSeries(it); else openMovie(it);
      });
    });
    if (s3) el.content.appendChild(s3);
  }

  // ---- Detailseiten ----

  function backButton() {
    return button('‹ Zurück', function () { ansichtZurueck(); }, true);
  }

  function detailHeader(title, backdrop, metaText) {
    var head = element('div', 'detail-head');
    var bd = element('div', 'detail-backdrop');
    if (backdrop) {
      var img = document.createElement('img');
      img.src = bildAdresse(backdrop, true);   // Backdrop darf größer sein
      img.onerror = function () { img.style.display = 'none'; };
      bd.appendChild(img);
    }
    var scrim = element('div', 'scrim');
    var d = designById(state.settings.design);
    var rgb = hexToRgba(d.bg, 1).replace('rgba(', '').replace(')', '').split(',');
    var base = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    scrim.style.background =
      'linear-gradient(to bottom, rgba(' + base + ',0) 24%, rgba(' + base + ',0.55) 58%,' +
      'rgba(' + base + ',0.92) 82%, rgba(' + base + ',1) 100%)';
    bd.appendChild(scrim);

    /*
     * Titel und Metazeile liegen IM Bild, getragen vom Verlauf. Vorher endete
     * das Backdrop mit einer harten Kante und der Titel stand darunter – das
     * Bild wirkte wie eine Briefmarke, und unterhalb blieb kaum Platz fuer
     * Beschreibung und Aktionen (der Abspiel-Knopf lag bei 959 von 1080 px).
     */
    var textbox = element('div', 'detail-textbox');
    textbox.appendChild(element('h2', 'detail-title', title));
    if (metaText) textbox.appendChild(element('div', 'detail-meta', metaText));
    bd.appendChild(textbox);

    head.appendChild(bd);
    return head;
  }

  /**
   * Ansicht wechseln und die vorherige merken. Ohne das verwarf ein Zurueck
   * aus einem Suchtreffer die ganze Suche – auf einer Bildschirmtastatur ist
   * eine Eingabe teuer, und man musste sie nach jedem angesehenen Treffer neu
   * tippen.
   */
  function vorherigeAnsicht() {
    var v = state.view;
    if (!v) return null;
    if (v.type === 'search') return { type: 'search', query: v.query };
    if (v.type === 'guide') return { type: 'guide' };
    return v.zurueck || null;   // aus einer Detailseite die Ebene darunter erben
  }

  function ansichtZurueck() {
    var ziel = state.view && state.view.zurueck;
    state.view = ziel || null;
    render();
  }

  /** Jahreszahl aus „2019-04-25", „2019" oder einer Zahl herausziehen. */
  function jahrAus(wert) {
    if (!wert) return null;
    var m = String(wert).match(/(19|20)\d{2}/);
    return m ? Number(m[0]) : null;
  }

  function openMovie(movie) {
    if (!movie.xtreamStreamID && state.source && state.source.kind === 'xtream') {
      movie.xtreamStreamID = nummerAusId(movie.id);
    }
    state.view = { type: 'movie', item: movie, zurueck: vorherigeAnsicht() };
    render();
    // Xtream liefert Beschreibung/Backdrop erst auf Nachfrage.
    if (state.source.kind === 'xtream' && movie.xtreamStreamID && !movie._detailsTried) {
      movie._detailsTried = true;
      var url = Core.xtreamApi(state.source.host, state.source.user, state.source.pass,
        'get_vod_info', { vod_id: movie.xtreamStreamID });
      httpGetJson(url, function (err, json) {
        if (err || !json || !json.info) {
          /*
           * Merker zuruecknehmen und Bescheid sagen: Vorher hatte ein einzelner
           * Netzaussetzer zur Folge, dass der Film fuer den Rest der Sitzung
           * ohne Beschreibung blieb – ohne jeden Hinweis und ohne zweiten
           * Versuch.
           */
          movie._detailsTried = false;
          if (state.view && state.view.item === movie) {
            toast('Details konnten nicht geladen werden. Detailseite erneut öffnen ' +
              'versucht es noch einmal.', 6000);
          }
          return;
        }
        var info = json.info;
        movie.plot = info.plot || info.description || movie.plot;
        movie.posterURL = movie.posterURL || info.movie_image;
        movie.backdropURL = (info.backdrop_path && info.backdrop_path.length)
          ? (typeof info.backdrop_path === 'string' ? info.backdrop_path : info.backdrop_path[0])
          : null;
        movie.durationSeconds = parseFloat(info.duration_secs) || null;
        movie.genre = info.genre || null;
        movie.cast = info.cast || info.actors || null;
        movie.director = info.director || null;
        // Das Jahr wurde nie ausgewertet: Es fehlte auf jeder Detailseite, und
        // die Sortierung „Jahr" verglich durchgehend -1 mit -1.
        movie.year = movie.year || jahrAus(info.releasedate || info.releaseDate || info.year);
        if (state.view && state.view.item === movie) render();
      });
    }
  }

  /** Kategorie-Kennung zu einem Namen finden (fuer Nachladen aus Detailseiten). */
  function katIdFuerName(name) {
    for (var i = 0; i < state.vodKategorien.length; i++) {
      if (state.vodKategorien[i].name === name) return state.vodKategorien[i].id;
    }
    return null;
  }

  function renderMovieDetail(m) {
    el.content.appendChild(backButton());

    var meta = [];
    if (m.year) meta.push(m.year);
    if (m.durationSeconds) meta.push(durationText(m.durationSeconds));
    if (m.rating) meta.push('★ ' + Number(m.rating).toFixed(1));
    if (m.genre) meta.push(m.genre);
    el.content.appendChild(detailHeader(m.title, m.backdropURL || m.posterURL, meta.join('   ·   ')));

    var resume = state.progress[m.id];
    var actions = element('div', 'detail-actions');
    var canResume = resume && resume.duration > 0 && resume.position > 30 &&
      (resume.position / resume.duration) < 0.95;
    // Der Abspiel-Knopf ist das Erstziel: Wer eine Detailseite oeffnet, will in
    // aller Regel genau das – und soll nur noch OK druecken muessen.
    if (canResume) {
      var weiter = button('▶ Weiter ab ' + durationText(resume.position), function () {
        var u1 = streamUrlOf(m);
        if (!u1) return toast('Für diesen Titel liegt keine Abspieladresse vor.', 6000);
        playItem(m.title, u1, m.group, 'movie', m.id, resume.position, null,
          { image: m.posterURL, group: m.group, ext: m.ext });
      });
      weiter.setAttribute('data-erstziel', '1');
      actions.appendChild(weiter);
      actions.appendChild(button('Von vorn', function () {
        var u2 = streamUrlOf(m);
        if (!u2) return toast('Für diesen Titel liegt keine Abspieladresse vor.', 6000);
        playItem(m.title, u2, m.group, 'movie', m.id, 0, null,
          { image: m.posterURL, group: m.group, ext: m.ext });
      }, true));
    } else {
      var ab = button('▶ Abspielen', function () {
        // Vorher oeffnete sich der Player mit leerer Adresse und meldete dann
        // „Stream laesst sich nicht abspielen" – die falsche Diagnose.
        var u = streamUrlOf(m);
        if (!u) return toast('Für diesen Titel liegt keine Abspieladresse vor.', 6000);
        playItem(m.title, u, m.group, 'movie', m.id, 0, null,
          { image: m.posterURL, group: m.group, ext: m.ext });
      });
      ab.setAttribute('data-erstziel', '1');
      actions.appendChild(ab);
    }
    actions.appendChild(button(isFavorite(m.id) ? '★ Favorit' : '☆ Favorit', function () {
      toggleFavorite(m.id, m); render();
    }, true, 'fav'));
    actions.appendChild(button(onWatchlist(m.id) ? '✓ Auf meiner Liste' : '+ Meine Liste', function () {
      toggleWatchlist(m.id, m); render();
    }, true, 'merk'));
    el.content.appendChild(actions);

    if (m.plot) el.content.appendChild(element('div', 'detail-plot', m.plot));
    if (m.director) el.content.appendChild(element('div', 'detail-meta', 'Regie: ' + m.director));
    if (m.cast) el.content.appendChild(element('div', 'detail-meta', 'Besetzung: ' + m.cast));

    // Ähnliche Titel aus derselben Kategorie.
    // Schleife mit Abbruch: `.filter()` lief über alle 142.000 Titel, obwohl
    // nur 20 gezeigt werden.
    var similar = [];
    /*
     * Im Lazy-Modus ist der Pool nur der Zwischenspeicher. Ist die Kategorie
     * des Films nicht (mehr) darin – etwa weil er aus der Suche oder dem
     * Verlauf kam –, wird sie im Hintergrund geholt; das Regal erscheint dann
     * beim naechsten Aufbau, statt dauerhaft zu fehlen.
     */
    var kandidaten = state.lazyKatalog ? geladeneFilme() : state.library.movies;
    if (state.lazyKatalog && m.group && !kandidaten.length) {
      var katID = katIdFuerName(m.group);
      if (katID && !state.katalogLaedt) {
        katalogLaden('m', katID, m.group, function () {
          if (state.view && state.view.item === m) render();
        });
      }
    }
    for (var si = 0; si < kandidaten.length && similar.length < 20; si++) {
      var cand = kandidaten[si];
      if (cand.group === m.group && cand.id !== m.id) similar.push(cand);
    }
    var s = shelf('Ähnliche Titel', similar, function (x) {
      return card(x.title, x.posterURL, function () { openMovie(x); });
    });
    if (s) el.content.appendChild(s);
  }

  /** Xtream-Nummer aus der Kennung holen, falls der Eintrag sie nicht traegt. */
  function nummerAusId(id) {
    var teile = String(id || '').split('|');
    var letzter = teile[teile.length - 1];
    return /^\d+$/.test(letzter) ? letzter : null;
  }

  function openSeries(series) {
    // Aus dem Merker gebaute Eintraege haben die Nummer evtl. nicht dabei –
    // ohne sie brach der Abruf ab und die Seite meldete dauerhaft „Keine Folgen".
    if (!series.xtreamSeriesID && state.source && state.source.kind === 'xtream') {
      series.xtreamSeriesID = nummerAusId(series.id);
    }
    state.view = { type: 'series', item: series, season: null, zurueck: vorherigeAnsicht() };
    // `_folgenGeholt` statt nur der Laenge: Eine Serie, fuer die das Panel
    // nichts liefert, loeste sonst bei JEDEM Oeffnen einen neuen Abruf samt
    // Vollbild-Spinner aus.
    if ((series.episodes && series.episodes.length) || series._folgenGeholt) { render(); return; }
    if (state.source.kind !== 'xtream' || !series.xtreamSeriesID) { render(); return; }

    state.loading = true;
    // Sonst stand hier „Bibliothek wird geladen …“ – der Nutzer hat aber
    // eine Serie angetippt, nicht die Bibliothek neu geladen.
    state.loadingStep = 'Folgen werden geladen …'; render();
    var url = Core.xtreamApi(state.source.host, state.source.user, state.source.pass,
      'get_series_info', { series_id: series.xtreamSeriesID });
    httpGetJson(url, function (err, json) {
      state.loading = false;
      state.loadingStep = null;
      if (!err && json) {
        series._folgenGeholt = true;   // auch bei null Folgen: nicht erneut fragen
        series.episodes = Core.parseEpisodes(json, state.source.host,
          state.source.user, state.source.pass, series.id);
        bibliothekGeaendert();   // die Folgen gehoeren jetzt in den Index
        if (json.info) {
          series.plot = series.plot || json.info.plot;
          series.backdropURL = (json.info.backdrop_path && json.info.backdrop_path.length)
            ? (typeof json.info.backdrop_path === 'string' ? json.info.backdrop_path : json.info.backdrop_path[0])
            : null;
        }
      } else {
        // Bei einem Fehler NICHT merken – ein zweiter Versuch soll moeglich sein.
        toast('Die Folgen kamen nicht an' + (err ? ' (' + err.message + ')' : '') +
          '. Prüfe die Internetverbindung und öffne die Serie noch einmal.', 7000);
      }
      render();
    });
  }

  /**
   * Startposition einer Folge – frisch gelesen und mit derselben 95-%-Regel
   * wie bei Filmen. Vorher wurde der Stand beim Aufbau eingefangen und ohne
   * Schwelle benutzt: Eine zu Ende gesehene Folge sprang ans Ende und damit
   * sofort in die naechste, und nach der Rueckkehr aus dem Player galt noch
   * der alte Wert.
   */
  function folgeStart(id) {
    var p = state.progress[id];
    if (!p || !(p.duration > 0)) return 0;
    if (p.position <= 30) return 0;
    if ((p.position / p.duration) >= 0.95) return 0;
    return p.position;
  }

  function renderSeriesDetail(s) {
    el.content.appendChild(backButton());
    el.content.appendChild(detailHeader(s.title, s.backdropURL || s.posterURL,
      s.episodes.length + ' Folgen' + (s.rating ? '   ·   ★ ' + Number(s.rating).toFixed(1) : '')));

    var actions = element('div', 'detail-actions');
    actions.appendChild(button(isFavorite(s.id) ? '★ Favorit' : '☆ Favorit', function () {
      toggleFavorite(s.id, s); render();
    }, true, 'fav'));
    actions.appendChild(button(onWatchlist(s.id) ? '✓ Auf meiner Liste' : '+ Meine Liste', function () {
      toggleWatchlist(s.id, s); render();
    }, true, 'merk'));
    el.content.appendChild(actions);

    if (s.plot) el.content.appendChild(element('div', 'detail-plot', s.plot));

    if (!s.episodes.length) {
      renderEmpty('Keine Folgen', 'Für diese Serie wurden keine Folgen gefunden.');
      return;
    }

    // Staffeln als Chips, wenn es mehr als eine gibt.
    var seasons = [], seen = {};
    for (var i = 0; i < s.episodes.length; i++) {
      var n = s.episodes[i].season;
      if (!seen[n]) { seen[n] = true; seasons.push(n); }
    }
    seasons.sort(function (a, b) { return a - b; });
    var current = state.view.season !== null ? state.view.season : seasons[0];

    if (seasons.length > 1) {
      var chips = element('div', 'chips');
      for (var j = 0; j < seasons.length; j++) {
        (function (n) {
          var c = element('span', 'chip focusable' + (n === current ? ' active' : ''), 'Staffel ' + n);
          c.tabIndex = 0;
          c.setAttribute('data-fkey', 'season:' + n);
          c.onclick = function () { state.view.season = n; render(); };
          chips.appendChild(c);
        })(seasons[j]);
      }
      el.content.appendChild(chips);
    }

    var box = document.createElement('div');
    var eps = s.episodes.filter(function (e) { return e.season === current; });
    for (var k = 0; k < eps.length; k++) {
      (function (ep) {
        var row = element('div', 'channel focusable');
        row.tabIndex = 0;
        var thumb = element('div', 'logo');
        if (ep.imageURL) {
          var img = document.createElement('img');
          img.className = 'logo';
          img.setAttribute('data-src', bildAdresse(ep.imageURL));
          img.onerror = function () { img.style.visibility = 'hidden'; };
          lazyBildAnmelden(img);
          thumb = img;
        }
        row.appendChild(thumb);
        var info = element('div', 'info');
        var label = 'S' + two(ep.season) + 'E' + two(ep.episode);
        info.appendChild(element('div', 'name', label + '   ' + ep.title));
        var p = state.progress[ep.id];
        if (ep.durationSeconds) info.appendChild(element('div', 'sub', durationText(ep.durationSeconds)));
        if (p && p.duration > 0) info.appendChild(progressBar(p.position / p.duration));
        row.appendChild(info);
        row.onclick = function () {
          playItem(s.title + ' · ' + label, streamUrlOf(ep), ep.title, 'episode', ep.id,
            folgeStart(ep.id), { series: s, episode: ep },
            { image: ep.imageURL || s.posterURL, group: s.group, ext: ep.ext });
        };
        box.appendChild(row);
      })(eps[k]);
    }
    el.content.appendChild(box);
  }

  // ---- Suche ----

  function renderSearch() {
    el.content.appendChild(backButton());
    var panel = element('div', 'panel');
    panel.appendChild(element('h2', null, 'Suche'));
    var input = element('input', 'focusable');
    input.type = 'text';
    input.placeholder = 'Film, Serie oder Sender …';
    input.value = state.view.query || '';
    // Hier ist das Feld der Zweck der Seite – anders als bei der
    // Kategorienliste soll die Bildschirmtastatur also aufgehen.
    input.setAttribute('data-erstziel', '1');
    input.setAttribute('data-fkey', 'suchfeld');
    // Mitschreiben, ohne neu zu zeichnen: Wird waehrend des Tippens neu
    // aufgebaut (z. B. weil das Titelverzeichnis fertig wird), war das
    // Getippte sonst weg und die Bildschirmtastatur klappte zu.
    input.oninput = function () { state.view.query = input.value; };
    input.onkeyup = input.oninput;   // manche TV-Tastaturen liefern kein input
    panel.appendChild(input);
    var go = button('Suchen', function () {
      state.view.query = input.value;
      render();
    });
    panel.appendChild(go);
    el.content.appendChild(panel);

    // Trimmen: Die webOS-Tastatur haengt bei Wortvorschlaegen ein Leerzeichen
    // an, und „film " fand dann nichts.
    var q = (state.view.query || '').replace(/^\s+|\s+$/g, '').toLowerCase();
    if (q.length < 2) {
      // Der Knopf fuer das Titelverzeichnis gehoert hierher, nicht erst hinter
      // eine magere Trefferliste – so laesst er sich vor der Suche vorbereiten.
      if (state.lazyKatalog) el.content.appendChild(indexHinweis());
      return;
    }

    // Suche mit Abbruch bei 30 Treffern statt drei Voll-Scans über 215.000
    // Titel mit je einem neuen Kleinbuchstaben-String.
    function search(list, field, limit) {
      var out = [];
      for (var i = 0; i < list.length && out.length < limit; i++) {
        var text = list[i][field];
        if (text && text.toLowerCase().indexOf(q) >= 0) out.push(list[i]);
      }
      return out;
    }

    /*
     * Die Suche bricht je Sparte bei 30 Treffern ab – ein Volltreffer-Scan
     * ueber 142.000 Titel je Tastendruck waere zu teuer. Das muss man sagen,
     * sonst haelt man die uebrigen Treffer fuer nicht vorhanden.
     */
    function spartenTitel(name, treffer, grenze) {
      return treffer.length >= grenze ? name + ' · erste ' + grenze : name;
    }
    var ch = search(state.library.channels, 'name', 30);
    var mv, sr;
    if (state.lazyKatalog) {
      // Filme liegen nicht mehr komplett im Speicher. Gesucht wird in dem, was
      // geladen ist – und, wenn der Nutzer ihn zugeschaltet hat, im schlanken
      // Titelindex über den ganzen Katalog.
      mv = state.filmIndex ? indexSuche(q, 30) : search(geladeneFilme(), 'title', 30);
      sr = search(geladeneSerien(), 'title', 30);
    } else {
      mv = search(state.library.movies, 'title', 30);
      sr = search(state.library.series, 'title', 30);
    }

    if (state.lazyKatalog) el.content.appendChild(indexHinweis());

    if (!ch.length && !mv.length && !sr.length) {
      el.content.appendChild(element('div', 'section-title', 'Keine Treffer'));
      el.content.appendChild(element('div', 'detail-meta',
        'Für „' + state.view.query + '“ wurde nichts gefunden.'));
      return;
    }
    if (ch.length) {
      el.content.appendChild(element('div', 'section-title', spartenTitel('Sender', ch, 30)));
      var box = document.createElement('div');
      for (var i = 0; i < ch.length; i++) box.appendChild(channelRow(ch[i], null));
      el.content.appendChild(box);
    }
    var s1 = shelf(spartenTitel('Filme', mv, 30), mv, function (m) {
      return card(m.title, m.posterURL, function () { openMovie(m); }, false, m.id);
    });
    if (s1) el.content.appendChild(s1);
    var s2 = shelf(spartenTitel('Serien', sr, 30), sr, function (s) {
      return card(s.title, s.posterURL, function () { openSeries(s); }, false, s.id);
    });
    if (s2) el.content.appendChild(s2);
  }

  /**
   * Der Suchindex ist bewusst freiwillig: Er kostet rund 13 MB Speicher,
   * dafür findet die Suche wieder jeden der 142.000 Filmtitel statt nur die
   * der geöffneten Kategorien.
   */
  function indexHinweis() {
    /*
     * Sobald das Verzeichnis steht, ist das eine reine Statusmeldung – die
     * bekommt eine schmale Zeile statt eines Panels. Als Panel schob sie die
     * Trefferliste unter den sichtbaren Bereich, und man sah nach dem Suchen
     * zuerst Weissraum.
     */
    if (state.indexLaedt) {
      /*
       * Mit Spinner: Der Aufbau dauert rund 15 Sekunden. Vorher verschwand der
       * Knopf und es stand nur eine schmale Zeile da – der Nutzer sah Stille
       * und drueckte irgendwann OK auf „Zurueck".
       */
      var laden = element('div', 'such-status-zeile');
      laden.appendChild(element('div', 'spinner klein'));
      laden.appendChild(element('div', 'such-status',
        'Titelverzeichnis wird aufgebaut – das dauert etwa 15 Sekunden.'));
      return laden;
    }
    if (state.filmIndex) {
      var box = element('div', 'such-status-zeile');
      box.appendChild(element('div', 'such-status',
        'Alle ' + state.filmIndex.length + ' Filme durchsuchbar.'));
      // Ein Verzeichnis kann unbrauchbar entstehen (verpackte Antwort,
      // abgebrochene Verbindung). Ohne diesen Knopf blieb es bis zum
      // App-Neustart bestehen und die Suche fand praktisch nichts.
      box.appendChild(button('Neu aufbauen', function () {
        state.filmIndex = null;
        filmIndexAufbauen();
      }, true, 'indexneu'));
      return box;
    }
    var box = element('div', 'panel');
    box.appendChild(element('div', 'detail-meta',
      'Gesucht wird gerade nur in den geöffneten Kategorien. Das Titelverzeichnis ' +
      'macht alle Filme durchsuchbar; es kostet einmalig etwa 15 Sekunden und ' +
      'rund 13 MB Speicher.'));
    box.appendChild(button('Alle Filme durchsuchbar machen', function () {
      // Fokus vorbelegen: Der Knopf loest sich beim Aufbau auf, der Merker
      // liefe sonst ins Leere und der Fokus spraenge auf „Zurueck".
      focusWuenschen('suchfeld');
      filmIndexAufbauen();
    }, true, 'indexbauen'));
    return box;
  }

  /**
   * Titelindex holen. Absichtlich OHNE JSON.parse: Der Objektgraph des vollen
   * Katalogs belegte rund 50 MB, der Regex-Scan über den Antworttext liefert
   * dasselbe für 13 MB (auf dem Gerät gemessen: 142.246 Titel, 5 s laden,
   * 2 s auswerten).
   */
  function filmIndexAufbauen() {
    var src = state.source;
    if (!src || src.kind !== 'xtream' || state.indexLaedt) return;
    // Ohne Kategorienliste liesse sich nicht entscheiden, was gesperrt ist –
    // dann lieber kein Verzeichnis als eines, das die Sperren umgeht.
    if (!state.vodKategorien.length) {
      toast('Ohne Kategorienliste lässt sich kein Titelverzeichnis aufbauen. ' +
        'In den Einstellungen „Neu laden“ versuchen.', 8000);
      return;
    }
    state.indexLaedt = true;
    render();

    var url = Core.xtreamApi(src.host, src.user, src.pass, 'get_vod_streams');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 120000;
    xhr.onload = function () {
      var eintraege = null;
      var laenge = (xhr.responseText || '').length;
      try {
        eintraege = Core.scanVodIndex(xhr.responseText);
      } catch (e) {
        eintraege = null;
      }
      xhr.onload = null;
      state.indexLaedt = false;
      /*
       * Plausibilitaet: Eine verpackte Antwort ({"movie_data":[…]}) oder eine
       * abgebrochene Verbindung ergibt einen oder wenige Eintraege bei einer
       * megabytegrossen Antwort. Das als Erfolg zu melden, machte die Suche
       * stillschweigend nutzlos.
       */
      var zuKlein = eintraege && eintraege.length < 10 && laenge > 1000000;
      if (!eintraege || !eintraege.length || zuKlein) {
        toast('Titelverzeichnis konnte nicht gelesen werden – die Antwort des ' +
          'Anbieters hat ein unerwartetes Format.', 8000);
      } else {
        state.filmIndex = eintraege;
        toast(eintraege.length + ' Filmtitel durchsuchbar.');
      }
      // Nur zeichnen, wenn die Suche noch offen ist: Sonst riss der Aufbau den
      // Nutzer aus der Ansicht, in der er inzwischen war.
      if (state.view && state.view.type === 'search') render();
    };
    xhr.onerror = function () {
      state.indexLaedt = false;
      toast('Titelverzeichnis konnte nicht geladen werden. Prüfe die ' +
        'Internetverbindung und versuch es noch einmal.', 8000);
      if (state.view && state.view.type === 'search') render();
    };
    xhr.ontimeout = xhr.onerror;
    // Ohne onabort bliebe `indexLaedt` haengen, wenn die Plattform die Anfrage
    // abbricht (App in den Hintergrund, Netzwechsel) – der Knopf kaeme nie wieder.
    xhr.onabort = xhr.onerror;
    xhr.send();
  }

  /** Im Titelindex suchen; das Ergebnis sieht aus wie ein Filmeintrag. */
  function indexSuche(q, limit) {
    var out = [], idx = state.filmIndex;
    if (!idx) return out;
    // Prototypfrei: Sonst ist katName['constructor'] wahr und eine so
    // benannte Kategorie gaelte als bekannt – der Schutz unten fiele aus.
    var katName = Object.create(null);
    for (var c = 0; c < state.vodKategorien.length; c++) {
      katName[state.vodKategorien[c].id] = state.vodKategorien[c].name;
    }
    // Einmal vor der Schleife: sonst je Treffer neu gebaut.
    var gewaehlteSprachen = null;
    if (state.settings.languages.length) {
      gewaehlteSprachen = {};
      for (var sp = 0; sp < state.settings.languages.length; sp++) {
        gewaehlteSprachen[state.settings.languages[sp]] = true;
      }
    }
    // Sprachfilter, ausgeblendete und gesperrte Kategorien gelten auch hier –
    // sonst wäre die Suche ein Weg an der Kindersicherung vorbei.
    for (var i = 0; i < idx.length && out.length < limit; i++) {
      var e = idx[i];
      if (e.t.toLowerCase().indexOf(q) < 0) continue;
      /*
       * Eine Kategorie, die die Kategorienliste nicht kennt, gilt als GESPERRT.
       * Vorher fiel sie auf „Allgemein" – ein Name, der nie in den Sperrlisten
       * steht. Panels, die ihre 18+-Rubrik aus `get_vod_categories` heraushalten
       * (aber in `get_vod_streams` mitliefern), und ein fehlgeschlagener Abruf
       * der Kategorienliste hebelten damit die Kindersicherung aus.
       */
      var gruppe = katName[e.c];
      if (!gruppe || !kategorieErlaubt(gruppe)) continue;
      if (gewaehlteSprachen) {
        /*
         * Direkt rechnen statt ueber filterByLanguage: Dessen Sicherheitsnetz
         * („ist ueberhaupt etwas erkennbar?") bezieht sich auf die ganze
         * Liste. Mit einer Ein-Element-Liste war es immer dann erfuellt, wenn
         * genau dieser Titel keine Sprache preisgibt – der Eintrag rutschte
         * dann auch im strikten Modus durch.
         */
        var lang = Core.detectLanguage(gruppe + ' ' + e.t);
        // Unerkannte Titel fallen nur im strengen Modus weg.
        if (lang === null ? state.settings.strict === 'streng' : !gewaehlteSprachen[lang]) continue;
      }
      out.push({
        id: 'xtream|m|' + e.s,
        title: e.t,
        posterURL: e.p || '',
        group: gruppe,
        sid: e.s,
        art: 'movie',
        ext: e.e || 'mp4',
        // Ohne dieses Feld holt `openMovie` keine Details – Suchtreffer haetten
        // dauerhaft keine Beschreibung, kein Backdrop und keine Besetzung.
        xtreamStreamID: e.s
      });
    }
    return out;
  }

  // ---- Programmführer ----

  function renderGuide() {
    el.content.appendChild(backButton());
    var withEpg = state.library.channels.filter(function (c) {
      var p = programsFor(c);
      return p && p.length;
    });
    if (!withEpg.length) {
      return renderEmpty('Kein Programmführer',
        'Diese Quelle liefert keine EPG-Daten (XMLTV).');
    }
    el.content.appendChild(element('div', 'section-title', withEpg.length > 100
      ? 'Jetzt und danach · 100 von ' + withEpg.length + ' Sendern'
      : 'Jetzt und danach'));
    var box = document.createElement('div');
    for (var i = 0; i < withEpg.length && i < 100; i++) {
      (function (ch) {
        var programs = programsFor(ch);
        var now = Core.nowProgram(programs);
        var next = Core.nextProgram(programs);
        var row = element('div', 'channel focusable' + (now ? ' on-air' : ''));
        row.tabIndex = 0;
        // Wie in der Senderliste: Ohne Merker sprang der Fokus nach der blauen
        // Taste an den Anfang – dieselbe Geste, zwei Verhalten.
        row.setAttribute('data-fkey', 'guide:' + ch.id);
        if (ch.logoURL) {
          var img = document.createElement('img');
          img.className = 'logo';
          img.setAttribute('data-src', bildAdresse(ch.logoURL));
          img.onerror = function () { img.style.visibility = 'hidden'; };
          lazyBildAnmelden(img);
          row.appendChild(img);
        } else row.appendChild(element('div', 'logo'));
        var info = element('div', 'info');
        info.appendChild(element('div', 'name', ch.name));
        if (now) {
          info.appendChild(element('div', 'sub',
            timeText(now.start) + '–' + timeText(now.end) + '   ' + now.title));
          var span = now.end - now.start;
          info.appendChild(progressBar(span > 0 ? (Date.now() - now.start) / span : 0));
        }
        if (next) {
          info.appendChild(element('div', 'sub', 'danach ' + timeText(next.start) + '   ' + next.title));
        }
        row.appendChild(info);
        row.onclick = function () { playChannel(ch); };
        row._favTarget = ch.id; row._favItem = ch; row._favItem = ch;
        box.appendChild(row);
      })(withEpg[i]);
    }
    el.content.appendChild(box);
  }

  // ---- Einstellungen ----

  /**
   * Quelle für die Anzeige unkenntlich machen.
   *
   * M3U-Adressen von Panels enthalten Benutzer und Passwort als Parameter –
   * ungekürzt stand das Passwort gut lesbar auf dem Fernsehbildschirm und auf
   * jedem Foto davon.
   */
  function maskSource(src) {
    if (src.kind === 'xtream') return src.host + '  (Benutzer: ' + maskValue(src.user) + ')';
    var url = src.m3u || '';
    return url
      .replace(/([?&](?:username|user|password|pass)=)([^&]*)/gi, function (all, key, value) {
        return key + maskValue(decodeURIComponent(value));
      })
      .slice(0, 90);
  }

  function maskValue(v) {
    v = String(v || '');
    if (v.length <= 2) return '***';
    return v.slice(0, 2) + '***';
  }


  /**
   * Kategorie-Wähler mit Suchfeld.
   *
   * Bei Playlisten dieser Größe hat ein Anbieter hunderte bis tausende
   * Kategorien. Eine harte Deckelung auf die ersten 80 hieß: Alles alphabetisch
   * dahinter war unerreichbar – ausgerechnet die 18+-Kategorien, die typisch
   * „XXX …" heißen, ließen sich damit nie sperren.
   *
   * Das Suchfeld baut NUR die Chipliste neu auf, nicht die ganze Seite: Ein
   * `render()` je Tastendruck würde den Fokus aus dem Feld reißen und die
   * Bildschirmtastatur schließen.
   */
  /** Chip mit einem bestimmten Fokusschluessel in einem Behaelter finden. */
  function chipMitSchluessel(behaelter, key) {
    var nodes = behaelter.querySelectorAll('[data-fkey]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-fkey') === key) return nodes[i];
    }
    return null;
  }

  function categoryPicker(gruppen, istGewaehlt, onToggle, praefix, marke) {
    var wrap = document.createElement('div');
    var feld = element('input', 'focusable');
    feld.type = 'text';
    feld.placeholder = 'Kategorie suchen';
    // Eigener Namensraum: sonst zählt das Feld bei den Chips mit.
    feld.setAttribute('data-fkey', 'suchfeld-' + praefix);
    wrap.appendChild(feld);

    var liste = element('div', 'chips');
    var hinweis = element('div', 'detail-meta', '');
    var MAX = 60;

    function fuellen() {
      clear(liste);
      var q = feld.value.replace(/^\s+|\s+$/g, '').toLowerCase();
      var treffer = 0, gezeigt = 0;
      for (var i = 0; i < gruppen.length; i++) {
        var name = gruppen[i];
        if (q && name.toLowerCase().indexOf(q) < 0) continue;
        treffer++;
        if (gezeigt >= MAX) continue;
        gezeigt++;
        (function (n) {
          var an = istGewaehlt(n);
          var c = element('span', 'chip focusable' + (an ? ' active' : ''), (an ? marke + ' ' : '') + n);
          c.tabIndex = 0;
          c.setAttribute('data-fkey', praefix + ':' + n);
          c.onclick = function () {
            onToggle(n);
            /*
             * `fuellen()` baut die Chipliste neu – samt dem gerade geklickten
             * Chip. Ohne Merker landete der Fokus danach auf <body>, und der
             * naechste Pfeiltastendruck sprang an den Anfang der langen
             * Einstellungsseite: Nach JEDER gesperrten Kategorie neu
             * hinunterhangeln.
             */
            var key = praefix + ':' + n;
            fuellen();
            var neuerChip = chipMitSchluessel(liste, key);
            if (neuerChip) { neuerChip.focus(); revealFocus(neuerChip); }
          };
          liste.appendChild(c);
        })(name);
      }
      if (!treffer) {
        hinweis.textContent = q
          ? 'Keine Kategorie enthält „' + feld.value + '“.'
          : 'Keine Kategorien geladen.';
      } else if (treffer > gezeigt) {
        hinweis.textContent = gezeigt + ' von ' + treffer +
          ' Treffern gezeigt – Suche eingrenzen, um die übrigen zu erreichen.';
      } else {
        hinweis.textContent = treffer + ' von ' + gruppen.length + ' Kategorien.';
      }
    }

    /*
     * Beide Ereignisse haengen dran, weil `oninput` auf manchen TV-Tastaturen
     * ausbleibt. Da meist BEIDE feuern, baute die Liste je Anschlag zweimal
     * neu auf – bei 1140 Kategorien spuerbar. Der Merker verhindert das.
     */
    var letzterWert = null;
    function beiEingabe() {
      if (feld.value === letzterWert) return;
      letzterWert = feld.value;
      fuellen();
    }
    feld.oninput = beiEingabe;
    feld.onkeyup = beiEingabe;
    fuellen();

    wrap.appendChild(liste);
    wrap.appendChild(hinweis);
    return wrap;
  }

  function renderSettings() {
    el.content.appendChild(backButton());
    var panel = element('div', 'panel');
    panel.appendChild(element('h2', null, 'Einstellungen'));

    var src = state.source;
    panel.appendChild(element('p', null, src
      ? ('Aktuelle Quelle: ' + maskSource(src))
      : 'Keine Quelle eingerichtet.'));

    // Downloads sind auf diesem Gerät nicht möglich – das gehört gesagt,
    // statt einen Knopf anzubieten, der nichts tut.
    panel.appendChild(element('div', 'section-title', 'Downloads'));
    panel.appendChild(element('p', null,
      'Auf dem Fernseher nicht verfügbar: LG lässt den Download-Dienst nur für ' +
      'signierte Apps zu (geprüft – der Aufruf wird abgelehnt), und der Browser-' +
      'Speicher reicht für Filme ohnehin nicht. Am Fernseher, der ohnehin am Netz ' +
      'hängt, bringt Offline auch wenig – auf iPhone und Quest gibt es die Funktion.'));

    // Modell und Firmware nennen, damit bei einer Rückfrage klar ist, worauf
    // die App läuft (LG unterscheidet sich je Baujahr erheblich).
    var geraet = element('p', null, 'Gerät wird ermittelt …');
    panel.appendChild(geraet);
    if (typeof webOS !== 'undefined' && webOS.deviceInfo) {
      webOS.deviceInfo(function (info) {
        geraet.textContent = 'Gerät: ' + (info.modelName || 'unbekannt') +
          '  ·  webOS ' + (info.sdkVersion || info.version || '?') +
          '  ·  GlassTV ' + APP_VERSION;
      });
    } else {
      geraet.textContent = 'GlassTV ' + APP_VERSION;
    }

    panel.appendChild(element('div', 'section-title', 'Bibliothek'));
    panel.appendChild(element('p', null,
      state.lazyKatalog
        ? (state.library.channels.length + ' Sender · ' + state.vodKategorien.length +
           ' Filmkategorien · ' + state.serienKategorien.length + ' Serienkategorien' +
           (state.filmIndex ? ' · ' + state.filmIndex.length + ' Titel im Verzeichnis' : ''))
        : (state.library.channels.length + ' Sender · ' + state.library.movies.length +
           ' Filme · ' + state.library.series.length + ' Serien')));

    var actions = element('div', 'actions');
    actions.appendChild(button('Statistik', function () {
      state.view = { type: 'stats' }; render();
    }, true));
    actions.appendChild(button('Neu laden', function () {
      state.view = null;
      reloadSource();
    }));
    actions.appendChild(button('Quelle ändern', function () {
      // Alles verwerfen, was zur alten Quelle gehört: Sonst zeigt das EPG des
      // alten Anbieters weiter auf Kanäle des neuen, und eine gewählte
      // Kategorie existiert dort womöglich gar nicht mehr.
      state.source = null; state.view = null;
      state.epg = {}; state.rawLibrary = null;
      state.library = { channels: [], movies: [], series: [] };
      state.group = { live: null, movies: null, series: null };
      render();
    }, true));
    actions.appendChild(button('Favoriten löschen (dieses Profil)', function () {
      state.favorites = {}; saveScoped('favorites', state.favorites);
      toast('Favoriten gelöscht.');
      render();
    }, true));
    actions.appendChild(button('Verlauf löschen (dieses Profil)', function () {
      state.progress = {}; saveScoped('progress', state.progress);
      toast('Verlauf gelöscht.');
      render();
    }, true));
    // Die Merkliste war die einzige Struktur ohne Deckelung UND ohne Notausgang.
    actions.appendChild(button('Meine Liste löschen (dieses Profil)', function () {
      state.watchlist = {}; saveScoped('watchlist', state.watchlist);
      toast('Meine Liste geleert.');
      render();
    }, true));
    panel.appendChild(actions);
    el.content.appendChild(panel);

    // ---- Profile ----
    el.content.appendChild(element('div', 'section-title',
      'Profile (aktiv: ' + profileName(state.activeProfile) + ')'));
    var profileBox = element('div', 'chips umbruch');
    for (var pi = 0; pi < state.profiles.length; pi++) {
      (function (prof) {
        var active = prof.id === state.activeProfile;
        var c = element('span', 'chip focusable' + (active ? ' active' : ''),
          (active ? '● ' : '') + prof.name);
        c.tabIndex = 0;
        c.setAttribute('data-fkey', 'profile:' + prof.id);
        c.onclick = function () { switchProfile(prof.id); render(); };
        profileBox.appendChild(c);
      })(state.profiles[pi]);
    }
    el.content.appendChild(profileBox);

    var profActions = element('div', 'actions');
    profActions.appendChild(button('Profil hinzufügen', function () {
      state.view.addProfile = !state.view.addProfile; render();
    }, true));
    if (state.activeProfile !== 'default') {
      profActions.appendChild(button('Aktives Profil löschen', function () {
        deleteProfile(state.activeProfile);
        render();
      }, true));
    }
    if (state.profiles.length > 1) {
      profActions.appendChild(button('Profil wechseln', function () {
        state.gate = true; state.view = null; render();
      }, true));
    }
    el.content.appendChild(profActions);

    if (state.view.addProfile) {
      var newPanel = element('div', 'panel');
      newPanel.appendChild(element('label', null, 'Name des neuen Profils'));
      var nameInput = element('input', 'focusable');
      newPanel.appendChild(nameInput);
      var newActions = element('div', 'actions');
      newActions.appendChild(button('Anlegen', function () {
        var v = (nameInput.value || '').replace(/^\s+|\s+$/g, '');
        if (!v) return toast('Bitte einen Namen eingeben.');
        var id = addProfile(v);
        state.view.addProfile = false;
        switchProfile(id);
        toast('Profil „' + v + '“ angelegt.');
        render();
      }));
      newPanel.appendChild(newActions);
      el.content.appendChild(newPanel);
    }

    // ---- Design ----
    el.content.appendChild(element('div', 'section-title', 'Design'));
    var designChips = element('div', 'chips umbruch');
    for (var i = 0; i < DESIGNS.length; i++) {
      (function (d) {
        var c = element('span', 'chip focusable' + (state.settings.design === d.id ? ' active' : ''), d.name);
        c.tabIndex = 0;
        c.setAttribute('data-fkey', 'design:' + d.id);
        c.onclick = function () {
          state.settings.design = d.id; save('settings', state.settings);
          applyTheme(); render();
        };
        designChips.appendChild(c);
      })(DESIGNS[i]);
    }
    el.content.appendChild(designChips);

    el.content.appendChild(element('div', 'section-title', 'Akzentfarbe'));
    var accentChips = element('div', 'chips umbruch');
    for (var j = 0; j < ACCENTS.length; j++) {
      (function (a) {
        var c = element('span', 'chip focusable' + (state.settings.accent === a.id ? ' active' : ''), a.name);
        c.tabIndex = 0;
        c.setAttribute('data-fkey', 'accent:' + a.id);
        // Dieselbe Dimmung wie in applyTheme: Die Rohfarbe ist auf hellem
        // Grund nicht zu sehen – ausgerechnet beim Rahmen, an dem man die
        // Farbe erkennen soll.
        c.style.borderColor = aktuellesDesignIstDunkel()
          ? a.color
          : akzentFuerHell(a.color, designById(state.settings.design).bg);
        c.onclick = function () {
          state.settings.accent = a.id; save('settings', state.settings);
          applyTheme(); render();
        };
        accentChips.appendChild(c);
      })(ACCENTS[j]);
    }
    el.content.appendChild(accentChips);

    var themeActions = element('div', 'actions');
    themeActions.appendChild(button('Überrasch mich', function () { shuffleTheme(); render(); }, true));
    el.content.appendChild(themeActions);

    // ---- Sortierung ----
    el.content.appendChild(element('div', 'section-title', 'Sortierung (Filme & Serien)'));
    var sortChips = element('div', 'chips');
    var sorts = [
      { id: 'standard', name: 'Standard' }, { id: 'name', name: 'Name (A–Z)' },
      { id: 'year', name: 'Jahr' }, { id: 'rating', name: 'Bewertung' },
    ];
    for (var k = 0; k < sorts.length; k++) {
      (function (o) {
        var c = element('span', 'chip focusable' + (state.settings.sort === o.id ? ' active' : ''), o.name);
        c.tabIndex = 0;
        c.setAttribute('data-fkey', 'sort:' + o.id);
        c.onclick = function () {
          state.settings.sort = o.id; save('settings', state.settings); render();
        };
        sortChips.appendChild(c);
      })(sorts[k]);
    }
    el.content.appendChild(sortChips);

    // ---- Sprachfilter ----
    el.content.appendChild(element('div', 'section-title', 'Sprachen / Länder'));
    var hint = element('div', 'detail-meta',
      'Keine Auswahl zeigt alles. Ist in einer Liste gar keine Sprache erkennbar, ' +
      'bleibt sie sichtbar – so verschwindet bei einsprachigen Anbietern nichts.');
    el.content.appendChild(hint);
    var langChips = element('div', 'chips');
    var codes = [];
    for (var code in Core.LANG_NAMES) {
      if (Object.prototype.hasOwnProperty.call(Core.LANG_NAMES, code)) codes.push(code);
    }
    for (var m = 0; m < codes.length; m++) {
      (function (code) {
        var on = state.settings.languages.indexOf(code) >= 0;
        var c = element('span', 'chip focusable' + (on ? ' active' : ''),
          (Core.LANG_FLAGS[code] || '') + ' ' + Core.LANG_NAMES[code]);
        c.tabIndex = 0;
        c.setAttribute('data-fkey', 'lang:' + code);
        c.onclick = function () {
          var idx = state.settings.languages.indexOf(code);
          if (idx >= 0) state.settings.languages.splice(idx, 1);
          else state.settings.languages.push(code);
          save('settings', state.settings);
          applyLanguageFilter();
          render();
        };
        langChips.appendChild(c);
      })(codes[m]);
    }
    el.content.appendChild(langChips);

    // Filterstufe als Chips – ein Umschaltknopf verbarg, dass es drei Stufen
    // gibt, und sagte nicht, was sie bedeuten.
    el.content.appendChild(element('div', 'detail-meta', 'Wie streng gefiltert wird'));
    var stufenChips = element('div', 'chips umbruch');
    for (var st = 0; st < SPRACH_STUFEN.length; st++) {
      (function (stufe) {
        var aktiv = state.settings.strict === stufe.id;
        var c = element('span', 'chip focusable' + (aktiv ? ' active' : ''), stufe.name);
        c.tabIndex = 0;
        c.setAttribute('data-fkey', 'stufe:' + stufe.id);
        c.onclick = function () {
          state.settings.strict = stufe.id;
          save('settings', state.settings);
          applyLanguageFilter();
          render();
        };
        stufenChips.appendChild(c);
      })(SPRACH_STUFEN[st]);
    }
    el.content.appendChild(stufenChips);
    // Erklaerung der gewaehlten Stufe – samt der Zahl, um die es geht.
    var aktuelleStufe = SPRACH_STUFEN[1];
    for (var sv = 0; sv < SPRACH_STUFEN.length; sv++) {
      if (SPRACH_STUFEN[sv].id === state.settings.strict) aktuelleStufe = SPRACH_STUFEN[sv];
    }
    var erklaerung = aktuelleStufe.hilfe;
    if (state.rawLibrary) {
      erklaerung += '  Derzeit sichtbar: ' + state.library.channels.length + ' von ' +
        state.rawLibrary.channels.length + ' Sendern.';
    }
    el.content.appendChild(element('div', 'detail-meta', erklaerung));

    // ---- Kategorien ausblenden ----
    var groups = allGroups();
    var kopf = element('div', 'section-title',
      'Kategorien ausblenden (' + state.settings.hiddenGroups.length + ' von ' + groups.length + ')');
    el.content.appendChild(kopf);
    el.content.appendChild(element('div', 'detail-meta',
      'Ohne PIN – reines Aufräumen. Bei großen Playlisten die wirksamste Bremse.'));
    var groupActions = element('div', 'actions');
    groupActions.appendChild(button(
      state.view.showGroups ? 'Liste zuklappen' : 'Kategorien wählen',
      function () { state.view.showGroups = !state.view.showGroups; render(); },
      true, 'kategorienliste'));
    if (state.settings.hiddenGroups.length) {
      groupActions.appendChild(button('Alle wieder zeigen', function () {
        state.settings.hiddenGroups = [];
        save('settings', state.settings); applyLanguageFilter(); render();
      }, true));
    }
    el.content.appendChild(groupActions);

    if (state.view.showGroups) {
      el.content.appendChild(categoryPicker(
        groups,
        function (name) { return state.settings.hiddenGroups.indexOf(name) >= 0; },
        function (name) {
          var idx = state.settings.hiddenGroups.indexOf(name);
          if (idx >= 0) state.settings.hiddenGroups.splice(idx, 1);
          else state.settings.hiddenGroups.push(name);
          save('settings', state.settings);
          applyLanguageFilter();
          // Die Überschrift zeigt die Anzahl – ohne Auffrischen bliebe sie stehen.
          if (kopf) {
            kopf.textContent = 'Kategorien ausblenden (' +
              state.settings.hiddenGroups.length + ' von ' + groups.length + ')';
          }
        },
        'hide', '✕'));
    }

    // ---- Kindersicherung ----
    el.content.appendChild(element('div', 'section-title', 'Kindersicherung'));
    if (!state.settings.pin) {
      el.content.appendChild(element('div', 'detail-meta',
        'Mit PIN lassen sich Kategorien sperren – sie verschwinden dann app-weit, ' +
        'bis hier entsperrt wird.'));
      var pinPanel = element('div', 'panel');
      pinPanel.appendChild(element('label', null, 'Neuer PIN (4–8 Ziffern)'));
      var pinInput = element('input', 'focusable');
      pinInput.type = 'password';
      pinPanel.appendChild(pinInput);
      var pinActions = element('div', 'actions');
      pinActions.appendChild(button('PIN setzen', function () {
        var v = (pinInput.value || '').replace(/[^0-9]/g, '');
        if (v.length < 4) return toast('Bitte 4 bis 8 Ziffern eingeben.');
        state.settings.pin = v;
        state.unlocked = true;
        /*
         * Erfolg pruefen: Bei vollem Speicher wirkte die PIN gesetzt, stand
         * aber nirgends – nach dem Neustart war die Kindersicherung weg. Eine
         * Sperre, die es nur zu glauben gibt, ist schlimmer als keine.
         */
        if (!save('settings', state.settings)) {
          state.settings.pin = null;
          toast('Die PIN konnte nicht gespeichert werden – der Speicher des ' +
            'Fernsehers ist voll. Die Kindersicherung ist NICHT aktiv.', 10000);
        }
        render();
      }));
      pinPanel.appendChild(pinActions);
      el.content.appendChild(pinPanel);
    } else if (!state.unlocked) {
      var lockPanel = element('div', 'panel');
      lockPanel.appendChild(element('h2', null, 'Gesperrt'));
      lockPanel.appendChild(element('p', null, 'PIN eingeben, um die Sperrliste zu ändern.'));
      var check = element('input', 'focusable');
      check.type = 'password';
      lockPanel.appendChild(check);
      var checkActions = element('div', 'actions');
      checkActions.appendChild(button('Entsperren', function () {
        if (check.value === state.settings.pin) {
          state.unlocked = true;
          applyLanguageFilter();
          render();
        } else {
          toast('Falscher PIN.');
          check.value = '';
        }
      }));
      lockPanel.appendChild(checkActions);
      el.content.appendChild(lockPanel);
    } else {
      var lockActions = element('div', 'actions');
      lockActions.appendChild(button('Wieder sperren', function () {
        state.unlocked = false; applyLanguageFilter(); render();
      }, true));
      lockActions.appendChild(button('PIN entfernen', function () {
        state.settings.pin = null;
        state.settings.lockedGroups = [];
        if (!save('settings', state.settings)) {
          toast('Die Änderung konnte nicht gespeichert werden – nach einem ' +
            'Neustart gilt wieder die alte Einstellung.', 9000);
        }
        applyLanguageFilter(); render();
      }, true));
      el.content.appendChild(lockActions);

      var sperrKopf = element('div', 'detail-meta',
        state.settings.lockedGroups.length + ' Kategorien gesperrt.');
      el.content.appendChild(sperrKopf);
      var gs = allGroups();
      el.content.appendChild(categoryPicker(
        gs,
        function (name) { return state.settings.lockedGroups.indexOf(name) >= 0; },
        function (name) {
          var idx = state.settings.lockedGroups.indexOf(name);
          if (idx >= 0) state.settings.lockedGroups.splice(idx, 1);
          else state.settings.lockedGroups.push(name);
          save('settings', state.settings);
          sperrKopf.textContent = state.settings.lockedGroups.length + ' Kategorien gesperrt.';
        },
        'lock', '🔒'));
    }
  }

  function renderSetup() {
    var saved = load('source', null);
    var panel = element('div', 'panel');
    panel.appendChild(element('h2', null, 'Quelle einrichten'));
    if (state.authFehler) {
      panel.appendChild(element('p', 'fehler', state.authIstNetz
        ? state.authFehler + '. Prüfe die Internetverbindung des Fernsehers.'
        : 'Anmeldung fehlgeschlagen: ' + state.authFehler + '. Bitte Zugangsdaten ' +
          'prüfen – bei abgelaufenem Zugang nennt der Anbieter neue.'));
      // Bei einem Netzaussetzer stimmen die gespeicherten Daten ja – dann soll
      // ein Knopf genuegen statt alles neu einzutippen.
      if (state.authIstNetz && saved) {
        var erneut = button('Erneut versuchen', function () {
          state.authFehler = null; state.authIstNetz = false;
          reloadSource();
        });
        erneut.setAttribute('data-erstziel', '1');
        panel.appendChild(erneut);
      }
    }
    panel.appendChild(element('p', null,
      'GlassTV spielt deine eigene Playlist ab – Xtream Codes oder M3U. ' +
      'Die Zugangsdaten bleiben auf diesem Fernseher.'));

    function field(labelText, value, type) {
      panel.appendChild(element('label', null, labelText));
      var input = element('input', 'focusable');
      input.type = type || 'text';
      input.value = value || '';
      panel.appendChild(input);
      return input;
    }

    var host = field('Xtream-Server (http://host:port)', saved && saved.host);
    var user = field('Benutzer', saved && saved.user);
    var pass = field('Passwort', saved && saved.pass, 'password');
    var m3u = field('… oder M3U-Adresse', saved && saved.m3u);

    var actions = element('div', 'actions');
    actions.appendChild(button('Xtream laden', function () {
      var cleanHost = Core.sanitizedHost(host.value);
      if (!cleanHost) return toast('Bitte eine gültige Server-Adresse eingeben.');
      loadXtreamSource(cleanHost, user.value, pass.value);
    }));
    actions.appendChild(button('M3U laden', function () {
      if (!m3u.value) return toast('Bitte eine M3U-Adresse eingeben.');
      loadM3USource(m3u.value);
    }, true));
    panel.appendChild(actions);
    el.content.appendChild(panel);
    /*
     * Nur beim ERSTEN Aufbau ins Feld springen. Vorher zog jeder Neuaufbau den
     * Fokus zurueck – nach einem gescheiterten Ladeversuch legte sich die
     * Bildschirmtastatur damit ueber die gerade erschienene Fehlermeldung.
     */
    if (!state.setupFokusGesetzt && !state.authFehler) {
      state.setupFokusGesetzt = true;
      setTimeout(function () { host.focus(); }, 0);
    }
  }

  // ----------------------------------------------------------- Laden ----

  /**
   * Sprachfilter auf die Rohbibliothek anwenden. Die ungefilterte Fassung
   * bleibt erhalten, sonst ließe sich der Filter nie wieder lockern.
   */
  /** Darf eine Kategorie nach Ausblenden/Kindersicherung überhaupt gezeigt werden? */
  function kategorieErlaubt(name) {
    var blockiert = state.settings.hiddenGroups;
    for (var i = 0; i < blockiert.length; i++) if (blockiert[i] === name) return false;
    if (state.settings.pin && !state.unlocked) {
      for (var j = 0; j < state.settings.lockedGroups.length; j++) {
        if (state.settings.lockedGroups[j] === name) return false;
      }
    }
    return true;
  }

  function applyLanguageFilter() {
    if (!state.rawLibrary) return;
    groupCache = {};        // Bibliothek ändert sich – Puffer verwerfen
    allGroupsCache = null;
    sortCache = {};
    // Nachgeladene Kategorien wurden nach den ALTEN Regeln gefiltert. Bleiben
    // sie liegen, zeigte eine frisch gesperrte Kategorie ihre Titel weiter.
    state.katalogCache = {};
    state.katalogReihe = [];
    if (state.katWahl.movies && !kategorieErlaubt(state.katWahl.movies.name)) {
      state.katWahl.movies = null;
    }
    if (state.katWahl.series && !kategorieErlaubt(state.katWahl.series.name)) {
      state.katWahl.series = null;
    }
    var lib = state.settings.languages.length
      ? Core.filterByLanguage(state.rawLibrary, state.settings.languages, state.settings.strict)
      : state.rawLibrary;

    // Ausgeblendete Kategorien immer, gesperrte nur solange nicht entsperrt.
    var blocked = state.settings.hiddenGroups.slice();
    if (state.settings.pin && !state.unlocked) {
      blocked = blocked.concat(state.settings.lockedGroups);
    }
    if (blocked.length) {
      // Nachschlagewerk statt indexOf: Bei 200 gesperrten Kategorien und
      // 142.000 Filmen wären das zig Millionen String-Vergleiche – pro Klick.
      var blockedSet = {};
      for (var b = 0; b < blocked.length; b++) blockedSet[blocked[b]] = true;
      var isBlocked = function (item) { return blockedSet[item.group] === true; };
      lib = {
        channels: lib.channels.filter(function (c) { return !isBlocked(c); }),
        movies: lib.movies.filter(function (m) { return !isBlocked(m); }),
        series: lib.series.filter(function (x) { return !isBlocked(x); }),
      };
    }
    state.library = lib;
    bibliothekGeaendert();
  }

  /** Alle Kategorien der ROHEN Bibliothek – auch die ausgeblendeten, sonst
   *  ließen die sich nie wieder einblenden. */
  var allGroupsCache = null;

  function allGroups() {
    if (allGroupsCache) return allGroupsCache;
    if (!state.rawLibrary) return [];
    var seen = Object.create(null), out = [];
    function add(list) {
      for (var i = 0; i < list.length; i++) {
        var g = list[i].group;
        if (g && !seen[g]) { seen[g] = true; out.push(g); }
      }
    }
    add(state.rawLibrary.channels); add(state.rawLibrary.movies); add(state.rawLibrary.series);
    /*
     * Beim bedarfsweisen Laden stecken Film- und Serienkategorien nicht in den
     * Einträgen (die sind ja noch nicht geholt), sondern in den Kategorienlisten.
     * Ohne diesen Zusatz stünden in den Einstellungen nur noch die Live-
     * Kategorien – die Kindersicherung könnte gerade die 18+-Kategorien der
     * Filme nicht mehr sperren.
     */
    function addNamen(liste) {
      for (var n = 0; n < liste.length; n++) {
        var g = liste[n].name;
        if (g && !seen[g]) { seen[g] = true; out.push(g); }
      }
    }
    addNamen(state.vodKategorien); addNamen(state.serienKategorien);
    out.sort();
    allGroupsCache = out;
    return out;
  }

  function afterLoad(lib) {
    state.rawLibrary = lib;
    state.epgURL = lib.epgURL || null;
    applyLanguageFilter();
    if (state.lazyKatalog) {
      toast(state.library.channels.length + ' Sender · ' + state.vodKategorien.length +
        ' Filmkategorien · ' + state.serienKategorien.length + ' Serienkategorien');
    } else {
      toast(state.library.channels.length + ' Sender · ' + state.library.movies.length +
        ' Filme · ' + state.library.series.length + ' Serien');
    }
    render();
  }

  function loadM3USource(url) {
    state.loading = true;
    state.loadingStep = 'Playlist wird geladen …';
    render();
    httpGet(url, function (err, text) {
      state.loading = false;
      state.loadingStep = null;
      if (err) { render(); return toast('M3U konnte nicht geladen werden: ' + err.message, 8000); }
      state.source = { kind: 'm3u', m3u: url };
      save('source', state.source);
      state.epg = {};
      // Eine M3U-Datei enthält alles auf einmal – kein Nachladen nötig.
      state.lazyKatalog = false;
      state.filmIndex = null;
      state.indexLaedt = false;
      state.katalogCache = {};
      state.katalogReihe = [];
      state.katWahl = { movies: null, series: null };
      // Ohne den Fang bliebe bei einem Parser-Fehler der Spinner für immer
      // stehen – und die Oberfläche hätte kein bedienbares Element mehr.
      try {
        afterLoad(Core.parseM3U(text, 'm3u'));
        loadEpg();
      } catch (parseError) {
        render();
        toast('Playlist konnte nicht gelesen werden: ' + parseError.message, 9000);
      }
    }, CATALOG_TIMEOUT);
  }

  function loadXtreamSource(host, user, pass) {
    state.authFehler = null;
    state.authIstNetz = false;
    state.loading = true;
    state.loadingStep = 'Anmeldung wird geprüft …';
    render();

    var categories = { live: {}, vod: {}, series: {} };
    var lib = { channels: [], movies: [], series: [] };
    var vodKategorien = [], serienKategorien = [];
    var problems = [];
    var authError = null;
    var netzFehler = null;

    /** Rohantwort der Kategorien in eine schlanke Liste bringen. */
    function kategorienListe(roh) {
      var out = [];
      if (!roh || !roh.length) return out;
      for (var i = 0; i < roh.length; i++) {
        var id = roh[i].category_id, name = roh[i].category_name;
        if (id !== undefined && name) out.push({ id: String(id), name: String(name) });
      }
      return out;
    }

    function fail(bereich, err) {
      // Jeden Teilbereich einzeln benennen: Früher wurden Fehler bei Filmen und
      // Serien verschluckt – der Nutzer sah eine leere Seite und hielt seinen
      // Anbieter für kaputt.
      problems.push(bereich + ' (' + (err && err.message ? err.message : 'unbekannt') + ')');
    }

    function finish() {
      state.loading = false;
      state.loadingStep = null;
      if (authError) {
        // Dauerhaft merken: Ein Hinweis verschwindet nach acht Sekunden und
        // laesst den Nutzer vor „nichts geladen" sitzen – etwa wenn das Abo
        // abgelaufen ist oder das Panel das Passwort geaendert hat.
        state.authFehler = netzFehler
          ? 'Der Server war nicht erreichbar (' + netzFehler.message + ')'
          : authError.message;
        state.authIstNetz = !!netzFehler;
        render();
        return toast(state.authFehler, 8000);
      }
      state.authFehler = null;
      state.source = { kind: 'xtream', host: host, user: user, pass: pass };
      save('source', state.source);
      state.lazyKatalog = true;
      state.vodKategorien = vodKategorien;
      state.serienKategorien = serienKategorien;
      state.katalogCache = {};
      state.katalogReihe = [];
      // Das Titelverzeichnis gehoert zur alten Quelle: Seine Stream-Nummern
      // mit den neuen Zugangsdaten ergaeben fremde oder tote Adressen, und
      // seine Kategorie-Kennungen zeigten auf die falschen Namen.
      state.filmIndex = null;
      state.indexLaedt = false;
      try {
        afterLoad(lib);
      } catch (parseError) {
        render();
        return toast('Bibliothek konnte nicht aufgebaut werden: ' + parseError.message, 9000);
      }
      if (problems.length) {
        toast('Teilweise geladen – nicht abrufbar: ' + problems.join(', ') +
          '. In den Einstellungen „Neu laden“ versuchen.', 9000);
      }
      loadEpg();
    }

    // Nacheinander statt gleichzeitig: Drei zweistellige Megabyte-Antworten
    // parallel teilen sich die Bandbreite und laufen eher ins Zeitlimit.
    function step1auth() {
      httpGetJson(Core.xtreamApi(host, user, pass, null), function (err, json) {
        /*
         * Netzfehler und abgelehnte Anmeldung sind zweierlei: Ein WLAN-Aussetzer
         * warf den Nutzer bisher mit „Anmeldung fehlgeschlagen" zurueck ins
         * Formular, obwohl die Zugangsdaten stimmten.
         */
        if (err) { netzFehler = err; authError = err; }
        else if (json && json.user_info && Number(json.user_info.auth) === 0) {
          authError = new Error('Benutzer oder Passwort falsch');
        }
        if (authError) return finish();
        state.loadingStep = 'Sender werden geladen …'; render();
        step2live();
      }, 30000);
    }

    function step2live() {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_live_categories'), function (e1, cats) {
        if (!e1 && cats) categories.live = Core.parseCategories(cats);
        httpGetJson(Core.xtreamApi(host, user, pass, 'get_live_streams'), function (err, json) {
          if (err) fail('Sender', err);
          // Ohne den Fang bliebe die Kette stehen und der Spinner für immer.
          else try { lib.channels = Core.parseLiveStreams(json, categories.live, host, user, pass, 'xtream'); }
          catch (pe) { fail('Sender', pe); }
          state.loadingStep = 'Filme werden geladen …'; render();
          step3vod();
        }, CATALOG_TIMEOUT);
      }, 30000);
    }

    /*
     * Filme und Serien werden NICHT mehr vollständig geladen – nur ihre
     * Kategorien (rund 24 KB gegenüber zweistelligen Megabyte). Die Einträge
     * einer Kategorie kommen erst, wenn sie geöffnet wird; das hält den
     * Speicher frei und die App startet in Sekunden statt in einer Minute.
     */
    function step3vod() {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_vod_categories'), function (e1, cats) {
        if (e1) fail('Filmkategorien', e1);
        else if (cats) {
          categories.vod = Core.parseCategories(cats);
          vodKategorien = kategorienListe(cats);
        }
        state.loadingStep = 'Serienkategorien werden geladen …'; render();
        step4series();
      }, 30000);
    }

    function step4series() {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_series_categories'), function (e1, cats) {
        if (e1) fail('Serienkategorien', e1);
        else if (cats) {
          categories.series = Core.parseCategories(cats);
          serienKategorien = kategorienListe(cats);
        }
        finish();
      }, 30000);
    }

    step1auth();
  }

  function reloadSource() {
    if (!state.source) return render();
    if (state.source.kind === 'm3u') loadM3USource(state.source.m3u);
    else loadXtreamSource(state.source.host, state.source.user, state.source.pass);
  }

  function loadEpg() {
    if (!state.source) return;
    var url;
    if (state.source.kind === 'xtream') {
      url = state.source.host + '/xmltv.php?username=' +
        encodeURIComponent(state.source.user) + '&password=' + encodeURIComponent(state.source.pass);
    } else {
      // M3U-Playlisten nennen ihre EPG-Adresse in der Kopfzeile.
      url = state.epgURL;
      if (!url) return;
    }
    httpGet(url, function (err, text) {
      if (err || !text) return;          // EPG ist Zugabe – ein Fehler darf nichts kippen
      try {
        // Nur Sendungen der tatsächlich vorhandenen Kanäle behalten: Die Datei
        // eines großen Anbieters ist dreistellig Megabyte groß.
        var ids = [];
        for (var c = 0; c < state.library.channels.length; c++) {
          if (state.library.channels[c].epgID) ids.push(state.library.channels[c].epgID);
        }
        state.epg = Core.parseXMLTV(text, ids.length ? ids : null);
        if (!state.view && (state.tab === 'live' || state.tab === 'home')) render();
      } catch (e) { /* stumm */ }
    }, 60000);
  }

  // ---------------------------------------------------------- Player ----

  var player = {
    open: false,
    kind: null,
    id: null,
    title: '',
    context: null,      // { series, episode } für „nächste Folge"
    hideTimer: null,
    tickTimer: null,
  };

  function playChannel(ch) {
    var now = Core.nowProgram(programsFor(ch));
    playItem(ch.name, streamUrlOf(ch), now ? now.title : ch.group, 'live', ch.id, 0,
      { channel: ch }, { image: ch.logoURL, group: ch.group });
  }

  function playItem(title, url, subtitle, kind, id, resumeSeconds, context, meta) {
    player.meta = meta || {};
    player.open = true;
    player.kind = kind;
    player.id = id;
    player.title = title;
    player.context = context || null;

    player.subtitle = subtitle || '';
    player.sourceUrl = url;
    player.lastSaved = undefined;
    el.playerTitle.textContent = title;
    el.playerSub.textContent = subtitle || '';
    el.player.className = 'open';
    el.scrubFill.style.width = '0%';
    el.times.textContent = kind === 'live' ? 'Live' : '';
    /*
     * Der Hinweis muss zum Inhalt passen: Bei Live wechseln die Pfeiltasten den
     * Sender, gespult wird nicht. Der feste Text versprach beides gleichzeitig.
     */
    var hint = document.getElementById('player-hint');
    if (hint) {
      hint.textContent = kind === 'live'
        ? 'OK = Pause · ◀ ▶ = Sender wechseln · Zurück = schließen'
        : 'OK = Pause · ◀ ▶ = 10 s spulen · Zurück = schließen';
    }

    el.video.src = url;
    el.video.load();
    // Einen noch offenen Resume-Wunsch des vorherigen Titels entfernen: Blieb er
    // hängen (Stream lud nie), sprang der NÄCHSTE Film an dessen Position.
    if (player.seekHandler) {
      el.video.removeEventListener('loadedmetadata', player.seekHandler);
      player.seekHandler = null;
    }
    if (resumeSeconds && resumeSeconds > 0) {
      // currentTime lässt sich erst setzen, wenn Metadaten da sind.
      player.seekHandler = function () {
        /*
         * Auf die tatsaechliche Laenge deckeln: Ist der Stream kuerzer als
         * gespeichert (der Anbieter hat die Datei ersetzt), klemmt der Browser
         * ans Ende und feuert sofort `ended` – bei Folgen sprang dadurch
         * ungefragt die naechste an, bei Filmen schloss sich der Player.
         */
        var dauer = el.video.duration;
        var ziel = (dauer && isFinite(dauer) && resumeSeconds > dauer - 5)
          ? Math.max(0, dauer - 5) : resumeSeconds;
        try { el.video.currentTime = ziel; } catch (e) { /* egal */ }
        el.video.removeEventListener('loadedmetadata', player.seekHandler);
        player.seekHandler = null;
      };
      el.video.addEventListener('loadedmetadata', player.seekHandler);
    }
    var p = el.video.play();
    if (p && p.catch) p.catch(function () { /* Autoplay-Ablehnung ignorieren */ });

    pokeChrome();
    startTick();
  }

  function startTick() {
    if (player.tickTimer) clearInterval(player.tickTimer);
    player.tickTimer = setInterval(function () {
      if (!player.open) return;
      var pos = el.video.currentTime || 0;
      var dur = el.video.duration;
      if (dur && isFinite(dur) && dur > 0) {
        el.scrubFill.style.width = ((pos / dur) * 100) + '%';
        el.times.textContent = clock(pos) + '  /  ' + clock(dur);
        // Fortschritt alle 10 s sichern, damit „Weiterschauen" stimmt.
        // Nicht `Math.floor(pos) % 10`: Die Medienzeit springt (19,95 → 21,02),
        // dabei wurde das Fenster übersprungen – oder bei Pause im Sekundentakt
        // die ganze Verlaufsliste geschrieben.
        // Erst ab 30 s speichern (dieselbe Schwelle wie `resumable`): Sonst stand
        // jeder Fehlgriff nach einer Sekunde im Verlauf, und ein still
        // gescheiterter Resume-Sprung loeschte die gemerkte Position.
        if (pos > 30 &&
            (player.lastSaved === undefined || Math.abs(pos - player.lastSaved) >= 10)) {
          player.lastSaved = pos;
          saveProgress(pos, dur);
        }
      } else if (player.kind === 'live') {
        el.times.textContent = 'Live';
      }
    }, 1000);
  }

  function clock(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    var h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return h > 0 ? h + ':' + two(m) + ':' + two(s) : m + ':' + two(s);
  }

  function saveProgress(position, duration) {
    if (!player.id) return;
    if (player.kind === 'live') {
      // Sender liefern keine Laufzeit – aber der Besuch selbst gehört in den
      // Verlauf: Er speist „Zuletzt gesehen", die Kachel „Verschiedene Sender"
      // und die Empfehlungen. Ohne ihn stand dort dauerhaft eine Null.
      state.progress[player.id] = {
        id: player.id, kind: 'live', title: player.title,
        url: '', image: (player.meta && player.meta.image) || null,
        group: (player.meta && player.meta.group) || null,
        position: 0, duration: 0, updatedAt: Date.now(),
      };
      trimProgress();
      saveScoped('progress', state.progress);
      return;
    }
    var prev = state.progress[player.id] || {};
    state.progress[player.id] = {
      id: player.id, kind: player.kind, title: player.title,
      // Keine Adresse im Verlauf: Sie trägt bei Xtream Benutzer und Passwort,
      // und der Verlauf liegt unverschlüsselt im Gerätespeicher. Beim
      // Fortsetzen wird sie aus der Bibliothek neu gebaut.
      url: '',
      // Poster und Kategorie kommen vom Aufrufer: ohne sie hätte
      // „Weiterschauen" kein Bild und die Empfehlungen keine Grundlage.
      image: (player.meta && player.meta.image) || prev.image || null,
      group: (player.meta && player.meta.group) || prev.group || null,
      // Die Dateiendung gehoert dazu: Ohne sie muesste ein rekonstruierter
      // Link „mp4" raten, und MKV-Titel liefen nicht wieder an.
      ext: (player.meta && player.meta.ext) || prev.ext || null,
      // Fingerabdruck der Quelle: Alle Xtream-Panels teilen sich denselben
      // Kennungsraum („xtream|m|4711"). Ohne diese Pruefung baute ein alter
      // Eintrag nach einem Panelwechsel eine gueltige Adresse auf einen voellig
      // ANDEREN Film – ohne Fehlermeldung.
      quelle: quellenAbdruck(),
      position: position, duration: duration, updatedAt: Date.now(),
    };
    trimProgress();
    saveScoped('progress', state.progress);
  }

  /** Verlauf deckeln – sonst sprengt er irgendwann den 5-MB-Gerätespeicher. */
  function trimProgress() {
    var ids = [];
    for (var k in state.progress) {
      if (Object.prototype.hasOwnProperty.call(state.progress, k)) ids.push(k);
    }
    if (ids.length <= 200) return;
    ids.sort(function (a, b) { return state.progress[a].updatedAt - state.progress[b].updatedAt; });
    for (var d = 0; d < ids.length - 200; d++) delete state.progress[ids[d]];
  }

  function closePlayer() {
    if (el.video.duration && isFinite(el.video.duration)) {
      saveProgress(el.video.currentTime || 0, el.video.duration);
    }
    player.open = false;
    var zuletztGespielt = player.id
      ? (istSender(player.id) ? 'ch:' + player.id : 'card:' + player.id)
      : null;
    if (player.tickTimer) { clearInterval(player.tickTimer); player.tickTimer = null; }
    if (player.hideTimer) { clearTimeout(player.hideTimer); player.hideTimer = null; }
    if (player.pufferTimer) { clearTimeout(player.pufferTimer); player.pufferTimer = null; }
    player.context = null;
    player.meta = null;
    if (player.seekHandler) {
      el.video.removeEventListener('loadedmetadata', player.seekHandler);
      player.seekHandler = null;
    }
    el.player.className = '';
    el.video.pause();
    el.video.removeAttribute('src');
    el.video.load();
    /*
     * Neu zeichnen, nachdem das Overlay zu ist: Sonst zeigt die Detailseite
     * kein „Weiter ab …", die Folgenliste keinen Fortschritt und die Startseite
     * eine veraltete Weiterschauen-Reihe – der Aufbau stammte noch von vor der
     * Wiedergabe. Der Fokus geht auf den zuletzt gespielten Eintrag statt an
     * den Listenanfang.
     */
    if (zuletztGespielt) focusWuenschen(zuletztGespielt);
    render();
  }

  function pokeChrome() {
    el.chrome.className = '';
    if (player.hideTimer) clearTimeout(player.hideTimer);
    player.hideTimer = setTimeout(function () { el.chrome.className = 'hidden'; }, 4000);
  }

  /** Spulen, begrenzt auf die tatsächliche Länge (sonst wirft die Pipeline). */
  function seekBy(seconds) {
    var dur = el.video.duration;
    var ziel = (el.video.currentTime || 0) + seconds;
    if (ziel < 0) ziel = 0;
    if (dur && isFinite(dur) && ziel > dur - 1) ziel = Math.max(0, dur - 1);
    try { el.video.currentTime = ziel; } catch (e) { /* nicht spulbar */ }
  }

  /** Sender wechseln (Zapping) – nur bei Live. */
  function zap(direction) {
    if (player.kind !== 'live' || !player.context || !player.context.channel) return;
    /*
     * In der gewaehlten Kategorie bleiben. Wer in „Sport" einen Sender
     * startet, landete mit ▶ sonst in der Gesamtliste – bei 10.000 Sendern
     * findet man von dort nicht zurueck.
     */
    var list = state.library.channels;
    if (state.group.live) {
      var gefiltert = [];
      for (var g = 0; g < list.length; g++) {
        if (list[g].group === state.group.live) gefiltert.push(list[g]);
      }
      if (gefiltert.length > 1) list = gefiltert;
    }
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === player.context.channel.id) { idx = i; break; }
    }
    if (idx < 0) return;
    var next = list[((idx + direction) % list.length + list.length) % list.length];
    playChannel(next);
  }

  /** Nächste Folge derselben Staffel, wenn vorhanden. */
  function playNextEpisode() {
    if (!player.context || !player.context.series) return false;
    var s = player.context.series, cur = player.context.episode;
    var eps = s.episodes.filter(function (e) { return e.season === cur.season; });
    for (var i = 0; i < eps.length - 1; i++) {
      if (eps[i].id === cur.id) {
        var nx = eps[i + 1];
        playItem(s.title + ' · S' + two(nx.season) + 'E' + two(nx.episode),
          streamUrlOf(nx), nx.title, 'episode', nx.id, 0, { series: s, episode: nx },
          // `ext` mitgeben: Ohne sie riet der rekonstruierte Link spaeter „mp4",
          // und automatisch gestartete MKV-Folgen liefen nicht wieder an.
          { image: nx.imageURL || s.posterURL, group: s.group, ext: nx.ext });
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------ Tastatur ----

  // webOS-Fernbedienung: Pfeile 37–40, OK 13, Zurück 461.
  // Farbtasten: rot 403, grün 404, gelb 405, blau 406.
  // Medientasten: Play 415, Pause 19, Stop 413, FF 417, RW 412.
  var beendenBestaetigt = false;

  function onKey(e) {
    var code = e.keyCode;

    /*
     * Beim Tippen gehören die Tasten dem Textfeld.
     * Vorher rief Backspace auf dem Einrichtungsbildschirm `exitApp()` auf –
     * jeder Korrekturversuch schloss also die App –, und die Pfeiltasten
     * stahlen dem Feld die Cursorbewegung.
     */
    var el0 = document.activeElement;
    if (el0 && (el0.tagName === 'INPUT' || el0.tagName === 'TEXTAREA')) {
      if (code === 8 || code === 37 || code === 39 || code === 35 || code === 36 || code === 46) {
        return;
      }
    }

    if (player.open) {
      pokeChrome();
      if (code === 461 || code === 8 || code === 27 || code === 413) {
        closePlayer(); e.preventDefault(); return;
      }
      if (code === 13 || code === 415 || code === 19) {
        if (el.video.paused) el.video.play(); else el.video.pause();
        e.preventDefault(); return;
      }
      if (code === 39 || code === 417) {
        if (player.kind === 'live') zap(1); else seekBy(10);
        e.preventDefault(); return;
      }
      if (code === 37 || code === 412) {
        if (player.kind === 'live') zap(-1); else seekBy(-10);
        e.preventDefault(); return;
      }
      if (code === 38) { if (player.kind === 'live') zap(-1); e.preventDefault(); return; }
      if (code === 40) { if (player.kind === 'live') zap(1); e.preventDefault(); return; }
      return;
    }

    if (code === 461 || code === 8) {
      if (state.view) {
        /*
         * Offene Teilbereiche zuerst schliessen: Vorher warf Zurueck die
         * gesamte Einstellungsseite weg, obwohl nur die Kategorienliste bzw.
         * das Profilformular offen war – ebenso bei einer gewaehlten Staffel.
         */
        if (state.view.type === 'settings' && state.view.showGroups) {
          state.view.showGroups = false; render(); e.preventDefault(); return;
        }
        if (state.view.type === 'settings' && state.view.addProfile) {
          state.view.addProfile = false; render(); e.preventDefault(); return;
        }
        ansichtZurueck(); e.preventDefault(); return;
      }
      /*
       * „Wer schaut?" ist bei mehreren Profilen der ERSTE Bildschirm. Vorher
       * verschluckte die Zurueck-Taste hier alles, und weil `appinfo.json`
       * `disableBackHistoryAPI` setzt, beendet auch die Plattform nicht: Man
       * kam nur noch ueber die Home-Taste heraus. Genau das prueft LG.
       */
      if (state.gate) { exitApp(); e.preventDefault(); return; }
      // Waehrend eine Kategorie laedt, ist Zurueck ein Abbruch – nicht der
      // Ausstieg aus dem Tab.
      if (state.katalogLaedt) { katalogAbbrechen(); e.preventDefault(); return; }
      // Eine geöffnete Kategorie ist eine eigene Ebene – erst zurück zur
      // Kategorienliste, dann erst zur Startseite.
      if (state.lazyKatalog && state.tab === 'movies' && state.katWahl.movies) {
        state.katWahl.movies = null; render(); e.preventDefault(); return;
      }
      if (state.lazyKatalog && state.tab === 'series' && state.katWahl.series) {
        state.katWahl.series = null; render(); e.preventDefault(); return;
      }
      if (state.tab !== 'home') { state.tab = 'home'; render(); e.preventDefault(); return; }
      /*
       * Nicht sofort beenden: Im Einrichtungsformular ist Zurueck die
       * naheliegende Geste, um die Bildschirmtastatur zu schliessen, und
       * waehrend des Ladens waeren 40 Sekunden umsonst. Deshalb wie auf webOS
       * ueblich erst eine Bestaetigung.
       */
      if (state.loading || !state.source) {
        if (!beendenBestaetigt) {
          beendenBestaetigt = true;
          toast('Zum Beenden noch einmal Zurück drücken.', 3000);
          setTimeout(function () { beendenBestaetigt = false; }, 3000);
          e.preventDefault();
          return;
        }
      }
      exitApp();
      e.preventDefault();
      return;
    }
    // Blaue Taste: Favorit umschalten für die fokussierte Zeile/Karte.
    if (code === 406) {
      var a = document.activeElement;
      if (a && a._favTarget) {
        toggleFavorite(a._favTarget, a._favItem);
        toast(isFavorite(a._favTarget) ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt', 2000);
        render();
      } else if (a && a.getAttribute && a.getAttribute('data-fkey') &&
                 a.getAttribute('data-fkey').indexOf('card:') === 0) {
        // Kacheln tragen kein Favoritenziel – vorher wurde die Taste hier
        // stillschweigend geschluckt.
        toast('Favoriten setzt du auf der Detailseite mit „☆ Favorit“.', 3500);
      }
      e.preventDefault(); return;
    }
    /*
     * Rote Taste: an den Anfang der Liste. Nach mehrmaligem Nachladen standen
     * ueber hundert Zeilen da, und hoch ging es nur Zeile fuer Zeile.
     */
    if (code === 403) {
      var erste = null;
      var alle = el.content.querySelectorAll('.focusable');
      for (var q = 0; q < alle.length; q++) {
        var r = alle[q].getBoundingClientRect();
        if (r.width > 0 || r.height > 0) { erste = alle[q]; break; }
      }
      if (erste) {
        erste.focus();
        if (el.content.scrollTop !== undefined) el.content.scrollTop = 0;
        revealFocus(erste);
        toast('Am Anfang', 1500);
      }
      e.preventDefault(); return;
    }
    // Gelbe Taste: Suche. Grüne: Programmführer.
    if (code === 405) { state.view = { type: 'search', query: '' }; render(); e.preventDefault(); return; }
    if (code === 404) { state.view = { type: 'guide' }; render(); e.preventDefault(); return; }

    if (code === 37) { moveFocus(-1, 0); e.preventDefault(); }
    else if (code === 39) { moveFocus(1, 0); e.preventDefault(); }
    else if (code === 38) { moveFocus(0, -1); e.preventDefault(); }
    else if (code === 40) { moveFocus(0, 1); e.preventDefault(); }
    else if (code === 13) {
      gedruecktAn();
      var el2 = document.activeElement;
      if (el2 && el2.tagName === 'INPUT') {
        /*
         * Auf der Bildschirmtastatur ist OK die Abschlussgeste. Vorher passierte
         * nichts, und man musste blind nach unten zum Knopf navigieren.
         */
        if (state.view && state.view.type === 'search') {
          state.view.query = el2.value;
          render();
          e.preventDefault();
        }
        return;
      }
      if (el2 && el2.click) el2.click();
    }
  }

  /**
   * App beenden.
   *
   * `appinfo.json` setzt `disableBackHistoryAPI`, die Plattform beendet also
   * NICHT mehr selbst – das muss die App tun. `webOS.platformBack()` steht nur
   * zur Verfügung, wenn webOSTV.js eingebunden ist; ohne das blieb der Nutzer
   * auf der Startseite gefangen und kam nur noch über die Home-Taste heraus.
   * Deshalb hier drei Wege, vom besten zum gröbsten.
   */
  /**
   * Kindersicherung und Profilwahl in den Ausgangszustand bringen – nach jedem
   * Wiedereintritt in die App, weil `boot()` dann nicht laeuft.
   */
  function sperreZuruecksetzen() {
    var warEntsperrt = state.unlocked;
    state.unlocked = false;
    state.gate = state.profiles.length > 1;
    if (warEntsperrt) applyLanguageFilter();
  }

  function exitApp() {
    // Der reguläre Weg – die Plattform blendet die App sauber aus.
    if (typeof webOS !== 'undefined' && webOS.platformBack) { webOS.platformBack(); return; }
    // Nur falls die Bibliothek fehlt (Browser-Test): grob, aber wirksam.
    try { window.close(); } catch (e) { /* dann bleibt die Home-Taste */ }
  }


  // ------------------------------------------------- Magic Remote ----

  /*
   * LG-Fernbedienungen haben einen Zeiger. Ohne Behandlung fühlt sich die App
   * damit tot an: Man fährt über eine Kachel, nichts passiert, und beim Klick
   * springt der Fokus woanders hin. LG prüft das bei der Zertifizierung.
   *
   * Grundsatz: Der Zeiger führt den Fokus. Was unter ihm liegt, ist fokussiert –
   * damit gibt es weiterhin genau EINE Ortsangabe, egal ob mit Tasten oder
   * Zeiger bedient wird.
   */
  var zeigerAktiv = false;

  function naechstesFokusziel(node) {
    // `closest` gibt es ab Chrome 41 – auf 53 also vorhanden.
    if (node && node.closest) return node.closest('.focusable');
    while (node && node !== document.body) {
      if (node.className && (' ' + node.className + ' ').indexOf(' focusable ') >= 0) return node;
      node = node.parentNode;
    }
    return null;
  }

  /**
   * Zeigerklasse setzen, ohne die uebrigen Body-Klassen zu verwerfen.
   * `document.body.className = 'zeiger'` loeschte auch `ruhig` – die
   * Einstellung „Bewegung reduzieren" waere beim ersten Zeigerereignis weg.
   */
  function zeigerKlasse(an) {
    var c = document.body.className.replace(/\s*\bzeiger\b/g, '');
    document.body.className = an ? (c + ' zeiger') : c;
  }

  /**
   * Gedrueckt-Zustand. Enter ueber die Fernbedienung loest KEIN `:active`
   * aus – auf einem Geraet, das fuer den Neuaufbau 200–600 ms braucht, ist
   * das die einzige sofortige Rueckmeldung auf einen Tastendruck.
   */
  var gedruecktTimer = null;
  function gedruecktAn() {
    var a = document.activeElement;
    if (a && a.className && a.className.indexOf('focusable') >= 0) {
      a.className = a.className + ' gedrueckt';
    }
    if (gedruecktTimer) clearTimeout(gedruecktTimer);
    // Sicherheitsnetz: `keyup` faellt auf manchen Fernbedienungen aus.
    gedruecktTimer = setTimeout(gedruecktAus, 180);
  }
  function gedruecktAus() {
    var n = document.querySelectorAll('.gedrueckt');
    for (var i = 0; i < n.length; i++) {
      n[i].className = n[i].className.replace(/\s*\bgedrueckt\b/g, '');
    }
  }

  function initZeiger() {
    document.addEventListener('mouseover', function (e) {
      var ziel = naechstesFokusziel(e.target);
      if (ziel && ziel !== document.activeElement) {
        zeigerAktiv = true;
        ziel.focus();
        // Kein revealFocus: Der Zeiger steht schon dort, ein Scrollen würde
        // den Inhalt unter ihm wegziehen.
      }
    });

    /*
     * webOS meldet, ob der Zeiger gerade sichtbar ist. Wird er ausgeblendet
     * (Nutzer legt die Fernbedienung hin und drückt eine Taste), bleibt der
     * zuletzt berührte Eintrag fokussiert – so führt die Tastenbedienung dort
     * weiter, wo der Zeiger aufgehört hat.
     */
    document.addEventListener('cursorStateChange', function (e) {
      zeigerAktiv = !!(e.detail && e.detail.visibility);
      zeigerKlasse(zeigerAktiv);
      if (!zeigerAktiv) {
        var a = document.activeElement;
        if (!a || a === document.body) ensureFocus();
      }
    });
  }

  // ------------------------------------------------------------ Start ----

  function boot() {
    el = {
      tabs: document.getElementById('tabs'),
      content: document.getElementById('content'),
      player: document.getElementById('player'),
      video: document.getElementById('video'),
      chrome: document.getElementById('player-chrome'),
      playerTitle: document.getElementById('player-title'),
      playerSub: document.getElementById('player-sub'),
      scrubFill: document.getElementById('player-scrub-fill'),
      times: document.getElementById('player-times'),
      toast: document.getElementById('toast'),
      search: document.getElementById('btn-search'),
      guide: document.getElementById('btn-guide'),
      settings: document.getElementById('btn-settings'),
    };

    loadProfiles();
    state.activeProfile = load('activeProfile', 'default') || 'default';
    // Ein gelöschtes Profil darf nicht als aktiv stehenbleiben.
    var known = false;
    for (var pi = 0; pi < state.profiles.length; pi++) {
      if (state.profiles[pi].id === state.activeProfile) known = true;
    }
    if (!known) state.activeProfile = 'default';
    loadProfileData();
    // „Wer schaut?" nur, wenn es überhaupt etwas zu wählen gibt.
    state.gate = state.profiles.length > 1;
    var saved = load('settings', null);
    if (saved) {
      // Beschädigte Werte würden sonst erst beim Klicken auffallen (splice/push
      // auf einem String wirft).
      function asArray(v) { return Object.prototype.toString.call(v) === '[object Array]' ? v : []; }
      state.settings.languages = asArray(saved.languages);
      /*
       * Migration der Filterstufe: Frueher gab es nur an/aus. „an" entspricht
       * jetzt „ausgewogen" – das ist das Verhalten, das der Nutzer zuletzt
       * gesehen hat. Wer wirklich nur die gewaehlten Sprachen will, waehlt in
       * den Einstellungen „streng".
       */
      if (typeof saved.strict === 'string') {
        state.settings.strict = saved.strict;
      } else {
        state.settings.strict = saved.strict === false ? 'grosszuegig' : 'ausgewogen';
      }
      if (SPRACH_STUFEN_IDS.indexOf(state.settings.strict) < 0) {
        state.settings.strict = 'ausgewogen';
      }
      state.settings.design = saved.design || 'perl';
      state.settings.accent = saved.accent || 'violet';
      state.settings.sort = saved.sort || 'standard';
      state.settings.pin = saved.pin || null;
      state.settings.lockedGroups = asArray(saved.lockedGroups);
      state.settings.hiddenGroups = asArray(saved.hiddenGroups);
    }
    applyTheme();

    el.search.onclick = function () { state.view = { type: 'search', query: '' }; render(); };
    el.guide.onclick = function () { state.view = { type: 'guide' }; render(); };
    el.settings.onclick = function () { state.view = { type: 'settings' }; render(); };

    el.video.addEventListener('error', function () {
      /*
       * Nachzuegler ignorieren: `closePlayer()` reisst die Quelle ab
       * (`removeAttribute('src')` + `load()`), und die webOS-Pipeline meldet
       * das durchaus als Fehler. Ohne diese Zeile erschien die Meldung, obwohl
       * nichts lief, und `closePlayer` lief ein zweites Mal – samt Fokussprung
       * mitten in der Liste.
       */
      if (!player.open) return;
      // Ohne Schließen bliebe ein schwarzes Vollbild stehen, dessen Bedienhinweis
      // nach vier Sekunden ausgeblendet ist.
      toast('Dieser Stream lässt sich auf dem Fernseher nicht abspielen.', 8000);
      closePlayer();
    });
    // Zwischen Tastendruck und erstem Bild vergehen bei IPTV mehrere Sekunden –
    // ohne Rückmeldung wirkt das wie ein Absturz.
    el.video.addEventListener('waiting', function () {
      el.playerSub.textContent = 'Wird geladen …';
      pokeChrome();
      /*
       * Zeitlimit fuers Puffern: Nimmt ein Server die Verbindung an, sendet
       * aber nichts, kommt weder `error` noch `playing` – es blieb ein
       * schwarzes Bild, dessen Bedienhinweis sich nach vier Sekunden
       * ausblendet. Der Ausweg existierte, war nur nicht mehr sichtbar.
       */
      if (player.pufferTimer) clearTimeout(player.pufferTimer);
      player.pufferTimer = setTimeout(function () {
        if (!player.open) return;
        toast('Der Stream antwortet nicht. Vielleicht ist der Sender gerade ' +
          'nicht verfügbar.', 8000);
        closePlayer();
      }, 30000);
    });
    el.video.addEventListener('playing', function () {
      if (player.pufferTimer) { clearTimeout(player.pufferTimer); player.pufferTimer = null; }
      if (el.playerSub.textContent === 'Wird geladen …') el.playerSub.textContent = player.subtitle || '';
    });
    el.video.addEventListener('ended', function () {
      if (!playNextEpisode()) closePlayer();
    });

    /*
     * Letzte Absicherung: Ohne Konsole am Fernseher ist ein Fehler beim
     * Aufbauen für den Nutzer nur ein halb gezeichneter Bildschirm. Hier wird
     * er sichtbar gemacht und die Oberfläche in einen bedienbaren Zustand
     * zurückgesetzt.
     */
    // Geht die App in den Hintergrund (Home-Taste), muss der Ton aufhören –
    // sonst läuft der Stream unbemerkt weiter.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && player.open && !el.video.paused) {
        if (el.video.duration && isFinite(el.video.duration)) {
          saveProgress(el.video.currentTime || 0, el.video.duration);
        }
        el.video.pause();
      }
    });

    window.onerror = function (message) {
      try {
        state.loading = false;
        state.loadingStep = null;
        toast('Es ist ein Fehler aufgetreten: ' + message, 9000);
      } catch (e) { /* dann hilft nur noch der Neustart */ }
      return false;
    };

    /*
     * `handlesRelaunch` in appinfo.json bedeutet: Startet der Nutzer die App
     * erneut, während sie schon läuft, wird sie NICHT neu geladen – stattdessen
     * kommt dieses Ereignis. Ohne Behandlung stünde er dort, wo er zuletzt war,
     * inklusive offenem Player.
     */
    document.addEventListener('webOSRelaunch', function () {
      /*
       * `exitApp()` beendet die App nicht, sondern legt sie in den Hintergrund
       * (`handlesRelaunch: true`). Beim naechsten Start feuert nur dieses
       * Ereignis – `boot()` laeuft NICHT. Ohne das Zuruecksetzen unten blieb
       * die Kindersicherung entsperrt und die Profilwahl uebersprungen: Wer
       * mit der PIN entsperrt und die App verlaesst, uebergab sie offen.
       */
      if (player.open) closePlayer();
      state.view = null;
      state.tab = 'home';
      sperreZuruecksetzen();
      render();
    });

    initZeiger();

    // Beim Scrollen nachladen bzw. freigeben – auch waagerechte Regale melden
    // sich hier (Scroll-Ereignisse steigen im Dokument auf, wenn man sie
    // einfängt statt sie an einem Element zu erwarten).
    document.addEventListener('scroll', lazyAnstossen, true);

    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', gedruecktAus);

    var savedSource = load('source', null);
    if (!savedSource) { render(); return; }
    state.source = savedSource;
    reloadSource();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
