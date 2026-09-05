# GlassTV — webOS (LG Smart TV)

GlassTV für LG-Fernseher. **Kein Android-Port**: webOS führt Web-Apps aus
(HTML/CSS/JS, verpackt als `.ipk`), das APK der Quest-/Android-Version läuft
hier nicht. Die Kern-Logik ist deshalb aus `GlassTVCore-Kotlin` nach
JavaScript portiert — mit denselben Testfällen.

## Status

Lauffähige erste Version (Machbarkeitsstufe):

- **Quellen**: Xtream Codes (Sender, Filme, Serien, Folgen auf Nachfrage) und
  M3U/M3U8. Zugangsdaten liegen nur im `localStorage` des Fernsehers.
- **EPG**: XMLTV vom Xtream-Panel; laufende Sendung mit Fortschrittsbalken und
  „danach …" in der Senderliste.
- **Player**: HTML5-`<video>`. OK pausiert, ◀ ▶ spulen 10 s, Zurück schließt.
- **Bedienung**: vollständig mit der Fernbedienung. Der Fokus wandert
  *geometrisch* (nicht in DOM-Reihenfolge), damit Raster und Reihen sich
  räumlich anfühlen.
- **Optik**: Grundfarbe und Akzent der iOS-/Quest-App, als 10-Fuß-Layout.

Noch nicht enthalten (im Gegensatz zur Quest-App): Profile, Favoriten,
Merklisten, Empfehlungen, Guide-Raster, Kindersicherung, Statistik, Downloads,
Mini-Player, Themes.

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
