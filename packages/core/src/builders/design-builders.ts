// Track D — UI design quality. These builders emit Luau executed in the plugin
// edit context (no plugin rebuild). `design_lint` is a deterministic, reproducible
// UI-quality metric; `ui_component_catalog` and `apply_theme` give the agent a
// canon to build against instead of re-inventing spacing/typography each time.
//
// Edit-mode note: GuiObjects parented under StarterGui DO get AbsolutePosition/
// AbsoluteSize computed in edit, so geometric checks (overlap/offscreen) work
// without a playtest. Topbar/safe-area insets are 0 in edit and need a playtest.

import { luaString, PATH_RESOLVER_LUA } from './luau-emit.js';

function wrap(body: string): string {
  return `${PATH_RESOLVER_LUA}\n${body}`;
}

// ─── Design system: tokens + canonical components (the build canon) ──────────
// A small, opinionated system the agent composes from instead of re-inventing
// spacing/typography/color on every screen. Pure data — no Studio round-trip.

export interface ThemeTokens {
  bg: [number, number, number];
  surface: [number, number, number];
  primary: [number, number, number];
  onPrimary: [number, number, number];
  text: [number, number, number];
  muted: [number, number, number];
  stroke: [number, number, number];
  danger: [number, number, number];
}

export const THEMES: Record<string, ThemeTokens> = {
  dark: {
    bg: [26, 27, 30], surface: [37, 38, 43], primary: [76, 110, 245], onPrimary: [255, 255, 255],
    text: [233, 236, 239], muted: [144, 146, 150], stroke: [55, 58, 64], danger: [250, 82, 82],
  },
  light: {
    bg: [248, 249, 250], surface: [255, 255, 255], primary: [76, 110, 245], onPrimary: [255, 255, 255],
    text: [33, 37, 41], muted: [134, 142, 150], stroke: [222, 226, 230], danger: [224, 49, 49],
  },
};

export const UI_DESIGN_CATALOG = {
  themes: Object.keys(THEMES),
  tokens: {
    spacing: [4, 8, 12, 16, 24, 32, 48],
    radius: { sm: 6, md: 10, lg: 16 },
    typography: {
      display: { size: 32, font: 'GothamBold' },
      heading: { size: 22, font: 'GothamBold' },
      body: { size: 16, font: 'Gotham' },
      caption: { size: 13, font: 'Gotham' },
    },
    minTextSize: 14,
    color: THEMES.dark,
  },
  components: [
    { name: 'button', description: 'Primary action.', parts: ['TextButton', 'UICorner(md)', 'UIPadding(12,8)', 'optional UIStroke'], tips: ['BackgroundColor3 = primary, TextColor3 = onPrimary', 'AutomaticSize = X for label-fit', 'set Selectable + NextSelection* for gamepad'] },
    { name: 'card', description: 'Grouped content surface.', parts: ['Frame', 'UICorner(md)', 'UIPadding(16)', 'UIListLayout(Vertical, 12)'], tips: ['BackgroundColor3 = surface', 'AutomaticSize = Y to fit children'] },
    { name: 'modal', description: 'Centered overlay dialog.', parts: ['Frame dimmer (bg, 0.5 transp)', 'Frame panel (surface, UICorner(lg), UIPadding(24))'], tips: ['AnchorPoint 0.5,0.5 + Position 0.5,0.5', 'UIAspectRatioConstraint to stay readable'] },
    { name: 'hud_meter', description: 'Health/resource bar.', parts: ['Frame track (surface)', 'Frame fill (primary, Size scale-X)', 'UICorner(sm)'], tips: ['drive fill via Size = UDim2.fromScale(pct,1)', 'use Scale not Offset so it scales'] },
    { name: 'list_row', description: 'Repeating list item.', parts: ['Frame/TextButton', 'UIListLayout on parent', 'UIPadding(12,8)'], tips: ['let the parent UIListLayout position rows; never hand-place'] },
    { name: 'nav_rail', description: 'Side navigation.', parts: ['Frame (surface)', 'UIListLayout(Vertical, 8)', 'icon TextButtons'], tips: ['Size with Scale on Y, Offset on X', 'highlight selected with primary'] },
  ],
  guidance: [
    'Use UIListLayout/UIGridLayout for any repeating or stacked content — never hand-position 4+ siblings.',
    'Prefer Scale (or UIScale/UIAspectRatioConstraint) over pure Offset so UI scales across devices.',
    'Keep text >= 14px; for dynamic/localized text use AutomaticSize + UITextSizeConstraint (MinTextSize >= 9).',
    'Use 9-slice (ScaleType.Slice + SliceCenter) for stretched decorative images so borders do not distort.',
    'Account for the topbar/safe-area inset (GuiService:GetGuiInset / IgnoreGuiInset) on full-screen UIs.',
    'Make interactive elements Selectable and wire NextSelection* for gamepad navigation.',
  ],
};

