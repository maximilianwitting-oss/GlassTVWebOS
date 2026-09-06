# Änderungen

## 1.18.0

**Die Suche liefert jetzt die besten Treffer, nicht die ersten.** Sie nahm die
ersten 30 Titel, in denen die Anfrage irgendwo vorkam, und brach dann ab — bei
142.000 Filmen entschied damit die Reihenfolge im Katalog des Anbieters, was
man zu sehen bekam. „Matrix" lieferte irgendwelche Titel mit „Matrix" darin,
der gesuchte Film stand dahinter und wurde nie erreicht. Jetzt wird bewertet,
wo die Anfrage sitzt: exakter Titel, Titelanfang, Wortgrenze, Wortmitte; bei
gleichem Rang gewinnt der knappere Titel. Auf dem Gerät gemessen steht „Matrix"
jetzt an erster Stelle, davor „The Matrix" und „Matrix (1999)". Der vollständige
Durchlauf über alle 174.000 Titel kostet 305–418 ms und läuft nur beim Druck auf
„Suchen".

Dazu sagt die Überschrift die Wahrheit: „Sender · 30 von 59" statt „erste 30" —
letzteres verriet nicht, ob 31 oder 4.000 folgen.

**Serien sind erstmals vollständig durchsuchbar.** Die Suche zeigt „Serien" als
eigene Sparte an, durchsucht hat sie aber nur die Kategorien, die man zuvor
geöffnet hatte. Wer eine Serie suchte, deren Rubrik er nie geöffnet hatte, bekam
„Keine Treffer" — ohne Hinweis, dass die Serie sehr wohl da ist. Das
Titelverzeichnis erfasst jetzt Filme **und** Serien: auf dem Gerät 142.386 Filme
und **31.602 Serien**. Geprüft bis zum Ende: Suchtreffer → Serie öffnen →
5 Staffeln, Folgen mit Laufzeit.

**Der Programmführer war eine Sackgasse.** Er zeigte 100 Sender und benannte in
der Überschrift die übrigen, bot aber weder Suche noch Nachladen. Auf diesem
Panel haben **1.364 Sender** ein Programm — 1.264 davon waren nicht erreichbar.
Jetzt mit Suchfeld und „Weitere 100 Sender anzeigen".

**53 MB Dauerbelegung durch eine einzige Zeile.** Beim Vereinheitlichen der
EPG-Kennungen lief `toLowerCase()` über alle 42.000 Sender der Senderliste. Auf
dem Fernseher gemessen kostete das 53 MB, die dauerhaft belegt blieben
(230 → 283 MB, eine Zeile Unterschied, zweimal gemessen). Vereinheitlicht wird
jetzt erst beim Vergleich — nachgeschlagen werden ohnehin nur die paar Dutzend
Sender, die auf dem Bildschirm stehen. Der Abgleich bleibt unverändert
zuverlässig: 1.364 Sender mit Programm, vorher wie nachher.

Zusammen mit einem Zwischenspeicher für die Senderkennungen im XMLTV-Scanner
(die Normalisierung lief für jede der 206.615 Sendungen statt je Sender):

| | 1.17.0 | 1.18.0 |
|---|---|---|
| Prozess im Betrieb | 228 MB | **214 MB** |
| mit Titelverzeichnis | — | **217 MB** |
| Spitze beim Start | 419 MB | **337 MB** |

**Kennungen werden beidseitig vereinheitlicht.** Stand in der Senderliste
`tvg-id="ard.de "` und im XMLTV `channel="ARD.de"`, schlug der Abgleich fehl —
der Sender hatte still kein Programm, ohne jeden Hinweis, dass es nur an einem
Leerzeichen lag. (Auf diesem Panel änderte das nichts, beide Seiten passen
ohnehin; für andere Anbieter ist es der Unterschied zwischen Programm und
leerem Guide.)

**Das Einrichtungsformular verliert die Eingabe nicht mehr.** Gespeichert wurde
erst bei Erfolg — nach einem Fehlversuch stand wieder der alte oder gar kein
Wert im Feld. Wer sich bei einem 60 Zeichen langen Passwort auf der
Fernbedienungstastatur vertippt hatte, durfte alles neu eingeben.

