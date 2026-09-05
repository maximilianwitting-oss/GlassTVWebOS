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
    progress: {},        // id -> { position, duration, updatedAt, title, url, image, kind }
    settings: {
      languages: [], strict: true, design: 'midnight', accent: 'violet', sort: 'standard',
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

  function save(key, value) {
    try { localStorage.setItem('glasstv.' + key, JSON.stringify(value)); } catch (e) { /* Speicher voll */ }
  }

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem('glasstv.' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
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

  function httpGetJson(url, cb) {
    httpGet(url, function (err, text) {
      if (err) return cb(err, null);
      try { cb(null, JSON.parse(text)); } catch (e) { cb(new Error('Ungültige Antwort'), null); }
    });
  }

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
    if (target) target.focus();
  }

  function moveFocus(dx, dy) {
    collectFocusables();
    var active = document.activeElement;
    if (!active || focusables.indexOf(active) < 0) { focusFirst(); return; }
    var from = active.getBoundingClientRect();
    var best = null, bestScore = Infinity;

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
      // Abstand in Richtung zählt voll, seitlicher Versatz dreifach.
      var along = Math.abs(dx ? ddx : ddy);
      var across = Math.abs(dx ? ddy : ddx);
      var score = along + across * 3;
      if (score < bestScore) { bestScore = score; best = node; }
    }
    if (best) {
      best.focus();
      if (best.scrollIntoView) {
        try { best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        catch (e) { best.scrollIntoView(false); }   // Chromium 53 kennt die Optionen nicht
      }
    }
  }

  // ---------------------------------------------------------- Bausteine ----

  function toast(message, ms) {
    el.toast.textContent = message;
    el.toast.className = 'show';
    if (toast._t) clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.className = ''; }, ms || 3500);
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

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

  function groupsOf(items, nameKey) {
    var seen = {}, out = [];
    for (var i = 0; i < items.length; i++) {
      var g = items[i].group;
      if (g && !seen[g]) { seen[g] = true; out.push(g); }
    }
    return out;
  }

  function programsFor(ch) {
    return ch.epgID ? state.epg[ch.epgID.toLowerCase()] : null;
  }

  function isFavorite(id) { return !!state.favorites[id]; }

  function toggleFavorite(id) {
    if (state.favorites[id]) delete state.favorites[id];
    else state.favorites[id] = true;
    save('favorites', state.favorites);
  }


  // --------------------------------------------------------- Designs ----

  /**
   * Designs aus der iOS-App, auf die dunklen beschränkt: Ein heller
   * Hintergrund blendet im abgedunkelten Wohnzimmer und ist auf OLED zudem
   * der einzige Fall, in dem der Fernseher nennenswert Strom zieht.
   */
  var DESIGNS = [
    { id: 'midnight', name: 'Mitternacht', bg: '#0b0a17', g1: 'rgba(140,128,247,0.22)', g2: 'rgba(38,77,230,0.16)' },
    { id: 'oled', name: 'Pur Schwarz', bg: '#000000', g1: 'rgba(140,128,247,0.10)', g2: 'rgba(0,0,0,0)' },
    { id: 'graphite', name: 'Graphit', bg: '#131316', g1: 'rgba(255,255,255,0.05)', g2: 'rgba(140,128,247,0.12)' },
    { id: 'aurora', name: 'Aurora', bg: '#050a17', g1: 'rgba(0,184,166,0.22)', g2: 'rgba(217,64,153,0.18)' },
    { id: 'nebula', name: 'Galaxie', bg: '#0d0519', g1: 'rgba(140,51,217,0.30)', g2: 'rgba(230,64,153,0.22)' },
    { id: 'ocean', name: 'Ozean', bg: '#040d1a', g1: 'rgba(0,115,217,0.24)', g2: 'rgba(0,191,184,0.18)' },
    { id: 'forest', name: 'Wald', bg: '#06100a', g1: 'rgba(31,153,89,0.20)', g2: 'rgba(128,179,51,0.12)' },
    { id: 'sunset', name: 'Sonnenuntergang', bg: '#170910', g1: 'rgba(255,107,51,0.26)', g2: 'rgba(217,51,102,0.20)' },
    { id: 'crimson', name: 'Purpur', bg: '#170508', g1: 'rgba(217,31,51,0.28)', g2: 'rgba(128,13,38,0.24)' },
    { id: 'mocha', name: 'Mokka', bg: '#140f0d', g1: 'rgba(140,97,61,0.24)', g2: 'rgba(102,66,46,0.20)' },
    { id: 'champagner', name: 'Champagner', bg: '#161310', g1: 'rgba(219,184,107,0.24)', g2: 'rgba(184,140,77,0.18)' },
    { id: 'kupfer', name: 'Kupfer', bg: '#170e0a', g1: 'rgba(209,115,61,0.26)', g2: 'rgba(153,77,41,0.20)' },
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
    return DESIGNS[0];
  }

  function accentById(id) {
    for (var i = 0; i < ACCENTS.length; i++) if (ACCENTS[i].id === id) return ACCENTS[i];
    return ACCENTS[0];
  }

  /** Design + Akzent auf die Seite anwenden (CSS-Variablen, Chromium 49+). */
  function applyTheme() {
    var d = designById(state.settings.design);
    var a = accentById(state.settings.accent);
    var root = document.documentElement;
    if (root.style.setProperty) {
      root.style.setProperty('--bg', d.bg);
      root.style.setProperty('--accent', a.color);
      root.style.setProperty('--accent-dim', hexToRgba(a.color, 0.22));
    }
    document.getElementById('backdrop').style.background =
      'radial-gradient(60% 60% at 0% 0%, ' + hexToRgba(a.color, 0.20) + ', transparent 70%),' +
      'radial-gradient(60% 60% at 100% 100%, ' + d.g2 + ', transparent 70%),' + d.bg;
    document.body.style.background = d.bg;
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

  function sortItems(list, titleKey) {
    var sort = state.settings.sort;
    if (!sort || sort === 'standard') return list;
    var copy = list.slice();
    if (sort === 'name') {
      copy.sort(function (a, b) { return (a[titleKey] || '').localeCompare(b[titleKey] || ''); });
    } else if (sort === 'year') {
      // Titel ohne Jahr ans Ende statt nach vorn spülen.
      copy.sort(function (a, b) { return (parseInt(b.year, 10) || -1) - (parseInt(a.year, 10) || -1); });
    } else if (sort === 'rating') {
      copy.sort(function (a, b) { return (Number(b.rating) || -1) - (Number(a.rating) || -1); });
    }
    return copy;
  }

  // ----------------------------------------------------------- Seiten ----

  function render() {
    renderTabs();
    clear(el.content);

    if (state.loading) { el.content.appendChild(element('div', 'spinner')); return; }
    if (!state.source) { renderSetup(); return; }

    if (state.view) {
      if (state.view.type === 'movie') renderMovieDetail(state.view.item);
      else if (state.view.type === 'series') renderSeriesDetail(state.view.item);
      else if (state.view.type === 'guide') renderGuide();
      else if (state.view.type === 'search') renderSearch();
      else if (state.view.type === 'settings') renderSettings();
    } else if (state.tab === 'home') renderHome();
    else if (state.tab === 'live') renderChannels();
    else if (state.tab === 'movies') renderMovies();
    else if (state.tab === 'series') renderSeriesList();
    else renderFavorites();

    setTimeout(focusFirst, 0);
  }

  function renderTabs() {
    clear(el.tabs);
    for (var i = 0; i < TABS.length; i++) {
      (function (t) {
        var active = !state.view && state.tab === t.id;
        var b = element('button', 'tab focusable' + (active ? ' active' : ''), t.label);
        b.onclick = function () { state.tab = t.id; state.view = null; render(); };
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
          playItem(p.title, p.url, 'Noch ' + rest + ' Min.', p.kind, p.id, p.position);
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

    var groups = groupsOf(all);
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
        renderChannelChunk(box, list, from + count, 120);
        collectFocusables();
      }, true);
      box.appendChild(more);
    }
  }

  function groupChips(groups, selected, onPick) {
    var wrap = element('div', 'chips');
    var all = element('span', 'chip focusable' + (selected ? '' : ' active'), 'Alle');
    all.tabIndex = 0;
    all.onclick = function () { onPick(null); };
    wrap.appendChild(all);
    for (var i = 0; i < groups.length && i < 40; i++) {
      (function (g) {
        var c = element('span', 'chip focusable' + (selected === g ? ' active' : ''), g);
        c.tabIndex = 0;
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

    var groups = groupsOf(all);
    el.content.appendChild(groupChips(groups, state.group.movies, function (g) {
      state.group.movies = g; render();
    }));

    var list = state.group.movies
      ? all.filter(function (m) { return m.group === state.group.movies; })
      : all;
    list = sortItems(list, 'title');
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

    var groups = groupsOf(all);
    el.content.appendChild(groupChips(groups, state.group.series, function (g) {
      state.group.series = g; render();
    }));

    var list = state.group.series
      ? all.filter(function (s) { return s.group === state.group.series; })
      : all;
    list = sortItems(list, 'title');
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
    var favChannels = lib.channels.filter(function (c) { return isFavorite(c.id); });
    var favMovies = lib.movies.filter(function (m) { return isFavorite(m.id); });
    var favSeries = lib.series.filter(function (s) { return isFavorite(s.id); });

    if (!favChannels.length && !favMovies.length && !favSeries.length) {
      return renderEmpty('Noch keine Favoriten',
        'Markiere Sender oder Titel mit der blauen Taste bzw. auf der Detailseite.');
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
    bd.appendChild(element('div', 'scrim'));
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
        playItem(m.title, m.streamURL, m.group, 'movie', m.id, resume.position);
      }));
      actions.appendChild(button('Von vorn', function () {
        playItem(m.title, m.streamURL, m.group, 'movie', m.id, 0);
      }, true));
    } else {
      actions.appendChild(button('▶ Abspielen', function () {
        playItem(m.title, m.streamURL, m.group, 'movie', m.id, 0);
      }));
    }
    actions.appendChild(button(isFavorite(m.id) ? '★ Favorit' : '☆ Favorit', function () {
      toggleFavorite(m.id); render();
    }, true));
    el.content.appendChild(actions);

    if (m.plot) el.content.appendChild(element('div', 'detail-plot', m.plot));
    if (m.director) el.content.appendChild(element('div', 'detail-meta', 'Regie: ' + m.director));
    if (m.cast) el.content.appendChild(element('div', 'detail-meta', 'Besetzung: ' + m.cast));

    // Ähnliche Titel aus derselben Kategorie.
    var similar = state.library.movies.filter(function (x) {
      return x.group === m.group && x.id !== m.id;
    }).slice(0, 20);
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
            p ? p.position : 0, { series: s, episode: ep });
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

    function matches(text) { return text && text.toLowerCase().indexOf(q) >= 0; }

    var ch = state.library.channels.filter(function (c) { return matches(c.name); }).slice(0, 30);
    var mv = state.library.movies.filter(function (m) { return matches(m.title); }).slice(0, 30);
    var sr = state.library.series.filter(function (s) { return matches(s.title); }).slice(0, 30);

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

  function renderSettings() {
    el.content.appendChild(backButton());
    var panel = element('div', 'panel');
    panel.appendChild(element('h2', null, 'Einstellungen'));

    var src = state.source;
    panel.appendChild(element('p', null, src
      ? ('Aktuelle Quelle: ' + (src.kind === 'xtream' ? src.host : src.m3u))
      : 'Keine Quelle eingerichtet.'));

    panel.appendChild(element('div', 'section-title', 'Bibliothek'));
    panel.appendChild(element('p', null,
      state.library.channels.length + ' Sender · ' + state.library.movies.length +
      ' Filme · ' + state.library.series.length + ' Serien'));

    var actions = element('div', 'actions');
    actions.appendChild(button('Neu laden', function () {
      state.view = null;
      reloadSource();
    }));
    actions.appendChild(button('Quelle ändern', function () {
      state.source = null; state.view = null; render();
    }, true));
    actions.appendChild(button('Favoriten löschen', function () {
      state.favorites = {}; save('favorites', state.favorites);
      toast('Favoriten gelöscht.');
    }, true));
    actions.appendChild(button('Verlauf löschen', function () {
      state.progress = {}; save('progress', state.progress);
      toast('Verlauf gelöscht.');
    }, true));
    panel.appendChild(actions);
    el.content.appendChild(panel);

    // ---- Design ----
    el.content.appendChild(element('div', 'section-title', 'Design'));
    var designChips = element('div', 'chips');
    for (var i = 0; i < DESIGNS.length; i++) {
      (function (d) {
        var c = element('span', 'chip focusable' + (state.settings.design === d.id ? ' active' : ''), d.name);
        c.tabIndex = 0;
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
    var lib = state.settings.languages.length
      ? Core.filterByLanguage(state.rawLibrary, state.settings.languages, state.settings.strict)
      : state.rawLibrary;

    // Ausgeblendete Kategorien immer, gesperrte nur solange nicht entsperrt.
    var blocked = state.settings.hiddenGroups.slice();
    if (state.settings.pin && !state.unlocked) {
      blocked = blocked.concat(state.settings.lockedGroups);
    }
    if (blocked.length) {
      var isBlocked = function (item) { return blocked.indexOf(item.group) >= 0; };
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
  function allGroups() {
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
    return out;
  }

  function afterLoad(lib) {
    state.rawLibrary = lib;
    applyLanguageFilter();
    toast(state.library.channels.length + ' Sender · ' + state.library.movies.length +
      ' Filme · ' + state.library.series.length + ' Serien');
    render();
  }

  function loadM3USource(url) {
    state.loading = true; render();
    httpGet(url, function (err, text) {
      state.loading = false;
      if (err) { render(); return toast('M3U konnte nicht geladen werden: ' + err.message, 6000); }
      state.source = { kind: 'm3u', m3u: url };
      save('source', state.source);
      afterLoad(Core.parseM3U(text, 'm3u'));
    }, 60000);
  }

  function loadXtreamSource(host, user, pass) {
    state.loading = true; render();
    var pending = 4;
    var categories = { live: {}, vod: {}, series: {} };
    var lib = { channels: [], movies: [], series: [] };
    var failed = null;

    function step() {
      if (--pending > 0) return;
      state.loading = false;
      if (failed && !lib.channels.length && !lib.movies.length && !lib.series.length) {
        render();
        return toast('Anmeldung fehlgeschlagen: ' + failed.message, 6000);
      }
      state.source = { kind: 'xtream', host: host, user: user, pass: pass };
      save('source', state.source);
      afterLoad(lib);
      loadEpg();
    }

    function categoriesThen(action, key, then) {
      httpGetJson(Core.xtreamApi(host, user, pass, action), function (err, json) {
        if (!err && json) categories[key] = Core.parseCategories(json);
        then();
      });
    }

    categoriesThen('get_live_categories', 'live', function () {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_live_streams'), function (err, json) {
        if (err) failed = err;
        else lib.channels = Core.parseLiveStreams(json, categories.live, host, user, pass, 'xtream');
        step();
      });
    });
    categoriesThen('get_vod_categories', 'vod', function () {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_vod_streams'), function (err, json) {
        if (!err && json) lib.movies = Core.parseVodStreams(json, categories.vod, host, user, pass, 'xtream');
        step();
      });
    });
    categoriesThen('get_series_categories', 'series', function () {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_series'), function (err, json) {
        if (!err && json) lib.series = Core.parseSeriesList(json, categories.series, 'xtream');
        step();
      });
    });
    // Vierter Schritt: Auth prüfen, damit ein falsches Passwort eine klare
    // Meldung ergibt statt dreier leerer Listen.
    httpGetJson(Core.xtreamApi(host, user, pass, null), function (err, json) {
      if (err) failed = err;
      else if (json && json.user_info && Number(json.user_info.auth) === 0) {
        failed = new Error('Benutzer oder Passwort falsch');
      }
      step();
    });
  }

  function reloadSource() {
    if (!state.source) return render();
    if (state.source.kind === 'm3u') loadM3USource(state.source.m3u);
    else loadXtreamSource(state.source.host, state.source.user, state.source.pass);
  }

  function loadEpg() {
    if (!state.source || state.source.kind !== 'xtream') return;
    var url = state.source.host + '/xmltv.php?username=' +
      encodeURIComponent(state.source.user) + '&password=' + encodeURIComponent(state.source.pass);
    httpGet(url, function (err, text) {
      if (err || !text) return;          // EPG ist Zugabe – ein Fehler darf nichts kippen
      try {
        state.epg = Core.parseXMLTV(text);
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
    playItem(ch.name, ch.streamURL, now ? now.title : ch.group, 'live', ch.id, 0, { channel: ch });
  }

  function playItem(title, url, subtitle, kind, id, resumeSeconds, context) {
    player.open = true;
    player.kind = kind;
    player.id = id;
    player.title = title;
    player.context = context || null;

    el.playerTitle.textContent = title;
    el.playerSub.textContent = subtitle || '';
    el.player.className = 'open';
    el.scrubFill.style.width = '0%';
    el.times.textContent = kind === 'live' ? 'Live' : '';

    el.video.src = url;
    el.video.load();
    if (resumeSeconds && resumeSeconds > 0) {
      // currentTime lässt sich erst setzen, wenn Metadaten da sind.
      var seek = function () {
        try { el.video.currentTime = resumeSeconds; } catch (e) { /* egal */ }
        el.video.removeEventListener('loadedmetadata', seek);
      };
      el.video.addEventListener('loadedmetadata', seek);
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
        if (Math.floor(pos) % 10 === 0) saveProgress(pos, dur);
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
    if (!player.id || player.kind === 'live') return;
    state.progress[player.id] = {
      id: player.id, kind: player.kind, title: player.title,
      url: el.video.currentSrc || el.video.src,
      image: null, position: position, duration: duration, updatedAt: Date.now(),
    };
    save('progress', state.progress);
  }

  function closePlayer() {
    if (el.video.duration && isFinite(el.video.duration)) {
      saveProgress(el.video.currentTime || 0, el.video.duration);
    }
    player.open = false;
    if (player.tickTimer) { clearInterval(player.tickTimer); player.tickTimer = null; }
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
          nx.streamURL, nx.title, 'episode', nx.id, 0, { series: s, episode: nx });
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

    if (player.open) {
      pokeChrome();
      if (code === 461 || code === 8 || code === 27 || code === 413) { closePlayer(); e.preventDefault(); return; }
      if (code === 13 || code === 415 || code === 19) {
        if (el.video.paused) el.video.play(); else el.video.pause();
        e.preventDefault(); return;
      }
      if (code === 39 || code === 417) {
        if (player.kind === 'live') zap(1); else el.video.currentTime += 10;
        e.preventDefault(); return;
      }
      if (code === 37 || code === 412) {
        if (player.kind === 'live') zap(-1); else el.video.currentTime -= 10;
        e.preventDefault(); return;
      }
      if (code === 38) { if (player.kind === 'live') zap(-1); e.preventDefault(); return; }
      if (code === 40) { if (player.kind === 'live') zap(1); e.preventDefault(); return; }
      return;
    }

    if (code === 461 || code === 8) {
      if (state.view) { state.view = null; render(); e.preventDefault(); return; }
      if (typeof webOS !== 'undefined' && webOS.platformBack) webOS.platformBack();
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

    state.favorites = load('favorites', {}) || {};
    state.progress = load('progress', {}) || {};
    var saved = load('settings', null);
    if (saved) {
      state.settings.languages = saved.languages || [];
      state.settings.strict = saved.strict !== false;
      state.settings.design = saved.design || 'midnight';
      state.settings.accent = saved.accent || 'violet';
      state.settings.sort = saved.sort || 'standard';
      state.settings.pin = saved.pin || null;
      state.settings.lockedGroups = saved.lockedGroups || [];
      state.settings.hiddenGroups = saved.hiddenGroups || [];
    }
    applyTheme();

    el.search.onclick = function () { state.view = { type: 'search', query: '' }; render(); };
    el.guide.onclick = function () { state.view = { type: 'guide' }; render(); };
    el.settings.onclick = function () { state.view = { type: 'settings' }; render(); };

    el.video.addEventListener('error', function () {
      toast('Dieser Stream lässt sich auf dem Fernseher nicht abspielen ' +
        '(Format wird nicht unterstützt).', 7000);
    });
    el.video.addEventListener('ended', function () {
      if (!playNextEpisode()) closePlayer();
    });

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
