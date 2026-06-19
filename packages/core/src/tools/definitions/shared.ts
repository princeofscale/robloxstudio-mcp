// Shared schema fragments used by generated-Luau builder and media tool schemas.
export const INSTANCE_ID_PROP = {
  type: 'string',
  description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.',
};

export const UDIM2_PROP = {
  type: 'array',
  items: { type: 'number' },
  description: 'UDim2 as [scaleX, offsetX, scaleY, offsetY].',
};

export const RGB_PROP = {
  type: 'array',
  items: { type: 'number' },
  description: 'Color as [r, g, b], each 0-255.',
};

export const VEC3_PROP = {
  type: 'array',
  items: { type: 'number' },
  description: 'World position/size as [x, y, z].',
};

export const GUI_OBJECT_PROPS: Record<string, object> = {
  parentPath: { type: 'string', description: 'Dot-notation path of the parent GUI container (e.g. "StarterGui.MainGui").' },
  name: { type: 'string', description: 'Name for the new element.' },
  size: UDIM2_PROP,
  position: UDIM2_PROP,
  anchorPoint: { type: 'array', items: { type: 'number' }, description: 'AnchorPoint as [x, y], each 0-1.' },
  backgroundColor: RGB_PROP,
  backgroundTransparency: { type: 'number', description: '0 (opaque) to 1 (invisible).' },
  text: { type: 'string', description: 'Text content (text elements only).' },
  font: { type: 'string', description: 'Enum.Font member name, e.g. "GothamBold" (text elements only).' },
  textScaled: { type: 'boolean', description: 'Auto-scale text to fit (text elements only).' },
  textColor: RGB_PROP,
  textSize: { type: 'number', description: 'Fixed text size in pixels (text elements only).' },
  image: { type: 'string', description: 'Image asset id, e.g. "rbxassetid://123" (image elements only).' },
  visible: { type: 'boolean', description: 'Initial visibility.' },
  zIndex: { type: 'number', description: 'Render order.' },
  instance_id: INSTANCE_ID_PROP,
};
