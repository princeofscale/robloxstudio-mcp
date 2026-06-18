#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEV_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

if [[ "${ROBLOXSTUDIO_MCP_USE_PUBLISHED:-}" == "1" ]]; then
	exec npx -y @princeofscale/robloxstudio-mcp@latest --auto-install-plugin
fi

cd "${DEV_ROOT}"
npm run build -w packages/core >&2
npm run build:plugin >&2
exec ./node_modules/.bin/tsx packages/robloxstudio-mcp/src/index.ts --auto-install-plugin
