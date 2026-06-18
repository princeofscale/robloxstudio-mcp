import {
  buildScreenGuiLuau,
  buildGuiObjectLuau,
  buildApplyLayoutLuau,
  buildMobileFriendlyLuau,
} from '../builders/ui-builders.js';

describe('buildScreenGuiLuau', () => {
  it('creates a ScreenGui under StarterGui by default and returns its path', () => {
    const code = buildScreenGuiLuau({ name: 'MainGui' });
    expect(code).toContain('Instance.new("ScreenGui")');
    expect(code).toContain('StarterGui');
    expect(code).toContain('"MainGui"');
    expect(code).toContain('return');
  });
  it('honors IgnoreGuiInset and ResetOnSpawn options', () => {
    const code = buildScreenGuiLuau({ name: 'Hud', ignoreGuiInset: true, resetOnSpawn: false });
    expect(code).toContain('IgnoreGuiInset = true');
    expect(code).toContain('ResetOnSpawn = false');
  });
});

describe('buildGuiObjectLuau', () => {
  it('creates a Frame with size, position, anchor, and color', () => {
    const code = buildGuiObjectLuau('Frame', {
      parentPath: 'StarterGui.MainGui',
      name: 'Panel',
      size: [0.5, 0, 0.5, 0],
      position: [0.25, 0, 0.25, 0],
      anchorPoint: [0.5, 0.5],
      backgroundColor: [40, 40, 60],
    });
    expect(code).toContain('Instance.new("Frame")');
    expect(code).toContain('UDim2.new(0.5, 0, 0.5, 0)');
    expect(code).toContain('Vector2.new(0.5, 0.5)');
    expect(code).toContain('Color3.fromRGB(40, 40, 60)');
    expect(code).toContain('resolvePath');
  });

  it('creates a TextButton with text, font, and TextScaled', () => {
    const code = buildGuiObjectLuau('TextButton', {
      parentPath: 'StarterGui.MainGui',
      text: 'Play',
      font: 'GothamBold',
      textScaled: true,
      textColor: [255, 255, 255],
    });
    expect(code).toContain('Instance.new("TextButton")');
    expect(code).toContain('Text = "Play"');
    expect(code).toContain('Enum.Font.GothamBold');
    expect(code).toContain('TextScaled = true');
  });

  it('sets Image for image elements', () => {
    const code = buildGuiObjectLuau('ImageLabel', {
      parentPath: 'StarterGui.MainGui',
      image: 'rbxassetid://12345',
    });
    expect(code).toContain('Instance.new("ImageLabel")');
    expect(code).toContain('rbxassetid://12345');
  });
});

describe('buildApplyLayoutLuau', () => {
  it('adds a UIListLayout with the requested fill direction and padding', () => {
    const code = buildApplyLayoutLuau('StarterGui.MainGui.Panel', {
      layout: 'list',
      fillDirection: 'Vertical',
      padding: 8,
    });
    expect(code).toContain('Instance.new("UIListLayout")');
    expect(code).toContain('Enum.FillDirection.Vertical');
    expect(code).toContain('UDim.new(0, 8)');
  });
  it('adds a UIGridLayout for grid layouts', () => {
    const code = buildApplyLayoutLuau('StarterGui.MainGui.Panel', { layout: 'grid' });
    expect(code).toContain('Instance.new("UIGridLayout")');
  });
});

describe('buildMobileFriendlyLuau', () => {
  it('adds a UIScale and AspectRatio safeguards to the target', () => {
    const code = buildMobileFriendlyLuau('StarterGui.MainGui');
    expect(code).toContain('resolvePath');
    expect(code).toMatch(/UIScale|UIAspectRatioConstraint|TextScaled/);
  });
});
