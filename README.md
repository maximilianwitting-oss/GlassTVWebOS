# GlassTV — webOS (LG Smart TV)

GlassTV für LG-Fernseher. **Kein Android-Port**: webOS führt Web-Apps aus
(HTML/CSS/JS, verpackt als `.ipk`), das APK der Quest-/Android-Version läuft
hier nicht. Die Kern-Logik ist deshalb aus `GlassTVCore-Kotlin` nach
JavaScript portiert — mit denselben Testfällen.

## Status

Auf einem LG C9 (webOS 4.10) installiert und im Betrieb geprüft – mit einer
Playlist aus 42.864 Sendern, 142.246 Filmen und 31.569 Serien.

- **Tabs**: Start · Live TV · Filme · Serien · Favoriten; Suche, Guide und
  Einstellungen als Schaltflächen rechts oben.
- **Start**: Regale für Weiterschauen (mit Restzeit), Jetzt im TV, Filme, Serien.
- **Quellen**: Xtream Codes (Sender, Filme, Serien, Folgen und Filmdetails auf
  Nachfrage) und M3U/M3U8. Zugangsdaten liegen nur im `localStorage` des Geräts.
- **Filme und Serien kommen kategorieweise**, nicht am Stück: Beim Start holt die
  App nur die Kategorienlisten (24 KB statt 58 MB), der Inhalt einer Kategorie
  folgt beim Öffnen in etwa einer Viertelsekunde. Die drei zuletzt geöffneten
  Kategorien bleiben im Speicher. Bei M3U-Quellen bleibt es beim bisherigen
  Verhalten – dort steht ohnehin alles in einer Datei.
- **Kategorien**: Chips in Live TV, Filmen und Serien; Sortierung nach Name,
  Jahr oder Bewertung.
- **Detailseiten**: Backdrop, Beschreibung, Regie/Besetzung, Favorit,
  „Weiter ab …" und ähnliche Titel. Serien mit Staffel-Chips und Folgenliste.
- **EPG**: XMLTV vom Panel; laufende Sendung mit Fortschrittsbalken, „danach …"
  und ein Programmführer (grüne Taste).
- **Player**: HTML5-`<video>` – Fortschrittsanzeige, Weiterschauen-Position,
  automatische nächste Folge, Zapping mit ◀ ▶ bei Live.
- **Designs**: 18 Designs (6 helle, 12 dunkle) und 15 Akzentfarben aus der
  iOS-App, plus „Überrasch mich". Standard ist das helle „Perl" wie dort. Ein
  Wechsel tauscht das komplette Schema – Flächen, Ränder und Textfarben ziehen
  mit, sonst stünde eine dunkle Karte auf hellem Grund.
- **Sprachfilter** mit demselben Sicherheitsnetz wie iOS, **Kategorien
  ausblenden** und **Kindersicherung** (PIN sperrt Kategorien app-weit). Beide
  Kategorielisten haben ein Suchfeld – die getestete Playlist hat 1140
  Kategorien, ohne Suche wären die alphabetisch hinteren unerreichbar (und
  gerade die 18+-Kategorien heißen typisch „XXX …").
- **Profile** mit „Wer schaut?"-Auswahl beim Start (erscheint nur ab dem
  zweiten Profil). Favoriten, Merkliste und Verlauf sind profilbezogen; das
  Hauptprofil behält bewusst die alten Speicherschlüssel, damit bestehende
  Installationen nichts verlieren.
- **Meine Liste**: eigener Merkzettel neben den Favoriten, als Regal auf der
  Startseite und im Favoriten-Tab.
- **Empfehlungen**: „Für dich" und „Weil du … gesehen hast" aus der
  Kategorie-Affinität des Verlaufs, mit Recency-Decay 1/(1+Tage/7) wie in der
  iOS-App – ohne den Abfall bestimmt für immer, was man einmal gesehen hat.
