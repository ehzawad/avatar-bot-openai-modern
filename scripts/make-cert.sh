#!/usr/bin/env bash
#
# Generate a self-signed TLS cert for LAN use.
#
# Why this exists: browsers only expose the microphone (getUserMedia) in a
# "secure context" — HTTPS, or localhost/127.0.0.1 which are exempt. Serving the
# app over plain HTTP to a LAN address means the mic silently does not exist, so
# the avatar voice loop and the studio capture button cannot work. A self-signed
# cert is enough to satisfy the secure-context rule; you accept the browser
# warning once per device.
#
# The cert lists every local IPv4 address as a SAN, so it is valid for whatever
# address other devices use to reach this machine.
#
#   ./scripts/make-cert.sh          # writes certs/dev.crt + certs/dev.key
#
# Nothing is purchased and no external key or account is required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CERT_DIR="${CERT_DIR:-certs}"
CRT="$CERT_DIR/dev.crt"
KEY="$CERT_DIR/dev.key"
DAYS="${DAYS:-825}"

mkdir -p "$CERT_DIR"

# Collect SANs: localhost, loopback, this host's name, and every global IPv4.
SANS="DNS:localhost,DNS:$(hostname),IP:127.0.0.1"
while read -r ip; do
  [[ -n "$ip" ]] && SANS="$SANS,IP:$ip"
done < <(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}' | sort -u)

echo "==> Subject alt names: $SANS"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" -out "$CRT" -days "$DAYS" \
  -subj "/CN=aria-dev" \
  -addext "subjectAltName=$SANS" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null

chmod 600 "$KEY"
echo "==> Wrote $CRT and $KEY (valid $DAYS days)"
echo "    These are gitignored. Never commit the key."
