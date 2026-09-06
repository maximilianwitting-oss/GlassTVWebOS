# Änderungen

## 1.16.0

Ergebnis eines zweiten Prüfdurchlaufs (Regression, Player, Datenhaltung,
Parser). Ein Teil der Befunde sind Fehler, die 1.15.0 selbst eingebaut hatte.

**Endlosschleife behoben.** Schlug das Nachladen einer verdrängten Kategorie
fehl, rief der Fehlerzweig `render()`, das landete sofort wieder im Nachladen —
gemessen 1074 Anfragen in 1,5 Sekunden, ohne Ausweg, weil auch „Abbrechen" und
die Zurück-Taste über `render()` liefen. Vermutlich die wahre Ursache der
Aussetzer, die zuvor dem Web-App-Manager zugeschrieben wurden.

**Kindersicherung an drei Stellen repariert.** Die App wird beim Beenden nur in
den Hintergrund gelegt (`handlesRelaunch`), `boot()` läuft dann nicht — die
Sperre blieb offen und die Profilwahl wurde übersprungen. Bei vollem Speicher
meldete das Setzen einer PIN Erfolg, obwohl nichts geschrieben wurde. Und die
Prüfung aus 1.15.0 lief ins Leere, weil `katName['constructor']` in einem
einfachen Objekt wahrheitsähnlich ist; alle Maps mit Schlüsseln aus der
Playlist sind jetzt prototypfrei. Unbekannte Kategorie-Kennungen heißen nicht
mehr „Allgemein" (ein nie gesperrter Sammelname), sondern tragen ihre Nummer.

**Sprachfilter: auf dem Gerät kam ein Vielfaches zurück.** Nach dem Aufspielen
zeigte dieselbe Playlist **10.948 statt 3.159 Sender**, und eine Kategorie, die
zuvor „0 Filme" meldete, enthielt **1.444**. Zwei Ursachen: Gruppe und Titel wurden als ein
Erstens wurden Gruppe und Titel als ein Text bewertet, und weil der längste
Treffer gewinnt, überstimmte ein Wort aus dem Titel das Kürzel der Kategorie —
„Captain America" galt als Englisch, „Five Nights at Freddy's" über das Wort
„at" als Österreich (2,5 % der 142.246 echten Titel). Zweitens griff das
Sicherheitsnetz je LISTE: Ein einziger Titel mit erkannter Fremdsprache ließ
eine ganze Kategorie verschwinden. Beides ist behoben — die Kategorie ist jetzt
die Bezugsgröße, und gefiltert wird nur, wo sie erkennbar sprachlich sortiert
ist (eigenes Kürzel oder mehrheitlich gekennzeichnete Titel).

**Leistung.** Favoriten wurden je Eintrag über einen Vollscan der Bibliothek
aufgelöst — gemessen das 17- bis 49-Fache der Vorversion, bei jedem
Neuzeichnen. Jetzt über ein Nachschlagewerk nach Kennung.

**Wiedergabe.** Live-Sender landeten nie im Verlauf, weil alle Aufrufer hinter
`duration > 0` stehen und Live `Infinity` meldet. Automatisch gestartete Folgen
verloren die Dateiendung und ließen sich später nicht fortsetzen. Die
Resume-Position wird auf die tatsächliche Länge gedeckelt. Nach dem Schließen
zeigt die Detailseite den neuen Stand, und der Fokus bleibt beim gesehenen
Titel. Erst ab 30 Sekunden wird gespeichert.

**Datenhaltung.** Favoriten aus 1.14 (`{id: true}`) werden beim ersten
Auftauchen aufgewertet statt stumm übersprungen. Favoriten und Merkliste sind
auf 500 Einträge gedeckelt; „Meine Liste" lässt sich jetzt löschen. Ein voller
Speicher kürzt erst den Verlauf, bevor er aufgibt.

**Parser.** Der Adresspfad entscheidet über Live/Film/Serie statt des
Gruppennamens — „US | TV SHOWS 24/7" wurde sonst zu lauter Einzelserien. Das
Jahr wird aus dem Titel gelesen (76 % der Titel tragen es), womit auch die
Sortierung nach Jahr wieder wirkt. Ein `null` in der Panel-Antwort kippt den
Import nicht mehr.

## 1.15.0

