import {
  assetUri,
  buildCreateSoundLuau,
  buildPlaySoundLuau,
  buildCreateAnimationLuau,
  buildPlayAnimationLuau,
  buildApplyTextureLuau,
  buildGenerateModelLuau,
} from '../builders/media-builders.js';

describe('assetUri', () => {
  it('wraps a numeric id in rbxassetid://', () => {
    expect(assetUri(12345)).toBe('rbxassetid://12345');
    expect(assetUri('678')).toBe('rbxassetid://678');
  });
  it('passes an existing uri through', () => {
    expect(assetUri('rbxassetid://9')).toBe('rbxassetid://9');
    expect(assetUri('http://www.roblox.com/asset/?id=9')).toBe('http://www.roblox.com/asset/?id=9');
  });
});

describe('buildCreateSoundLuau', () => {
  it('creates a Sound with a normalized SoundId and config', () => {
    const code = buildCreateSoundLuau({ parentPath: 'Workspace', soundId: 99, volume: 0.5, looped: true });
    expect(code).toContain('Instance.new("Sound")');
    expect(code).toContain('SoundId = "rbxassetid://99"');
    expect(code).toContain('Volume = 0.5');
    expect(code).toContain('Looped = true');
    expect(code).toContain('resolvePath');
  });
  it('plays on create when requested', () => {
    expect(buildCreateSoundLuau({ parentPath: 'Workspace', soundId: 1, playOnCreate: true })).toContain(':Play()');
  });
});

describe('buildPlaySoundLuau', () => {
  it('resolves and plays an existing sound', () => {
    const code = buildPlaySoundLuau({ path: 'Workspace.Ambience' });
    expect(code).toContain('resolvePath');
    expect(code).toContain(':Play()');
  });
});

describe('buildCreateAnimationLuau', () => {
  it('creates an Animation with a normalized AnimationId', () => {
    const code = buildCreateAnimationLuau({ parentPath: 'ReplicatedStorage', animationId: 777, name: 'Wave' });
    expect(code).toContain('Instance.new("Animation")');
    expect(code).toContain('AnimationId = "rbxassetid://777"');
    expect(code).toContain('"Wave"');
  });
});

describe('buildPlayAnimationLuau', () => {
  it('loads the animation onto a rig humanoid/animator and plays it', () => {
    const code = buildPlayAnimationLuau({ rigPath: 'Workspace.Dummy', animationId: 5 });
    expect(code).toContain('rbxassetid://5');
    expect(code).toMatch(/Animator|Humanoid|LoadAnimation/);
    expect(code).toContain(':Play()');
  });
});

describe('buildApplyTextureLuau', () => {
  it('applies an image to the right property based on class', () => {
    const code = buildApplyTextureLuau({ targetPath: 'StarterGui.Gui.Icon', assetId: 42 });
    expect(code).toContain('resolvePath');
    expect(code).toContain('rbxassetid://42');
    // It should branch on class to pick Image / Texture / Decal / TextureID.
    expect(code).toMatch(/ImageLabel|Decal|Texture|MeshPart/);
  });
  it('honors an explicit property override', () => {
    const code = buildApplyTextureLuau({ targetPath: 'Workspace.Part.Decal', assetId: 7, property: 'Texture' });
    expect(code).toContain('target.Texture = "rbxassetid://7"');
  });
});

describe('buildGenerateModelLuau', () => {
  it('emits TextPrompt and the default Body1 predefined schema', () => {
    const code = buildGenerateModelLuau({ prompt: 'a small wooden stool' });
    expect(code).toContain('GenerationService:GenerateModelAsync(inputs, schema)');
    expect(code).toContain('TextPrompt = "a small wooden stool"');
    expect(code).toContain('PredefinedSchema = "Body1"');
    expect(code).toContain('resolvePath("Workspace")');
  });
  it('uses a custom SchemaDefinition when parts are given (overriding predefined)', () => {
    const code = buildGenerateModelLuau({ prompt: 'a cart', parts: ['body', 'wheel_fl'], predefinedSchema: 'Car5' });
    expect(code).toContain('SchemaDefinition = { Groups = { "body", "wheel_fl" } }');
    expect(code).not.toContain('PredefinedSchema');
  });
  it('threads optional size, triangle budget and texture flag into inputs', () => {
    const code = buildGenerateModelLuau({ prompt: 'x', size: { x: 4, y: 2, z: 4 }, maxTriangles: 5000, generateTextures: false });
    expect(code).toContain('Size = Vector3.new(4, 2, 4)');
    expect(code).toContain('MaxTriangles = 5000');
    expect(code).toContain('GenerateTextures = false');
  });
});
