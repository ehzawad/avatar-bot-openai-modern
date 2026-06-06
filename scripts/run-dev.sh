#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

IFS=$'\t' read -r HOST PORT OPENAI_CONFIGURED < <(python - <<'PY'
from app.core.config import get_settings

settings = get_settings()
print(f"{settings.app_host}\t{settings.app_port}\t{int(settings.openai_enabled)}")
PY
)

if [[ "$OPENAI_CONFIGURED" != "1" ]]; then
  echo "OPENAI_API_KEY is not configured for this process."
  echo "If it is defined in ~/.zshrc, run: source ~/.zshrc"
  echo "Or create .env from .env.example and set OPENAI_API_KEY there."
  exit 1
fi

echo "Starting Aria at http://${HOST}:${PORT}"
python -m uvicorn app.main:app --host "$HOST" --port "$PORT" --reload