**Sortierung „Neu hinzugefügt".** Das Feld `added` kam von jedem Panel mit,
wurde aber nie gelesen. Außerdem tragen „Jahr" und „Bewertung" jetzt einen
Zweitschlüssel: `Array#sort` ist auf Chromium 53 nicht stabil, und gerade dort
haben sehr viele Titel denselben Wert — die Liste stand bei jedem Aufbau anders
da.

**Fokus nach dem Nachladen.** `focusWuenschen('guidemehr')` lief ins Leere, weil
`button()` seinen Merker mit `btn:` versieht — der Fokus sprang nach jedem
Nachladen an den Seitenanfang. Auf dem Gerät gefunden; ein Test prüft jetzt für
jeden festen Fokuswunsch im Quelltext, ob er einen wirklich vergebenen Merker
trifft.


## 1.17.0

**Detailseite: Das Bild ist jetzt die Bühne.** Vorher endete das Backdrop mit
einer harten Kante, Titel und Metazeile standen darunter — das Bild wirkte wie
eine Briefmarke, und unterhalb blieb kaum Platz (der Abspiel-Knopf lag bei 959
von 1080 px). Jetzt liegen Titel und Metazeile im Bild, getragen von einem
Verlauf, der in den Seitengrund blendet. Auf hellen wie dunklen Backdrops
geprüft.

