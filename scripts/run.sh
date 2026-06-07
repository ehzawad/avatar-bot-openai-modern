#!/usr/bin/env bash
#
# One-command launcher for the unified app (avatar at /, Bengali eval studio at /studio).
#
#   ./scripts/run.sh         Build the web/ SPA, then serve everything from ONE process.
#                            Open http://HOST:PORT/  (avatar)  and  /studio  (studio).
#   ./scripts/run.sh dev     Hot-reload mode: backend + Vite dev server together; open the
#                            Vite URL it prints. (Two processes, one terminal — Ctrl-C stops both.)
#
# Env toggles:
#   SKIP_BUILD=1   Skip the npm build in default mode (reuse an existing web/dist).
#   HOST=, PORT=   Override the backend host/port (defaults come from app settings).
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

  echo "==> Starting backend on http://${HOST}:${PORT} (reload)"
  python -m uvicorn app.main:app --host "$HOST" --port "$PORT" --reload &
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
  echo "==> Building the web/ SPA (avatar + studio)"
  (cd web && npm install --silent && npm run build)
fi

echo
echo "==> Aria is starting on http://${HOST}:${PORT}"
echo "      Avatar:  http://${HOST}:${PORT}/"
echo "      Studio:  http://${HOST}:${PORT}/studio"
echo "      API docs: http://${HOST}:${PORT}/docs"
echo
exec python -m uvicorn app.main:app --host "$HOST" --port "$PORT"
