# Roblox Studio MCP Server

**An MCP server for Roblox Studio runtime debugging, playtest automation, and bulk place editing from Claude, Cursor, Codex, or Gemini.**

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

## Why this server

Use this when you want your agent to debug and operate a live Roblox Studio session with precise runtime control:

- `edit`, `server`, and `client-N` targeting for live playtests.
- Game-VM eval on the server or a specific client, sharing the same `require` cache as your scripts.
- Explicit StudioTestService multiplayer runs: start, add/remove clients, inspect state, and end.
- Runtime logs, Stats memory, and Scene Analysis attribution per peer.
- Viewport screenshots plus virtual mouse, keyboard, character navigation, and UI interaction.
- Bulk property/script/attribute/tag operations for large places.
- `.rbxm` import/export through `SerializationService`.
- A read-only inspector package for safer review/debugging sessions.

75 tools total, including file tree inspection, mass reads/writes, script search-and-replace, asset insertion, build import/export, screenshot capture, runtime eval, memory tools, Scene Analysis, and playtest control.

## Setup

1. Install the [Studio plugin](https://github.com/chrrxs/robloxstudio-mcp/releases) (or run `npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin`)
2. Enable **Allow HTTP Requests** in Game Settings → Security
3. Wire up your AI:

```bash
# Claude Code
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest

# Codex CLI
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest

# Gemini CLI
gemini mcp add robloxstudio npx --trust -- -y @chrrxs/robloxstudio-mcp@latest
```

Plugin shows "Connected" when ready.

> **Custom Plugins folder?** Set `MCP_PLUGINS_DIR` before `--install-plugin`. Works on Windows, macOS, and WSL.

<details>
<summary>Other MCP clients (Claude Desktop, Cursor, etc.)</summary>

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "npx",
      "args": ["-y", "@chrrxs/robloxstudio-mcp@latest"]
    }
  }
}
```

On Windows, wrap with `cmd /c` if `npx` doesn't resolve:
```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@chrrxs/robloxstudio-mcp@latest"]
    }
  }
}
```
</details>

## What you can ask

> *"What's the structure of this game?"*
> *"Find scripts using deprecated APIs and rewrite them."*
> *"Start a multiplayer test with 2 clients, read the server log, and tell me why the round never starts."*
> *"Evaluate `MatchService.activeMatches` on the server while a match is running."*
> *"Spawn 50 NPCs in a 10x5 grid for stress testing."*

## Inspector edition (read-only)

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

Same plugin family, different `.rbxmx`. 35 read-only tools — no writes, no script edits, no creation/deletion. Safe for browsing, code review, and debugging without risk of accidental changes.

Install only one variant at a time. Do not leave both `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` in the Studio Plugins folder; Studio loads both and they can register duplicate runtime peers. `--replace-variant` removes the other variant before installing:

```bash
npx -y @chrrxs/robloxstudio-mcp-inspector@latest --install-plugin --replace-variant

# Claude / Codex / Gemini — same shape, different package name
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest
codex mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest
gemini mcp add robloxstudio-inspector npx --trust -- -y @chrrxs/robloxstudio-mcp-inspector@latest
```

---

<!-- VERSION_LINE -->
**v2.15.0**

## Building from source

```bash
npm install && cd studio-plugin && npm install && cd ..
npm run build                                            # node packages
cd studio-plugin && npm run build && cd ..               # plugin TS → Luau
node scripts/build-plugin.mjs                            # → MCPPlugin.rbxmx
node scripts/build-plugin.mjs --variant inspector        # → MCPInspectorPlugin.rbxmx
```

On WSL the `.rbxmx` is auto-installed into `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/`, and the local build script removes the other plugin variant from that folder. Set `MCP_PLUGINS_DIR` to override. **Fully close and reopen Studio** after a plugin rebuild, and verify only the one variant you intend to test remains in the Plugins folder.

[Report Issues](https://github.com/chrrxs/robloxstudio-mcp/issues) · MIT Licensed · Based on [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0