**Marken statt Textballast.** 4K, HD und Dolby werden aus dem Titel gelesen und
als Marke ins Poster gesetzt — auch in den hochgestellten Unicode-Varianten
(„⁴ᴷ ³⁸⁴⁰ᴾ ᴰᵒˡᵇʸ"), die IPTV-Playlisten verwenden. Höchstens zwei je Eintrag.
„LIVE" ist die einzige gesättigte Fläche der Oberfläche.

**Bewegung** mit drei Kurven und zwei Dauern, ausgerichtet an der
Tastenwiederholung der Fernbedienung: 160 ms herein, 110 ms hinaus. Der
Fokusring selbst erscheint in 0 ms — die Ortsangabe darf nicht nachlaufen.
Karten skalieren nicht mehr, sondern heben ab, während das Poster innen zoomt.
Neu ist ein Gedrückt-Zustand; Enter über die Fernbedienung löst kein `:active`
aus, es gab also bisher gar keine Rückmeldung auf einen Tastendruck.

**Scrollen beim Öffnen.** Die Detailseite sprang um 65 px hoch, wodurch der
obere Bildrand samt Zurück-Knopf hinter der Kopfleiste verschwand. Ursache war
der großzügige Komfortrand von `revealFocus`: Er zog den Blick auch dann zum
Ziel, wenn dieses längst sichtbar war. Beim Erstaufbau und beim bloßen
Neuzeichnen wird jetzt nur noch gescrollt, wenn das Element wirklich außerhalb
liegt.

## 1.17.0

**Liquid Glass — ohne `backdrop-filter`.** Der klassische Glas-Effekt braucht
`backdrop-filter`, das es erst ab Chrome 76 gibt; webOS 4 hat Chromium 53.
Ersatz ist `background-attachment: fixed`: Der Hintergrund wird am Viewport
verankert statt am Element, das Element zeigt also genau die Pixel, die
dahinter liegen — deckend und trotzdem durchsichtig. Die Kopie ist leicht
versetzt (72 %/−4 % statt 60 %/0 %), was einen Brechungsversatz erzeugt, den
`backdrop-filter` gar nicht kann. Auf dem Gerät gemessen: **60 fps**, auch mit
der aufwendigsten Variante.

Dazu Kantenlicht statt Schlagschatten, wo viele Elemente nebeneinander stehen
(30 Chips mit je 30 px Weichzeichnung ergäben eine schmutzige Fläche), und
getrennte Glaswerte für helle und dunkle Designs: Auf OLED-Schwarz wäre eine
weiße Kante bei 0,95 ein grelles Strichgitter.

**Der Fokusring war auf der wichtigsten Liste unsichtbar.** `box-shadow` ist
eine einzige Eigenschaft — `.channel.on-air` und `.chip.active` standen hinter
`.focusable:focus` bei gleicher Spezifität und löschten den Ring vollständig.
Auf dem Gerät gemessen: Eine fokussierte laufende Senderzeile hatte nur noch
die on-air-Kante. Zustandsmarken zeichnen jetzt mit `:before`, nie mehr mit
`box-shadow`.

**Der Ring ist neutral statt akzentfarben.** Als Ortsangabe muss er auf allen
270 Design/Akzent-Kombinationen gleich stark sein: neutral 15–17:1, mit Akzent
im schlechtesten Fall 3,8:1. Das trennt zugleich die Bedeutungen — Akzent heißt
„ausgewählt / läuft", neutral heißt „hier stehst du". Der Trennring wächst von
3 auf 4 px (3 px sind auf 3 m nur 2,2 Bogenminuten).

**Akzentfarben auf hellen Designs.** Die alte Abdunklung skalierte alle
Farbkanäle und entzog dabei die halbe Sättigung: Violett fiel von 88 % auf
32 %, Koralle von 100 auf 41 — Violett, Indigo und Schiefer sahen fast gleich
aus. Jetzt bleiben Ton und Sättigung erhalten, gesenkt wird nur die Helligkeit,
bis der Kontrast gegen den tatsächlichen Grund des Designs 4,5:1 erreicht.
Geprüft: 48 Design/Akzent-Paare, keines darunter.

**Typografie und Abstände folgen jetzt einem System.** Vorher: 14 Schriftgrößen,
davon sechs im Rauschen zwischen 17 und 22 px; `line-height` stand an nur sechs
Stellen, den Rest rechnete der Browser mit „normal"; `letter-spacing` kam kein
einziges Mal vor; 25 Abstandswerte, elf davon außerhalb des Vierer-Rasters;
elf Radien.

Jetzt: sechs Schriftstufen (18/22/28/34/44/56, Faktor rund 1,25), jede mit
eigener Zeilenhöhe; Abstände ausschließlich als Vielfache von 4; sechs Radien.
Große Schrift läuft enger, Versalien weiter. Der Fließtext wächst von 20 auf
22 px — auf drei Meter Abstand war er zu klein. Ein Test hält das System fest,
inklusive der Rechnung für die feste Kartenhöhe (Innenabstand + zwei Zeilen);
ohne sie stünde die dritte Zeile wieder angeschnitten da.

**Ein echter Layoutfehler:** `.grid` fehlte `margin-right`. Die Inhaltsbox war
dadurch 1780 statt 1792 px, die siebte Karte brach um — das Raster zeigte sechs
Spalten, obwohl es auf sieben ausgelegt ist.

Außerdem: Profilkacheln bekommen einen Trennring (die Standard-Profilfarbe ist
identisch mit dem Standardakzent, Kontrast war 1,00), Eingabefelder skalieren
auch im Zeigermodus nicht mehr (18 px Überhang erzeugten waagerechtes
Scrollen), und die Regal-Reserven für den Fokusring stimmen jetzt rechnerisch.

## 1.16.1

**Sprachfilter in drei Stufen** statt an/aus. Die beiden alten Enden lagen weit
auseinander: „aus" ließ alles Unerkannte durch, „an" warf ganze Kategorien weg,
die kein Sprachkürzel tragen.

- **Großzügig** – die gewählten Sprachen plus alles ohne Sprachangabe.
- **Ausgewogen** (Standard) – Kategorien mit Sprachkürzel werden gefiltert,
  Kategorien ohne Angabe bleiben vollständig.
- **Streng** – nur Titel, deren Sprache nachweislich passt.

Die Einstellung nennt jetzt bei jeder Stufe, was sie bedeutet, und zeigt die
Auswirkung an der eigenen Playlist („Derzeit sichtbar: 10949 von 42916
Sendern"). Bestehende Installationen landen auf „Ausgewogen" – das entspricht
dem Verhalten, das sie zuletzt gesehen haben.

Auf dem Gerät gemessen: Großzügig 10.949, Ausgewogen 10.949, Streng 3.160
Sender. Bei Xtream fallen die ersten beiden zusammen, weil dort die Kategorie
die Sprache bestimmt; bei M3U-Playlisten mit Sprachkürzel im Titel gehen sie
auseinander.

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
