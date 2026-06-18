# Roblox Studio MCP Server

**A free, open-source MCP server that lets Claude, Cursor, Codex, or Gemini operate Roblox Studio — debug live playtests, bulk-edit places, and scaffold whole games — with a built-in safety layer.**

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

## What this is

Your AI assistant connects over MCP to a Node/TypeScript server, which bridges (local HTTP long-poll) to a Roblox Studio plugin that operates the open place: Workspace, ServerScriptService, ReplicatedStorage, StarterGui, Terrain, Lighting, and more.

```
Claude Code / Codex / Cursor / Gemini
        ↓  MCP (stdio)
Node/TypeScript MCP server  ── localhost dashboard, --doctor
        ↓  local HTTP bridge (long-poll)
Roblox Studio plugin
        ↓
Your place: Workspace · ServerScriptService · ReplicatedStorage · StarterGui · Terrain · Lighting …
```

### Why this vs. WEPPY?

- **Free and open-source (MIT).** No Pro subscription, no paywalled tools, no account gating.
- **Self-hostable.** Everything runs locally; the plugin talks only to your machine.
- **Own your safety policy.** Dry-run, confirmation gating, script backups, operation history, and hard limits are built in and configurable — not a black box.
- **No proprietary code.** This project shares no code with, and does not attempt to bypass, any closed-source tool.

## Setup

1. Enable **Allow HTTP Requests** in Game Settings → Security.
2. Wire up your AI client. `@latest` floats to the newest release; `--auto-install-plugin` copies the matching Studio plugin into Roblox Studio's Plugins folder on start.

```bash
# Claude Code
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin

# Codex CLI
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin

# Gemini CLI
gemini mcp add robloxstudio npx --trust -- -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

**Cursor** — add `.cursor/mcp.json` to your project:

```json
{
  "mcpServers": {
    "robloxstudio": {
      "command": "npx",
      "args": ["-y", "@chrrxs/robloxstudio-mcp@latest", "--auto-install-plugin"]
    }
  }
}
```

**Manual plugin install:** `npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin`. Set `MCP_PLUGINS_DIR` first to override the target folder (works on Windows, macOS, WSL).

Fully close and reopen Studio after the plugin is first installed or updated. The plugin shows **Connected** when ready.

### CLI flags

| Flag | Purpose |
|---|---|
| `--auto-install-plugin` | Install/refresh the bundled plugin on start. |
| `--install-plugin` | Install the plugin and exit. |
| `--port <n>` | Override the bridge port (default 58741). |
| `--debug` | Verbose logging. |
| `--doctor` | Run diagnostics and exit. |

### Verify it works: `--doctor`

```bash
npx -y @chrrxs/robloxstudio-mcp@latest --doctor
```

Checks Node version, server package, whether the Studio plugin is installed, whether the local bridge is running, and whether Studio is reachable — with a clear pass/warn/fail line for each.

### Dashboard

While the server is running, open **http://localhost:58741/dashboard** for a live view: Studio connection status, server version, pending requests, recent operations, and buttons to refresh, clear the log view, and export diagnostics JSON.

## What you can ask

> *"What's the structure of this game?"*
> *"Create an obby game with 6 checkpoints."*
> *"Add a checkpoint system and a timer HUD."*
> *"Fix all script errors."*
> *"Create a shop UI that's mobile-friendly."*
> *"Generate an island map with mountains and water."*
> *"Search the marketplace for a low-poly tree and insert one into Workspace."*
> *"Set the lighting to a horror preset and add a day-night cycle."*
> *"Start a multiplayer test with 2 clients and tell me why the round never starts."*

## Tool catalog (108 tools)

- **Browse & inspect:** file tree, services, instances, properties, attributes, tags, descendants, scene/memory analysis.
- **Edit:** create/delete/duplicate/move instances, set properties (typed), bulk operations, script read/patch/replace, grep.
- **Runtime:** `execute_luau`, server/client runtime eval, playtest start/stop, multiplayer tests, runtime logs, screenshots, input simulation.
- **Safety layer:** dry-run and confirmation gating on destructive ops, automatic script backups, `get_operation_history`, `list_script_backups`, `restore_script_backup`, undo/redo, hard limits (objects per op, script size, terrain volume), protected-service guards, dangerous-Luau detection.
- **UI builder:** `ui_create_screen_gui`, `ui_create_frame`, `ui_create_text_label`/`text_button`/`image_label`/`image_button`, `ui_apply_layout`, `ui_make_mobile_friendly`.
- **Environment:** `environment_set_time_of_day`, `environment_set_lighting_preset` (sunny, sunset, night, horror, cyberpunk, obby, simulator, realistic), `environment_set_atmosphere`, `environment_set_sky`, `environment_create_day_night_cycle_script`.
- **Terrain:** `terrain_generate_baseplate`/`island`/`mountains`/`water`, `terrain_paint_material`, `terrain_clear_region` (volume-limited; clear requires confirmation).
- **Game templates:** `template_create_obby_game`, `template_create_simulator_game`, `template_create_tycoon_game`, `template_create_round_game`.
- **Local sync:** `sync_pull` (Studio → `.server.lua`/`.client.lua`/`.module.lua` files), `sync_status` (three-way diff), `sync_push` (files → Studio, conflict-aware, dry-run).
- **Free marketplace (no key):** `marketplace_search` (public toolbox search for models/decals/audio/meshes) and `marketplace_search_and_insert` (find + insert the top match), plus key-free `insert_asset`/`preview_asset`.
- **Creator Store (Open Cloud key):** `search_assets`, `get_asset_details`, `get_asset_thumbnail`, `upload_asset`, build import/export, `.rbxm` import/export.

## Security

This server lets an AI run Luau and mutate your place. Safeguards are on by default:

- **Destructive operations are gated.** Deleting a protected service (Workspace, ServerScriptService, …), large bulk changes, terrain clears, and Luau matching destructive patterns (`ClearAllChildren`, `:Destroy`, DataStore writes, `os.*`) require `confirm: true`.
- **Script overwrites are backed up** before they run; restore with `restore_script_backup`.
- **Dry-run everywhere** that mutates significantly: pass `dryRun: true` to preview.
- **Hard limits** cap objects-per-operation, script size, and terrain volume even when confirmed.

Still: only connect this to places you own, and review what the AI proposes before confirming destructive steps. For browsing or code review with zero write risk, use the read-only **inspector** edition below.

## Inspector edition (read-only)

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

Same plugin family, read-only tool set — no writes, no script edits, no creation/deletion. Safe for browsing, code review, and debugging.

```bash
npx -y @chrrxs/robloxstudio-mcp-inspector@latest --install-plugin

claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
codex mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
gemini mcp add robloxstudio-inspector npx --trust -- -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
```

Install only one variant at a time — don't leave both `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` in the Plugins folder. The CLI installers remove the other variant first.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Plugin never shows "Connected" | Enable **Allow HTTP Requests** (Game Settings → Security); fully restart Studio after first install. |
| `--doctor` says nothing on the port | The bridge only runs while your MCP client has started the server. Launch the client, then re-run. |
| Yellow banner in the plugin | Server/plugin versions differ. Re-run `--auto-install-plugin` and restart Studio. |
| Tool call hangs | Multiple Studio places connected — pass `instance_id` (see `get_connected_instances`). |
| Editing the plugin in an IDE shows red type errors | Install plugin deps: `cd studio-plugin && npm install`. It is a roblox-ts package separate from the root workspaces. |
| `npx` not found on Windows | Wrap the command with `cmd /c`. |

## Building from source

```bash
npm install && cd studio-plugin && npm install && cd ..
npm run build                                            # node packages
npm run typecheck && npm test                            # 184 unit tests
cd studio-plugin && npm run build && cd ..               # plugin TS → Luau
node scripts/build-plugin.mjs                            # → MCPPlugin.rbxmx
node scripts/build-plugin.mjs --variant inspector        # → MCPInspectorPlugin.rbxmx
```

## License & credits

MIT Licensed. Based on [Chrrxs/robloxstudio-mcp](https://github.com/Chrrxs/robloxstudio-mcp), itself based on [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp). Safety layer, UI/terrain/environment/template builders, local sync, `--doctor`, and the dashboard are additions in this fork.

[Report Issues](https://github.com/chrrxs/robloxstudio-mcp/issues)
