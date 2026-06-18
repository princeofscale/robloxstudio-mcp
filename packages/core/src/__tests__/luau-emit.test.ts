import { luaString, color3FromRGB, udim2, vector3, PATH_RESOLVER_LUA } from '../builders/luau-emit.js';

describe('luaString', () => {
  it('wraps a plain string in double quotes', () => {
    expect(luaString('hello')).toBe('"hello"');
  });
  it('escapes embedded double quotes and backslashes', () => {
    expect(luaString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
  it('escapes newlines', () => {
    expect(luaString('a\nb')).toBe('"a\\nb"');
  });
});

describe('color3FromRGB', () => {
  it('emits a Color3.fromRGB call clamped to 0-255 integers', () => {
    expect(color3FromRGB(255, 128, 0)).toBe('Color3.fromRGB(255, 128, 0)');
  });
  it('clamps out-of-range channels', () => {
    expect(color3FromRGB(-5, 999, 12.7)).toBe('Color3.fromRGB(0, 255, 13)');
  });
});

describe('udim2', () => {
  it('emits UDim2.new from scale/offset pairs', () => {
    expect(udim2(0.5, 10, 0.25, -4)).toBe('UDim2.new(0.5, 10, 0.25, -4)');
  });
});

describe('vector3', () => {
  it('emits Vector3.new', () => {
    expect(vector3(1, 2, 3)).toBe('Vector3.new(1, 2, 3)');
  });
});

describe('PATH_RESOLVER_LUA', () => {
  it('defines a resolvePath helper usable by generated code', () => {
    expect(PATH_RESOLVER_LUA).toContain('local function resolvePath');
    expect(PATH_RESOLVER_LUA).toContain('GetService');
  });
});
