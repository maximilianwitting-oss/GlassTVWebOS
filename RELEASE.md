# Release und Einreichung

Stand: 1.20.0, gebaut und auf einem LG OLED77C9PLA (webOS 4.10) geprüft.

## Was fertig ist

Das Paket `de.app.glasstv_1.20.0_all.ipk` ist gebaut, installiert und
läuft. Technisch ist die App einreichbereit:

| Punkt | Stand |
|---|---|
| `appinfo.json` vollständig | ja – id, version, vendor, icons, bgColor, resolution |
| Icons in LG-Größen | 80×80 und 130×130, geprüft |
| `requiredMemory` | **400 MB** – die 320 lagen unter der eigenen Messung. Auf dem OLED77C9PLA gemessen: 214 MB Betrieb, 217 MB mit Titelverzeichnis, **Spitze beim Start 337 MB**, mit laufendem Video bis 333 MB. `requiredMemory` ist die Zusage, an der webOS die App misst; überschreitet sie, ist sie der erste Kandidat für den Low-Memory-Killer – ausgerechnet beim Start und beim Abspielen, den beiden Momenten des Funktionstests. |
| Beenden über Zurück-Taste | ja, `webOS.platformBack()` – LG prüft das |
| Vollständig mit Fernbedienung bedienbar | ja, inkl. Magic-Remote-Zeiger |
| Auflösung 1920×1080 | ja |
| Fehlerfall falsche Zugangsdaten | klare Meldung, führt zurück zur Einrichtung |
| Debug-Reste im Code | keine `console.log`, kein `debugger` (maschinell geprüft) |
| Tests | 63 Core + 17 UI, alle grün |

## Was noch fehlt – und nur du erledigen kannst

Die Einreichung selbst läuft über ein Konto, das an deine Person und deine
Steuerdaten gebunden ist. Sie lässt sich nicht automatisieren:

1. **Konto in der Seller Lounge** (<https://seller.lgappstv.com>) anlegen,
   Vertrag zeichnen, Steuer- und Auszahlungsdaten hinterlegen.
2. **Pflichtdokumente** ausfüllen – ohne sie wird abgelehnt, das steht so in
   LGs eigener Beschreibung des Prüfverfahrens:
   - **Self-Checklist** mit echten Testergebnissen (Vorlage kommt von LG).
     Die Werte dafür stehen in der Tabelle oben und in `docs/ux-szenario.md`.
   - **UX-Szenario**, damit die Prüfer die App bedienen können – siehe
     `docs/ux-szenario.md`.
3. **Store-Material**: Screenshots in 1280×720, Beschreibung, Alterseinstufung.
4. **Hochladen und einreichen**, dann 5–10 Werktage Prüfung in drei Stufen:
   Vortest (Vollständigkeit), Funktionstest, Inhaltstest.

Jede spätere Version muss erneut durch die Prüfung; eine einmal freigegebene
App darf nicht einfach aktualisiert werden.

## Der Knackpunkt: Womit sollen die Prüfer testen?

GlassTV bringt keine Inhalte mit – ohne Zugangsdaten sehen LGs Prüfer nur den
Einrichtungsbildschirm und brechen den Funktionstest ab. Du musst also einen
Testzugang mitliefern.

Dabei ist zu bedenken, dass die dritte Prüfstufe ein **Inhaltstest** ist. Was
immer über den mitgelieferten Zugang zu sehen ist, wird damit Teil der Prüfung.
Ein Zugang zu einem Panel, das Katalogtitel kommerzieller Dienste führt, fällt
dort durch – unabhängig davon, dass die App selbst nur ein Abspieler ist.

Der gangbare Weg ist ein Testzugang mit frei verbreitbaren Inhalten. Dafür
eignen sich öffentlich-rechtliche Livestreams und frei lizenzierte Filme; eine
kleine, selbst gehostete M3U-Datei mit einer Handvoll solcher Einträge reicht
für den Funktionstest vollkommen aus und lässt sich den Prüfern gefahrlos
mitgeben. Dieselbe Playlist liefert dann auch die Store-Screenshots.

## Realistische Einschätzung

Reine Abspieler ohne eigene Inhalte haben es im Content Store schwer. Zwei
Dinge verbessern die Lage spürbar:

- Die App als **Werkzeug** einreichen, nicht als Videodienst: Sie spielt
  Playlisten ab, die der Nutzer selbst besitzt – so wie ein Dateimanager
  Dateien öffnet, die er nicht mitbringt.
- Im UX-Szenario klar sagen, dass keinerlei Inhalte mitgeliefert oder
  vermittelt werden und die Zugangsdaten das Gerät nicht verlassen.

Falls die Einreichung scheitert, bleibt die App über den Developer Mode
installierbar (siehe README) – das ist der Weg, auf dem sie jetzt läuft.

## Datenschutz

Die App speichert Zugangsdaten, Favoriten, Merkliste, Verlauf und Einstellungen
ausschließlich im `localStorage` des Fernsehers. Sie sendet nichts an eigene
Server, es gibt keine Analyse und keine Werbung. Netzwerkverbindungen gehen
ausschließlich an die vom Nutzer eingetragene Quelle.

Für die Einreichung braucht es diese Aussage als erreichbare
Datenschutzerklärung unter `vendorUrl` (derzeit <https://witting.info>).
