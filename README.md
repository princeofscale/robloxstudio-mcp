# Roblox Studio MCP Server

**Connect AI assistants like Claude and Gemini to Roblox Studio. Per-peer `execute_luau` and `stop_playtest` actually work.**

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

> This is a fork of [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0 with four plugin-side fixes baked in. The fixes target Roblox engine constraints around per-peer HTTP access and cross-DataModel signaling that the upstream plugin didn't account for.

## Fork fixes

| # | Bug upstream | Fix in this fork |
|---|---|---|
| 1 | `detectRole` uses `IsRunMode()`, so every play-mode peer reports as `edit` | One-line swap to `IsRunning()` in `Communication.ts:21` |
| 2 | Plugin only registers with MCP when user clicks Connect - invisible in play DMs | Auto-activate on load via `task.delay(2, ...)` orchestrator in `server/index.server.ts` |
| 3 | `target=client-N` is structurally impossible - client peer can't `HttpService:RequestAsync` | Server-peer **broker pattern**: per-player proxies registered with role=`client`, dispatched via `ReplicatedStorage.__MCPClientBroker` `RemoteFunction:InvokeClient` ([ClientBroker.ts](studio-plugin/src/modules/ClientBroker.ts)) |
| 4 | `stop_playtest` warns `__MCP_STOP__` hoping a `LogService.MessageOut` listener catches it - never works cross-DM | Server-peer **edit-proxy** races the real edit DM for `/api/stop-playtest` specifically, calls `StudioTestService:EndTest` from the play server DM where it's legal |

All four are implemented in TypeScript under [studio-plugin/src/](studio-plugin/src/). The compiled `MCPPlugin.rbxmx` is attached to GitHub releases.

---

## Setup

1. Install the [Studio plugin](https://github.com/chrrxs/robloxstudio-mcp/releases) to your Plugins folder (or run `npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin`)
2. Enable **Allow HTTP Requests** in Experience Settings > Security
3. Connect your AI:

**Claude Code:**
```bash
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest
```

**Codex CLI:**
```bash
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest
```

**Gemini CLI:**
```bash
gemini mcp add robloxstudio npx --trust -- -y robloxstudio-mcp@latest
```

Plugin shows "Connected" when ready.

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

**Windows users:** If you encounter issues, use `cmd`:
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

## What Can You Do?

Ask things like: *"What's the structure of this game?"*, *"Find scripts with deprecated APIs"*, *"Create 50 test NPCs in a grid"*, *"Optimize this movement code"*

<details>
<summary><strong>Inspector Edition (Read-Only)</strong></summary>

### robloxstudio-mcp-inspector

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

A lighter, **read-only** version that only exposes inspection tools. No writes, no script edits, no object creation/deletion. Ideal for safely browsing game structure, reviewing scripts, and debugging without risk of accidental changes.

**31 read-only tools:** `get_file_tree`, `search_files`, `get_place_info`, `get_services`, `search_objects`, `get_instance_properties`, `get_instance_children`, `search_by_property`, `get_class_info`, `get_project_structure`, `mass_get_property`, `get_script_source`, `grep_scripts`, `get_attributes`, `get_tags`, `get_tagged`, `get_selection`, `get_playtest_output`, `get_connected_instances`, `get_descendants`, `compare_instances`, `get_output_log`, `export_build`, `list_library`, `search_materials`, `get_build`, `search_assets`, `get_asset_details`, `get_asset_thumbnail`, `preview_asset`, `capture_screenshot`

**Setup** - same plugin, just swap the package name:

**Claude:**
```bash
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest
```

**Codex:**
```bash
codex mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest
```

**Gemini:**
```bash
gemini mcp add robloxstudio-inspector npx --trust -- -y robloxstudio-mcp-inspector@latest
```

<details>
<summary>Other MCP clients (Claude Desktop, Cursor, etc.)</summary>

```json
{
  "mcpServers": {
    "robloxstudio-mcp-inspector": {
      "command": "npx",
      "args": ["-y", "@chrrxs/robloxstudio-mcp-inspector@latest"]
    }
  }
}
```

**Windows users:** If you encounter issues, use `cmd`:
```json
{
  "mcpServers": {
    "robloxstudio-mcp-inspector": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@chrrxs/robloxstudio-mcp-inspector@latest"]
    }
  }
}
```
</details>

</details>

---

<!-- VERSION_LINE -->**v2.8.0** - based on boshyxd v2.7.0 + four plugin-side fixes

## Building & releasing

```bash
# Install all workspaces + the studio-plugin TS toolchain
npm install
cd studio-plugin && npm install && cd ..

# Build node packages (core, mcp, inspector)
npm run build

# Compile the Studio plugin TS to Luau, then assemble the rbxmx
cd studio-plugin && npm run build && cd ..
node scripts/build-plugin.mjs                       # produces studio-plugin/MCPPlugin.rbxmx
node scripts/build-plugin.mjs --variant inspector   # produces studio-plugin/MCPInspectorPlugin.rbxmx
```

On WSL the rbxmx is auto-installed into `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/`. Set `MCP_PLUGINS_DIR` to override.

After a code change, **fully close and reopen Roblox Studio** for the new plugin to load (Studio caches plugin Scripts across `Plugins/` mtime).

### Releasing

1. Bump `version` in the four `package.json` files (root + 3 workspaces) in lockstep.
2. `cd studio-plugin && npm run build && cd .. && node scripts/build-plugin.mjs && node scripts/build-plugin.mjs --variant inspector` to produce both rbxmx files.
3. `npm publish --access public -w packages/robloxstudio-mcp -w packages/robloxstudio-mcp-inspector` (core is `private: true`-style internal, but currently published as a regular dep - flip it to `private: true` in `packages/core/package.json` if you don't want it on npm).
4. Cut a GitHub release on `chrrxs/robloxstudio-mcp` tagged `v<version>` with `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` attached so `--install-plugin` finds them.

### Verification recipe (against a running Studio)

```text
mcp__Roblox_Studio__execute_luau target=edit                # baseline
mcp__Roblox_Studio__start_playtest mode=play numPlayers=1   # wait ~10s
mcp__Roblox_Studio__get_connected_instances                 # expect edit + server + client-N + edit-proxy
mcp__Roblox_Studio__execute_luau target=server              # IsServer=true, LocalPlayer=nil
mcp__Roblox_Studio__execute_luau target=client-N            # IsClient=true, LocalPlayer=<name>
mcp__Roblox_Studio__stop_playtest                           # "Playtest stopped via edit-proxy/EndTest"
mcp__Roblox_Studio__execute_luau target=server              # "Target instance 'server' disconnected"
```

[Report Issues](https://github.com/chrrxs/robloxstudio-mcp/issues) | Upstream: [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) | [DevForum (upstream)](https://devforum.roblox.com/t/v180-roblox-studio-mcp-speed-up-your-workflow-by-letting-ai-read-paths-and-properties/3707071) | MIT Licensed
