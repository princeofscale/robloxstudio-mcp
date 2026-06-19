import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SyncManager } from '../sync/sync-manager.js';
import { SyncTools } from '../tools/sync-tools.js';

describe('SyncTools', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roblox-sync-tools-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pulls Studio scripts into suffixed local files and writes a manifest', async () => {
    const callSingle = jest.fn(async () => ({
      returnValue: JSON.stringify([
        {
          path: 'game.ServerScriptService.Main',
          className: 'Script',
          source: 'print("hello")',
        },
      ]),
    }));
    const recordOperation = jest.fn();
    const tools = new SyncTools(new SyncManager(), { callSingle, recordOperation });

    await tools.syncPull(dir, 'place-1');

    expect(callSingle).toHaveBeenCalledWith(
      '/api/execute-luau',
      expect.objectContaining({ code: expect.stringContaining('GetDescendants') }),
      'edit',
      'place-1',
    );
    expect(fs.readFileSync(path.join(dir, 'ServerScriptService/Main.server.lua'), 'utf8')).toBe('print("hello")');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.robloxsync.json'), 'utf8')).paths)
      .toEqual({ 'ServerScriptService/Main.server.lua': 'print("hello")' });
    expect(recordOperation).toHaveBeenCalledWith('sync_pull', expect.stringContaining('pulled 1 scripts'));
  });
});
