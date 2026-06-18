// Generators that turn UI tool parameters into small, self-contained Luau
// snippets executed in the Studio plugin's edit context. Each snippet resolves
// its parent, creates the instance, sets typed properties (UDim2/Color3/etc.),
// and returns a summary table { path, className, success }.

import {
  luaString,
  luaNumber,
  luaBool,
  color3FromRGB,
  udim2,
  vector2,
  PATH_RESOLVER_LUA,
} from './luau-emit.js';

const TEXT_CLASSES = new Set(['TextLabel', 'TextButton', 'TextBox']);
const IMAGE_CLASSES = new Set(['ImageLabel', 'ImageButton']);

export type GuiObjectClass =
  | 'Frame'
  | 'TextLabel'
  | 'TextButton'
  | 'TextBox'
  | 'ImageLabel'
  | 'ImageButton';

export interface ScreenGuiOptions {
  name: string;
  parentPath?: string;
  ignoreGuiInset?: boolean;
  resetOnSpawn?: boolean;
  displayOrder?: number;
}

export interface GuiObjectOptions {
  parentPath: string;
  name?: string;
  size?: [number, number, number, number];
  position?: [number, number, number, number];
  anchorPoint?: [number, number];
  backgroundColor?: [number, number, number];
  backgroundTransparency?: number;
  text?: string;
  font?: string;
  textScaled?: boolean;
  textColor?: [number, number, number];
  textSize?: number;
  image?: string;
  visible?: boolean;
  zIndex?: number;
}

export interface LayoutOptions {
  layout: 'list' | 'grid';
  fillDirection?: string;
  padding?: number;
  cellSize?: [number, number, number, number];
  horizontalAlignment?: string;
  verticalAlignment?: string;
  sortOrder?: string;
}

function wrap(body: string): string {
  return `${PATH_RESOLVER_LUA}\n${body}`;
}

/** Sanitize an enum member name to a bare identifier (defends generated code). */
function enumName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '');
}

export function buildScreenGuiLuau(options: ScreenGuiOptions): string {
  const parentPath = options.parentPath ?? 'StarterGui';
  const lines: string[] = [
    `local parent = resolvePath(${luaString(parentPath)}) or game:GetService("StarterGui")`,
    `local obj = Instance.new("ScreenGui")`,
    `obj.Name = ${luaString(options.name)}`,
  ];
  if (options.ignoreGuiInset !== undefined) lines.push(`obj.IgnoreGuiInset = ${luaBool(options.ignoreGuiInset)}`);
  if (options.resetOnSpawn !== undefined) lines.push(`obj.ResetOnSpawn = ${luaBool(options.resetOnSpawn)}`);
  if (options.displayOrder !== undefined) lines.push(`obj.DisplayOrder = ${luaNumber(options.displayOrder)}`);
  lines.push(`obj.Parent = parent`);
  lines.push(`return { path = obj:GetFullName(), className = "ScreenGui", success = true }`);
  return wrap(lines.join('\n'));
}