export function getDesignCatalog() {
  return UI_DESIGN_CATALOG;
}

// ─── apply_theme: standardize an existing GUI onto a theme ───────────────────

export interface ApplyThemeOptions {
  rootPath: string;
  /** Theme name (default "dark"). */
  theme?: string;
  /** Raise any text below this size (default 14). */
  minTextSize?: number;
  /** Add a UICorner where missing (default true). */
  roundCorners?: boolean;
}

function color3(rgb: [number, number, number]): string {
  return `Color3.fromRGB(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function buildApplyThemeLuau(options: ApplyThemeOptions): string {
  const themeName = options.theme && THEMES[options.theme] ? options.theme : 'dark';
  const t = THEMES[themeName];
  const minTextSize = options.minTextSize ?? 14;
  const radiusMd = UI_DESIGN_CATALOG.tokens.radius.md;
  const roundCorners = options.roundCorners !== false;

  const body = `local root = resolvePath(${luaString(options.rootPath)})
if root == nil then error("Root not found: " .. ${luaString(options.rootPath)}) end
local SURFACE = ${color3(t.surface)}
local PRIMARY = ${color3(t.primary)}
local ON_PRIMARY = ${color3(t.onPrimary)}
local TEXT = ${color3(t.text)}
local MIN_TEXT = ${minTextSize}
local ROUND = ${roundCorners ? 'true' : 'false'}
local styled = 0
local function ensureCorner(o)
\tif not ROUND then return end
\tif o:FindFirstChildWhichIsA("UICorner") == nil then
\t\tlocal c = Instance.new("UICorner")
\t\tc.CornerRadius = UDim.new(0, ${radiusMd})
\t\tc.Parent = o
\tend
end
for _, o in ipairs(root:GetDescendants()) do
\tif o:IsA("GuiButton") then
\t\to.BackgroundColor3 = PRIMARY
\t\to.BorderSizePixel = 0
\t\tif o:IsA("TextButton") then
\t\t\to.TextColor3 = ON_PRIMARY
\t\t\tif not o.TextScaled and o.TextSize < MIN_TEXT then o.TextSize = MIN_TEXT end
\t\tend
\t\tensureCorner(o)
\t\tstyled = styled + 1
\telseif o:IsA("Frame") or o:IsA("ScrollingFrame") then
\t\to.BackgroundColor3 = SURFACE
\t\to.BorderSizePixel = 0
\t\tensureCorner(o)
\t\tstyled = styled + 1
\telseif o:IsA("TextLabel") or o:IsA("TextBox") then
\t\to.TextColor3 = TEXT
\t\tif not o.TextScaled and o.TextSize < MIN_TEXT then o.TextSize = MIN_TEXT end
\t\tstyled = styled + 1
\tend
end
return { success = true, theme = ${luaString(themeName)}, styledCount = styled, rootPath = root:GetFullName() }`;
  return wrap(body);
}

// ─── design_review capture helpers ──────────────────────────────────────────
// A ScreenGui under StarterGui does not render to the editor viewport, so to
// screenshot it we temporarily reparent it to CoreGui (which renders over the
// editor), capture, then restore. Verified live: reparenting + cross-call state
// persist in the edit DM.

export function buildReviewReparentLuau(rootPath: string): string {
  const body = `local target = resolvePath(${luaString(rootPath)})
if target == nil then error("Root not found: " .. ${luaString(rootPath)}) end
if not target:IsA("LayerCollector") then error("design_review needs a ScreenGui (LayerCollector); got a " .. target.ClassName .. ". Pass the ScreenGui path.") end
local CoreGui = game:GetService("CoreGui")
local origParent = target.Parent
target:SetAttribute("__dr_origParent", origParent and origParent:GetFullName() or "StarterGui")
target.Enabled = true
target.Parent = CoreGui
task.wait()
return { newPath = target:GetFullName(), origParentPath = origParent and origParent:GetFullName() or "StarterGui", name = target.Name }`;
  return wrap(body);
}

export function buildReviewRestoreLuau(newPath: string, origParentPath: string): string {
  const body = `local target = resolvePath(${luaString(newPath)})
if target == nil then return { restored = false } end
target:SetAttribute("__dr_origParent", nil)
local origParent = resolvePath(${luaString(origParentPath)})
if origParent ~= nil then target.Parent = origParent end
return { restored = target.Parent ~= nil and target.Parent.Name == ${luaString(origParentPath.split('.').pop() ?? 'StarterGui')} }`;
  return wrap(body);
}

/** The fixed reviewer rubric. The agent's extra instruction (if any) is appended. */
export function designReviewPrompt(instruction?: string): string {
  return [
    'You are a senior Roblox UI/UX designer reviewing a screenshot of in-game UI.',
    instruction ? `Reviewer focus: ${instruction}` : '',
    'Rate the UI 1-10 on each of: visual hierarchy, spacing & density, color & contrast, alignment & consistency, and "AI slop" risk (generic/unrefined look).',
    'Then give 3-5 SPECIFIC, actionable fixes phrased in Roblox terms (UIListLayout/UIPadding, Scale vs Offset, TextSize, color tokens, 9-slice, AutomaticSize).',
    'Be concise. Format as: one line "Scores: hierarchy=x spacing=x color=x alignment=x slop=x", then a short "Fixes:" bullet list, then a one-line "Verdict:".',
  ].filter(Boolean).join(' ');
}

export interface DesignLintOptions {
  /** A specific ScreenGui/GuiObject path. Omit to scan every ScreenGui in StarterGui. */
  rootPath?: string;
  /** Minimum readable text size (default 9). */
  minTextSize?: number;
}

export function buildDesignLintLuau(options: DesignLintOptions = {}): string {
  const minTextSize = options.minTextSize ?? 9;
  const rootResolution = options.rootPath
    ? `local r = resolvePath(${luaString(options.rootPath)})
if r == nil then error("Root not found: " .. ${luaString(options.rootPath)}) end
table.insert(roots, r)`
    : `for _, sg in ipairs(StarterGui:GetChildren()) do
\tif sg:IsA("LayerCollector") or sg:IsA("GuiObject") then table.insert(roots, sg) end
end`;

  const body = `local StarterGui = game:GetService("StarterGui")
local Workspace = game:GetService("Workspace")
local camera = Workspace.CurrentCamera
local viewport = (camera and camera.ViewportSize) or Vector2.new(1280, 720)
local MIN_TEXT_SIZE = ${minTextSize}

local findings = {}
local function add(rule, severity, inst, detail)
\ttable.insert(findings, { rule = rule, severity = severity, path = inst:GetFullName(), className = inst.ClassName, detail = detail })
end

local function rectsOverlap(aPos, aSize, bPos, bSize)
\treturn aPos.X < bPos.X + bSize.X and aPos.X + aSize.X > bPos.X
\t\tand aPos.Y < bPos.Y + bSize.Y and aPos.Y + aSize.Y > bPos.Y
end

local function lintRoot(root)
\tlocal interactives = {}
\tfor _, o in ipairs(root:GetDescendants()) do
\t\tif o:IsA("GuiObject") then
\t\t\tif (o:IsA("TextLabel") or o:IsA("TextButton") or o:IsA("TextBox")) and not o.TextScaled and o.TextSize < MIN_TEXT_SIZE then
\t\t\t\tadd("tiny_text", "warn", o, string.format("TextSize %d < %d; hard to read — raise it or use TextScaled + UITextSizeConstraint", o.TextSize, MIN_TEXT_SIZE))
\t\t\tend
\t\t\tif o.Visible and o.AbsoluteSize.X > 0 and o.AbsoluteSize.Y > 0 then
\t\t\t\tlocal p, s = o.AbsolutePosition, o.AbsoluteSize
\t\t\t\tif p.X < -1 or p.Y < -1 or p.X + s.X > viewport.X + 1 or p.Y + s.Y > viewport.Y + 1 then
\t\t\t\t\tadd("offscreen", "warn", o, string.format("extends beyond the %dx%d viewport", math.floor(viewport.X), math.floor(viewport.Y)))
\t\t\t\tend
\t\t\t\tif o.Size.X.Scale == 0 and o.Size.Y.Scale == 0 and (s.X > viewport.X * 0.5 or s.Y > viewport.Y * 0.5) then
\t\t\t\t\tadd("non_responsive_size", "info", o, "large element sized in pure offset; it won't scale across devices — add Scale or a UIScale/UIAspectRatioConstraint")
\t\t\t\tend
\t\t\t\tif (o:IsA("ImageLabel") or o:IsA("ImageButton")) and o.Image ~= "" and o.ScaleType == Enum.ScaleType.Stretch and s.X > 64 and s.Y > 64 then
\t\t\t\t\tadd("stretched_image_no_slice", "info", o, "stretched image >64px without 9-slice; set ScaleType=Slice + SliceCenter so borders don't distort")
\t\t\t\tend
\t\t\t\tif o:IsA("GuiButton") then table.insert(interactives, o) end
\t\t\tend
\t\t\tlocal guiKids = 0
\t\t\tfor _, c in ipairs(o:GetChildren()) do if c:IsA("GuiObject") then guiKids += 1 end end
\t\t\tif guiKids >= 4 then
\t\t\t\tlocal hasLayout = o:FindFirstChildWhichIsA("UIListLayout") or o:FindFirstChildWhichIsA("UIGridLayout") or o:FindFirstChildWhichIsA("UITableLayout")
\t\t\t\tif not hasLayout then
\t\t\t\t\tadd("no_layout_container", "info", o, string.format("%d GUI children with no UIListLayout/UIGridLayout; manual positioning is brittle under localization/scaling", guiKids))
\t\t\t\tend
\t\t\tend
\t\tend
\tend
\tfor i = 1, #interactives do
\t\tfor j = i + 1, #interactives do
\t\t\tlocal a, b = interactives[i], interactives[j]
\t\t\tif not a:IsDescendantOf(b) and not b:IsDescendantOf(a) then
\t\t\t\tif rectsOverlap(a.AbsolutePosition, a.AbsoluteSize, b.AbsolutePosition, b.AbsoluteSize) then
\t\t\t\t\tadd("overlap_interactive", "warn", a, "overlaps another interactive element: " .. b:GetFullName())
\t\t\t\tend
\t\t\tend
\t\tend
\tend
end

local roots = {}
${rootResolution}

for _, r in ipairs(roots) do lintRoot(r) end

local score = 100
for _, f in ipairs(findings) do
\tscore = score - (f.severity == "warn" and 8 or 3)
end
if score < 0 then score = 0 end

return {
\tsuccess = true,
\tscore = score,
\tfindingCount = #findings,
\tscannedRoots = #roots,
\tviewport = { x = math.floor(viewport.X), y = math.floor(viewport.Y) },
\tfindings = findings,
\tnote = "Geometric checks use edit-mode layout; topbar/safe-area insets read 0 in edit and need a playtest to verify.",
}`;
  return wrap(body);
}
