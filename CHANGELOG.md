# Änderungen

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
