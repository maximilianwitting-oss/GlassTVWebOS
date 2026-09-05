/**
 * GlassTV Core für webOS – portiert aus GlassTVCore-Kotlin bzw. der iOS-Vorlage.
 *
 * Bewusst ES5-nah und ohne Build-Schritt: webOS-Fernseher tragen je nach
 * Baujahr sehr alte Chromium-Versionen (webOS 3.x ≈ Chromium 38). Alles, was
 * hier steht, muss dort laufen – keine Klassenfelder, kein optional chaining,
 * kein async/await.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- M3U ----

  var VIDEO_EXTENSIONS = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg'];
  var ATTRIBUTE_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  var EPISODE_RE = /\bS(\d{1,2})\s*[.x _-]?\s*E(\d{1,3})\b/i;
  var YEAR_RE = /\((19|20)\d{2}\)/;
  var SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.\-]*:\/\//;

  /**
   * Index des Kommas, das Attribute vom Anzeigenamen trennt: das ERSTE Komma
   * AUSSERHALB von Anführungszeichen.
   *
   * NICHT das letzte Komma nehmen – Titel enthalten selbst Kommas
   * („Der Vorname, 2018", „Berlin, Berlin") und würden sonst abgeschnitten.
   */
  function displayNameIndex(line) {
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '"') inQuotes = !inQuotes;
      else if (c === ',' && !inQuotes) return i;
    }
    return -1;
  }

  function parseAttributes(part) {
    var attrs = {};
    var m;
    ATTRIBUTE_RE.lastIndex = 0;
    while ((m = ATTRIBUTE_RE.exec(part)) !== null) {
      attrs[m[1].toLowerCase()] = m[2];
    }
    return attrs;
  }

  function lastPathComponent(url) {
    var s = url.split('?')[0].split('#')[0];
    s = s.replace(/\/+$/, '');
    var slash = s.lastIndexOf('/');
    return slash >= 0 ? s.substring(slash + 1) : s;
  }

  function pathExtension(url) {
    var last = lastPathComponent(url);
    var dot = last.lastIndexOf('.');
    return dot >= 0 ? last.substring(dot + 1).toLowerCase() : '';
  }

  function trimDecorations(s) {
    return s.replace(/^[\s\-–—:|.·]+/, '').replace(/[\s\-–—:|.·]+$/, '');
  }

  function classify(name, group, url) {
    var m = EPISODE_RE.exec(name);
    if (m) {
      var season = parseInt(m[1], 10);
      var episode = parseInt(m[2], 10);
      if (!isNaN(season) && !isNaN(episode)) {
        var seriesName = trimDecorations(name.substring(0, m.index));
        if (!seriesName) {
          // Steht die Folgenkennung vorn („S01E01 - Pilot"), ist der Titel
          // dahinter. Auf den Gruppennamen auszuweichen ließ früher tausende
          // Einträge zu einer einzigen „Serie" verschmelzen.
          seriesName = trimDecorations(name.substring(m.index + m[0].length));
        }
        if (!seriesName) seriesName = group;
        return { kind: 'episode', seriesName: seriesName, season: season, episode: episode };
      }
    }
    var ext = pathExtension(url);
    var lowerGroup = group.toLowerCase();
    var isVOD = ['film', 'movie', 'vod', 'kino', 'cinema'].some(function (k) {
      return lowerGroup.indexOf(k) >= 0;
    });
    var isSeries = ['serie', 'series', 'show', 'staffel', 'season'].some(function (k) {
      return lowerGroup.indexOf(k) >= 0;
    });
    // `isSeries` muss den Zweig selbst öffnen können: Xtream-Serien-URLs haben
    // oft gar keine Endung (…/series/user/pass/12345) und die Gruppe heißt nur
    // „SERIEN | …" – solche Einträge landeten allesamt im Live-TV.
    if (VIDEO_EXTENSIONS.indexOf(ext) >= 0 || isVOD || isSeries) {
      if (isSeries) return { kind: 'episode', seriesName: name, season: 1, episode: 1 };
      return { kind: 'movie' };
    }
    return { kind: 'live' };
  }

  /** M3U/M3U8 einlesen → { channels, movies, series }. */
  function parseM3U(text, sourceID) {
    var result = { channels: [], movies: [], series: [] };
    /*
     * Schlüssel kommen aus der Playlist und können auf Prototyp-Eigenschaften
     * treffen: Eine Serie namens „Constructor" lieferte beim Nachschlagen
     * `Object.prototype.constructor` – der Anlegen-Zweig wurde übersprungen und
     * der Import brach mit einem TypeError komplett ab. Mit einem Objekt ohne
     * Prototyp kann das nicht passieren.
     */
    var seriesByName = Object.create(null);
    var seriesOrder = [];
    var currentName = '';
    var currentAttributes = {};

    var lines = text.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^[\s﻿]+/, '').replace(/[\s﻿]+$/, '');
      if (line.indexOf('#EXTM3U') === 0) {
        // Die Kopfzeile trägt bei fast jeder Playlist die EPG-Adresse
        // (url-tvg / x-tvg-url) – ohne sie blieb der Programmführer bei
        // M3U-Quellen dauerhaft leer.
        var head = parseAttributes(line);
        result.epgURL = head['url-tvg'] || head['x-tvg-url'] || null;
        continue;
      }
      if (!line) continue;

      if (line.indexOf('#EXTINF') === 0) {
        var comma = displayNameIndex(line);
        // Attribute NUR aus dem Teil vor dem Trenner – sonst würden
        // Anführungszeichen im Namen als Attribute fehlgedeutet.
        currentAttributes = parseAttributes(comma >= 0 ? line.substring(0, comma) : line);
        currentName = comma >= 0 ? line.substring(comma + 1).replace(/^\s+|\s+$/g, '') : '';
        continue;
      }
      if (line.charAt(0) === '#') continue;

      if (!SCHEME_RE.test(line)) {
        currentName = ''; currentAttributes = {};
        continue;
      }

      var name = currentName || currentAttributes['tvg-name'] || lastPathComponent(line);
      // Steuerzeichen aus kaputten Exporten entfernen (iOS: sanitizedName).
      name = name.replace(/[\u0000-\u001F\u007F]/g, '');
      var group = (currentAttributes['group-title'] || '').replace(/^\s+|\s+$/g, '') || 'Allgemein';
      var logo = currentAttributes['tvg-logo'] || null;
      var epgID = currentAttributes['tvg-id'] || null;
      var itemID = sourceID + '|' + line;

      var c = classify(name, group, line);
      if (c.kind === 'episode') {
        var key = c.seriesName.toLowerCase();
        var series = seriesByName[key];
        if (!series) {
          series = {
            id: sourceID + '|series|' + key,
            title: c.seriesName, posterURL: logo, group: group,
            sourceID: sourceID, episodes: [],
          };
          seriesByName[key] = series;
          seriesOrder.push(key);
        }
        if (!series.posterURL) series.posterURL = logo;
        series.episodes.push({
          id: itemID, title: name, season: c.season, episode: c.episode,
          streamURL: line, imageURL: logo,
        });
      } else if (c.kind === 'movie') {
        var yearMatch = YEAR_RE.exec(name);
        result.movies.push({
          id: itemID, title: name, posterURL: logo, group: group, streamURL: line,
          year: yearMatch ? yearMatch[0].replace(/[()]/g, '') : null, sourceID: sourceID,
        });
      } else {
        result.channels.push({
          id: itemID, name: name, logoURL: logo, group: group,
          streamURL: line, epgID: epgID, sourceID: sourceID,
        });
      }
      currentName = ''; currentAttributes = {};
    }

    result.series = seriesOrder.map(function (k) { return seriesByName[k]; })
      .sort(function (a, b) { return a.title.localeCompare(b.title); });
    return result;
  }

  // ------------------------------------------------------------ Xtream ----

  /** Host bereinigen: Schema ergänzen, Pfad/Slash abschneiden. */
  function sanitizedHost(raw) {
    var s = (raw || '').replace(/^\s+|\s+$/g, '');
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    var m = /^(https?:\/\/[^/?#]+)/i.exec(s);
    return m ? m[1] : null;
  }

  function num(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { var n = parseFloat(v); return isNaN(n) ? null : n; }
    return null;
  }

  function str(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    return null;
  }

  function xtreamApi(host, user, pass, action, extra) {
    var url = host + '/player_api.php?username=' + encodeURIComponent(user) +
      '&password=' + encodeURIComponent(pass);
    if (action) url += '&action=' + action;
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) {
          url += '&' + k + '=' + encodeURIComponent(extra[k]);
        }
      }
    }
    return url;
  }

  /** Xtream-Kategorien → { id: name }. */
  function parseCategories(json) {
    var map = {};
    if (!json || !json.length) return map;
    for (var i = 0; i < json.length; i++) {
      var c = json[i];
      var id = str(c.category_id);
      var name = str(c.category_name);
      if (id && name) map[id] = name;
    }
    return map;
  }

  /**
   * Adresse eines Xtream-Streams aus seiner Nummer bauen.
   *
   * Die Adresse wird bewusst NICHT je Eintrag gespeichert: Sie enthält
   * Benutzer und Passwort und ist rund 70 Zeichen lang – bei sechsstelligen
   * Bibliotheken zweimal je Eintrag (Adresse + Kennung) sind das zig Megabyte
   * und die Zugangsdaten stünden in jedem gemerkten Favoriten.
   */
  function xtreamStreamUrl(art, host, user, pass, sid, ext) {
    var ordner = art === 'live' ? 'live' : (art === 'series' ? 'series' : 'movie');
    var endung = art === 'live' ? 'm3u8' : (ext || 'mp4');
    return host + '/' + ordner + '/' + encodeURIComponent(user) + '/' +
      encodeURIComponent(pass) + '/' + sid + '.' + endung;
  }

  function parseLiveStreams(json, categories, host, user, pass, sourceID) {
    var out = [];
    if (!json || !json.length) return out;
    for (var i = 0; i < json.length; i++) {
      var s = json[i];
      var id = num(s.stream_id);
      if (id === null) continue;
      out.push({
        // Kennung aus der Stream-Nummer: kurz, stabil und ohne Zugangsdaten.
        id: sourceID + '|l|' + id,
        name: str(s.name) || ('Sender ' + id),
        logoURL: str(s.stream_icon),
        group: categories[str(s.category_id)] || 'Allgemein',
        sid: id,
        art: 'live',
        epgID: str(s.epg_channel_id),
        xtreamStreamID: id,
        archiveDays: num(s.tv_archive_duration),
        sourceID: sourceID,
      });
    }
    return out;
  }

  function parseVodStreams(json, categories, host, user, pass, sourceID) {
    var out = [];
    if (!json || !json.length) return out;
    for (var i = 0; i < json.length; i++) {
      var s = json[i];
      var id = num(s.stream_id);
      if (id === null) continue;
      out.push({
        id: sourceID + '|m|' + id,
        title: str(s.name) || ('Film ' + id),
        posterURL: str(s.stream_icon),
        group: categories[str(s.category_id)] || 'Allgemein',
        sid: id,
        art: 'movie',
        ext: str(s.container_extension) || null,
        rating: num(s.rating),
        year: null,
        xtreamStreamID: id,
        sourceID: sourceID,
      });
    }
    return out;
  }


  /**
   * Schlanker Titelindex aus der Rohantwort von `get_vod_streams`.
   *
   * Bewusst OHNE JSON.parse: Der volle Objektgraph des Katalogs belegte auf
   * dem Fernseher rund 50 MB. Ein Scan über den Antworttext liefert Titel,
   * Stream-Nummer, Kategorie, Poster und Dateiendung fuer rund 13 MB — genug,
   * um jeden Film zu finden und danach abzuspielen (auf dem Geraet gemessen:
   * 142.246 Titel, 5 s laden, 2 s auswerten).
   *
   * Der Scan arbeitet je Datensatz: `stream_id` markiert den Anfang eines
   * Eintrags, die uebrigen Felder werden nur bis zum naechsten `stream_id`
   * gesucht. So kann ein fehlendes Feld nicht den Wert des Nachbarn erben —
   * ein Greedy-Muster ueber die ganze Antwort tut genau das.
   */
  function scanVodIndex(text) {
    var out = [];
    if (!text) return out;

    /*
     * Datensaetze werden an den echten Objektklammern getrennt, nicht an einem
     * Feld: Der Name steht VOR `stream_id`, Kategorie und Endung dahinter — an
     * `stream_id` geschnitten erbt jeder Eintrag Felder seines Nachbarn. Der
     * Scanner ueberspringt Strings, damit eine Klammer in einem Filmtitel
     * ("Wer {das} liest") die Grenzen nicht verschiebt.
     */
    var marke = /[{}"]/g;
    var tiefe = 0, start = -1, m;
    while ((m = marke.exec(text)) !== null) {
      var z = m[0], i = m.index;
      if (z === '"') {
        var ende = stringEnde(text, i + 1);
        if (ende < 0) break;
        marke.lastIndex = ende + 1;
        continue;
      }
      if (z === '{') {
        tiefe++;
        if (tiefe === 1) start = i;
      } else {
        tiefe--;
        if (tiefe === 0 && start >= 0) {
          eintragLesen(out, text.slice(start, i + 1));
          start = -1;
        }
        if (tiefe < 0) tiefe = 0;
      }
    }
    return out;
  }

  /** Position des schliessenden Anfuehrungszeichens ab `von` (Escapes beachtet). */
  function stringEnde(text, von) {
    var i = von;
    while (i < text.length) {
      var c = text.charCodeAt(i);
      if (c === 92) { i += 2; continue; }   // Backslash: naechstes Zeichen ueberspringen
      if (c === 34) return i;               // Anfuehrungszeichen
      i++;
    }
    return -1;
  }

  /** Aus einem einzelnen Datensatz die Felder ziehen, die die Suche braucht. */
  function eintragLesen(out, roh) {
    var sid = feldText(roh, 'stream_id');
    if (!sid) return;
    out.push({
      s: Number(sid),
      t: feldText(roh, 'name') || ('Film ' + sid),
      c: feldText(roh, 'category_id'),
      p: feldText(roh, 'stream_icon'),
      e: feldText(roh, 'container_extension')
    });
  }

  /** Ein JSON-Stringfeld aus einem Textausschnitt holen (mit Escapes). */
  function feldText(text, feld) {
    var re = new RegExp('"' + feld + '":\\s*"((?:[^"\\\\]|\\\\.)*)"');
    var m = re.exec(text);
    if (!m) {
      // Zahlenfelder wie category_id kommen je nach Panel ohne Anfuehrungszeichen.
      var reZahl = new RegExp('"' + feld + '":\\s*(\\d+)');
      var m2 = reZahl.exec(text);
      return m2 ? m2[1] : '';
    }
    return jsonEntkleiden(m[1]);
  }

  /** JSON-Escapes in einem rohen Stringinhalt aufloesen. */
  function jsonEntkleiden(roh) {
    if (roh.indexOf('\\') < 0) return roh;
    try {
      return JSON.parse('"' + roh + '"');
    } catch (e) {
      return roh.replace(/\\\\(.)/g, '$1');
    }
  }

  function parseSeriesList(json, categories, sourceID) {
    var out = [];
    if (!json || !json.length) return out;
    for (var i = 0; i < json.length; i++) {
      var s = json[i];
      var id = num(s.series_id);
      if (id === null) continue;
      out.push({
        id: sourceID + '|series|' + id,
        title: str(s.name) || ('Serie ' + id),
        posterURL: str(s.cover),
        group: categories[str(s.category_id)] || 'Allgemein',
        plot: str(s.plot),
        rating: num(s.rating),
        xtreamSeriesID: id,
        episodes: [],
        sourceID: sourceID,
      });
    }
    return out;
  }

  /**
   * Episoden aus series_info. Tolerant gegen die Formatvielfalt der Panels:
   * `episodes` kommt mal als Objekt (Staffel → Liste), mal als Array; die
   * Staffelnummer steht teils nur im Schlüssel. Strikte Auswertung verwarf
   * früher ALLE Folgen, sobald ein Element aus der Reihe tanzte.
   */
  function parseEpisodes(info, host, user, pass, seriesID) {
    var out = [];
    var perSeason = {};
    if (!info || !info.episodes) return out;
    var container = info.episodes;

    function collect(node, seasonHint, depth) {
      if (!node || depth > 12) return;
      if (Object.prototype.toString.call(node) === '[object Array]') {
        for (var i = 0; i < node.length; i++) collect(node[i], seasonHint, depth + 1);
        return;
      }
      if (typeof node !== 'object') return;
      var id = num(node.id);
      if (id !== null) {
        var infoNode = node.info || {};
        var staffel = num(node.season) !== null ? num(node.season) : (seasonHint || 1);
        var nummer = num(node.episode_num);
        if (nummer === null) {
          // Ersatznummer JE STAFFEL: Fortlaufend über alle Folgen ergab sonst
          // S01E01–E10 gefolgt von S02E11.
          perSeason[staffel] = (perSeason[staffel] || 0) + 1;
          nummer = perSeason[staffel];
        }
        out.push({
          id: seriesID + '|e|' + id,
          title: str(node.title) || str(infoNode.name) || ('Folge ' + id),
          season: staffel,
          episode: nummer,
          sid: id,
          art: 'series',
          ext: str(node.container_extension) || null,
          imageURL: str(infoNode.movie_image),
          durationSeconds: num(infoNode.duration_secs),
        });
        return;
      }
      for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        var hint = parseInt(key, 10);
        collect(node[key], isNaN(hint) ? seasonHint : hint, depth + 1);
      }
    }

    collect(container, null, 0);
    out.sort(function (a, b) { return (a.season - b.season) || (a.episode - b.episode); });
    return out;
  }

  // ---------------------------------------------------------- Sprachen ----

  var LANG_ALIASES = {
    de: ['deutschland', 'österreich', 'deutsch', 'german', 'germany', 'austria', 'swiss', 'schweiz', 'de', 'ger', 'deu', 'at', 'ch'],
    en: ['united kingdom', 'great britain', 'english', 'america', 'usa', 'ireland', 'en', 'eng', 'uk', 'gb', 'us'],
    fr: ['français', 'francais', 'french', 'france', 'fr', 'fra'],
    es: ['español', 'espanol', 'spanish', 'spain', 'latino', 'mexico', 'es', 'spa'],
    it: ['italiano', 'italian', 'italia', 'italy', 'it', 'ita'],
    pt: ['portuguese', 'portugal', 'brasil', 'brazil', 'pt', 'por', 'br'],
    nl: ['nederland', 'netherlands', 'holland', 'dutch', 'nl', 'nld'],
    pl: ['polski', 'polish', 'poland', 'polska', 'pl', 'pol'],
    tr: ['türkiye', 'turkish', 'turkey', 'türk', 'turk', 'tr', 'tur'],
    ar: ['arabic', 'arab', 'ar', 'ara'],
    ru: ['russian', 'russia', 'ru', 'rus'],
    gr: ['greek', 'greece', 'gr', 'ell'],
    ro: ['romanian', 'romania', 'ro', 'ron'],
    sv: ['swedish', 'sweden', 'sverige', 'se', 'sv'],
    no: ['norwegian', 'norway', 'norge', 'no', 'nor'],
    ex: ['adult', 'xxx', 'porn', '18+'],
  };

  var LANG_NAMES = {
    de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch',
    pt: 'Portugiesisch', nl: 'Niederländisch', pl: 'Polnisch', tr: 'Türkisch',
    ar: 'Arabisch', ru: 'Russisch', gr: 'Griechisch', ro: 'Rumänisch',
    sv: 'Schwedisch', no: 'Norwegisch', ex: '18+',
  };

  var LANG_FLAGS = {
    de: '🇩🇪', en: '🇬🇧', fr: '🇫🇷', es: '🇪🇸', it: '🇮🇹', pt: '🇵🇹', nl: '🇳🇱',
    pl: '🇵🇱', tr: '🇹🇷', ar: '🇸🇦', ru: '🇷🇺', gr: '🇬🇷', ro: '🇷🇴', sv: '🇸🇪',
    no: '🇳🇴', ex: '🔞',
  };

  // Lange Aliase zuerst, damit „german movies" nicht an kurzen Codes hängenbleibt.
  var SORTED_ALIASES = (function () {
    var list = [];
    for (var code in LANG_ALIASES) {
      if (!Object.prototype.hasOwnProperty.call(LANG_ALIASES, code)) continue;
      for (var i = 0; i < LANG_ALIASES[code].length; i++) {
        list.push({ alias: LANG_ALIASES[code][i], code: code });
      }
    }
    return list.sort(function (a, b) { return b.alias.length - a.alias.length; });
  })();

  /*
   * Nachschlagewerk für Ein-Wort-Aliase und die Liste der mehrteiligen.
   *
   * Vorher lief je Titel die ganze Aliasliste (~110 Einträge) mit einem
   * `indexOf` über die Tokens – bei 142.000 Filmen sind das Millionen von
   * Array-Suchen. Jetzt kostet ein Titel nur noch so viel wie er Wörter hat.
   */
  var ALIAS_MAP = Object.create(null);
  var MULTI_ALIASES = [];
  var SPECIAL_ALIASES = [];
  (function () {
    for (var i = 0; i < SORTED_ALIASES.length; i++) {
      var e = SORTED_ALIASES[i];
      if (e.alias.indexOf(' ') >= 0) MULTI_ALIASES.push(e);
      else if (/[^a-z0-9\u00C0-\u024F]/.test(e.alias)) SPECIAL_ALIASES.push(e);
      // Längere Aliase gewinnen: Sie stehen vorn und werden nicht überschrieben.
      else if (ALIAS_MAP[e.alias] === undefined) ALIAS_MAP[e.alias] = e.code;
    }
  })();

  function detectLanguage(text) {
    var lower = (text || '').toLowerCase();
    // Mehrteilige Aliase zuerst: „great britain" darf nicht an „britain" scheitern.
    for (var m = 0; m < MULTI_ALIASES.length; m++) {
      if (lower.indexOf(MULTI_ALIASES[m].alias) >= 0) return MULTI_ALIASES[m].code;
    }
    // Aliase mit Sonderzeichen ebenfalls als Teilzeichenkette prüfen: „18+"
    // zerfällt bei der Tokenisierung zu „18" und wurde nie erkannt.
    for (var x = 0; x < SPECIAL_ALIASES.length; x++) {
      if (lower.indexOf(SPECIAL_ALIASES[x].alias) >= 0) return SPECIAL_ALIASES[x].code;
    }
    // Kein \p{L} (Unicode-Property-Escapes gibt es erst ab Chrome 64, ältere
    // webOS-Fernseher liegen darunter): Latin-1-Bereich explizit zulassen.
    var tokens = lower.split(/[^a-z0-9\u00C0-\u024F]+/);
    var best = null, bestLen = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      if (Object.prototype.hasOwnProperty.call(ALIAS_MAP, t) && t.length > bestLen) {
        // Längster Treffer gewinnt – „german" schlägt „ger".
        best = ALIAS_MAP[t]; bestLen = t.length;
      }
    }
    return best;
  }

  /**
   * Bibliothek auf bevorzugte Sprachen filtern. Leere Auswahl = alles.
   * Sicherheitsnetz: ist in einer Liste GAR KEINE Sprache erkennbar (Anbieter
   * ohne Kürzel), bleibt sie ungefiltert – sonst verschwände alles.
   */
  function filterByLanguage(playlist, preferred, strict) {
    if (!preferred || !preferred.length) return playlist;

    // Auswahl als Nachschlagewerk statt indexOf je Element.
    var wanted = {};
    for (var w = 0; w < preferred.length; w++) wanted[preferred[w]] = true;

    function filterItems(items, textOf) {
      // Sprache je Element EINMAL bestimmen und am Element merken – vorher lief
      // die Erkennung zweimal über die gesamte Liste (einmal für die Prüfung
      // „ist überhaupt etwas erkennbar", einmal zum Filtern).
      var detectable = false;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it._lang === undefined) it._lang = detectLanguage(textOf(it));
        if (it._lang !== null) detectable = true;
      }
      if (!detectable) return items;
      var out = [];
      for (var j = 0; j < items.length; j++) {
        var x = items[j];
        if ((x._lang !== null && wanted[x._lang]) || (!strict && x._lang === null)) out.push(x);
      }
      return out;
    }

    return {
      channels: filterItems(playlist.channels, function (c) { return c.group + ' ' + c.name; }),
      movies: filterItems(playlist.movies, function (m) { return m.group + ' ' + m.title; }),
      series: filterItems(playlist.series, function (s) { return s.group + ' ' + s.title; }),
    };
  }

  // ---------------------------------------------------------------- EPG ----

  /**
   * XMLTV einlesen (Fenster −8 h … +72 h wie iOS).
   *
   * Zeitstempel-Fallstrick: Anbieter liefern den Offset auch OHNE Leerzeichen
   * („20240115143000+0100"). Wird das als offsetlose Ortszeit gelesen, ist das
   * Programm still um Stunden verschoben – deshalb der explizite Offset-Zweig.
   */
  function parseXmltvDate(raw) {
    if (!raw) return null;
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(raw.replace(/^\s+|\s+$/g, ''));
    if (!m) return null;
    var year = +m[1], month = +m[2] - 1, day = +m[3];
    var hour = +m[4], minute = +m[5], second = m[6] ? +m[6] : 0;
    if (m[7]) {
      var sign = m[7].charAt(0) === '-' ? -1 : 1;
      var offMin = sign * (parseInt(m[7].substr(1, 2), 10) * 60 + parseInt(m[7].substr(3, 2), 10));
      return new Date(Date.UTC(year, month, day, hour, minute, second) - offMin * 60000);
    }
    return new Date(year, month, day, hour, minute, second);
  }

  function parseXMLTV(xmlText, wantedIds) {
    // Ohne Prototyp: Eine tvg-id namens „constructor" ließ den Aufbau sonst
    // mit einem TypeError abbrechen – und das gesamte EPG verschwand stumm.
    var epg = Object.create(null);
    // Nur Kanäle behalten, die es in der Bibliothek gibt: XMLTV-Dateien großer
    // Anbieter sind dreistellige Megabyte, und jede Sendung kostet zwei
    // Date-Objekte. Ohne die Beschränkung geht dem Fernseher der Speicher aus.
    var filter = null;
    if (wantedIds) {
      filter = Object.create(null);
      for (var f = 0; f < wantedIds.length; f++) {
        if (wantedIds[f]) filter[String(wantedIds[f]).toLowerCase()] = true;
      }
    }
    var now = Date.now();
    var from = now - 8 * 3600 * 1000;
    var to = now + 72 * 3600 * 1000;

    var doc;
    try {
      doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    } catch (e) {
      return epg;
    }
    var programmes = doc.getElementsByTagName('programme');
    for (var i = 0; i < programmes.length; i++) {
      var p = programmes[i];
      var start = parseXmltvDate(p.getAttribute('start'));
      var stop = parseXmltvDate(p.getAttribute('stop'));
      if (!start || !stop) continue;
      if (stop.getTime() < from || start.getTime() > to) continue;
      var channel = (p.getAttribute('channel') || '').toLowerCase();
      if (!channel) continue;
      if (filter && !filter[channel]) continue;
      // Bei mehrsprachigen <title>/<desc> nur die erste Fassung nehmen.
      var titleNode = p.getElementsByTagName('title')[0];
      var descNode = p.getElementsByTagName('desc')[0];
      if (!epg[channel]) epg[channel] = [];
      epg[channel].push({
        channelID: channel,
        title: titleNode ? titleNode.textContent : '(ohne Titel)',
        desc: descNode ? descNode.textContent : null,
        start: start,
        end: stop,
      });
    }
    for (var key in epg) {
      if (Object.prototype.hasOwnProperty.call(epg, key)) {
        epg[key].sort(function (a, b) { return a.start - b.start; });
      }
    }
    return epg;
  }

  function nowProgram(programs) {
    if (!programs) return null;
    var t = Date.now();
    for (var i = 0; i < programs.length; i++) {
      if (programs[i].start.getTime() <= t && programs[i].end.getTime() > t) return programs[i];
    }
    return null;
  }

  /** Nächste Sendung: das MINIMUM der künftigen Starts, nicht einfach die erste. */
  function nextProgram(programs) {
    if (!programs) return null;
    var t = Date.now();
    var best = null;
    for (var i = 0; i < programs.length; i++) {
      var p = programs[i];
      if (p.start.getTime() > t && (!best || p.start < best.start)) best = p;
    }
    return best;
  }

  global.GlassTVCore = {
    parseM3U: parseM3U,
    displayNameIndex: displayNameIndex,
    sanitizedHost: sanitizedHost,
    xtreamApi: xtreamApi,
    xtreamStreamUrl: xtreamStreamUrl,
    parseCategories: parseCategories,
    parseLiveStreams: parseLiveStreams,
    parseVodStreams: parseVodStreams,
    scanVodIndex: scanVodIndex,
    parseSeriesList: parseSeriesList,
    parseEpisodes: parseEpisodes,
    detectLanguage: detectLanguage,
    filterByLanguage: filterByLanguage,
    parseXMLTV: parseXMLTV,
    parseXmltvDate: parseXmltvDate,
    nowProgram: nowProgram,
    nextProgram: nextProgram,
    LANG_NAMES: LANG_NAMES,
    LANG_FLAGS: LANG_FLAGS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