- **Zurück-Taste** in Stufen: Unteransicht → Liste, geöffnete Kategorie →
  Kategorienliste, anderer Tab → Startseite, Startseite → App beenden (über
  `webOS.platformBack()`).
- **Magic Remote**: Der Zeiger führt den Fokus – was unter ihm liegt, ist
  fokussiert, damit es weiterhin genau eine Ortsangabe gibt. Bei sichtbarem
  Zeiger wird der Fokusring ruhiger (der Zeiger zeigt die Position ja selbst).
- **Bedienung**: vollständig mit der Fernbedienung. Der Fokus wandert
  *geometrisch* (nicht in DOM-Reihenfolge), damit Raster und Reihen sich
  räumlich anfühlen. Farbtasten: grün = Guide, gelb = Suche, blau = Favorit.

- **Statistik**: Sehzeit, zu Ende gesehen, Tage am Stück, verschiedene Sender,
  Wochenübersicht und Top-Kategorien (Einstellungen → Statistik). Gezählt
  werden **Titel je Tag**, keine erfundenen Minuten – ein Verlaufseintrag trägt
  nur einen Stand, eine echte Sehzeit je Tag gibt er nicht her.
Nicht enthalten: Downloads und Mini-Player – beides ist auf diesem Gerät
technisch nicht möglich (siehe unten).

## Was auf dem Gerät gilt

- **Chromium 53.** Der Fernseher kennt weder CSS Grid noch `gap`, `inset` oder
  `aspect-ratio`. Ein `inset: 0` auf dem Player-Overlay ließ dieses auf Größe
  null zusammenfallen – der Film lief, war aber unsichtbar. Deshalb: Raster über
  `inline-block`, Abstände über `margin`, Seitenverhältnisse über den
  `padding-top`-Trick.
- **MKV läuft.** `canPlayType("video/x-matroska")` sagt zwar nichts zu, der
  Fernseher spielt es über seine native Pipeline dennoch ab – auf dem Gerät mit
  einem 4K-MKV geprüft.
- **Video ist nicht im Screenshot.** Die Wiedergabe läuft auf einer Hardware-
  Ebene, die der Browser nicht mitzeichnet: Ein Screenshot des laufenden Films
  ist schwarz, obwohl auf dem Schirm das Bild steht.
- **Große Listen** werden bewusst in Blöcken gezeichnet (120 Senderzeilen,
  63 Kacheln, Nachladen über eine Schaltfläche) – der TV-Browser bricht sonst
  ein, und jede sichtbare Kachel kostet ein dekodiertes Bild.
- **Speicher.** Auf dem Gerät gemessen mit einer Playlist aus 42.915 Sendern,
  142.246 Filmen und 31.569 Serien:

  | Posten | ursprünglich | 1.14 | jetzt |
  |---|---|---|---|
  | Prozess gesamt | — | 388 MB | **205 MB** |
  | JS-Heap nach dem Start | 117 MB | 82 MB | **21 MB** |
  | bis die Bibliothek steht | — | 72 s | **41 s** |
  | dekodierte Bilder | 242 MB | 61 MB | 61 MB |
  | Kacheln je Ansicht | 150 | 63 | 63 |

  Drei Schritte führen dahin. Erstens speichern Xtream-Einträge nur die
  Stream-Nummer statt der vollen Adresse (die steckte zweimal je Eintrag – als
  Adresse und in der Kennung). Zweitens werden Bilder in bildschirmgerechter
  Größe angefordert und nur in der Nähe des Sichtfelds geladen bzw. wieder
  freigegeben. Drittens – der große Sprung – kommen Filme und Serien
  kategorieweise statt am Stück: Die Antwort auf `get_vod_streams` ist bei
  dieser Playlist **58 MB**, die Kategorienliste dagegen **24 KB**. Der JS-Heap
  bleibt nach einem Rundgang durch alle Tabs stabil – kein Leck. Was vom
  Prozesswert übrig bleibt, sind Browser-Cache und Renderer sowie die 42.915
  Sender, die für Zapping und Programmführer geladen bleiben müssen.
