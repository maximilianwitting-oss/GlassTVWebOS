/**
 * GlassTV für webOS – Oberfläche und Ablaufsteuerung.
 *
 * Zwei Eigenheiten der Plattform prägen den Code:
 *  1. Bedient wird mit der Fernbedienung. Es gibt keinen Mauszeiger (außer der
 *     Magic Remote), also führt jede Ansicht eine Liste fokussierbarer Elemente
 *     und schaltet mit den Pfeiltasten geometrisch weiter.
 *  2. Alte Chromium-Versionen: kein async/await, keine Klassen, kein fetch mit
 *     AbortController. XMLHttpRequest ist hier der verlässliche Weg.
 */
(function () {
  'use strict';

  var Core = window.GlassTVCore;

  // ---------------------------------------------------------- Zustand ----

  var state = {
    tab: 'live',
    library: { channels: [], movies: [], series: [] },
    epg: {},
    source: null,        // { kind, host, user, pass, m3u }
    loading: false,
    currentSeries: null,
  };

  var el = {
    tabs: document.getElementById('tabs'),
    content: document.getElementById('content'),
    settings: document.getElementById('btn-settings'),
    player: document.getElementById('player'),
    video: document.getElementById('video'),
    chrome: document.getElementById('player-chrome'),
    playerTitle: document.getElementById('player-title'),
    playerSub: document.getElementById('player-sub'),
    toast: document.getElementById('toast'),
  };

  var TABS = [
    { id: 'live', label: 'Live TV' },
    { id: 'movies', label: 'Filme' },
    { id: 'series', label: 'Serien' },
  ];

  // ------------------------------------------------------- Persistenz ----

  // localStorage ist auf webOS vorhanden, kann aber (Speicher voll, Privatmodus)
  // werfen – deshalb überall abgesichert.
  function save(key, value) {
    try { localStorage.setItem('glasstv.' + key, JSON.stringify(value)); } catch (e) { /* egal */ }
  }

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem('glasstv.' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  // ------------------------------------------------------------ Netz ----

  /** GET mit Timeout; ruft cb(fehler, text). */
  function httpGet(url, cb, timeoutMs) {
    var xhr = new XMLHttpRequest();
    var done = false;
    function finish(err, text) {
      if (done) return;
      done = true;
      cb(err, text);
    }
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
    } catch (e) {
      finish(e, null);
    }
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
    // Erstes Element im Inhalt bevorzugen, sonst die Kopfzeile.
    var inContent = focusables.filter(function (n) { return el.content.contains(n); });
    var target = inContent.length ? inContent[0] : focusables[0];
    if (target) target.focus();
  }

  /**
   * Geometrische Navigation: das nächste Element in Richtung dx/dy.
   * Reine Reihenfolge im DOM reicht nicht – Raster und Reihen liegen
   * zweidimensional, und der Nutzer erwartet räumliches Verhalten.
   */
  function moveFocus(dx, dy) {
    collectFocusables();
    var active = document.activeElement;
    if (!active || focusables.indexOf(active) < 0) { focusFirst(); return; }
    var from = active.getBoundingClientRect();
    var best = null;
    var bestScore = Infinity;

    for (var i = 0; i < focusables.length; i++) {
      var node = focusables[i];
      if (node === active) continue;
      var r = node.getBoundingClientRect();
      var ddx = (r.left + r.width / 2) - (from.left + from.width / 2);
      var ddy = (r.top + r.height / 2) - (from.top + from.height / 2);
      // Nur Kandidaten in der gewünschten Richtung.
      if (dx > 0 && ddx <= 8) continue;
      if (dx < 0 && ddx >= -8) continue;
      if (dy > 0 && ddy <= 8) continue;
      if (dy < 0 && ddy >= -8) continue;
      // Abstand in Bewegungsrichtung zählt voll, seitlicher Versatz dreifach –
      // sonst springt der Fokus quer über den Bildschirm.
      var along = Math.abs(dx ? ddx : ddy);
      var across = Math.abs(dx ? ddy : ddx);
      var score = along + across * 3;
      if (score < bestScore) { bestScore = score; best = node; }
    }
    if (best) best.focus();
  }

  // ---------------------------------------------------------- Anzeige ----

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

  function renderTabs() {
    clear(el.tabs);
    TABS.forEach(function (t) {
      var b = element('button', 'tab focusable' + (state.tab === t.id ? ' active' : ''), t.label);
      b.onclick = function () { state.tab = t.id; render(); };
      el.tabs.appendChild(b);
    });
  }

  function posterNode(url, title) {
    if (url) {
      var img = element('img', 'poster');
      img.src = url;
      img.alt = '';
      // Kaputte Poster-URLs sind bei IPTV die Regel, nicht die Ausnahme.
      img.onerror = function () { img.style.display = 'none'; };
      return img;
    }
    var ph = element('div', 'poster');
    return ph;
  }

  function card(title, imageUrl, onSelect) {
    var c = element('div', 'card focusable');
    c.tabIndex = 0;
    c.appendChild(posterNode(imageUrl, title));
    c.appendChild(element('div', 'label', title));
    c.onclick = onSelect;
    return c;
  }

  function channelRow(ch) {
    var programs = ch.epgID ? state.epg[ch.epgID.toLowerCase()] : null;
    var now = Core.nowProgram(programs);
    var next = Core.nextProgram(programs);

    var row = element('div', 'channel focusable' + (now ? ' on-air' : ''));
    row.tabIndex = 0;

    if (ch.logoURL) {
      var logo = element('img', 'logo');
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
        (next ? '  ·  danach ' + timeText(next.start) + ' ' + next.title : '')));
      var bar = element('div', 'progress');
      var fill = element('div');
      var span = now.end - now.start;
      var pct = span > 0 ? Math.max(2, Math.min(100, ((Date.now() - now.start) / span) * 100)) : 2;
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      info.appendChild(bar);
    } else {
      info.appendChild(element('div', 'sub', ch.group));
    }
    row.appendChild(info);

    if (now) row.appendChild(element('span', 'badge-live', 'LIVE'));

    row.onclick = function () { playItem(ch.name, ch.streamURL, now ? now.title : ch.group); };
    return row;
  }

  function timeText(date) {
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return two(date.getHours()) + ':' + two(date.getMinutes());
  }

  // ----------------------------------------------------------- Seiten ----

  function render() {
    renderTabs();
    clear(el.content);

    if (state.loading) {
      el.content.appendChild(element('div', 'spinner'));
      return;
    }
    if (!state.source) return renderSetup();

    if (state.currentSeries) return renderSeriesDetail();

    if (state.tab === 'live') renderChannels();
    else if (state.tab === 'movies') renderMovies();
    else renderSeries();

    setTimeout(focusFirst, 0);
  }

  function renderEmpty(title, message) {
    var e = element('div', 'empty');
    e.appendChild(element('strong', null, title));
    e.appendChild(document.createTextNode(message));
    el.content.appendChild(e);
  }

  function renderChannels() {
    if (!state.library.channels.length) {
      return renderEmpty('Keine Sender', 'Die Quelle hat keine Live-Sender geliefert.');
    }
    el.content.appendChild(element('div', 'section-title',
      state.library.channels.length + ' Sender'));
    var list = element('div');
    // Sehr lange Listen bremsen alte TV-Browser aus – erst einmal 300 Zeilen.
    state.library.channels.slice(0, 300).forEach(function (ch) {
      list.appendChild(channelRow(ch));
    });
    el.content.appendChild(list);
  }

  function renderMovies() {
    if (!state.library.movies.length) {
      return renderEmpty('Keine Filme', 'Die Quelle hat keine Filme geliefert.');
    }
    el.content.appendChild(element('div', 'section-title',
      state.library.movies.length + ' Filme'));
    var grid = element('div', 'grid');
    state.library.movies.slice(0, 200).forEach(function (m) {
      grid.appendChild(card(m.title, m.posterURL, function () {
        playItem(m.title, m.streamURL, m.group);
      }));
    });
    el.content.appendChild(grid);
  }

  function renderSeries() {
    if (!state.library.series.length) {
      return renderEmpty('Keine Serien', 'Die Quelle hat keine Serien geliefert.');
    }
    el.content.appendChild(element('div', 'section-title',
      state.library.series.length + ' Serien'));
    var grid = element('div', 'grid');
    state.library.series.slice(0, 200).forEach(function (s) {
      grid.appendChild(card(s.title, s.posterURL, function () { openSeries(s); }));
    });
    el.content.appendChild(grid);
  }

  function openSeries(series) {
    state.currentSeries = series;
    if (series.episodes && series.episodes.length) { render(); return; }
    // Xtream liefert Folgen erst auf Nachfrage.
    if (state.source.kind !== 'xtream' || !series.xtreamSeriesID) { render(); return; }
    state.loading = true; render();
    var url = Core.xtreamApi(state.source.host, state.source.user, state.source.pass,
      'get_series_info', { series_id: series.xtreamSeriesID });
    httpGetJson(url, function (err, json) {
      state.loading = false;
      if (!err && json) {
        series.episodes = Core.parseEpisodes(json, state.source.host,
          state.source.user, state.source.pass, series.id);
      } else {
        toast('Folgen konnten nicht geladen werden: ' + (err ? err.message : 'unbekannt'));
      }
      render();
    });
  }

  function renderSeriesDetail() {
    var s = state.currentSeries;
    var back = element('button', 'tab focusable', '‹ Zurück');
    back.onclick = function () { state.currentSeries = null; render(); };
    el.content.appendChild(back);

    el.content.appendChild(element('div', 'section-title', s.title));
    if (!s.episodes.length) {
      renderEmpty('Keine Folgen', 'Für diese Serie wurden keine Folgen gefunden.');
      setTimeout(focusFirst, 0);
      return;
    }
    var list = element('div');
    s.episodes.forEach(function (ep) {
      var row = element('div', 'channel focusable');
      row.tabIndex = 0;
      row.appendChild(element('div', 'logo'));
      var info = element('div', 'info');
      var label = 'S' + (ep.season < 10 ? '0' : '') + ep.season +
        'E' + (ep.episode < 10 ? '0' : '') + ep.episode;
      info.appendChild(element('div', 'name', label + '  ' + ep.title));
      row.appendChild(info);
      row.onclick = function () { playItem(s.title + ' · ' + label, ep.streamURL, ep.title); };
      list.appendChild(row);
    });
    el.content.appendChild(list);
    setTimeout(focusFirst, 0);
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
    var loadXtream = element('button', 'focusable', 'Xtream laden');
    loadXtream.onclick = function () {
      var cleanHost = Core.sanitizedHost(host.value);
      if (!cleanHost) return toast('Bitte eine gültige Server-Adresse eingeben.');
      loadXtreamSource(cleanHost, user.value, pass.value);
    };
    var loadM3U = element('button', 'focusable ghost', 'M3U laden');
    loadM3U.onclick = function () {
      if (!m3u.value) return toast('Bitte eine M3U-Adresse eingeben.');
      loadM3USource(m3u.value);
    };
    actions.appendChild(loadXtream);
    actions.appendChild(loadM3U);
    panel.appendChild(actions);

    el.content.appendChild(panel);
    setTimeout(function () { host.focus(); }, 0);
  }

  // ----------------------------------------------------------- Laden ----

  function loadM3USource(url) {
    state.loading = true; render();
    httpGet(url, function (err, text) {
      state.loading = false;
      if (err) {
        state.loading = false;
        render();
        return toast('M3U konnte nicht geladen werden: ' + err.message, 6000);
      }
      state.library = Core.parseM3U(text, 'm3u');
      state.source = { kind: 'm3u', m3u: url };
      save('source', state.source);
      toast(state.library.channels.length + ' Sender, ' + state.library.movies.length +
        ' Filme, ' + state.library.series.length + ' Serien geladen.');
      render();
    });
  }

  function loadXtreamSource(host, user, pass) {
    state.loading = true; render();
    var pending = 4;
    var categories = { live: {}, vod: {}, series: {} };
    var lib = { channels: [], movies: [], series: [] };
    var failed = null;

    function step() {
      pending--;
      if (pending > 0) return;
      state.loading = false;
      if (failed && !lib.channels.length && !lib.movies.length && !lib.series.length) {
        render();
        return toast('Anmeldung fehlgeschlagen: ' + failed.message, 6000);
      }
      state.library = lib;
      state.source = { kind: 'xtream', host: host, user: user, pass: pass };
      save('source', state.source);
      toast(lib.channels.length + ' Sender, ' + lib.movies.length + ' Filme, ' +
        lib.series.length + ' Serien geladen.');
      render();
      loadEpgIfPossible();
    }

    function fetchCategories(action, key, then) {
      httpGetJson(Core.xtreamApi(host, user, pass, action), function (err, json) {
        if (!err && json) categories[key] = Core.parseCategories(json);
        then();
      });
    }

    fetchCategories('get_live_categories', 'live', function () {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_live_streams'), function (err, json) {
        if (err) failed = err;
        else lib.channels = Core.parseLiveStreams(json, categories.live, host, user, pass, 'xtream');
        step();
      });
    });
    fetchCategories('get_vod_categories', 'vod', function () {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_vod_streams'), function (err, json) {
        if (!err && json) lib.movies = Core.parseVodStreams(json, categories.vod, host, user, pass, 'xtream');
        step();
      });
    });
    fetchCategories('get_series_categories', 'series', function () {
      httpGetJson(Core.xtreamApi(host, user, pass, 'get_series'), function (err, json) {
        if (!err && json) lib.series = Core.parseSeriesList(json, categories.series, 'xtream');
        step();
      });
    });
    // Vierter Schritt: Authentifizierung prüfen, damit ein falsches Passwort
    // eine klare Meldung ergibt statt dreier leerer Listen.
    httpGetJson(Core.xtreamApi(host, user, pass, null), function (err, json) {
      if (err) failed = err;
      else if (json && json.user_info && json.user_info.auth === 0) {
        failed = new Error('Benutzer oder Passwort falsch');
      }
      step();
    });
  }

  function loadEpgIfPossible() {
    if (!state.source || state.source.kind !== 'xtream') return;
    var url = state.source.host + '/xmltv.php?username=' +
      encodeURIComponent(state.source.user) + '&password=' + encodeURIComponent(state.source.pass);
    httpGet(url, function (err, text) {
      if (err || !text) return;      // EPG ist Zugabe – ein Fehler darf nichts kippen
      try {
        state.epg = Core.parseXMLTV(text);
        if (state.tab === 'live') render();
      } catch (e) { /* stumm */ }
    }, 45000);
  }

  // ---------------------------------------------------------- Player ----

  var playerOpen = false;
  var hideTimer = null;

  function playItem(title, url, subtitle) {
    el.playerTitle.textContent = title;
    el.playerSub.textContent = subtitle || '';
    el.player.className = 'open';
    playerOpen = true;
    el.video.src = url;
    var p = el.video.play();
    if (p && p.catch) p.catch(function () { /* Autoplay-Ablehnung ignorieren */ });
    el.video.focus();
    pokeChrome();
  }

  function closePlayer() {
    playerOpen = false;
    el.player.className = '';
    el.video.pause();
    el.video.removeAttribute('src');
    el.video.load();
    setTimeout(focusFirst, 0);
  }

  function pokeChrome() {
    el.chrome.className = '';
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { el.chrome.className = 'hidden'; }, 4000);
  }

  el.video.addEventListener('error', function () {
    toast('Dieser Stream lässt sich auf dem Fernseher nicht abspielen.', 6000);
  });

  // ------------------------------------------------------ Tastatur ----

  // webOS-Fernbedienung: Pfeile 37–40, OK 13, Zurück 461 (LG) bzw. 8/27.
  document.addEventListener('keydown', function (e) {
    var code = e.keyCode;

    if (playerOpen) {
      pokeChrome();
      if (code === 461 || code === 8 || code === 27) { closePlayer(); e.preventDefault(); return; }
      if (code === 13 || code === 415 || code === 19) {          // OK / Play / Pause
        if (el.video.paused) el.video.play(); else el.video.pause();
        e.preventDefault(); return;
      }
      if (code === 39) { el.video.currentTime += 10; e.preventDefault(); return; }
      if (code === 37) { el.video.currentTime -= 10; e.preventDefault(); return; }
      return;
    }

    if (code === 461 || code === 8) {
      // Zurück: erst in der Serie eine Ebene hoch, sonst App schließen.
      if (state.currentSeries) { state.currentSeries = null; render(); e.preventDefault(); return; }
      if (typeof webOS !== 'undefined' && webOS.platformBack) webOS.platformBack();
      return;
    }
    if (code === 37) { moveFocus(-1, 0); e.preventDefault(); }
    else if (code === 39) { moveFocus(1, 0); e.preventDefault(); }
    else if (code === 38) { moveFocus(0, -1); e.preventDefault(); }
    else if (code === 40) { moveFocus(0, 1); e.preventDefault(); }
    else if (code === 13) {
      var a = document.activeElement;
      if (a && a.tagName !== 'INPUT' && a.click) a.click();
    }
  });

  el.settings.onclick = function () {
    state.source = null;
    state.currentSeries = null;
    render();
  };

  // ------------------------------------------------------------ Start ----

  function boot() {
    var saved = load('source', null);
    if (!saved) { render(); return; }
    state.source = saved;
    if (saved.kind === 'm3u') loadM3USource(saved.m3u);
    else loadXtreamSource(saved.host, saved.user, saved.pass);
  }

  boot();
})();
