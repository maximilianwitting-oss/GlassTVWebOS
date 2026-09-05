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

  // ---------------------------------------------------------- Zustand ----

  var state = {
    tab: 'home',
    library: { channels: [], movies: [], series: [] },
    epg: {},
    source: null,
    loading: false,
    view: null,          // null | {type:'movie'|'series'|'guide'|'search', …}
    group: { live: null, movies: null, series: null },
    favorites: {},       // id -> true
    watchlist: {},       // id -> true („Meine Liste")
    progress: {},        // id -> { position, duration, updatedAt, title, url, image, kind, group }
    profiles: [],        // [{ id, name, color }]
    activeProfile: 'default',
    gate: false,         // „Wer schaut?" wird gerade gezeigt
    settings: {
      languages: [], strict: true, design: 'perl', accent: 'violet', sort: 'standard',
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
    } catch (e) {
      if (!storageWarned && el.toast) {
        storageWarned = true;
        toast('Der Speicher des Fernsehers ist voll – Einstellungen und Verlauf ' +
          'lassen sich gerade nicht sichern.', 9000);
      }
    }
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

  function saveScoped(key, value) { save(scoped(key), value); }
  function loadScoped(key, fallback) { return load(scoped(key), fallback); }

  /** Profildaten neu einlesen (nach Wechsel oder Anlegen). */
  function loadProfileData() {
    state.favorites = loadScoped('favorites', {}) || {};
    state.progress = loadScoped('progress', {}) || {};
    state.watchlist = loadScoped('watchlist', {}) || {};
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
  }

  function httpGetJson(url, cb, timeoutMs) {
    httpGet(url, function (err, text) {
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
    var inContent = [];
    for (var i = 0; i < focusables.length; i++) {
      if (el.content.contains(focusables[i])) inContent.push(focusables[i]);
    }
    var target = inContent.length ? inContent[0] : focusables[0];
    if (target) { target.focus(); revealFocus(target); }
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
  function revealFocus(node) {
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
      if (box.top < cb.top + 90) col.scrollTop -= (cb.top + 90 - box.top);
      else if (box.bottom > cb.bottom - 90) col.scrollTop += (box.bottom - cb.bottom + 90);
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
          var erste = zielReihe.querySelector('.focusable');
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

  function rememberFocus() {
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
        revealFocus(nodes[i]);
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
      img.src = url;
      img.onerror = function () { img.style.display = 'none'; };
      box.appendChild(img);
    }
    return box;
  }

  function card(title, imageUrl, onSelect, wide) {
    var c = element('div', 'card focusable' + (wide ? ' wide' : ''));
    c.tabIndex = 0;
    c.appendChild(posterBox(imageUrl, wide));
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

  function button(label, onClick, ghost) {
    var b = element('button', 'focusable' + (ghost ? ' ghost' : ''), label);
    // Beschriftungen sind je Seite eindeutig – als Merker für den Fokus genug.
    b.setAttribute('data-fkey', 'btn:' + label);
    b.onclick = onClick;
    return b;
  }

  function shelf(title, items, builder) {
    if (!items.length) return null;
    var wrap = document.createElement('div');
    wrap.appendChild(element('div', 'section-title', title));
    var row = element('div', 'row');
    for (var i = 0; i < items.length && i < 30; i++) row.appendChild(builder(items[i]));
    wrap.appendChild(row);
    return wrap;
  }

  // -------------------------------------------------- Abgeleitete Daten ----

  function progressList() {
    var out = [];
    for (var id in state.progress) {
      if (Object.prototype.hasOwnProperty.call(state.progress, id)) out.push(state.progress[id]);
    }
    out.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    return out;
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
    var seen = {}, out = [];
    for (var i = 0; i < items.length; i++) {
      var g = items[i].group;
      if (g && !seen[g]) { seen[g] = true; out.push(g); }
    }
    if (cacheKey) groupCache[cacheKey] = { len: items.length, list: out };
    return out;
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

  function onWatchlist(id) { return !!state.watchlist[id]; }

  function toggleWatchlist(id) {
    if (state.watchlist[id]) delete state.watchlist[id];
    else state.watchlist[id] = true;
    saveScoped('watchlist', state.watchlist);
  }

  function toggleFavorite(id) {
    if (state.favorites[id]) delete state.favorites[id];
    else state.favorites[id] = true;
    saveScoped('favorites', state.favorites);
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

  function designById(id) {
    for (var i = 0; i < DESIGNS.length; i++) if (DESIGNS[i].id === id) return DESIGNS[i];
    return DESIGNS[0];   // Perl – der iOS-Standard
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

    var accent = d.dark ? a.color : darken(a.color, 0.55);

    root.style.setProperty('--bg', d.bg);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-dim', hexToRgba(accent, d.dark ? 0.22 : 0.16));
    if (d.dark) {
      root.style.setProperty('--surface', 'rgba(255,255,255,0.06)');
      root.style.setProperty('--surface-strong', 'rgba(255,255,255,0.12)');
      root.style.setProperty('--border', 'rgba(255,255,255,0.12)');
      root.style.setProperty('--text', '#eae7f2');
      root.style.setProperty('--text-dim', '#a9a4bd');
      root.style.setProperty('--on-accent', '#12101f');
    } else {
      // Auf hellem Grund tragen weiße Schleier nicht – es braucht dunkle.
      root.style.setProperty('--surface', 'rgba(0,0,0,0.045)');
      root.style.setProperty('--surface-strong', 'rgba(0,0,0,0.10)');
      root.style.setProperty('--border', 'rgba(0,0,0,0.14)');
      root.style.setProperty('--text', '#1b1926');
      root.style.setProperty('--text-dim', '#5a5670');
      root.style.setProperty('--on-accent', '#ffffff');
    }

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
        'linear-gradient(to bottom, rgba(' + base + ',0) 30%, rgba(' + base + ',0.95) 100%)';
    }
  }

  /** Farbe abdunkeln – helle Akzente sind auf hellem Grund sonst unlesbar. */
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
    var scores = {};
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
    var pool = [];
    for (var j = 0; j < state.library.movies.length && pool.length < 20; j++) {
      var m = state.library.movies[j];
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

  // ----------------------------------------------------------- Seiten ----

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
    if (!state.source) { renderSetup(); return; }

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

    setTimeout(function () { if (!restoreFocus()) ensureFocus(); }, 0);
    // Zweiter Anlauf: Beim ersten Aufbau sind Bilder/Layout noch nicht fertig,
    // ein Fokus auf ein Element der Größe null greift nicht.
    setTimeout(ensureFocus, 350);
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
          setTimeout(focusFirst, 0);
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
          playItem(p.title, p.url, 'Noch ' + rest + ' Min.', p.kind, p.id, p.position, null,
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
    var s2 = shelf('Jetzt im TV', live, function (ch) {
      var now = Core.nowProgram(programsFor(ch));
      var c = card(ch.name, ch.logoURL, function () { playChannel(ch); }, true);
      if (now) {
        c.appendChild(element('div', 'sub', now.title));
        var span = now.end - now.start;
        c.appendChild(progressBar(span > 0 ? (Date.now() - now.start) / span : 0));
      }
      return c;
    });
    if (s2) el.content.appendChild(s2);

    // Merkliste vor den allgemeinen Regalen – bewusst Gemerktes zuerst.
    var listItems = pickByIds(lib.movies, state.watchlist)
      .concat(pickByIds(lib.series, state.watchlist));
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
      var sBec = shelf('Weil du „' + because.title + '" gesehen hast', because.items, function (m) {
        return card(m.title, m.posterURL, function () { openMovie(m); });
      });
      if (sBec) el.content.appendChild(sBec);
    }

    var forYouSeries = recommendations(lib.series, 'id', 20);
    var sForS = shelf('Serien für dich', forYouSeries, function (x) {
      return card(x.title, x.posterURL, function () { openSeries(x); });
    });
    if (sForS) el.content.appendChild(sForS);

    var s3 = shelf('Filme', lib.movies.slice(0, 30), function (m) {
      return card(m.title, m.posterURL, function () { openMovie(m); });
    });
    if (s3) el.content.appendChild(s3);

    var s4 = shelf('Serien', lib.series.slice(0, 30), function (s) {
      return card(s.title, s.posterURL, function () { openSeries(s); });
    });
    if (s4) el.content.appendChild(s4);

    if (!cont.length && !live.length && !lib.movies.length && !lib.series.length) {
      renderEmpty('Nichts geladen', 'Die Quelle hat keine Inhalte geliefert.');
    }
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

  function groupChips(groups, selected, onPick) {
    var wrap = element('div', 'chips');
    var all = element('span', 'chip focusable' + (selected ? '' : ' active'), 'Alle');
    all.tabIndex = 0;
    all.setAttribute('data-fkey', 'group:*');
    all.onclick = function () { onPick(null); };
    wrap.appendChild(all);
    for (var i = 0; i < groups.length && i < 40; i++) {
      (function (g) {
        var c = element('span', 'chip focusable' + (selected === g ? ' active' : ''), g);
        c.tabIndex = 0;
        c.setAttribute('data-fkey', 'group:' + g);
        c.onclick = function () { onPick(g); };
        wrap.appendChild(c);
      })(groups[i]);
    }
    return wrap;
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
      logo.src = ch.logoURL;
      logo.onerror = function () { logo.style.visibility = 'hidden'; };
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

    if (isFavorite(ch.id)) row.appendChild(element('span', 'badge-live', '★'));
    if (now) row.appendChild(element('span', 'badge-live', 'LIVE'));

    row.onclick = function () { playChannel(ch); };
    // Lange OK-Taste ist auf der Fernbedienung unzuverlässig – Favorit über
    // die blaue Farbtaste (403) im Tastatur-Handler.
    row._favTarget = ch.id;
    return row;
  }

  // ---- Filme / Serien ----

  function renderMovies() {
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
    for (var i = 0; i < list.length && i < 150; i++) {
      (function (m) {
        grid.appendChild(card(m.title, m.posterURL, function () { openMovie(m); }));
      })(list[i]);
    }
    el.content.appendChild(grid);
  }

  function renderSeriesList() {
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
    for (var i = 0; i < list.length && i < 150; i++) {
      (function (s) {
        grid.appendChild(card(s.title, s.posterURL, function () { openSeries(s); }));
      })(list[i]);
    }
    el.content.appendChild(grid);
  }

  // ---- Favoriten ----

  function renderFavorites() {
    var lib = state.library;
    // Aus den gemerkten IDs heraus arbeiten: Fünf Voll-Scans über die
    // Bibliothek für ein paar Dutzend Treffer waren pro Aufbau spürbar.
    var favChannels = pickByIds(lib.channels, state.favorites);
    var favMovies = pickByIds(lib.movies, state.favorites);
    var favSeries = pickByIds(lib.series, state.favorites);

    var listMoviesFav = pickByIds(lib.movies, state.watchlist);
    var listSeriesFav = pickByIds(lib.series, state.watchlist);
    var anyList = listMoviesFav.length > 0 || listSeriesFav.length > 0;
    if (!favChannels.length && !favMovies.length && !favSeries.length && !anyList) {
      return renderEmpty('Noch nichts gemerkt',
        'Markiere Sender mit der blauen Taste oder setze Titel auf der Detailseite ' +
        'auf „Meine Liste".');
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
    return button('‹ Zurück', function () { state.view = null; render(); }, true);
  }

  function detailHeader(title, backdrop, metaText) {
    var head = element('div', 'detail-head');
    var bd = element('div', 'detail-backdrop');
    if (backdrop) {
      var img = document.createElement('img');
      img.src = backdrop;
      img.onerror = function () { img.style.display = 'none'; };
      bd.appendChild(img);
    }
    var scrim = element('div', 'scrim');
    var d = designById(state.settings.design);
    var rgb = hexToRgba(d.bg, 1).replace('rgba(', '').replace(')', '').split(',');
    var base = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    scrim.style.background =
      'linear-gradient(to bottom, rgba(' + base + ',0) 30%, rgba(' + base + ',0.95) 100%)';
    bd.appendChild(scrim);
    head.appendChild(bd);
    head.appendChild(element('div', 'detail-title', title));
    if (metaText) head.appendChild(element('div', 'detail-meta', metaText));
    return head;
  }

  function openMovie(movie) {
    state.view = { type: 'movie', item: movie };
    render();
    // Xtream liefert Beschreibung/Backdrop erst auf Nachfrage.
    if (state.source.kind === 'xtream' && movie.xtreamStreamID && !movie._detailsTried) {
      movie._detailsTried = true;
      var url = Core.xtreamApi(state.source.host, state.source.user, state.source.pass,
        'get_vod_info', { vod_id: movie.xtreamStreamID });
      httpGetJson(url, function (err, json) {
        if (err || !json || !json.info) return;
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
        if (state.view && state.view.item === movie) render();
      });
    }
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
    if (canResume) {
      actions.appendChild(button('▶ Weiter ab ' + durationText(resume.position), function () {
        playItem(m.title, m.streamURL, m.group, 'movie', m.id, resume.position, null,
          { image: m.posterURL, group: m.group });
      }));
      actions.appendChild(button('Von vorn', function () {
        playItem(m.title, m.streamURL, m.group, 'movie', m.id, 0, null,
          { image: m.posterURL, group: m.group });
      }, true));
    } else {
      actions.appendChild(button('▶ Abspielen', function () {
        playItem(m.title, m.streamURL, m.group, 'movie', m.id, 0, null,
          { image: m.posterURL, group: m.group });
      }));
    }
    actions.appendChild(button(isFavorite(m.id) ? '★ Favorit' : '☆ Favorit', function () {
      toggleFavorite(m.id); render();
    }, true));
    actions.appendChild(button(onWatchlist(m.id) ? '✓ Auf meiner Liste' : '+ Meine Liste', function () {
      toggleWatchlist(m.id); render();
    }, true));
    el.content.appendChild(actions);

    if (m.plot) el.content.appendChild(element('div', 'detail-plot', m.plot));
    if (m.director) el.content.appendChild(element('div', 'detail-meta', 'Regie: ' + m.director));
    if (m.cast) el.content.appendChild(element('div', 'detail-meta', 'Besetzung: ' + m.cast));

    // Ähnliche Titel aus derselben Kategorie.
    // Schleife mit Abbruch: `.filter()` lief über alle 142.000 Titel, obwohl
    // nur 20 gezeigt werden.
    var similar = [];
    for (var si = 0; si < state.library.movies.length && similar.length < 20; si++) {
      var cand = state.library.movies[si];
      if (cand.group === m.group && cand.id !== m.id) similar.push(cand);
    }
    var s = shelf('Ähnliche Titel', similar, function (x) {
      return card(x.title, x.posterURL, function () { openMovie(x); });
    });
    if (s) el.content.appendChild(s);
  }

  function openSeries(series) {
    state.view = { type: 'series', item: series, season: null };
    if (series.episodes && series.episodes.length) { render(); return; }
    if (state.source.kind !== 'xtream' || !series.xtreamSeriesID) { render(); return; }

    state.loading = true; render();
    var url = Core.xtreamApi(state.source.host, state.source.user, state.source.pass,
      'get_series_info', { series_id: series.xtreamSeriesID });
    httpGetJson(url, function (err, json) {
      state.loading = false;
      if (!err && json) {
        series.episodes = Core.parseEpisodes(json, state.source.host,
          state.source.user, state.source.pass, series.id);
        if (json.info) {
          series.plot = series.plot || json.info.plot;
          series.backdropURL = (json.info.backdrop_path && json.info.backdrop_path.length)
            ? (typeof json.info.backdrop_path === 'string' ? json.info.backdrop_path : json.info.backdrop_path[0])
            : null;
        }
      } else {
        toast('Folgen konnten nicht geladen werden: ' + (err ? err.message : 'unbekannt'), 5000);
      }
      render();
    });
  }

  function renderSeriesDetail(s) {
    el.content.appendChild(backButton());
    el.content.appendChild(detailHeader(s.title, s.backdropURL || s.posterURL,
      s.episodes.length + ' Folgen' + (s.rating ? '   ·   ★ ' + Number(s.rating).toFixed(1) : '')));

    var actions = element('div', 'detail-actions');
    actions.appendChild(button(isFavorite(s.id) ? '★ Favorit' : '☆ Favorit', function () {
      toggleFavorite(s.id); render();
    }, true));
    actions.appendChild(button(onWatchlist(s.id) ? '✓ Auf meiner Liste' : '+ Meine Liste', function () {
      toggleWatchlist(s.id); render();
    }, true));
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
          img.className = 'logo'; img.src = ep.imageURL;
          img.onerror = function () { img.style.visibility = 'hidden'; };
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
          playItem(s.title + ' · ' + label, ep.streamURL, ep.title, 'episode', ep.id,
            p ? p.position : 0, { series: s, episode: ep },
            { image: ep.imageURL || s.posterURL, group: s.group });
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
    input.value = state.view.query || '';
    panel.appendChild(input);
    var go = button('Suchen', function () {
      state.view.query = input.value;
      render();
    });
    panel.appendChild(go);
    el.content.appendChild(panel);

    var q = (state.view.query || '').toLowerCase();
    if (q.length < 2) return;

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
    var ch = search(state.library.channels, 'name', 30);
    var mv = search(state.library.movies, 'title', 30);
    var sr = search(state.library.series, 'title', 30);

    if (!ch.length && !mv.length && !sr.length) {
      return renderEmpty('Keine Treffer', 'Für „' + state.view.query + '" wurde nichts gefunden.');
    }
    if (ch.length) {
      el.content.appendChild(element('div', 'section-title', 'Sender'));
      var box = document.createElement('div');
      for (var i = 0; i < ch.length; i++) box.appendChild(channelRow(ch[i], null));
      el.content.appendChild(box);
    }
    var s1 = shelf('Filme', mv, function (m) {
      return card(m.title, m.posterURL, function () { openMovie(m); });
    });
    if (s1) el.content.appendChild(s1);
    var s2 = shelf('Serien', sr, function (s) {
      return card(s.title, s.posterURL, function () { openSeries(s); });
    });
    if (s2) el.content.appendChild(s2);
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
    el.content.appendChild(element('div', 'section-title', 'Jetzt und danach'));
    var box = document.createElement('div');
    for (var i = 0; i < withEpg.length && i < 100; i++) {
      (function (ch) {
        var programs = programsFor(ch);
        var now = Core.nowProgram(programs);
        var next = Core.nextProgram(programs);
        var row = element('div', 'channel focusable' + (now ? ' on-air' : ''));
        row.tabIndex = 0;
        if (ch.logoURL) {
          var img = document.createElement('img');
          img.className = 'logo'; img.src = ch.logoURL;
          img.onerror = function () { img.style.visibility = 'hidden'; };
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
        row._favTarget = ch.id;
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

    panel.appendChild(element('div', 'section-title', 'Bibliothek'));
    panel.appendChild(element('p', null,
      state.library.channels.length + ' Sender · ' + state.library.movies.length +
      ' Filme · ' + state.library.series.length + ' Serien'));

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
    }, true));
    actions.appendChild(button('Verlauf löschen (dieses Profil)', function () {
      state.progress = {}; saveScoped('progress', state.progress);
      toast('Verlauf gelöscht.');
    }, true));
    panel.appendChild(actions);
    el.content.appendChild(panel);

    // ---- Profile ----
    el.content.appendChild(element('div', 'section-title',
      'Profile (aktiv: ' + profileName(state.activeProfile) + ')'));
    var profileBox = element('div', 'chips');
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
        toast('Profil „' + v + '" angelegt.');
        render();
      }));
      newPanel.appendChild(newActions);
      el.content.appendChild(newPanel);
    }

    // ---- Design ----
    el.content.appendChild(element('div', 'section-title', 'Design'));
    var designChips = element('div', 'chips');
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
    var accentChips = element('div', 'chips');
    for (var j = 0; j < ACCENTS.length; j++) {
      (function (a) {
        var c = element('span', 'chip focusable' + (state.settings.accent === a.id ? ' active' : ''), a.name);
        c.tabIndex = 0;
        c.setAttribute('data-fkey', 'accent:' + a.id);
        c.style.borderColor = a.color;
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

    var strictActions = element('div', 'actions');
    strictActions.appendChild(button(
      state.settings.strict ? 'Strikt filtern: an' : 'Strikt filtern: aus',
      function () {
        state.settings.strict = !state.settings.strict;
        save('settings', state.settings);
        applyLanguageFilter();
        render();
      }, true));
    el.content.appendChild(strictActions);

    // ---- Kategorien ausblenden ----
    var groups = allGroups();
    el.content.appendChild(element('div', 'section-title',
      'Kategorien ausblenden (' + state.settings.hiddenGroups.length + ' von ' + groups.length + ')'));
    el.content.appendChild(element('div', 'detail-meta',
      'Ohne PIN – reines Aufräumen. Bei großen Playlisten die wirksamste Bremse.'));
    var groupActions = element('div', 'actions');
    groupActions.appendChild(button(
      state.view.showGroups ? 'Liste zuklappen' : 'Kategorien wählen',
      function () { state.view.showGroups = !state.view.showGroups; render(); }, true));
    if (state.settings.hiddenGroups.length) {
      groupActions.appendChild(button('Alle wieder zeigen', function () {
        state.settings.hiddenGroups = [];
        save('settings', state.settings); applyLanguageFilter(); render();
      }, true));
    }
    el.content.appendChild(groupActions);

    if (state.view.showGroups) {
      var groupChipBox = element('div', 'chips');
      // Bei tausenden Kategorien nur die ersten 80 – alles andere bremst den TV.
      for (var g = 0; g < groups.length && g < 80; g++) {
        (function (name) {
          var hidden = state.settings.hiddenGroups.indexOf(name) >= 0;
          var c = element('span', 'chip focusable' + (hidden ? ' active' : ''),
            (hidden ? '✕ ' : '') + name);
          c.tabIndex = 0;
          c.setAttribute('data-fkey', 'hide:' + name);
          c.onclick = function () {
            var idx = state.settings.hiddenGroups.indexOf(name);
            if (idx >= 0) state.settings.hiddenGroups.splice(idx, 1);
            else state.settings.hiddenGroups.push(name);
            save('settings', state.settings); applyLanguageFilter(); render();
          };
          groupChipBox.appendChild(c);
        })(groups[g]);
      }
      el.content.appendChild(groupChipBox);
      if (groups.length > 80) {
        el.content.appendChild(element('div', 'detail-meta',
          (groups.length - 80) + ' weitere Kategorien werden hier nicht gezeigt.'));
      }
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
        save('settings', state.settings);
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
        save('settings', state.settings);
        applyLanguageFilter(); render();
      }, true));
      el.content.appendChild(lockActions);

      el.content.appendChild(element('div', 'detail-meta',
        state.settings.lockedGroups.length + ' Kategorien gesperrt.'));
      var lockChips = element('div', 'chips');
      var gs = allGroups();
      for (var h = 0; h < gs.length && h < 80; h++) {
        (function (name) {
          var locked = state.settings.lockedGroups.indexOf(name) >= 0;
          var c = element('span', 'chip focusable' + (locked ? ' active' : ''),
            (locked ? '🔒 ' : '') + name);
          c.tabIndex = 0;
          c.setAttribute('data-fkey', 'lock:' + name);
          c.onclick = function () {
            var idx = state.settings.lockedGroups.indexOf(name);
            if (idx >= 0) state.settings.lockedGroups.splice(idx, 1);
            else state.settings.lockedGroups.push(name);
            save('settings', state.settings); render();
          };
          lockChips.appendChild(c);
        })(gs[h]);
      }
      el.content.appendChild(lockChips);
    }
  }

  function renderSetup() {
    var saved = load('source', null);
    var panel = element('div', 'panel');
    panel.appendChild(element('h2', null, 'Quelle einrichten'));
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
    setTimeout(function () { host.focus(); }, 0);
  }

  // ----------------------------------------------------------- Laden ----

  /**
   * Sprachfilter auf die Rohbibliothek anwenden. Die ungefilterte Fassung
   * bleibt erhalten, sonst ließe sich der Filter nie wieder lockern.
   */
  function applyLanguageFilter() {
    if (!state.rawLibrary) return;
    groupCache = {};        // Bibliothek ändert sich – Puffer verwerfen
    allGroupsCache = null;
    sortCache = {};
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
  }

  /** Alle Kategorien der ROHEN Bibliothek – auch die ausgeblendeten, sonst
   *  ließen die sich nie wieder einblenden. */
  var allGroupsCache = null;

  function allGroups() {
    if (allGroupsCache) return allGroupsCache;
    if (!state.rawLibrary) return [];
    var seen = {}, out = [];
    function add(list) {
      for (var i = 0; i < list.length; i++) {
        var g = list[i].group;
        if (g && !seen[g]) { seen[g] = true; out.push(g); }
      }
    }
    add(state.rawLibrary.channels); add(state.rawLibrary.movies); add(state.rawLibrary.series);
    out.sort();
    allGroupsCache = out;
    return out;
  }

  function afterLoad(lib) {
    state.rawLibrary = lib;
    state.epgURL = lib.epgURL || null;
    applyLanguageFilter();
    toast(state.library.channels.length + ' Sender · ' + state.library.movies.length +
      ' Filme · ' + state.library.series.length + ' Serien');
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
    state.loading = true;
    state.loadingStep = 'Anmeldung wird geprüft …';
    render();

    var categories = { live: {}, vod: {}, series: {} };
    var lib = { channels: [], movies: [], series: [] };
    var problems = [];
    var authError = null;

    function fail(bereich, err) {
      // Jeden Teilbereich einzeln benennen: Früher wurden Fehler bei Filmen und
      // Serien verschluckt – der Nutzer sah eine leere Seite und hielt seinen
      // Anbieter für kaputt.
      problems.push(bereich + ' (' + (err && err.message ? err.message : 'unbekannt') + ')');
    }

    function finish() {
      state.loading = false;
      state.loadingStep = null;
      if (authError) { render(); return toast('Anmeldung fehlgeschlagen: ' + authError.message, 8000); }
      state.source = { kind: 'xtream', host: host, user: user, pass: pass };
      save('source', state.source);
      try {
        afterLoad(lib);
      } catch (parseError) {
        render();
        return toast('Bibliothek konnte nicht aufgebaut werden: ' + parseError.message, 9000);
      }
      if (problems.length) {
        toast('Teilweise geladen – nicht abrufbar: ' + problems.join(', ') +
          '. In den Einstellungen „Neu laden" versuchen.', 9000);
      }
      loadEpg();
    }

    // Nacheinander statt gleichzeitig: Drei zweistellige Megabyte-Antworten
    // parallel teilen sich die Bandbreite und laufen eher ins Zeitlimit.
    function step1auth() {
      httpGetJson(Core.xtreamApi(host, user, pass, null), function (err, json) {
        if (err) authError = err;
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

    function step3vod() {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_vod_categories'), function (e1, cats) {
        if (!e1 && cats) categories.vod = Core.parseCategories(cats);
        httpGetJson(Core.xtreamApi(host, user, pass, 'get_vod_streams'), function (err, json) {
          if (err) fail('Filme', err);
          else try { lib.movies = Core.parseVodStreams(json, categories.vod, host, user, pass, 'xtream'); }
          catch (pe) { fail('Filme', pe); }
          state.loadingStep = 'Serien werden geladen …'; render();
          step4series();
        }, CATALOG_TIMEOUT);
      }, 30000);
    }

    function step4series() {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_series_categories'), function (e1, cats) {
        if (!e1 && cats) categories.series = Core.parseCategories(cats);
        httpGetJson(Core.xtreamApi(host, user, pass, 'get_series'), function (err, json) {
          if (err) fail('Serien', err);
          else try { lib.series = Core.parseSeriesList(json, categories.series, 'xtream'); }
          catch (pe) { fail('Serien', pe); }
          finish();
        }, CATALOG_TIMEOUT);
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
    playItem(ch.name, ch.streamURL, now ? now.title : ch.group, 'live', ch.id, 0,
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
        try { el.video.currentTime = resumeSeconds; } catch (e) { /* egal */ }
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
        if (player.lastSaved === undefined || Math.abs(pos - player.lastSaved) >= 10) {
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
      // Bewusst die ursprünglich angeforderte Adresse, nicht `currentSrc`:
      // Letztere trägt bei Xtream Benutzer und Passwort im Pfad, und der
      // Verlauf liegt unverschlüsselt im Gerätespeicher.
      url: player.sourceUrl || '',
      // Poster und Kategorie kommen vom Aufrufer: ohne sie hätte
      // „Weiterschauen" kein Bild und die Empfehlungen keine Grundlage.
      image: (player.meta && player.meta.image) || prev.image || null,
      group: (player.meta && player.meta.group) || prev.group || null,
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
    if (player.tickTimer) { clearInterval(player.tickTimer); player.tickTimer = null; }
    if (player.hideTimer) { clearTimeout(player.hideTimer); player.hideTimer = null; }
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
    setTimeout(focusFirst, 0);
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
    var list = state.library.channels;
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
          nx.streamURL, nx.title, 'episode', nx.id, 0, { series: s, episode: nx },
          { image: nx.imageURL || s.posterURL, group: s.group });
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------ Tastatur ----

  // webOS-Fernbedienung: Pfeile 37–40, OK 13, Zurück 461.
  // Farbtasten: rot 403, grün 404, gelb 405, blau 406.
  // Medientasten: Play 415, Pause 19, Stop 413, FF 417, RW 412.
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
      if (state.view) { state.view = null; render(); e.preventDefault(); return; }
      if (state.gate) return;              // Profilwahl ist die oberste Ebene
      if (state.tab !== 'home') { state.tab = 'home'; render(); e.preventDefault(); return; }
      exitApp();
      e.preventDefault();
      return;
    }
    // Blaue Taste: Favorit umschalten für die fokussierte Zeile/Karte.
    if (code === 406) {
      var a = document.activeElement;
      if (a && a._favTarget) {
        toggleFavorite(a._favTarget);
        toast(isFavorite(a._favTarget) ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt', 2000);
        render();
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
      var el2 = document.activeElement;
      if (el2 && el2.tagName !== 'INPUT' && el2.click) el2.click();
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
  function exitApp() {
    if (typeof webOS !== 'undefined' && webOS.platformBack) { webOS.platformBack(); return; }
    if (typeof window.close === 'function') {
      try { window.close(); return; } catch (e) { /* weiter unten */ }
    }
    // Letzter Ausweg: Der Systemdienst schließt die App zuverlässig.
    try {
      var b = new PalmServiceBridge();
      b.onservicecallback = function () {};
      b.call('luna://com.webos.applicationManager/close', JSON.stringify({ id: 'de.app.glasstv' }));
    } catch (e2) { /* dann bleibt nur die Home-Taste */ }
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
      state.settings.strict = saved.strict !== false;
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
    });
    el.video.addEventListener('playing', function () {
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

    document.addEventListener('keydown', onKey);

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
