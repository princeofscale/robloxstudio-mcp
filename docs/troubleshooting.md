# Troubleshooting

## Plugin not connecting

**Symptom:** Plugin shows "Disconnected" or nothing.
**Most common cause:** **Allow HTTP Requests** is disabled in Game Settings → Security.

**Fix:**
1. In Roblox Studio, go to **Home** → **Game Settings** → **Security**.
2. Enable **Allow HTTP Requests**.
3. Fully restart Studio (File → Exit, then reopen).

## Plugin still not connecting after enabling HTTP

1. Check that the MCP server is running (your AI client should have started it).
2. Run `--doctor` to check connectivity:
   ```bash
   npx -y @princeofscale/robloxstudio-mcp@latest --doctor
   ```
3. If doctor shows no server on the port, the MCP client isn't running — launch it first.
4. If the plugin was just installed/updated, **fully restart Studio** (plugins load at startup only).

## Yellow banner showing version mismatch

The server and plugin versions differ. This doesn't break every tool, but it's best to match them:

```bash
# Re-run with auto-install to sync the plugin version
npx -y @princeofscale/robloxstudio-mcp@latest --auto-install-plugin
```

Then fully restart Studio.

## Tool calls hang or time out

| Cause | Fix |
|---|---|
| Multiple Studio places open | Pass `instance_id` from `get_connected_instances` to target the right place. |
| Heavy Luau operation | Use `execute_luau_async` instead of `execute_luau` for long-running code. |
| Studio busy (playtest running) | Stop the playtest first, or target the runtime peer explicitly. |

## Port conflicts

The default bridge port is 58741. If something else is using it, pass `--port`:

```bash
claude mcp add robloxstudio -- npx -y @princeofscale/robloxstudio-mcp@latest --auto-install-plugin --port 58742
```

The server tries up to 4 sequential ports before giving up.

## macOS plugin location

The plugin should be at `~/Documents/Roblox/Plugins/MCPPlugin.rbxmx`. If auto-install fails:

```bash
MCP_PLUGINS_DIR=~/Documents/Roblox/Plugins npx -y @princeofscale/robloxstudio-mcp@latest --install-plugin
```

## Windows plugin location

The plugin should be at `%USERPROFILE%\Documents\Roblox\Plugins\MCPPlugin.rbxmx`. If auto-install fails:

```powershell
$env:MCP_PLUGINS_DIR="$env:USERPROFILE\Documents\Roblox\Plugins"
npx -y @princeofscale/robloxstudio-mcp@latest --install-plugin
```

## WSL path issues

In WSL, `npx` auto-detects Windows paths via `wslpath`. If the plugin doesn't appear:

```bash
MCP_PLUGINS_DIR=$(wslpath "$(wslvar USERPROFILE)")/Documents/Roblox/Plugins npx -y @princeofscale/robloxstudio-mcp@latest --install-plugin
```

## Script errors when editing plugin source

The plugin (`studio-plugin/`) is a separate roblox-ts package NOT in the root npm workspaces:

```bash
cd studio-plugin && npm install
```

Then your IDE should resolve the `@rbxts/*` types correctly.

## `npx` not found

Wrap the command:

```bash
cmd /c npx -y @princeofscale/robloxstudio-mcp@latest --auto-install-plugin
```

## Dashboard not loading

The dashboard is at `http://localhost:58741/dashboard` while the server is running. If it doesn't load:

1. Confirm the MCP server is active (your AI client started it).
2. Check if a different port was configured via `--port`.
3. Check the terminal for error messages.

## Still stuck?

[Open an issue](https://github.com/princeofscale/robloxstudio-mcp/issues) with:

- OS and version
- Node version (`node --version`)
- Roblox Studio version
- AI client used
- `--doctor` output
- Any error messages from the MCP server terminal
