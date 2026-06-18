import { SyncManager } from '../sync/sync-manager.js';

describe('SyncManager file naming', () => {
  const sync = new SyncManager();

  it('maps script classes to suffixed file names', () => {
    expect(sync.fileNameFor('Main', 'Script')).toBe('Main.server.lua');
    expect(sync.fileNameFor('Controller', 'LocalScript')).toBe('Controller.client.lua');
    expect(sync.fileNameFor('Util', 'ModuleScript')).toBe('Util.module.lua');
  });

  it('reverses a file name back to base name and class', () => {
    expect(sync.classNameForFile('Main.server.lua')).toEqual({ baseName: 'Main', className: 'Script' });
    expect(sync.classNameForFile('Controller.client.lua')).toEqual({ baseName: 'Controller', className: 'LocalScript' });
    expect(sync.classNameForFile('Util.module.lua')).toEqual({ baseName: 'Util', className: 'ModuleScript' });
  });

  it('returns null for non-script files', () => {
    expect(sync.classNameForFile('readme.md')).toBeNull();
    expect(sync.classNameForFile('Main.lua')).toBeNull();
  });
});

describe('SyncManager path mapping', () => {
  const sync = new SyncManager();

  it('maps a DataModel script path to a relative file path', () => {
    expect(sync.instancePathToFilePath('game.ServerScriptService.Systems.Main', 'Script'))
      .toBe('ServerScriptService/Systems/Main.server.lua');
  });

  it('drops a leading game. and handles top-level services', () => {
    expect(sync.instancePathToFilePath('ServerScriptService.Boot', 'Script'))
      .toBe('ServerScriptService/Boot.server.lua');
  });

  it('reverses a relative file path back to a DataModel path', () => {
    expect(sync.filePathToInstancePath('ServerScriptService/Systems/Main.server.lua'))
      .toEqual({ instancePath: 'ServerScriptService.Systems.Main', className: 'Script' });
  });
});

describe('SyncManager ignore rules', () => {
  it('matches simple globs and directory prefixes', () => {
    const sync = new SyncManager({ ignore: ['**/*.spec.lua', 'ReplicatedStorage/Packages/**'] });
    expect(sync.isIgnored('ServerScriptService/Foo.spec.lua')).toBe(true);
    expect(sync.isIgnored('ReplicatedStorage/Packages/Promise.module.lua')).toBe(true);
    expect(sync.isIgnored('ServerScriptService/Main.server.lua')).toBe(false);
  });
});

describe('SyncManager conflict detection', () => {
  const sync = new SyncManager();

  it('reports none when local and studio match', () => {
    expect(sync.detectConflict({ local: 'a', base: 'a', studio: 'a' })).toBe('none');
    expect(sync.detectConflict({ local: 'b', base: 'a', studio: 'b' })).toBe('none');
  });

  it('reports studio when only studio changed', () => {
    expect(sync.detectConflict({ local: 'a', base: 'a', studio: 'b' })).toBe('studio');
  });

  it('reports local when only local changed', () => {
    expect(sync.detectConflict({ local: 'b', base: 'a', studio: 'a' })).toBe('local');
  });

  it('reports both when each side diverged differently', () => {
    expect(sync.detectConflict({ local: 'b', base: 'a', studio: 'c' })).toBe('both');
  });

  it('treats a missing base as studio-changed when local is absent', () => {
    expect(sync.detectConflict({ local: undefined, base: undefined, studio: 'new' })).toBe('studio');
  });
});