export function buildGuiObjectLuau(className: GuiObjectClass, options: GuiObjectOptions): string {
  const lines: string[] = [
    `local parent = resolvePath(${luaString(options.parentPath)})`,
    `if parent == nil then error("Parent not found: " .. ${luaString(options.parentPath)}) end`,
    `local obj = Instance.new(${luaString(className)})`,
  ];
  if (options.name !== undefined) lines.push(`obj.Name = ${luaString(options.name)}`);
  if (options.size) lines.push(`obj.Size = ${udim2(...options.size)}`);
  if (options.position) lines.push(`obj.Position = ${udim2(...options.position)}`);
  if (options.anchorPoint) lines.push(`obj.AnchorPoint = ${vector2(...options.anchorPoint)}`);
  if (options.backgroundColor) lines.push(`obj.BackgroundColor3 = ${color3FromRGB(...options.backgroundColor)}`);
  if (options.backgroundTransparency !== undefined) lines.push(`obj.BackgroundTransparency = ${luaNumber(options.backgroundTransparency)}`);
  if (options.visible !== undefined) lines.push(`obj.Visible = ${luaBool(options.visible)}`);
  if (options.zIndex !== undefined) lines.push(`obj.ZIndex = ${luaNumber(options.zIndex)}`);

  if (TEXT_CLASSES.has(className)) {
    if (options.text !== undefined) lines.push(`obj.Text = ${luaString(options.text)}`);
    if (options.font !== undefined) lines.push(`obj.Font = Enum.Font.${enumName(options.font)}`);
    if (options.textScaled !== undefined) lines.push(`obj.TextScaled = ${luaBool(options.textScaled)}`);
    if (options.textColor) lines.push(`obj.TextColor3 = ${color3FromRGB(...options.textColor)}`);
    if (options.textSize !== undefined) lines.push(`obj.TextSize = ${luaNumber(options.textSize)}`);
  }
  if (IMAGE_CLASSES.has(className) && options.image !== undefined) {
    lines.push(`obj.Image = ${luaString(options.image)}`);
  }

  lines.push(`obj.Parent = parent`);
  lines.push(`return { path = obj:GetFullName(), className = ${luaString(className)}, success = true }`);
  return wrap(lines.join('\n'));
}

export function buildApplyLayoutLuau(targetPath: string, options: LayoutOptions): string {
  const lines: string[] = [
    `local target = resolvePath(${luaString(targetPath)})`,
    `if target == nil then error("Target not found: " .. ${luaString(targetPath)}) end`,
  ];
  if (options.layout === 'grid') {
    lines.push(`local layout = Instance.new("UIGridLayout")`);
    if (options.cellSize) lines.push(`layout.CellSize = ${udim2(...options.cellSize)}`);
    if (options.padding !== undefined) lines.push(`layout.CellPadding = UDim2.new(0, ${luaNumber(options.padding)}, 0, ${luaNumber(options.padding)})`);
  } else {
    lines.push(`local layout = Instance.new("UIListLayout")`);
    if (options.fillDirection) lines.push(`layout.FillDirection = Enum.FillDirection.${enumName(options.fillDirection)}`);
    if (options.padding !== undefined) lines.push(`layout.Padding = UDim.new(0, ${luaNumber(options.padding)})`);
  }
  if (options.horizontalAlignment) lines.push(`layout.HorizontalAlignment = Enum.HorizontalAlignment.${enumName(options.horizontalAlignment)}`);
  if (options.verticalAlignment) lines.push(`layout.VerticalAlignment = Enum.VerticalAlignment.${enumName(options.verticalAlignment)}`);
  lines.push(`layout.SortOrder = Enum.SortOrder.${enumName(options.sortOrder ?? 'LayoutOrder')}`);
  lines.push(`layout.Parent = target`);
  lines.push(`return { path = layout:GetFullName(), className = layout.ClassName, success = true }`);
  return wrap(lines.join('\n'));
}

export function buildMobileFriendlyLuau(targetPath: string): string {
  // Adds responsive safeguards to every GuiObject under the target: a UIScale
  // for global scaling, and TextScaled on text elements so labels reflow on
  // small screens. Idempotent — it reuses an existing UIScale if present.
  const body = `local target = resolvePath(${luaString(targetPath)})
if target == nil then error("Target not found: " .. ${luaString(targetPath)}) end
local touched = 0
local function ensureScale(gui)
\tif not gui:FindFirstChildOfClass("UIScale") then
\t\tlocal scale = Instance.new("UIScale")
\t\tscale.Scale = 1
\t\tscale.Parent = gui
\tend
end
local descendants = target:GetDescendants()
table.insert(descendants, target)
for _, child in ipairs(descendants) do
\tif child:IsA("GuiObject") then
\t\tensureScale(child)
\t\ttouched += 1
\tend
\tif child:IsA("TextLabel") or child:IsA("TextButton") or child:IsA("TextBox") then
\t\tchild.TextScaled = true
\tend
end
return { path = target:GetFullName(), guiObjectsUpdated = touched, success = true }`;
  return wrap(body);
}
