import { RobloxStudioMCPServer, getAllTools, runDoctor } from '@princeofscale/robloxstudio-mcp-core';
import { createRequire } from 'module';

const argFlagValue = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
};

// --port / --debug are honored by setting env the core server reads.
const portArg = argFlagValue('--port');
if (portArg) process.env.ROBLOX_STUDIO_PORT = portArg;
if (process.argv.includes('--debug')) process.env.ROBLOX_STUDIO_DEBUG = '1';

if (process.argv.includes('--doctor')) {
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json');
  process.exitCode = await runDoctor({
    version,
    port: portArg ? parseInt(portArg) : undefined,
  });
} else if (process.argv.includes('--install-plugin')) {
  const { installPlugin } = await import('./install-plugin.js');
  await installPlugin().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
} else {
  if (process.argv.includes('--auto-install-plugin')) {
    const { installBundledPlugin } = await import('./install-plugin.js');
    await installBundledPlugin({
      log: (message) => console.error(`[install-plugin] ${message}`),
      warn: (message) => console.error(message),
    }).catch((err) => {
      console.error(
        `[install-plugin] Auto-install skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  const flagValue = (flag: string): string | undefined => {
    const idx = process.argv.indexOf(flag);
    return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
  };

  const openCloudKey = flagValue('--open-cloud-key');
  const creatorId = flagValue('--creator-id');
  const creatorGroupId = flagValue('--creator-group-id');
  const pollinationsKey = flagValue('--pollinations-key');

  if (openCloudKey) process.env.ROBLOX_OPEN_CLOUD_API_KEY = openCloudKey;
  if (creatorId) process.env.ROBLOX_CREATOR_USER_ID = creatorId;
  if (creatorGroupId) process.env.ROBLOX_CREATOR_GROUP_ID = creatorGroupId;
  if (pollinationsKey) process.env.POLLINATIONS_API_KEY = pollinationsKey;

  const require = createRequire(import.meta.url);
  const { version: VERSION } = require('../package.json');

  const server = new RobloxStudioMCPServer({
    name: 'robloxstudio-mcp',
    version: VERSION,
    tools: getAllTools(),
  });

  server.run().catch((error) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}
