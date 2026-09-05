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
- **Kategorien**: Chips in Live TV, Filmen und Serien; Sortierung nach Name,
  Jahr oder Bewertung.
- **Detailseiten**: Backdrop, Beschreibung, Regie/Besetzung, Favorit,
  „Weiter ab …" und ähnliche Titel. Serien mit Staffel-Chips und Folgenliste.
- **EPG**: XMLTV vom Panel; laufende Sendung mit Fortschrittsbalken, „danach …"
  und ein Programmführer (grüne Taste).
- **Player**: HTML5-`<video>` – Fortschrittsanzeige, Weiterschauen-Position,
  automatische nächste Folge, Zapping mit ◀ ▶ bei Live.
- **Designs**: 12 dunkle Designs und 15 Akzentfarben aus der iOS-App, plus
  „Überrasch mich". Helle Designs bewusst weggelassen: Sie blenden im
  abgedunkelten Wohnzimmer.
- **Sprachfilter** mit demselben Sicherheitsnetz wie iOS, **Kategorien
  ausblenden** und **Kindersicherung** (PIN sperrt Kategorien app-weit).
- **Bedienung**: vollständig mit der Fernbedienung. Der Fokus wandert
  *geometrisch* (nicht in DOM-Reihenfolge), damit Raster und Reihen sich
  räumlich anfühlen. Farbtasten: grün = Guide, gelb = Suche, blau = Favorit.

Nicht enthalten: Profile, Merklisten, Empfehlungen, Statistik, Downloads,
Mini-Player.

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
- **Große Listen** werden bewusst gedeckelt (120 Senderzeilen, 150 Kacheln,
  Nachladen über eine Schaltfläche) – der TV-Browser bricht sonst ein.

## Warum ES5-Stil

webOS-Fernseher tragen je nach Baujahr sehr alte Chromium-Versionen
(webOS 3.x ≈ Chromium 38). Deshalb: kein `async/await`, keine Klassen, kein
optional chaining, kein `\p{…}` in regulären Ausdrücken, `XMLHttpRequest`
statt `fetch`. Der Code läuft ohne Build-Schritt direkt so, wie er hier steht.

## Tests

```sh
export PATH="$HOME/.local/webos-toolchain/node/bin:$PATH"
node test/core.test.js    # 22 Prüfungen: M3U, Xtream, Sprache, EPG-Zeitstempel
node test/ui.test.js      # 6 Prüfungen: rendert, Tabs, Fokus, appinfo (jsdom)
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
  appinfo.json   webOS-Manifest (id, Icons, Hintergrundfarbe)
  index.html     Gerüst: Kopf, Inhalt, Player-Overlay, Toast
  style.css      10-Fuß-Layout, Fokus-Hervorhebung, Design-Hintergrund
  core.js        portierte Logik: M3U, Xtream, Sprache, XMLTV
  app.js         Zustand, Seiten, Fokus-Navigation, Player, Fernbedienung
test/            Selbsttests (ohne Framework bzw. mit jsdom)
```

## Verhältnis zu den anderen Projekten

Eigenständiges Projekt neben `GlassTV` (iOS/tvOS/macOS), `GlassTVAndroid`
(Quest/Android) und `GlassTVCore-Kotlin`. Ändert sich die Kern-Logik dort,
muss sie hier nachgezogen werden — die Tests decken dieselben Fälle ab und
schlagen fehl, wenn das Verhalten auseinanderläuft.
