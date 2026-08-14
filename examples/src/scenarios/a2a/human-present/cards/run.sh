#!/bin/bash
set -e

SAMPLE_DIR="$(cd "$(dirname "$0")/../../../../.." && pwd)"
cd "$SAMPLE_DIR"

echo "=========================================="
echo "AP2 TypeScript Sample - Human-Present Cards"
echo "=========================================="

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

USE_VERTEXAI=$(printf "%s" "${GOOGLE_GENAI_USE_VERTEXAI}" | tr '[:upper:]' '[:lower:]')
if [ -z "${GOOGLE_API_KEY}" ] && [ "${USE_VERTEXAI}" != "true" ]; then
  echo "Error: GOOGLE_API_KEY is not set."
  echo "Either export GOOGLE_API_KEY or set GOOGLE_GENAI_USE_VERTEXAI=true."
  echo "See ${SAMPLE_DIR}/.env.example for reference."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo ""
echo "Starting all agents (merchant, credentials, payment processor) and the"
echo "Shopping Agent web UI on http://localhost:3001 ..."
echo "Press Ctrl+C to stop."
echo ""

exec npm run dev
