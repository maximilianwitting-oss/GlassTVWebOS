# webOSTV.js

Offizielle Bibliothek von LG, Version **1.2.13**, unverändert übernommen aus
dem webOS-TV-SDK (`@webos-tools/cli`, Vorlage `bootplate-web`). Lizenz:
Apache 2.0, siehe `LICENSE-2.0.txt`.

Wird gebraucht für:

- `webOS.platformBack()` – die App muss das Beenden selbst übernehmen, weil
  `appinfo.json` `disableBackHistoryAPI` setzt.
- `webOS.deviceInfo()` – Modell und Firmware in den Einstellungen.
- `webOS.service.request()` – aufgeräumter Zugang zu Luna-Diensten als der
  rohe `PalmServiceBridge`.

Beim Aktualisieren der CLI erneut von dort kopieren, nicht von Hand ändern.