- **Suche über alle Filme ist zuschaltbar.** Ohne die Filme im Speicher sucht die
  App zunächst in den geöffneten Kategorien. Ein Knopf im Suchbildschirm baut
  ein Titelverzeichnis über den ganzen Katalog auf: 142.246 Titel für rund
  45 MB, gegenüber etwa 150 MB für den vollen Objektgraphen. Es entsteht
  **ohne `JSON.parse`** – ein Scanner liest Name, Stream-Nummer, Kategorie und
  Dateiendung direkt aus dem Antworttext. Gegen `JSON.parse` geprüft:
  **0 Abweichungen über alle 142.246 Einträge**. Zwei Fallen stecken darin:
  Datensatzgrenzen laufen über die echten Objektklammern und nicht über ein
  Feld – der Name steht vor `stream_id`, Kategorie und Endung dahinter, sodass
  ein Schnitt am Feld jeden Eintrag Werte seines Nachbarn erben ließe (Strings
  werden übersprungen, damit eine Klammer im Filmtitel keine Grenze
  vortäuscht). Und jedes gelesene Feld wird **kopiert**: V8 legt für
  Teilzeichenketten ab 13 Zeichen keine Kopie an, sondern einen Zeiger auf den
  Elternstring – ein einziger behaltener Filmtitel hielt damit die ganze
  58-MB-Antwort fest, also genau den Posten, den das Verzeichnis vermeiden
  soll.
- **Kein Mini-Player.** Das Video liegt auf einer Hardware-Ebene, die sich
  nicht verkleinern lässt: Schrumpft man das `<video>` per CSS, läuft der Ton
  weiter und das Bild bleibt schwarz. Die naheliegende Abhilfe – die Videoebene
  über `luna://com.webos.media/setDisplayWindow` verschieben – gibt es auf
  webOS 4 nicht (auf dem Gerät geprüft, ebenso zwei Alternativpfade). Ein
  Mini-Player wurde deshalb wieder entfernt, statt eine halbe Lösung zu lassen.
