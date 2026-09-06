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
  /**
   * Trennstelle zwischen Attributteil und Anzeigename einer `#EXTINF`-Zeile.
   *
   * Normalfall: das erste Komma ausserhalb von Anfuehrungszeichen (deshalb
   * wird „Der Vorname, 2018" nicht am Komma im Titel getrennt).
   *
   * Sonderfall: Enthaelt ein Attributwert selbst ein Anfuehrungszeichen
   * (`tvg-name="Der 25" Film"`), ist deren Zahl ungerade und die Umschalt-
   * logik laeuft aus dem Tritt – der Trenner landete dann mitten im Titel
   * oder gar nicht. Dann wird stattdessen hinter dem letzten sauber
   * erkannten `attr="…"` gesucht.
   */
  /**
   * Trennstelle zwischen Attributteil und Anzeigename einer `#EXTINF`-Zeile.
   *
   * Massgeblich ist das Ende des LETZTEN vollstaendigen `attr="…"` – danach
   * das naechste Komma. Das ist verlaesslicher als Anfuehrungszeichen zu
   * zaehlen: Ein Wert, der selbst ein Anfuehrungszeichen enthaelt
   * (`tvg-name="Der 25" Film"`), bringt jede Zaehl- oder Umschaltlogik aus
   * dem Tritt – auch bei gerader Gesamtzahl, weil die Paarung falsch liegt.
   * Der Trenner landete dann mitten im Titel, und aus „Der 25" Film, 2019"
   * wurde „2019".
   *
   * Ein Komma INNERHALB eines Attributwerts (`tvg-id="a,b"`) wird dabei
   * ebenfalls korrekt uebersprungen – das leistete die alte Fassung nur,
   * solange die Anfuehrungszeichen sauber paarweise standen.
   */
  function displayNameIndex(line) {
    var re = /[A-Za-z0-9_-]+="[^"]*"/g, m, ende = -1;
    while ((m = re.exec(line)) !== null) ende = m.index + m[0].length;

    if (ende >= 0) {
      var nach = line.indexOf(',', ende);
      if (nach >= 0) return nach;
    }

    // Keine Attribute (oder keins vor dem Komma): erstes Komma ausserhalb
    // von Anfuehrungszeichen.
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

  /**
   * Erkennt eine Gruppe als Serien-Rubrik. Bewusst mit Wortgrenzen: Ein
   * blosses `indexOf('show')` machte aus der Live-Gruppe „US | TV SHOWS 24/7"
   * lauter einzelne Serien mit je einer Folge.
   */
  function istSerienGruppe(group) {
    var g = ' ' + String(group || '').toLowerCase() + ' ';
    return /[^a-z](serien?|series|staffel|season|tv[ -]?shows?)[^a-z]/.test(g);
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
    /*
     * Der Pfad der Adresse ist das verlaesslichste Signal – verlaesslicher als
     * der Gruppenname. Ein Live-Kanal in der Gruppe „US | TV SHOWS 24/7" wurde
     * sonst zu lauter Einzelserien, und in einer Gruppe „Kinderserien" wurde
     * jeder Film zu einer eigenen Serie mit genau einer Folge.
     */
    var lowerUrl = String(url || '').toLowerCase();
    if (lowerUrl.indexOf('/live/') >= 0) return { kind: 'live' };
    if (lowerUrl.indexOf('/series/') >= 0) {
      return { kind: 'episode', seriesName: name, season: 1, episode: 1 };
    }
    if (lowerUrl.indexOf('/movie/') >= 0) return { kind: 'movie' };
    var isVOD = ['film', 'movie', 'vod', 'kino', 'cinema'].some(function (k) {
      return lowerGroup.indexOf(k) >= 0;
    });
    var isSeries = istSerienGruppe(lowerGroup);
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
      /*
       * `#EXTGRP:` traegt die Gruppe bei Playlisten, die kein `group-title`
       * benutzen. Vorher fiel die Zeile unter „alles andere mit #" – solche
       * Sender landeten samt und sonders in „Allgemein". Zwei Folgen: Die
       * Kindersicherung arbeitet ueber Gruppennamen und griff nicht mehr, und
       * die Gruppe ist die verlaesslichste Quelle der Spracherkennung.
       */
      if (line.indexOf('#EXTGRP') === 0) {
        var dp = line.indexOf(':');
        if (dp >= 0 && !currentAttributes['group-title']) {
          var grp = line.substring(dp + 1).replace(/^\s+|\s+$/g, '');
          if (grp) currentAttributes['group-title'] = grp;
        }
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
      var epgID = epgKennung(currentAttributes['tvg-id']);
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
      } else if (!istTrennzeile(name)) {   // Gruppentrenner sind keine Sender
        result.channels.push({
          id: itemID, name: name, logoURL: logo, group: group,
          streamURL: line, epgID: epgID, sourceID: sourceID,
        });
      }
      currentName = ''; currentAttributes = {};
    }

    result.series = seriesOrder.map(function (k) { return seriesByName[k]; })
      .sort(function (a, b) { return a.title.localeCompare(b.title); });
    /*
     * Folgen nach Staffel und Nummer sortieren – wie es `parseEpisodes` fuer
     * Xtream tut. Ohne das stand die Folgenliste in Playlist-Reihenfolge, und
     * „naechste Folge" nahm den Datei-Nachfolger: Nach S01E05 lief S01E02.
     */
    for (var si = 0; si < result.series.length; si++) {
      var eps = result.series[si].episodes;
      if (eps && eps.length > 1) {
        eps.sort(function (a, b) { return (a.season - b.season) || (a.episode - b.episode); });
      }
    }
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

  /**
   * Kennung fuer den EPG-Abgleich vereinheitlichen.
   *
   * Sender und XMLTV kommen oft aus verschiedenen Ausgaben desselben Panels.
   * Steht in der Senderliste `tvg-id="ard.de "` und im XMLTV `channel="ARD.de"`,
   * schlug der Abgleich fehl und der Sender hatte still kein Programm — ohne
   * jeden Hinweis, dass es nur an einem Leerzeichen lag.
   *
   * NUR beim Vergleichen aufrufen, nicht beim Einlesen der Senderliste:
   * `toLowerCase()` ueber die 42.000 Kennungen dieses Panels kostete auf dem
   * Fernseher gemessen **53 MB Dauerbelegung** (230 -> 283 MB, eine Zeile
   * Unterschied). Nachgeschlagen werden aber nur die paar Dutzend Sender, die
   * gerade auf dem Bildschirm stehen.
   */
  function epgSchluessel(v) {
    var s = str(v);
    if (!s) return null;
    s = kopie(s.replace(/^\s+|\s+$/g, '').toLowerCase());
    return s || null;
  }

  /**
   * Sparsame Fassung fuer das Einlesen: nur Leerraum abschneiden, damit die
   * Kennung sauber gespeichert wird. Kleingeschrieben wird erst beim Vergleich.
   */
  function epgKennung(v) {
    var s = str(v);
    if (!s) return null;
    s = s.replace(/^\s+|\s+$/g, '');
    return s || null;
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
  /**
   * Anzeigename einer Kategorie. Unbekannte Kennungen bekommen einen eigenen,
   * sprechenden Namen statt „Allgemein": Dieser Sammelname steht nie in den
   * Sperrlisten, weshalb Panels, die ihre 18+-Rubrik aus der Kategorienliste
   * heraushalten (sie aber in den Streams mitliefern), die Kindersicherung
   * damit aushebelten.
   */
  function kategorieName(categories, rohID) {
    var id = str(rohID);
    var name = id && Object.prototype.hasOwnProperty.call(categories, id)
      ? categories[id] : null;
    if (typeof name === 'string' && name) return name;
    return id ? 'Unbekannte Kategorie ' + id : 'Ohne Kategorie';
  }

  function parseCategories(json) {
    /*
     * Prototypfrei: Die Schluessel kommen aus der Playlist. Bei einem
     * einfachen `{}` ist `map['constructor']` wahrheitsaehnlich – eine
     * Kategorie dieses Namens gaelte damit als bekannt, und Pruefungen der
     * Form `if (!gruppe)` fielen genau dort aus, wo sie schuetzen sollen.
     */
    var map = Object.create(null);
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

  /**
   * Adresse einer Archivaufnahme („Catch-up"/Timeshift).
   *
   * Xtream-Panels legen den Rueckblick unter einem eigenen Pfad ab, NICHT
   * unter `/live/`. Der Zeitpunkt steht darin in der Ortszeit des Panels, die
   * nicht die des Fernsehers sein muss – deshalb wird er nie selbst gerechnet,
   * sondern woertlich aus `get_simple_data_table` uebernommen (Feld `start`).
   * Jede Umrechnung waere eine Vermutung ueber die Zeitzone des Anbieters.
   *
   * `start` hat die Form `JJJJ-MM-TT:HH-MM`, `minuten` ist die Laufzeit.
   */
  function xtreamTimeshiftUrl(host, user, pass, minuten, start, sid) {
    return host + '/timeshift/' + encodeURIComponent(user) + '/' +
      encodeURIComponent(pass) + '/' + minuten + '/' + start + '/' + sid + '.m3u8';
  }

  /** Aeltere Panels kennen nur diesen Weg – als Ausweichadresse. */
  function xtreamTimeshiftUrlAlt(host, user, pass, minuten, start, sid) {
    return host + '/streaming/timeshift.php?username=' + encodeURIComponent(user) +
      '&password=' + encodeURIComponent(pass) + '&stream=' + sid +
      '&start=' + encodeURIComponent(start) + '&duration=' + minuten;
  }

  /** `2026-09-06 20:15:00` → `2026-09-06:20-15` (Form, die der Pfad braucht). */
  function timeshiftZeit(panelZeit) {
    var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(String(panelZeit || ''));
    return m ? m[1] + ':' + m[2] + '-' + m[3] : null;
  }

  /**
   * Base64 mit UTF-8-Inhalt entschluesseln.
   *
   * `get_simple_data_table` liefert Titel und Beschreibung base64-kodiert.
   * Eigene Umsetzung statt `atob`, damit dieselbe Funktion auch im Test ohne
   * Browser laeuft – und `atob` allein gaebe ohnehin Bytes zurueck, aus denen
   * „Tatort: Wehrlos" ohne UTF-8-Schritt als „TatortÂ Wehrlos" herauskaeme.
   */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64Text(roh) {
    var s = String(roh || '').replace(/[^A-Za-z0-9+/=]/g, '');
    if (!s) return '';
    var bytes = [], puffer = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '=') break;
      var w = B64.indexOf(c);
      if (w < 0) continue;
      puffer = (puffer << 6) | w;
      bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push((puffer >> bits) & 255); }
    }
    return utf8Text(bytes);
  }

  /** Bytefolge als UTF-8 lesen (ungueltige Folgen werden uebersprungen). */
  function utf8Text(bytes) {
    var out = '', i = 0;
    while (i < bytes.length) {
      var b = bytes[i++];
      if (b < 0x80) { out += String.fromCharCode(b); continue; }
      var zahl = -1, weitere = 0;
      if (b >= 0xC0 && b < 0xE0) { zahl = b & 0x1F; weitere = 1; }
      else if (b >= 0xE0 && b < 0xF0) { zahl = b & 0x0F; weitere = 2; }
      else if (b >= 0xF0 && b < 0xF8) { zahl = b & 0x07; weitere = 3; }
      else continue;                                  // Folgebyte ohne Anfang
      if (i + weitere > bytes.length) break;
      for (var k = 0; k < weitere; k++) {
        var f = bytes[i++];
        if ((f & 0xC0) !== 0x80) { zahl = -1; break; }
        zahl = (zahl << 6) | (f & 0x3F);
      }
      if (zahl < 0) continue;
      if (zahl > 0xFFFF) {
        zahl -= 0x10000;
        out += String.fromCharCode(0xD800 + (zahl >> 10), 0xDC00 + (zahl & 0x3FF));
      } else out += String.fromCharCode(zahl);
    }
    return out;
  }

  /**
   * Archivierbare Sendungen eines Senders aus `get_simple_data_table`.
   *
   * Behalten wird nur, was das Panel selbst als archiviert meldet
   * (`has_archive`), was in der Vergangenheit liegt und was noch innerhalb der
   * Archivdauer des Senders ist. Ohne die letzte Pruefung stuenden Sendungen
   * in der Liste, die der Server laengst geloescht hat – man waehlt sie aus
   * und bekommt einen schwarzen Bildschirm.
   *
   * Zeiten kommen aus `start_timestamp`/`stop_timestamp` (echte Unix-Sekunden,
   * damit die Anzeige zur uebrigen App passt), die Adresse dagegen aus dem
   * Textfeld `start` – das steht in der Ortszeit des Panels und darf nicht
   * umgerechnet werden.
   */
  /**
   * Obergrenze fuer die angeforderte Laenge einer Archivaufnahme.
   *
   * Das Panel baut die Wiedergabeliste linear auf – auf dem Geraet gemessen,
   * derselbe Sender und Startzeitpunkt:
   *
   *     60 Minuten   ->  HTTP 200 nach  5,4 s   (6 KB)
   *    240 Minuten   ->  HTTP 200 nach 17,5 s  (25 KB)
   *    720 Minuten   ->  Zeitueberschreitung
   *
   * Die 720 stammen nicht aus einer echten Sendung, sondern aus den
   * „Sendepause"-Bloecken, mit denen viele Panels ihre EPG-Luecken fuellen.
   * Ohne Deckel liefen genau diese Eintraege in einen schwarzen Bildschirm,
   * obwohl die Aufnahme vorhanden ist: mit 60 Minuten Anforderung spielte
   * derselbe Zeitpunkt einwandfrei.
   *
   * 180 Minuten decken jede reale Sendung samt Spielfilm ab und halten die
   * Wartezeit unter dem 30-Sekunden-Limit des Players.
   */
  var ARCHIV_MAX_MINUTEN = 180;

  function parseArchivListe(json, archivTage, jetzt) {
    var out = [];
    var liste = json && (json.epg_listings || json.epg_listing || json.js);
    if (!liste || !liste.length) return out;
    jetzt = jetzt || Date.now();
    var grenze = archivTage > 0 ? jetzt - archivTage * 86400000 : null;

    for (var i = 0; i < liste.length; i++) {
      var e = liste[i];
      if (!e || typeof e !== 'object') continue;
      // `has_archive` kommt mal als 1, mal als "1" – beides gilt.
      var hat = e.has_archive;
      if (!(hat === 1 || hat === '1' || hat === true)) continue;

      var start = num(e.start_timestamp);
      var stop = num(e.stop_timestamp);
      if (start === null || stop === null || stop <= start) continue;
      start *= 1000; stop *= 1000;
      if (start >= jetzt) continue;                 // laeuft noch oder kommt erst
      if (grenze !== null && start < grenze) continue;   // vom Server geloescht

      var zeit = timeshiftZeit(e.start);
      if (!zeit) continue;                          // ohne Startzeit keine Adresse

      var minuten = Math.max(1, Math.round((stop - start) / 60000));
      out.push({
        title: base64Text(e.title) || '(ohne Titel)',
        desc: base64Text(e.description) || null,
        start: start,
        end: stop,
        // Fuer die Adresse: woertliche Panel-Ortszeit und Laufzeit in Minuten.
        panelStart: zeit,
        minuten: minuten,
        // Was tatsaechlich angefordert wird – siehe ARCHIV_MAX_MINUTEN.
        abrufMinuten: Math.min(minuten, ARCHIV_MAX_MINUTEN),
      });
    }
    // Neueste zuerst – danach sucht man beim Zurueckschauen. Zweitschluessel,
    // weil `Array#sort` auf Chromium 53 nicht stabil ist.
    for (var p = 0; p < out.length; p++) out[p]._p = p;
    out.sort(function (a, b) { return b.start - a.start || a._p - b._p; });
    for (var q = 0; q < out.length; q++) delete out[q]._p;
    return out;
  }

  /**
   * Trennzeile einer Playlist erkennen (`##### 4K ᵁᴴᴰ #####`).
   *
   * Anbieter stellen solche Zeilen als optische Gruppentrenner in ihre Liste.
   * Sie sind keine Sender: Wer sie anwaehlt, bekommt einen schwarzen
   * Bildschirm. Die App zeichnete sie als ganz normale, anwaehlbare Zeile –
   * auf diesem Panel 697 Stueck, und ausgerechnet eine davon stand als Zeile 1
   * ganz oben in der Senderliste.
   *
   * Bewusst eng: Rauten an BEIDEN Enden. Gegen die echten 42.907 Namen
   * geprueft trifft das genau die 697 Trenner – und keinen einzigen Sender,
   * der nur an einem Ende Rauten traegt (davon gibt es keinen).
   */
  function istTrennzeile(name) {
    var t = String(name || '').replace(/^\s+|\s+$/g, '');
    return /^#{3,}[\s\S]*#{3,}$/.test(t);
  }

  function parseLiveStreams(json, categories, host, user, pass, sourceID) {
    var out = [];
    if (!json || !json.length) return out;
    for (var i = 0; i < json.length; i++) {
      var s = json[i];
      if (!s || typeof s !== 'object') continue;   // ein null kippte sonst den Import
      var id = num(s.stream_id);
      if (id === null) continue;
      if (istTrennzeile(s.name)) continue;      // Gruppentrenner, kein Sender
      out.push({
        // Kennung aus der Stream-Nummer: kurz, stabil und ohne Zugangsdaten.
        id: sourceID + '|l|' + id,
        name: str(s.name) || ('Sender ' + id),
        logoURL: str(s.stream_icon),
        group: kategorieName(categories, s.category_id),
        sid: id,
        art: 'live',
        epgID: epgKennung(s.epg_channel_id),
        xtreamStreamID: id,
        archiveDays: num(s.tv_archive_duration),
        sourceID: sourceID,
      });
    }
    return out;
  }

  /** Jahreszahl aus einem Titel wie „Der Vorname (2018)" holen. */
  function jahrAusTitel(titel) {
    var m = /\((19|20)(\d{2})\)/.exec(String(titel || ''));
    return m ? Number(m[1] + m[2]) : null;
  }

  function parseVodStreams(json, categories, host, user, pass, sourceID) {
    var out = [];
    if (!json || !json.length) return out;
    for (var i = 0; i < json.length; i++) {
      var s = json[i];
      if (!s || typeof s !== 'object') continue;   // ein null kippte sonst den Import
      var id = num(s.stream_id);
      if (id === null) continue;
      out.push({
        id: sourceID + '|m|' + id,
        title: str(s.name) || ('Film ' + id),
        posterURL: str(s.stream_icon),
        group: kategorieName(categories, s.category_id),
        sid: id,
        art: 'movie',
        ext: str(s.container_extension) || null,
        rating: num(s.rating),
        // 108.246 von 142.246 echten Titeln tragen „(JJJJ)". Ohne das blieb das
        // Jahr auf jeder Detailseite leer und die Sortierung „Jahr" verglich
        // durchgehend -1 mit -1, war also wirkungslos.
        year: jahrAusTitel(s.name),
        // Zeitpunkt der Aufnahme in den Katalog (Unix-Sekunden). Panels
        // liefern das Feld praktisch immer mit; ohne es gaebe es keine
        // Sortierung „Neu hinzugefuegt", und genau danach sucht man auf einer
        // Startseite als Erstes.
        added: num(s.added),
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
    return scanIndex(text, eintragLesen);
  }

  /**
   * Dasselbe fuer `get_series`. Serien lagen bisher nur kategorieweise vor:
   * Wer eine Serie suchte, deren Kategorie er noch nicht geoeffnet hatte, fand
   * nichts — obwohl die Suche „Serien" als eigene Sparte anzeigt. Der Katalog
   * ist mit rund 12.000 Titeln deutlich kleiner als der Filmkatalog, der Scan
   * kostet entsprechend wenig.
   */
  function scanSeriesIndex(text) {
    return scanIndex(text, serienEintragLesen);
  }

  function scanIndex(text, lesen) {
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
          lesen(out, text.slice(start, i + 1));
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

  /** Dasselbe fuer einen Serien-Datensatz: `series_id` statt `stream_id`. */
  function serienEintragLesen(out, roh) {
    var sid = feldText(roh, 'series_id');
    if (!sid) return;
    out.push({
      s: Number(sid),
      t: feldText(roh, 'name') || ('Serie ' + sid),
      c: feldText(roh, 'category_id'),
      p: feldText(roh, 'cover')
    });
  }

  /**
   * Ein JSON-Stringfeld aus einem Textausschnitt holen (mit Escapes).
   *
   * WICHTIG: Das Ergebnis wird bewusst kopiert. V8 legt fuer Teilzeichenketten
   * ab 13 Zeichen keine Kopie an, sondern einen Zeiger auf den Elternstring —
   * ein einziger behaltener Filmtitel haelt damit die GANZE Antwort im
   * Speicher. Beim Titelverzeichnis waeren das 58 MB statt der 15 MB
   * Nutzdaten; gemessen wurden 60,5 MB gegenueber 3,8 MB mit Kopie. Genau
   * diesen Posten soll das Verzeichnis ja vermeiden.
   */
  function feldText(text, feld) {
    var re = new RegExp('"' + feld + '":\\s*"((?:[^"\\\\]|\\\\.)*)"');
    var m = re.exec(text);
    if (!m) {
      // Zahlenfelder wie category_id kommen je nach Panel ohne Anfuehrungszeichen.
      var reZahl = new RegExp('"' + feld + '":\\s*(\\d+)');
      var m2 = reZahl.exec(text);
      return m2 ? kopie(m2[1]) : '';
    }
    return kopie(jsonEntkleiden(m[1]));
  }

  /** Flache Kopie erzwingen, damit kein Zeiger auf den Elternstring bleibt. */
  function kopie(s) {
    if (!s) return '';
    return (' ' + s).slice(1);
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
      if (!s || typeof s !== 'object') continue;   // ein null kippte sonst den Import
      var id = num(s.series_id);
      if (id === null) continue;
      out.push({
        id: sourceID + '|series|' + id,
        title: str(s.name) || ('Serie ' + id),
        posterURL: str(s.cover),
        group: kategorieName(categories, s.category_id),
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

  /**
   * Sprache aus einem Text bestimmen.
   *
   * `nurLange` blendet Aliase mit hoechstens drei Zeichen aus. Die sind fuer
   * Kategorienamen gedacht („DE", „FR"), treffen in Filmtiteln aber gewoehnliche
   * Woerter: Gemessen an 142.246 echten Titeln schlug „at" 1937-mal zu
   * („Five Nights at Freddy's" → Oesterreich), „it" 4252-mal, „se" 4743-mal.
   */
  function detectLanguage(text, nurLange) {
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
      if (nurLange && t.length <= 3) continue;
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
  /**
   * Bibliothek auf bevorzugte Sprachen filtern.
   *
   * `modus` steuert, wie streng das geschieht:
   *   'grosszuegig' – alles Passende plus alles, was keine Sprache preisgibt
   *   'ausgewogen'  – Kategorien mit erkennbarer Sprache werden gefiltert,
   *                   neutrale Kategorien bleiben vollstaendig (Standard)
   *   'streng'      – nur Eintraege, deren Sprache nachweislich passt
   *
   * Fuer Bestandsaufrufe gilt weiterhin `true` = streng, `false` = grosszuegig.
   */
  function filterByLanguage(playlist, preferred, modus) {
    if (!preferred || !preferred.length) return playlist;
    if (modus === true) modus = 'streng';
    else if (modus === false || modus === undefined) modus = 'grosszuegig';
    var strict = modus !== 'grosszuegig';

    // Auswahl als Nachschlagewerk statt indexOf je Element.
    var wanted = {};
    for (var w = 0; w < preferred.length; w++) wanted[preferred[w]] = true;

    /**
     * Sprache eines Eintrags: erst die Kategorie, dann – nur mit langen
     * Aliasen – der Titel.
     *
     * Vorher wurden beide als EIN Text bewertet, und weil der laengste Treffer
     * gewinnt, schlug ein Wort aus dem Titel das zweibuchstabige Kuerzel der
     * Kategorie. Gemessen: 3.527 von 142.246 Titeln (2,5 %) fielen in einer
     * reinen DE-Gruppe aus dem strikten DE-Filter — „Captain America" als
     * Englisch, „Made in Italy" als Italienisch.
     */
    function spracheVon(gruppe, titel) {
      var ausGruppe = detectLanguage(gruppe);
      if (ausGruppe !== null) return ausGruppe;
      return detectLanguage(titel, true);
    }

    /*
     * Ist eine Kategorie ueberhaupt sprachlich sortiert?
     *
     * Verlaesslich ist nur das Kuerzel der Kategorie selbst. Sonst entscheidet
     * die Mehrheit der Titel: Tragen die meisten ein Sprachmerkmal („DE - …",
     * „FR - …"), ist die Kategorie sortiert. Ein einzelnes „The Italian Job"
     * unter zwoelf neutralen Titeln macht sie es nicht.
     *
     * Vorher galt das Netz je LISTE und liess sich von einem einzigen Eintrag
     * kippen — auf dem Geraet gemessen: eine Kategorie mit 13 Filmen zeigte 0.
     */
    var ANTEIL_SORTIERT = 0.5;

    function filterItems(items, textOf, gruppeOf) {
      var gruppen = Object.create(null);
      var i, it, g;
      // Sprache je Element EINMAL bestimmen und am Element merken.
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (it._lang === undefined) it._lang = textOf(it);
        g = gruppeOf(it) || '';
        if (!gruppen[g]) {
          gruppen[g] = {
            ausGruppe: detectLanguage(g) !== null,
            gesamt: 0,
            mitSprache: 0
          };
        }
        gruppen[g].gesamt++;
        if (it._lang !== null) gruppen[g].mitSprache++;
      }

      // Je Kategorie entscheiden, ob gefiltert wird.
      for (g in gruppen) {
        if (!Object.prototype.hasOwnProperty.call(gruppen, g)) continue;
        var d = gruppen[g];
        d.filtern = d.ausGruppe ||
          (d.gesamt > 0 && d.mitSprache / d.gesamt >= ANTEIL_SORTIERT);
      }

      var out = [];
      for (var j = 0; j < items.length; j++) {
        var x = items[j];
        var info = gruppen[gruppeOf(x) || ''];
        // Im strengen Modus greift das Netz nicht: Dort ist ausdruecklich
        // gewuenscht, dass alles ohne nachgewiesene Sprache wegfaellt.
        if (modus !== 'streng' && (!info || !info.filtern)) { out.push(x); continue; }
        if ((x._lang !== null && wanted[x._lang]) || (!strict && x._lang === null)) out.push(x);
      }
      return out;
    }

    return {
      channels: filterItems(playlist.channels,
        function (c) { return spracheVon(c.group, c.name); },
        function (c) { return c.group; }),
      movies: filterItems(playlist.movies,
        function (m) { return spracheVon(m.group, m.title); },
        function (m) { return m.group; }),
      series: filterItems(playlist.series,
        function (s) { return spracheVon(s.group, s.title); },
        function (s) { return s.group; }),
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
    /*
     * Neben `±HHMM` auch `Z`, `UTC`, `GMT` und `±HH:MM` erkennen. Vorher fiel
     * alles davon in den Zweig „Ortszeit" – eine mit `Z` ausgezeichnete
     * Sendung war in Berlin um eine Stunde verschoben (im Sommer zwei), in
     * Auckland um dreizehn.
     */
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?/i
      .exec(raw.replace(/^\s+|\s+$/g, ''));
    if (!m) return null;
    var year = +m[1], month = +m[2] - 1, day = +m[3];
    var hour = +m[4], minute = +m[5], second = m[6] ? +m[6] : 0;
    var zone = m[7];
    if (zone) {
      var offMin = 0;
      if (!/^(Z|UTC|GMT)$/i.test(zone)) {
        var ziffern = zone.replace(':', '');
        var sign = ziffern.charAt(0) === '-' ? -1 : 1;
        offMin = sign * (parseInt(ziffern.substr(1, 2), 10) * 60 +
                         parseInt(ziffern.substr(3, 2), 10));
      }
      return new Date(Date.UTC(year, month, day, hour, minute, second) - offMin * 60000);
    }
    return new Date(year, month, day, hour, minute, second);
  }

  /** Attributwert aus einem Element-Kopf holen (einfache oder doppelte Quotes). */
  function attrAus(kopf, name) {
    var re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')');
    var m = re.exec(kopf);
    if (!m) return '';
    // Fanggruppen sind in V8 ebenfalls Zeiger auf den Elternstring.
    return kopie(m[2] !== undefined ? m[2] : (m[3] || ''));
  }

  /**
   * Inhalt des ERSTEN <tag> in einem Ausschnitt. Bei mehrsprachigen
   * <title lang="de"> nimmt das – wie zuvor der DOM-Weg – die erste Fassung.
   */
  function elementText(koerper, tag) {
    var auf = koerper.indexOf('<' + tag);
    if (auf < 0) return null;
    var zu = koerper.indexOf('>', auf);
    if (zu < 0) return null;
    if (koerper.charAt(zu - 1) === '/') return '';        // <title/>
    var endTag = koerper.indexOf('</' + tag + '>', zu);
    if (endTag < 0) return null;
    return entitaeten(koerper.slice(zu + 1, endTag));
  }

  /** Die fuenf XML-Entitaeten plus Zahlenreferenzen aufloesen. */
  /**
   * XML-Entitaeten aufloesen – und das Ergebnis IMMER als eigenstaendige
   * Zeichenkette zurueckgeben.
   *
   * Ohne `kopie()` ist der haeufige Fall (Text ohne `&`) ein Rueckgabewert,
   * der auf denselben V8-SlicedString zeigt wie der Ausschnitt aus der
   * XMLTV-Datei. Jeder behaltene Sendungstitel haelt damit die GANZE Datei im
   * Speicher – hier 64,4 MB. Genau dieser Fehler war beim Titelverzeichnis
   * schon einmal dran; im XMLTV-Scanner stand die Kopie noch aus.
   */
  function entitaeten(t) {
    if (t.indexOf('&') < 0) return kopie(t);
    return t
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, z) { return String.fromCharCode(+z); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, z) { return String.fromCharCode(parseInt(z, 16)); })
      .replace(/&amp;/g, '&');   // zuletzt, sonst werden Doppelungen falsch
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
        var wk = epgSchluessel(wantedIds[f]);
        if (wk) filter[wk] = true;
      }
    }
    // Rohkennung -> vereinheitlichte Kennung, damit die Normalisierung je
    // Sender genau einmal laeuft statt je Sendung.
    var schluessel = Object.create(null);
    /*
     * Zeitfenster eng halten. Auf dem Geraet gemessen: Mit −8/+72 Stunden
     * blieben aus der 64-MB-Datei dieses Panels **107.495 Sendungen** im
     * Speicher und der Heap stieg auf **347 MB** – fuer eine Ansicht, die je
     * Sender nur „laeuft gerade" und „danach" zeigt.
     *
     * −2/+6 Stunden decken beides ab, und der Auffrischer laedt alle vier
     * Stunden nach. Wer spaeter einen echten Programmfuehrer ueber den Tag
     * bauen will, braucht hier ein groesseres Fenster – dann aber besser
     * bedarfsweise je Sender statt alles auf einmal.
     */
    var now = Date.now();
    var from = now - 2 * 3600 * 1000;
    var to = now + 6 * 3600 * 1000;

    /*
     * KEIN DOMParser. Auf dem Geraet gemessen: Die XMLTV-Datei dieses Panels
     * ist 64 MB gross und enthaelt 206.615 Sendungen; `parseFromString`
     * brauchte dafuer allein **12 Sekunden** und baute einen vollstaendigen
     * Baum auf – fuer Daten, von denen anschliessend fast alles wieder
     * verworfen wird (gefiltert auf die vorhandenen Sender und ein Zeitfenster
     * von 80 Stunden).
     *
     * Der Scanner geht stattdessen einmal linear ueber den Text und baut nur
     * fuer die Sendungen etwas auf, die tatsaechlich behalten werden. Dieselbe
     * Technik wie beim Titelverzeichnis der Filme.
     */
    var pos = 0, i;
    while (true) {
      var anfang = xmlText.indexOf('<programme', pos);
      if (anfang < 0) break;
      var kopfEnde = xmlText.indexOf('>', anfang);
      if (kopfEnde < 0) break;
      var ende = xmlText.indexOf('</programme>', kopfEnde);
      var naechster = xmlText.indexOf('<programme', kopfEnde);
      // Selbstschliessend oder fehlendes Endetag: bis zum naechsten Eintrag.
      if (ende < 0 || (naechster >= 0 && naechster < ende)) ende = kopfEnde;
      pos = ende + 1;

      var kopf = xmlText.slice(anfang, kopfEnde);
      /*
       * Ueber den Zwischenspeicher, nicht direkt: `epgSchluessel` laeuft sonst
       * fuer JEDE der 206.615 Sendungen und legt jedes Mal eine neue
       * Zeichenkette an – auf dem Geraet gemessen 52 MB Dauerbelegung, obwohl
       * es nur rund 1.400 verschiedene Senderkennungen gibt. Mit dem
       * Zwischenspeicher teilen sich alle Sendungen eines Senders dieselbe.
       */
      var roh = attrAus(kopf, 'channel');
      var channel = schluessel[roh];
      if (channel === undefined) channel = schluessel[roh] = epgSchluessel(roh);
      if (!channel) continue;
      if (filter && !filter[channel]) continue;

      var start = parseXmltvDate(attrAus(kopf, 'start'));
      var stop = parseXmltvDate(attrAus(kopf, 'stop'));
      if (!start || !stop) continue;
      if (stop.getTime() < from || start.getTime() > to) continue;

      var koerper = ende > kopfEnde ? xmlText.slice(kopfEnde + 1, ende) : '';
      if (!epg[channel]) epg[channel] = [];
      epg[channel].push({
        channelID: channel,
        title: elementText(koerper, 'title') || '(ohne Titel)',
        desc: elementText(koerper, 'desc'),
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

  /**
   * Relevanz eines Titels zu einer Suchanfrage. 0 heisst „passt nicht".
   *
   * Warum ueberhaupt: Die Suche nahm bisher die ERSTEN 30 Titel, in denen die
   * Anfrage irgendwo vorkam, und brach dann ab. Bei 142.000 Filmen entschied
   * damit die Reihenfolge im Katalog des Anbieters, was man zu sehen bekam:
   * „Matrix" lieferte „Die Matrix-Verschwoerung" und „Matrixx", der eigentlich
   * gesuchte Film stand irgendwo dahinter und wurde nie erreicht.
   *
   * Bewertet wird, WO die Anfrage sitzt — je weiter vorn und je genauer die
   * Wortgrenze, desto hoeher:
   *
   *   1000  Titel ist die Anfrage
   *    800  Titel beginnt mit der Anfrage        („Matrix Reloaded")
   *    600  Anfrage steht auf einer Wortgrenze   („DE| Matrix (1999)")
   *    400  Anfrage steht irgendwo im Titel      („Matrixx")
   *    300  alle Woerter kommen vor, in beliebiger Reihenfolge
   *
   * Der Abzug fuer die Titellaenge sortiert bei gleichem Rang den knapperen
   * Titel nach oben: „Matrix" vor „Matrix – Die Dokumentation ueber …".
   */
  /*
   * Hochgestellte Qualitaetsangaben aus einem ANZEIGETITEL entfernen.
   *
   * IPTV-Playlisten haengen „ᵁᴴᴰ ³⁸⁴⁰ᴾ ᴰᵒˡᵇʸ ⱽᶦˢᶦᵒⁿ" an fast jeden Namen –
   * auf diesem Panel an 27.900 von 42.907 Sendern. Bei 22 px Grundgroesse
   * sind diese Glyphen rund 11 px hoch: auf drei Metern unter der
   * Aufloesungsgrenze, also reine Stoerung. Schlimmer noch, sie verbrauchen
   * genau die Breite, in der `text-overflow: ellipsis` anschliessend den
   * echten Namen abschneidet, und in mancher Ersatzschrift erscheinen sie als
   * leere Kaestchen.
   *
   * Gelesen werden die Angaben weiterhin: `markenAusTitel` bekommt das
   * ORIGINAL und macht daraus die lesbaren 4K/HD/Dolby-Marken. Gekuerzt wird
   * ausschliesslich fuer die Anzeige – Suche, Sortierung und Kennungen
   * arbeiten unveraendert mit dem vollen Namen.
   *
   * Bereiche: U+02B0–02FF Modifikatorbuchstaben, U+1D2C–1DBF phonetische
   * Erweiterungen, U+2070–209F Hoch-/Tiefstellungen, U+2C7C/2C7D sowie die
   * drei Altlasten ¹²³ aus Latin-1. `{2,}`: nur Ketten, nie ein Einzelzeichen
   * – ein alleinstehendes U+02BC ist in echten Titeln ein Apostroph
   * („Hawaiʻi") und muss stehen bleiben.
   */
  var HOCHGESTELLT =
    /[²³¹ʰ-˿ᴬ-ᶿ⁰-₟ⱼⱽ]{2,}/g;
  var QUALITAET_ENDE =
    /[\s|:·\-]*\b(?:4K|UHD|FHD|HD|SD|2160P?|1080P?|720P?|DOLBY(?:\s+(?:AUDIO|VISION|ATMOS))?|ATMOS|VISION)\b[\s|:·\-]*$/i;

  function titelKurz(titel) {
    var roh = String(titel || '');
    var t = roh.replace(HOCHGESTELLT, ' ');
    // Dreimal: „… 4K UHD Dolby Audio" braucht drei Durchlaeufe.
    t = t.replace(QUALITAET_ENDE, '').replace(QUALITAET_ENDE, '')
         .replace(QUALITAET_ENDE, '');
    t = t.replace(/\s{2,}/g, ' ')
         .replace(/^[\s|:·\-]+/, '')
         .replace(/[\s|:·\-]+$/, '');
    // Notausgang: Ein Titel, der NUR aus Qualitaetsangaben besteht, waere sonst
    // leer – dann lieber das Original als eine namenlose Zeile.
    return t.length >= 2 ? t : roh;
  }

  /*
   * Anbieter-Kuerzel („TOP - ", „4K:", „IE|") vor Titeln erkennen.
   *
   * Auf diesem Panel beginnt in der Kategorie „TOP KIDS BLURAY" JEDER der 100
   * Filme mit „TOP - ". Das Kuerzel frisst die erste Haelfte der Beschriftung,
   * und der echte Titel wird dahinter abgeschnitten („TOP - Justice League:
   * Crisis on…").
   *
   * Eine feste Liste bekannter Kuerzel waere falsch: Jedes Panel hat andere,
   * und echte Titel faengt man damit mit – „IT: Chapter Two", „M: Eine Stadt
   * sucht einen Moerder", „TED: For the Love of Science" wuerden verstuemmelt.
   * Deshalb wird GELERNT statt geraten: Ein Kuerzel gilt nur, wenn es viele
   * Titel DERSELBEN Liste anfuehrt. Gegen den echten Katalog gemessen kuerzt
   * das 26.328 von 42.907 Sendernamen und laesst die Faelle oben in Ruhe.
   */
  function praefixVon(titel) {
    // Kleinbuchstaben schliessen aus: „The Matrix" darf nie „The" ergeben.
    var m = /^([A-Z0-9+._]{1,12})\s*[-:|]\s+/.exec(String(titel || ''));
    return m ? m[1] : null;
  }

  /**
   * Kuerzel bestimmen, die in dieser Liste wirklich Anbietertags sind.
   * `mindestZahl` faengt kurze Listen ab: Bei drei Titeln ist „alle drei
   * fangen mit IT: an" kein Beleg.
   */
  function tagsErkennen(titel, mindestAnteil, mindestZahl) {
    mindestAnteil = mindestAnteil || 0.3;
    mindestZahl = mindestZahl || 4;
    var zaehler = Object.create(null), gesamt = 0, i;
    for (i = 0; i < titel.length; i++) {
      var pf = praefixVon(titel[i]);
      gesamt++;
      if (pf) zaehler[pf] = (zaehler[pf] || 0) + 1;
    }
    var tags = Object.create(null);
    if (gesamt < mindestZahl) return tags;
    for (var k in zaehler) {
      if (zaehler[k] >= mindestZahl && zaehler[k] / gesamt >= mindestAnteil) tags[k] = true;
    }
    return tags;
  }

  /** Titel fuer die Anzeige um sein Kuerzel kuerzen – nur wenn Rest bleibt. */
  function titelOhneTag(titel, tags) {
    var pf = praefixVon(titel);
    if (!pf || !tags || !tags[pf]) return titel;
    var rest = String(titel).replace(/^([A-Z0-9+._]{1,12})\s*[-:|]\s+/, '');
    // Ein Sender, der wirklich „TOP - 1" heisst, soll nicht zu „1" werden.
    return rest.length >= 2 ? rest : titel;
  }

  function trefferRang(titel, anfrage, teile) {
    if (!titel || !anfrage) return 0;
    var t = titel.toLowerCase();
    var pos = t.indexOf(anfrage);
    var rang = 0;

    if (pos >= 0) {
      if (t.length === anfrage.length) rang = 1000;
      else if (pos === 0) rang = 800;
      else if (istWortgrenze(t, pos)) rang = 600;
      else rang = 400;
      // Frueher im Titel ist besser, aber nie so stark, dass es eine Stufe kippt.
      rang -= Math.min(pos, 60) / 2;
    } else if (teile && teile.length > 1) {
      // „knight dark" soll „The Dark Knight" finden. Nur wenn ALLE Woerter
      // vorkommen – sonst faende „der herr" jeden zweiten Titel.
      for (var i = 0; i < teile.length; i++) {
        if (t.indexOf(teile[i]) < 0) return 0;
      }
      rang = 300;
    } else {
      return 0;
    }

    // Laengenabzug, gedeckelt: ein sehr langer Titel soll nicht unter eine
    // ganze Rangstufe fallen, nur weiter hinten in seiner Stufe stehen.
    return rang - Math.min(t.length, 90) / 2;
  }

  /** Steht an `pos` ein Wortanfang? (Zeichen davor ist kein Buchstabe/Ziffer.) */
  function istWortgrenze(text, pos) {
    var c = text.charCodeAt(pos - 1);
    if (c >= 48 && c <= 57) return false;               // 0-9
    if (c >= 97 && c <= 122) return false;              // a-z
    // Umlaute und Akzente zaehlen als Buchstabe. \p{L} kennt Chromium 53 nicht,
    // der Latin-1- und Latin-Extended-A-Bereich deckt die hier ueblichen ab.
    if (c >= 0xC0 && c <= 0x17F) return false;
    return true;
  }

  /** Anfrage in Suchwoerter zerlegen (leere Teile fallen weg). */
  function sucheZerlegen(anfrage) {
    var roh = String(anfrage || '').toLowerCase().split(/\s+/);
    var out = [];
    for (var i = 0; i < roh.length; i++) if (roh[i]) out.push(roh[i]);
    return out;
  }

  global.GlassTVCore = {
    parseM3U: parseM3U,
    displayNameIndex: displayNameIndex,
    sanitizedHost: sanitizedHost,
    xtreamApi: xtreamApi,
    xtreamStreamUrl: xtreamStreamUrl,
    xtreamTimeshiftUrl: xtreamTimeshiftUrl,
    xtreamTimeshiftUrlAlt: xtreamTimeshiftUrlAlt,
    timeshiftZeit: timeshiftZeit,
    base64Text: base64Text,
    parseArchivListe: parseArchivListe,
    ARCHIV_MAX_MINUTEN: ARCHIV_MAX_MINUTEN,
    parseCategories: parseCategories,
    parseLiveStreams: parseLiveStreams,
    istTrennzeile: istTrennzeile,
    parseVodStreams: parseVodStreams,
    scanVodIndex: scanVodIndex,
    scanSeriesIndex: scanSeriesIndex,
    trefferRang: trefferRang,
    titelKurz: titelKurz,
    praefixVon: praefixVon,
    tagsErkennen: tagsErkennen,
    titelOhneTag: titelOhneTag,
    sucheZerlegen: sucheZerlegen,
    parseSeriesList: parseSeriesList,
    parseEpisodes: parseEpisodes,
    detectLanguage: detectLanguage,
    filterByLanguage: filterByLanguage,
    SPRACH_MODI: ['grosszuegig', 'ausgewogen', 'streng'],
    epgSchluessel: epgSchluessel,
    epgKennung: epgKennung,
    parseXMLTV: parseXMLTV,
    parseXmltvDate: parseXmltvDate,
    nowProgram: nowProgram,
    nextProgram: nextProgram,
    LANG_NAMES: LANG_NAMES,
    LANG_FLAGS: LANG_FLAGS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
