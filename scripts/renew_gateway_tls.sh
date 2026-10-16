#!/usr/bin/env bash
# Renew the trusted Tailscale certificate; restart only when certificate changes.
set -euo pipefail
HOST="${1:?Tailscale hostname required}"
OUT="${2:?TLS directory required}"
SERVICE="${3:-pilotv-gateway.service}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# Fail closed: never replace a trusted certificate with a self-signed fallback.
tailscale cert --min-validity=720h --cert-file "$TMP/cert.pem" --key-file "$TMP/key.pem" "$HOST"
openssl x509 -in "$TMP/cert.pem" -checkend 86400 -noout
if cmp -s "$TMP/cert.pem" "$OUT/pilotv-fullchain.pem"; then
  echo 'Trusted certificate unchanged; no restart needed.'
  exit 0
fi
OWNER=$(stat -c %u "$OUT/pilotv-key.pem")
GROUP=$(stat -c %g "$OUT/pilotv-key.pem")
install -o "$OWNER" -g "$GROUP" -m 600 "$TMP/key.pem" "$OUT/pilotv-key.pem"
install -o "$OWNER" -g "$GROUP" -m 644 "$TMP/cert.pem" "$OUT/pilotv-fullchain.pem"
systemctl restart "$SERVICE"
echo 'Trusted certificate renewed and gateway restarted.'
