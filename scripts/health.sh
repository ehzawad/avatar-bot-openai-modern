#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${APP_HOST:-127.0.0.1}"
PORT="${APP_PORT:-8000}"

if [[ -x .venv/bin/python ]]; then
  IFS=$'\t' read -r HOST PORT < <(.venv/bin/python - <<'PY'
from app.core.config import get_settings

settings = get_settings()
print(f"{settings.app_host}\t{settings.app_port}")
PY
)
fi

curl -sS "http://${HOST}:${PORT}/api/health" | python3 -m json.tool
