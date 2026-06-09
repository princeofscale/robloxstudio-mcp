#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEV_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
CURRENT_ROOT="$(git -C "${PWD}" rev-parse --show-toplevel 2>/dev/null || pwd -P)"

if [[ "${ROBLOXSTUDIO_MCP_DEV:-}" == "1" || "${CURRENT_ROOT}" == "${DEV_ROOT}" ]]; then
	cd "${DEV_ROOT}"
	npm run build -w packages/core >&2
	npm run build:plugin >&2
	exec ./node_modules/.bin/tsx packages/robloxstudio-mcp/src/index.ts --auto-install-plugin
fi

exec npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
