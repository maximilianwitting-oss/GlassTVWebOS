#!/bin/bash
# GlassTV auf einen LG-Fernseher bringen.
#
#   ./install.sh <TV-IP>
#
# Setzt voraus, dass am TV die App „Developer Mode" installiert, angemeldet und
# auf Dev Mode = ON / Key Server = ON steht (siehe README).
set -e

TV_IP="$1"
if [ -z "$TV_IP" ]; then
  echo "Aufruf: ./install.sh <TV-IP>   (IP steht in der Developer-Mode-App am TV)"
  exit 1
fi

export PATH="$HOME/.local/webos-toolchain/node/bin:$PATH"
cd "$(dirname "$0")"

if ! command -v ares-package >/dev/null 2>&1; then
  echo "Fehler: ares-CLI nicht gefunden. Erwartet unter ~/.local/webos-toolchain/node/bin"
  exit 1
fi

echo "==> Paket bauen"
ares-package src -o . >/dev/null
IPK=$(ls -t de.app.glasstv_*_all.ipk | head -1)
echo "    $IPK"

echo "==> Gerät eintragen ($TV_IP)"
ares-setup-device --add tv \
  --info "{'host':'$TV_IP','port':'9922','username':'prisoner'}" >/dev/null

echo "==> Schlüssel holen"
echo "    Die Passphrase steht in der Developer-Mode-App auf dem Fernseher."
ares-novacom --device tv --getkey

echo "==> Installieren"
ares-install --device tv "$IPK"

echo "==> Starten"
ares-launch --device tv de.app.glasstv

echo
echo "Fertig. GlassTV liegt jetzt in der App-Leiste des Fernsehers."
echo "Log ansehen:  ares-log --device tv -f de.app.glasstv"
