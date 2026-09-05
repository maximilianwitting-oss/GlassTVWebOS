# Store-Texte für die Einreichung

Vorlagen für die Felder in der Seller Lounge. Deutsch und Englisch, weil der
Store beides abfragt.

## Kategorie

**Utilities / Tools** – bewusst nicht „Video" oder „Entertainment". Die App ist
ein Abspieler ohne eigene Inhalte; als Videodienst eingeordnet würde sie an
Anforderungen gemessen, die für einen Dienst mit eigenem Katalog gedacht sind.

## Titel

`GlassTV`

## Kurzbeschreibung

**DE:** Spielt deine eigenen IPTV-Playlisten ab – Xtream Codes oder M3U.

**EN:** Plays your own IPTV playlists – Xtream Codes or M3U.

## Beschreibung

**DE:**

> GlassTV ist ein schlanker Abspieler für Playlisten, die du selbst mitbringst.
> Trage einen Xtream-Codes-Zugang oder eine M3U-Adresse ein, und GlassTV macht
> daraus eine aufgeräumte Oberfläche für den Fernseher.
>
> • Live-TV mit Kategorien, Programmführer und Sender wechseln per Pfeiltaste
> • Filme und Serien nach Kategorien, mit Beschreibung, Besetzung und Poster
> • Serien mit Staffeln, Folgenliste und automatisch nächster Folge
> • Weiterschauen an der Stelle, an der du aufgehört hast
> • Favoriten, Merkliste und Empfehlungen aus deinem Verlauf
> • Profile für mehrere Personen im Haushalt
> • Kindersicherung: PIN sperrt Kategorien app-weit
> • Sprachfilter für mehrsprachige Playlisten
> • 18 Designs und 15 Akzentfarben, hell wie dunkel
> • Vollständig mit der Fernbedienung bedienbar, Magic Remote unterstützt
>
> GlassTV enthält und vermittelt keine Inhalte. Es werden nur die Quellen
> geöffnet, die du selbst einträgst. Deine Zugangsdaten bleiben auf dem
> Fernseher und werden an niemanden gesendet.

**EN:**

> GlassTV is a lean player for playlists you bring yourself. Enter an Xtream
> Codes account or an M3U address, and GlassTV turns it into a tidy interface
> built for the television.
>
> • Live TV with categories, a programme guide and channel zapping
> • Movies and series by category, with plot, cast and posters
> • Series with seasons, episode lists and automatic next episode
> • Resume where you left off
> • Favourites, a watchlist and recommendations from your history
> • Profiles for several people in the household
> • Parental control: a PIN locks categories across the whole app
> • Language filter for multilingual playlists
> • 18 themes and 15 accent colours, light and dark
> • Fully operable with the remote, Magic Remote supported
>
> GlassTV contains and provides no content of its own. It only opens the
> sources you enter yourself. Your credentials stay on the television and are
> never sent anywhere else.

## Alterseinstufung

Die App selbst zeigt keine Inhalte. Da über eine Nutzerquelle grundsätzlich
beliebiges Material erreichbar ist, ist eine vorsichtige Einstufung angebracht;
auf die eingebaute Kindersicherung (PIN, kategorieweise Sperre) sollte im
Einstufungsfragebogen hingewiesen werden.

## Screenshots (1280×720, mindestens vier)

Vorschlag für die Auswahl:

1. Startseite mit Regalen
2. Live-TV mit Kategorien und laufender Sendung
3. Detailseite eines Films
4. Einstellungen mit der Designauswahl

**Nur mit einer Playlist aufnehmen, deren Inhalte frei verbreitbar sind.** Die
Screenshots gehen durch denselben Inhaltstest wie die App.

Aufnehmen lassen sie sich mit den Werkzeugen im Repo:

```sh
ares-inspect --device tv --app de.app.glasstv
node tools/tvshot.js ws://localhost:PORT/... startseite.png
sips -z 720 1280 startseite.png        # auf Store-Größe bringen
```