**Filme und Serien kommen kategorieweise statt am Stück.** Die Antwort auf
`get_vod_streams` ist bei der getesteten Playlist 58 MB und band rund 50 MB
dauerhaft. Beim Start kommen jetzt nur noch die Kategorienlisten (24 KB); der
Inhalt einer Kategorie folgt beim Öffnen in etwa einer Viertelsekunde, drei
Kategorien bleiben zwischengespeichert. Auf dem Gerät gemessen (42.915 Sender
/ 142.246 Filme / 31.569 Serien): Prozess 388 → 205 MB, JS-Heap nach dem Start
82 → 21 MB, bis die Bibliothek steht 72 → 41 s. M3U-Quellen bleiben unverändert
– dort steht ohnehin alles in einer Datei.

**Titelverzeichnis für die Suche** (zuschaltbar): Ohne die Filme im Speicher
sucht die App zunächst nur in den geöffneten Kategorien. Ein Knopf im
Suchbildschirm macht alle 142.246 Titel durchsuchbar, für rund 45 MB statt der
etwa 150 MB eines vollen Objektgraphen. Der Aufbau läuft ohne `JSON.parse`;
gegen dieses geprüft: 0 Abweichungen über alle Einträge.

**Kindersicherung – zwei Umgehungen geschlossen.** Der Titelindex bildete
unbekannte Kategorie-Kennungen auf „Allgemein" ab, einen Namen, der nie in den
Sperrlisten steht; Panels, die ihre 18+-Rubrik aus der Kategorienliste
heraushalten, hebelten die PIN damit aus. Und der Verlauf wurde nirgends
gefiltert: Titel und Poster gesperrter Kategorien standen weiter unter
„Weiterschauen".

**Favoriten, Merkliste und Weiterschauen funktionieren wieder.** Sie wurden
über die Bibliothek aufgelöst, die beim kategorieweisen Laden leer ist – ein
gemerkter Film verschwand sofort wieder. Sie führen ihre Anzeigedaten jetzt
selbst, und Abspieladressen lassen sich aus der Kennung rekonstruieren.
Serienfolgen wurden von „Weiterschauen" grundsätzlich nie gefunden.

