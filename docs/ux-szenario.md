# UX-Szenario für die Prüfung (LG Content Store)

Dieses Dokument ist für LGs Prüfer gedacht. Es beschreibt, was die App tut und
wie sie zu bedienen ist. LG weist ausdrücklich darauf hin, dass eine ungenaue
Beschreibung die Ablehnung wahrscheinlicher macht – deshalb hier lieber zu
ausführlich.

*Vor dem Einreichen: Testzugang unter „Vorbereitung" eintragen und diesen
Hinweis löschen.*

## Was die App ist

GlassTV ist ein Abspieler für Playlisten, die der Nutzer selbst mitbringt
(Xtream-Codes-Zugang oder eine M3U-Datei). Die App enthält, vermittelt und
verkauft **keine Inhalte**. Sie verhält sich zu Playlisten wie ein
Dateimanager zu Dateien: Sie öffnet, was der Nutzer ihr nennt.

Es gibt keine Registrierung, kein Nutzerkonto, keine Zahlungsfunktion, keine
Werbung und keine Analysedienste. Alle Daten – Zugangsdaten, Favoriten,
Verlauf, Einstellungen – bleiben im lokalen Speicher des Fernsehers.

## Vorbereitung

Beim ersten Start erscheint „Quelle einrichten". Für den Test bitte eintragen:

- **Xtream-Server**: `____________________`
- **Benutzer**: `____________________`
- **Passwort**: `____________________`

*oder* stattdessen im unteren Feld eine **M3U-Adresse**.

Danach „Xtream laden" bzw. „M3U laden" wählen. Das Laden dauert je nach Größe
der Playlist einige Sekunden; ein Ladehinweis zeigt den Fortschritt.

## Bedienung

Alles ist mit der normalen Fernbedienung erreichbar; ein Magic Remote wird
zusätzlich unterstützt (der Zeiger führt den Fokus).

| Taste | Wirkung |
|---|---|
| Pfeile | Fokus bewegen (geometrisch, nicht in Dokumentreihenfolge) |
| OK | Auswählen; im Player Pause/Weiter |
| Zurück | Eine Ebene zurück; auf der Startseite **beendet sie die App** |
| ◀ ▶ im Player | 10 s spulen, bei Live-Sendern Programmwechsel |
| Grün | Programmführer |
| Gelb | Suche |
| Blau | Favorit für das fokussierte Element umschalten |

## Testablauf

1. **Start** – Quelle wie oben einrichten. Die Startseite zeigt danach Regale:
   „Jetzt im TV", zuletzt geöffnete Filme und Serien, bei vorhandenem Verlauf
   auch „Weiterschauen".
2. **Live TV** – Senderliste mit Kategorien. Einen Sender wählen: Die Wiedergabe
   startet als Vollbild. Mit ◀ ▶ wird der Sender gewechselt, Zurück schließt.
3. **Filme** – Es erscheint zuerst eine **Kategorienliste**. Das ist beabsichtigt:
   Große Playlisten haben über 140.000 Filme, die vollständig zu laden würde den
   Speicher des Fernsehers belasten. Eine Kategorie wählen – ihr Inhalt wird
   nachgeladen (etwa eine Viertelsekunde) und als Kachelraster gezeigt. Ein Film
   führt auf eine Detailseite mit Beschreibung, Besetzung und „Abspielen".
4. **Serien** – wie Filme, zusätzlich mit Staffel-Auswahl und Folgenliste. Nach
   dem Ende einer Folge startet die nächste automatisch.
5. **Suche** (gelbe Taste) – durchsucht Sender und geöffnete Kategorien. Ein
   Knopf baut auf Wunsch ein Titelverzeichnis über den ganzen Katalog auf.
6. **Guide** (grüne Taste) – Programmführer, sofern die Quelle EPG-Daten liefert.
7. **Einstellungen** – Design und Akzentfarbe (18 Designs), Sprachfilter,
   Kategorien ausblenden, Kindersicherung mit PIN, Profile, Statistik.
8. **Beenden** – Auf der Startseite die Zurück-Taste drücken. Die App schließt
   sich über `webOS.platformBack()`.

## Fehlerfälle, die geprüft werden können

- **Falsche Zugangsdaten**: Die App bleibt auf dem Einrichtungsbildschirm und
  zeigt eine abgesetzte Meldung „Anmeldung fehlgeschlagen" mit dem Grund.
- **Quelle nicht erreichbar**: Gleiches Verhalten, mit HTTP-Status.
- **Teilweise Antwort**: Fällt nur ein Bereich aus (etwa Serien), lädt der Rest
  trotzdem, und ein Hinweis benennt den fehlenden Bereich.
- **Nicht abspielbarer Stream**: Der Player zeigt eine Meldung und lässt sich
  mit Zurück schließen.

## Jugendschutz

Unter Einstellungen lässt sich eine PIN setzen und Kategorien sperren. Gesperrte
Kategorien verschwinden dann app-weit – aus den Listen, aus der Suche und aus
den Empfehlungen. Da einschlägige Kategorien in solchen Playlisten typischerweise
am Ende des Alphabets stehen, haben beide Kategorielisten ein Suchfeld.

## Bekannte Grenzen auf webOS 4

Beides wurde auf dem Gerät geprüft und ist keine Auslassung, sondern eine
Plattformgrenze:

- **Kein Bild-im-Bild.** Die Wiedergabe liegt auf einer Hardware-Ebene, die sich
  nicht verkleinern lässt; `luna://com.webos.media/setDisplayWindow` existiert
  auf webOS 4 nicht.
- **Keine Downloads.** `luna://com.webos.service.downloadmanager` lehnt den
  Aufruf ab („Denied method call").
