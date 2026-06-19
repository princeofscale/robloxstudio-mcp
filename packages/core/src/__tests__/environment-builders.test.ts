import {
  LIGHTING_PRESETS,
  buildSetTimeOfDayLuau,
  buildLightingPresetLuau,
  buildAtmosphereLuau,
  buildSkyLuau,
  buildDayNightCycleScriptLuau,
} from '../builders/environment-builders.js';

describe('LIGHTING_PRESETS', () => {
  it('defines all required presets', () => {
    const expected = ['sunny', 'sunset', 'night', 'horror', 'cyberpunk', 'obby', 'simulator', 'realistic'];
    for (const name of expected) {
      expect(LIGHTING_PRESETS[name]).toBeDefined();
    }
  });
});

describe('buildSetTimeOfDayLuau', () => {
  it('sets ClockTime from a numeric hour', () => {
    const code = buildSetTimeOfDayLuau(14.5);
    expect(code).toContain('Lighting');
    expect(code).toContain('ClockTime = 14.5');
  });
  it('accepts an HH:MM:SS string as TimeOfDay', () => {
    const code = buildSetTimeOfDayLuau('06:30:00');
    expect(code).toContain('TimeOfDay = "06:30:00"');
  });
  it('clamps numeric hours into 0-24', () => {
    expect(buildSetTimeOfDayLuau(30)).toContain('ClockTime = 24');
    expect(buildSetTimeOfDayLuau(-3)).toContain('ClockTime = 0');
  });
});

describe('buildLightingPresetLuau', () => {
  it('emits Lighting assignments for a known preset', () => {
    const code = buildLightingPresetLuau('night');
    expect(code).toContain('local Lighting = game:GetService("Lighting")');
    expect(code).toContain('Lighting.ClockTime');
    expect(code).toContain('Lighting.Ambient');
    expect(code).toContain('Color3.fromRGB');
  });
  it('throws for an unknown preset', () => {
    expect(() => buildLightingPresetLuau('banana')).toThrow(/unknown preset/i);
  });
  it('configures atmosphere for presets that define one (cyberpunk)', () => {
    const code = buildLightingPresetLuau('cyberpunk');
    expect(code).toContain('Atmosphere');
  });
  it('does not add post-processing effects by default', () => {
    const code = buildLightingPresetLuau('simulator');
    expect(code).not.toContain('BloomEffect');
    expect(code).not.toContain('Technology.Future');
  });
  it('adds idempotent post-FX and Future lighting when withPostFx is true', () => {
    const code = buildLightingPresetLuau('simulator', true);
    expect(code).toContain('BloomEffect');
    expect(code).toContain('ColorCorrectionEffect');
    expect(code).toContain('SunRaysEffect');
    expect(code).toContain('Technology.Future');
    // idempotent: looks up by name before creating
    expect(code).toContain('FindFirstChild');
  });
});

describe('buildAtmosphereLuau', () => {
  it('creates or reuses an Atmosphere and sets density', () => {
    const code = buildAtmosphereLuau({ density: 0.4, color: [200, 200, 255] });
    expect(code).toContain('Atmosphere');
    expect(code).toContain('Density = 0.4');
    expect(code).toContain('Color3.fromRGB(200, 200, 255)');
  });
});

describe('buildSkyLuau', () => {
  it('creates or reuses a Sky and sets sun/moon textures', () => {
    const code = buildSkyLuau({ sunTextureId: 'rbxassetid://1', starCount: 3000 });
    expect(code).toContain('Sky');
    expect(code).toContain('rbxassetid://1');
    expect(code).toContain('StarCount = 3000');
  });
});

describe('buildDayNightCycleScriptLuau', () => {
  it('creates a Script in ServerScriptService that advances ClockTime', () => {
    const code = buildDayNightCycleScriptLuau({ minutesPerDay: 10 });
    expect(code).toContain('ServerScriptService');
    expect(code).toContain('Instance.new("Script")');
    expect(code).toContain('ClockTime');
    expect(code).toContain('return');
  });
});
