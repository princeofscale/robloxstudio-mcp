import { buildDesignLintLuau, buildApplyThemeLuau, getDesignCatalog, THEMES, buildReviewReparentLuau, buildReviewRestoreLuau, designReviewPrompt } from '../builders/design-builders.js';

describe('buildDesignLintLuau', () => {
  it('scans all StarterGui ScreenGuis by default', () => {
    const code = buildDesignLintLuau();
    expect(code).toContain('StarterGui:GetChildren()');
    expect(code).toContain('MIN_TEXT_SIZE = 9');
    expect(code).toContain('lintRoot');
  });
  it('targets a single root when rootPath is given', () => {
    const code = buildDesignLintLuau({ rootPath: 'StarterGui.MainMenu' });
    expect(code).toContain('resolvePath("StarterGui.MainMenu")');
    expect(code).not.toContain('StarterGui:GetChildren()');
  });
  it('honors a custom minimum text size', () => {
    const code = buildDesignLintLuau({ minTextSize: 14 });
    expect(code).toContain('MIN_TEXT_SIZE = 14');
  });
  it('emits every lint rule', () => {
    const code = buildDesignLintLuau();
    for (const rule of ['tiny_text', 'offscreen', 'overlap_interactive', 'non_responsive_size', 'no_layout_container', 'stretched_image_no_slice']) {
      expect(code).toContain(rule);
    }
  });
});

describe('getDesignCatalog', () => {
  it('exposes themes, tokens, components and guidance', () => {
    const c = getDesignCatalog();
    expect(c.themes).toEqual(expect.arrayContaining(['dark', 'light']));
    expect(c.tokens.minTextSize).toBe(14);
    expect(c.components.map((x) => x.name)).toEqual(expect.arrayContaining(['button', 'card', 'modal']));
    expect(c.guidance.length).toBeGreaterThan(0);
  });
});

describe('buildApplyThemeLuau', () => {
  it('emits the dark theme tokens and raises tiny text', () => {
    const code = buildApplyThemeLuau({ rootPath: 'StarterGui.Menu' });
    const [r, g, b] = THEMES.dark.primary;
    expect(code).toContain(`Color3.fromRGB(${r}, ${g}, ${b})`);
    expect(code).toContain('resolvePath("StarterGui.Menu")');
    expect(code).toContain('MIN_TEXT = 14');
  });
  it('falls back to dark for an unknown theme and honors light', () => {
    expect(buildApplyThemeLuau({ rootPath: 'X', theme: 'bogus' })).toContain('theme = "dark"');
    expect(buildApplyThemeLuau({ rootPath: 'X', theme: 'light' })).toContain('theme = "light"');
  });
  it('can disable rounded corners', () => {
    expect(buildApplyThemeLuau({ rootPath: 'X', roundCorners: false })).toContain('local ROUND = false');
  });
});

describe('design_review helpers', () => {
  it('reparent requires a LayerCollector and remembers the original parent', () => {
    const code = buildReviewReparentLuau('StarterGui.Menu');
    expect(code).toContain('resolvePath("StarterGui.Menu")');
    expect(code).toContain('IsA("LayerCollector")');
    expect(code).toContain('__dr_origParent');
    expect(code).toContain('game:GetService("CoreGui")');
  });
  it('restore returns the element to the original parent path', () => {
    const code = buildReviewRestoreLuau('CoreGui.Menu', 'StarterGui');
    expect(code).toContain('resolvePath("CoreGui.Menu")');
    expect(code).toContain('resolvePath("StarterGui")');
  });
  it('builds a rubric that scores the key dimensions and appends focus', () => {
    const p = designReviewPrompt('mobile layout');
    expect(p).toContain('Roblox');
    expect(p).toContain('AI slop');
    expect(p).toContain('Reviewer focus: mobile layout');
  });
});
