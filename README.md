# Roblox Studio MCP Server

**The MCP server for serious Roblox developers. Drive playtests, evaluate Luau on the running game's server and client peers, and read live runtime state — from Claude, Cursor, Codex, or Gemini.**

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

## Why this one

If you only need to read scripts and inspect static instance trees, the [official Roblox MCP](https://create.roblox.com/docs/studio/mcp) is enough.

Pick this if you want to:

- **Start a playtest from your AI agent**, watch it run, and stop it cleanly — every time.
- **Evaluate Luau inside the running game**, on the server peer *or* a specific client, with access to the same `require` cache your game scripts use. Inspect runtime-mutated module state — networking caches, ECS tick state, datastore queues — that sandboxed eval can't see.
- **Read live logs, memory, selection, and properties per peer** during a playtest. `target=edit | server | client-N` everywhere it makes sense.
- **Round-trip parts of your place through `.rbxm`** (export/import via `SerializationService`) and undo the whole import with one Ctrl+Z.
- **Get the real parser error** when your eval has a syntax bug — not a generic "Requested module experienced an error while loading".

70 tools total — full file-tree, mass property reads/writes, script search-and-replace, attribute/tag management, build import/export, asset insertion, screenshot capture, ScriptEditorService integration, .rbxm bundling, runtime memory inspection.

A fork of [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0 with the playtest-driving and per-peer pieces actually working out of the box.

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
> *"Start a playtest with 2 clients, read the server log, and tell me why the round never starts."*
> *"Evaluate `MatchService.activeMatches` on the server while a match is running."*
> *"Spawn 50 NPCs in a 10x5 grid for stress testing."*

## Inspector edition (read-only)

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

Same plugin family, different `.rbxmx`. 34 read-only tools — no writes, no script edits, no creation/deletion. Safe for browsing, code review, and debugging without risk of accidental changes.

Install only one variant at a time. `--replace-variant` swaps atomically:

```bash
npx -y @chrrxs/robloxstudio-mcp-inspector@latest --install-plugin --replace-variant

# Claude / Codex / Gemini — same shape, different package name
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest
codex mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest
gemini mcp add robloxstudio-inspector npx --trust -- -y @chrrxs/robloxstudio-mcp-inspector@latest
```

---

<!-- VERSION_LINE -->
**v2.12.0** — based on boshyxd v2.7.0

## Building from source

```bash
npm install && cd studio-plugin && npm install && cd ..
npm run build                                            # node packages
cd studio-plugin && npm run build && cd ..               # plugin TS → Luau
node scripts/build-plugin.mjs                            # → MCPPlugin.rbxmx
node scripts/build-plugin.mjs --variant inspector        # → MCPInspectorPlugin.rbxmx
```

On WSL the `.rbxmx` is auto-installed into `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/`. Set `MCP_PLUGINS_DIR` to override. **Fully close and reopen Studio** after a plugin rebuild.

[Report Issues](https://github.com/chrrxs/robloxstudio-mcp/issues) · Upstream: [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) · MIT Licensed