- **Downloads sind nicht möglich.** `luna://com.webos.service.downloadmanager`
  existiert, lehnt den Aufruf für selbstgebaute Apps aber ab
  („Denied method call"). Der Browser-Speicher reicht für Filme ohnehin nicht,
  und am dauerhaft vernetzten Fernseher bringt Offline wenig. Die Einstellungen
  sagen das offen, statt einen Knopf anzubieten, der nichts tut.

## Warum ES5-Stil

webOS-Fernseher tragen je nach Baujahr sehr alte Chromium-Versionen
(webOS 3.x ≈ Chromium 38). Deshalb: kein `async/await`, keine Klassen, kein
optional chaining, kein `\p{…}` in regulären Ausdrücken, `XMLHttpRequest`
statt `fetch`. Der Code läuft ohne Build-Schritt direkt so, wie er hier steht.

## Tests

```sh
export PATH="$HOME/.local/webos-toolchain/node/bin:$PATH"
node test/core.test.js    # 36 Prüfungen: M3U, Xtream, Sprache, EPG, Titelindex
node test/ui.test.js      # 10 Prüfungen: rendert, Tabs, Fokus, Suche, appinfo (jsdom)
```

## Auf dem Fernseher prüfen

Der webOS-Inspector spricht das Chrome DevTools Protocol – damit lässt sich die
App auf der echten Hardware fernsteuern und ansehen, statt zu raten:

```sh
ares-inspect --device tv --app de.app.glasstv     # gibt die ws-Adresse aus
node tools/tvshot.js  ws://localhost:PORT/... bild.png        # Screenshot + Konsole
node tools/tvpoke.js  ws://localhost:PORT/... state           # Kurzbericht
node tools/tvpoke.js  ws://... click ".card" wait 2000 state  # Bedienung simulieren
node tools/tvpoke.js  ws://... key 461                        # Taste (461 = Zurück)
```

`core.test.js` spiegelt die Kotlin-/Swift-Tests, inklusive der teuer erkauften
Fälle: Kommas im Anzeigenamen, Offset ohne Leerzeichen im XMLTV-Zeitstempel,
Sicherheitsnetz des Sprachfilters, tolerante Episoden-Auswertung.

## Bauen

```sh
export PATH="$HOME/.local/webos-toolchain/node/bin:$PATH"
ares-package src -o .        # erzeugt de.app.glasstv_<version>_all.ipk
```

Die Toolchain (Node + `@webos-tools/cli`) liegt unter
`~/.local/webos-toolchain/`.

## Veröffentlichung

Der Stand der Release-Vorbereitung, die Pflichtdokumente für LGs Prüfung und
die realistische Einschätzung stehen in [RELEASE.md](RELEASE.md). Die Unterlagen
für die Einreichung liegen in `docs/` (UX-Szenario für die Prüfer, Store-Texte).

## Auf den Fernseher bringen

LG lässt selbstgebaute Apps **nur im Developer Mode** zu. Einmalige Einrichtung:

1. Kostenloses Konto auf <https://webostv.developer.lge.com> anlegen.
2. Am TV im LG Content Store die App **„Developer Mode"** installieren, mit
   demselben Konto anmelden, **Dev Mode Status = ON** und **Key Server = ON**.
   Der TV startet neu und zeigt danach **IP-Adresse** und **Passphrase**.
   Der Modus läuft ~50 Stunden und wird in der App verlängert.
3. TV und Rechner müssen im selben Netz sein.

Dann am Rechner:

```sh
export PATH="$HOME/.local/webos-toolchain/node/bin:$PATH"
ares-setup-device --add tv --info "{'host':'<TV-IP>','port':'9922','username':'prisoner'}"
ares-novacom --device tv --getkey          # fragt die Passphrase vom TV-Bildschirm ab
ares-install --device tv de.app.glasstv_1.0.0_all.ipk
ares-launch --device tv de.app.glasstv
```

Oder bequemer: `./install.sh <TV-IP>` erledigt Schritt für Schritt dasselbe.

## Aufbau

```
src/
  lib/webOSTV.js LGs offizielle Bibliothek (Apache 2.0, aus dem SDK; siehe
                 lib/HERKUNFT.md) – liefert platformBack, deviceInfo, service
  appinfo.json   webOS-Manifest (id, Icons, Hintergrundfarbe)
  index.html     Gerüst: Kopf, Inhalt, Player-Overlay, Toast
  style.css      10-Fuß-Layout, Fokus-Hervorhebung, Design-Hintergrund
  core.js        portierte Logik: M3U, Xtream, Sprache, XMLTV
  app.js         Zustand, Seiten, Fokus-Navigation, Player, Fernbedienung
test/            Selbsttests (ohne Framework bzw. mit jsdom)
```

## Lizenz

MIT – siehe [LICENSE](LICENSE), gilt für den Code dieses Projekts.

**Ausgenommen** ist `src/lib/webOSTV.js` (LG Electronics, Apache 2.0). Details
in [THIRD-PARTY.md](THIRD-PARTY.md); der Lizenztext und der Urhebervermerk
müssen bei einer Weitergabe erhalten bleiben.

GlassTV enthält und vermittelt **keine Inhalte**. Die App spielt ausschließlich
Playlisten ab, die der Nutzer selbst einträgt; die Zugangsdaten bleiben auf dem
Gerät.

## Verhältnis zu den anderen Projekten

Eigenständiges Projekt neben `GlassTV` (iOS/tvOS/macOS), `GlassTVAndroid`
(Quest/Android) und `GlassTVCore-Kotlin`. Ändert sich die Kern-Logik dort,
muss sie hier nachgezogen werden — die Tests decken dieselben Fälle ab und
schlagen fehl, wenn das Verhalten auseinanderläuft.
