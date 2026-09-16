#!/usr/bin/env bash
#
# One-command launcher for the unified app (landing at /, avatar at /avatar, studio at /studio).
#
#   ./scripts/run.sh         Build the web/ SPA, then serve everything from ONE process.
#                            Open http://HOST:PORT/  (landing), /avatar, and /studio.
#   ./scripts/run.sh dev     Hot-reload mode: backend + Vite dev server together; open the
#                            Vite URL it prints. (Two processes, one terminal — Ctrl-C stops both.)
#
# Env toggles:
#   SKIP_BUILD=1   Skip the npm build in default mode (reuse an existing web/dist).
#   HOST=, PORT=   Override the backend host/port (defaults come from app settings).
#   HTTPS=1        Serve over TLS using certs/dev.{crt,key}, generating them via
#                  scripts/make-cert.sh if missing. Required for microphone access
#                  from any device other than this one: browsers only expose
#                  getUserMedia on a secure origin, and localhost is the only
#                  plain-HTTP exemption. Without it the record button fails on a
#                  phone or another laptop even though the page loads fine.
#
# `uvicorn` lives in the project virtualenv (.venv), not system Python — this script
# always uses it, so you never hit "No module named uvicorn".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-run}"

# --- Python venv + backend deps ------------------------------------------------
if [[ ! -d .venv ]]; then
  echo "==> Creating virtualenv (.venv)"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt

# --- Resolve host/port + OpenAI key state from app settings --------------------
IFS=$'\t' read -r CFG_HOST CFG_PORT OPENAI_CONFIGURED < <(python - <<'PY'
from app.core.config import get_settings
s = get_settings()
print(f"{s.app_host}\t{s.app_port}\t{int(s.openai_enabled)}")
PY
)
HOST="${HOST:-$CFG_HOST}"
PORT="${PORT:-$CFG_PORT}"

# --- TLS (optional, needed for mic access off this machine) ---------------------
SSL_ARGS=()
SCHEME="http"
if [[ "${HTTPS:-0}" == "1" ]]; then
  CERT_DIR="${CERT_DIR:-certs}"
  if [[ ! -f "$CERT_DIR/dev.crt" || ! -f "$CERT_DIR/dev.key" ]]; then
    echo "==> No cert found in $CERT_DIR — generating a self-signed one"
    ./scripts/make-cert.sh
  fi
  SSL_ARGS=(--ssl-certfile "$CERT_DIR/dev.crt" --ssl-keyfile "$CERT_DIR/dev.key")
  SCHEME="https"
fi

# When bound to all interfaces, 0.0.0.0 is not a usable address to type into a
# browser. Show a real LAN IP instead so the printed URLs can be copied as-is.
DISPLAY_HOST="$HOST"
if [[ "$HOST" == "0.0.0.0" ]]; then
  DISPLAY_HOST="$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}' | head -1)"
  DISPLAY_HOST="${DISPLAY_HOST:-127.0.0.1}"
fi

if [[ "$OPENAI_CONFIGURED" != "1" ]]; then
  echo "WARNING: OPENAI_API_KEY is not set for this process."
  echo "  Chat / transcription / TTS will return 503 until it is set."
  echo "  Fix: export OPENAI_API_KEY=...   (or add it to .env)   then re-run."
fi

# --- Helpers -------------------------------------------------------------------
need_node() {
  command -v npm >/dev/null 2>&1 || { echo "ERROR: npm/node not found — install Node 18+."; exit 1; }
}

if [[ "$MODE" == "dev" ]]; then
  # ---- Dev mode: backend (background) + Vite dev server (foreground) ----------
  need_node
  echo "==> Installing web deps (web/)"
  (cd web && npm install --silent)

  if [[ "${HTTPS:-0}" == "1" ]]; then
    echo "NOTE: HTTPS=1 applies to the backend only; the Vite dev server still serves"
    echo "      plain HTTP, so the microphone will not work from another device in dev"
    echo "      mode. Use the default (non-dev) mode for LAN testing with audio."
  fi
  echo "==> Starting backend on ${SCHEME}://${DISPLAY_HOST}:${PORT} (reload)"
  python -m uvicorn app.main:app --host "$HOST" --port "$PORT" --reload "${SSL_ARGS[@]}" &
  BACKEND_PID=$!
  # Stop the backend whenever this script exits (Ctrl-C, vite quit, etc.)
  trap 'echo; echo "==> Stopping backend (pid $BACKEND_PID)"; kill "$BACKEND_PID" 2>/dev/null || true' EXIT

  echo "==> Starting Vite dev server (open the URL it prints; /api is proxied to :${PORT})"
  (cd web && npm run dev)
  exit 0
fi

# ---- Default (prod-style): build once, serve everything from one process ------
if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  if [[ ! -d web/dist ]]; then
    echo "ERROR: SKIP_BUILD=1 but web/dist does not exist. Run without SKIP_BUILD first."
    exit 1
  fi
  echo "==> SKIP_BUILD=1 — reusing existing web/dist"
else
  need_node
  echo "==> Building the web/ SPA (landing + avatar + studio)"
  (cd web && npm install --silent && npm run build)
fi

BASE="${SCHEME}://${DISPLAY_HOST}:${PORT}"
echo
echo "==> Aria is starting on ${BASE}"
echo "      Home:    ${BASE}/"
echo "      Avatar:  ${BASE}/avatar"
echo "      Studio:  ${BASE}/studio"
echo "      API docs: ${BASE}/docs"
if [[ "$SCHEME" == "https" ]]; then
  echo
  echo "    The cert is self-signed, so each device shows a warning once."
  echo "    Accept it (Advanced -> Proceed) and the microphone will work."
elif [[ "$HOST" == "0.0.0.0" ]]; then
  echo
  echo "    NOTE: serving plain HTTP on the network. The page will load on other"
  echo "    devices but the microphone will NOT — browsers require HTTPS off"
  echo "    localhost. Re-run with HTTPS=1 to enable audio capture."
fi
echo
exec python -m uvicorn app.main:app --host "$HOST" --port "$PORT" "${SSL_ARGS[@]}"