**Bedienung**: Auf dem Profilschirm war die Zurück-Taste tot – aus dem ersten
Bildschirm der App kam man nur über die Home-Taste heraus (LG prüft das).
Während eine Kategorie lud, gab es kein bedienbares Element; jetzt Spinner mit
Abbrechen. Umschaltknöpfe wie „☆ Favorit" verloren beim Klick den Fokus an den
Seitenanfang. Zurück aus einem Suchtreffer verwarf die ganze Eingabe. Der
Erstfokus liegt auf „Abspielen" bzw. im Suchfeld, OK löst die Suche aus. Die
Farbtasten haben eine Legende. Die rote Taste springt an den Listenanfang.
Deckelungen werden benannt („30 von 142") statt zu schweigen.

**Darstellung**: Knöpfe und Tabs erbten die Schriftart nicht und rendeten in
Arial, während die Chips daneben in LG Smart UI standen. Die Fehlermeldung war
fest verdrahtet und lag auf den zwölf dunklen Designs bei 2,3:1. Kartentitel
wurden in der dritten Zeile angeschnitten. Statistikbalken waren auf hellen
Designs heller als ihr Grund. Der Favoritenstern trug den roten Live-Punkt.
Die 18 Design-Chips lagen in einer nicht umbrechenden Reihe von 2250 Pixeln.

**Fehlerfälle**: Falsche oder abgelaufene Zugangsdaten führen zurück zur
Einrichtung mit klarer Meldung, statt nach acht Sekunden „nichts geladen"
stehen zu lassen. Netzausfälle werden von abgelehnten Anmeldungen getrennt und
bieten „Erneut versuchen". Zu Ende gesehene Folgen starten wieder von vorn
statt am Ende. Bei M3U-Serien werden die Folgen nach Staffel und Nummer
sortiert – „nächste Folge" nahm vorher den Datei-Nachfolger.

**Veröffentlichung**: MIT-Lizenz (LGs `webOSTV.js` bleibt Apache 2.0, siehe
`THIRD-PARTY.md`), Unterlagen für die Einreichung im LG Content Store unter
`RELEASE.md` und `docs/`.

## 1.14.0
- **Magic-Remote-Zeiger unterstützt**: Der Fokus folgt dem Zeiger; bei
  sichtbarem Zeiger wird der Fokusring ruhiger. Zertifizierungskriterium bei LG.
- **Speicherbedarf gesenkt**: JS-Heap 117 → 82 MB, dekodierte Bilder
  242 → 61 MB. Xtream-Einträge tragen nur noch die Stream-Nummer, Bilder werden
  kleiner angefordert und außerhalb des Sichtfelds freigegeben, Raster werden
  in Blöcken à 63 Kacheln gezeichnet.
- Nebeneffekt: Zugangsdaten stehen nicht mehr in Kennungen und im Verlauf.
  **Achtung:** Dadurch ändern sich die Kennungen – bereits gemerkte Favoriten
  und der bisherige Verlauf werden einmalig nicht mehr zugeordnet.

## 1.11.0
- **webOSTV.js eingebunden** (LGs offizielle Bibliothek 1.2.13 aus dem SDK,
  Apache 2.0). Damit läuft das Beenden über `webOS.platformBack()` statt über
  einen Umweg.
- Zurück-Taste eskaliert sauber: Unteransicht → Liste, Tab → Startseite,
  Startseite → beenden.
- Neustart bei laufender App (`webOSRelaunch`) schließt einen offenen Player
  und kehrt zur Startseite zurück.
- Einstellungen nennen Modell, webOS-Version und App-Version – hilfreich bei
  Rückfragen, weil sich LG-Geräte je Baujahr stark unterscheiden.

## 1.10.1
- **Suchfeld für Kategorien** in „Kategorien ausblenden", in der Kindersicherung
  und über den Listen in Live TV / Filme / Serien. Vorher waren nur die ersten
  80 bzw. 40 Kategorien erreichbar – bei 1140 Kategorien also ein Bruchteil,
  und ausgerechnet die alphabetisch hinten liegenden 18+-Kategorien ließen sich
  nicht sperren.
- Die gewählte Kategorie wird in der Leiste immer angezeigt, auch wenn sie
  hinter Position 40 liegt.

## 1.8.0
- **Mini-Ansicht entfernt.** Auf dem Fernseher lief dort nur der Ton weiter, weil
  sich die Videoebene nicht verkleinern lässt (siehe README).
- **Standard-Design ist jetzt hell („Perl"), wie in der iOS-App.** Sechs helle
  Designs ergänzt; ein Designwechsel tauscht nun das komplette Farbschema
  (Flächen, Ränder, Text), nicht nur den Grundton.
- **Bedienung repariert:** Der Fokus blieb nach jedem Klick nicht mehr stehen,
  sondern sprang an den Seitenanfang – in den Einstellungen wirkte es dadurch,
  als ließe sich kein Design umstellen. Der Fokus wird jetzt gehalten.
- Fokusring auf Akzent-Knöpfen war unsichtbar (Akzent auf Akzent) und wurde in
  jedem Regal abgeschnitten. Beides behoben.
- Zurück-Taste beendet die App wieder.
- Xtream-Kataloge werden nacheinander mit großzügigem Zeitlimit geladen;
  Teilfehler werden benannt statt verschluckt.
- Schutz gegen unbedienbare Zustände: Endlos-Spinner, beschädigte Profile,
  voller Gerätespeicher, Fehler beim Aufbauen.
- Deutlich schneller bei großen Playlisten (Sprach-Erkennung, Sortierung,
  Kategorien und Favoriten laufen nicht mehr bei jedem Aufbau über alles).
- Zugangsdaten werden in den Einstellungen maskiert und nicht mehr im Verlauf
  gespeichert.
- Schriftgrößen, Abstände und Sicherheitsränder für den Betrachtungsabstand
  von drei Metern überarbeitet.

## 1.6.0
- Statistik; Mini-Ansicht (in 1.8.0 wieder entfernt).

## 1.5.0
- Profile mit „Wer schaut?", Merkliste, Empfehlungen.

## 1.3.0
- Kategorien ausblenden, Kindersicherung.

## 1.2.0
- Vollausbau der Oberfläche; Layout- und Player-Fehler auf Chromium 53 behoben.

## 1.0.0
- Erste Fassung: Xtream/M3U, Senderliste, Filme, Serien, Player.
