// Response-shaping for token efficiency. Read tools can return long lists
// (get_descendants, search_objects) where the agent often needs only the first N
// items and a couple of fields. paginateList + pickFields let those tools cap and
// project results server-side, so the context window isn't flooded with a 10k-line
// dump. Both are pure and composed by shapeListResponse, which leaves error
// responses and unshaped calls untouched.

export interface PageOptions {
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  returned: number;
  hasMore: boolean;
}

export function paginateList<T>(items: T[], opts: PageOptions): Page<T> {
  const total = items.length;
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const end = opts.limit !== undefined ? offset + Math.max(0, Math.floor(opts.limit)) : total;
  const page = items.slice(offset, end);
  return {
    items: page,
    total,
    offset,
    returned: page.length,
    hasMore: offset + page.length < total,
  };
}

export function pickFields<T extends Record<string, unknown>>(item: T, fields?: string[]): T | Partial<T> {
  if (!fields || fields.length === 0) return item;
  const out: Partial<T> = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(item, f)) {
      out[f as keyof T] = item[f as keyof T];
    }
  }
  return out;
}

export interface ShapeOptions extends PageOptions {
  fields?: string[];
}

/**
 * Shape the array under `listKey` of a plugin response: paginate, project fields,
 * and attach a `pagination` block. Returns the original object unchanged for error
 * responses, missing lists, or when no shaping options are supplied.
 */
export function shapeListResponse(
  response: unknown,
  listKey: string,
  opts: ShapeOptions,
): any {
  if (!response || typeof response !== 'object') return response;
  const r = response as Record<string, unknown>;
  if (typeof r.error === 'string') return response;
  const list = r[listKey];
  if (!Array.isArray(list)) return response;

  const wantsPage = opts.limit !== undefined || opts.offset !== undefined;
  const wantsFields = !!opts.fields && opts.fields.length > 0;
  if (!wantsPage && !wantsFields) return response;

  const page = paginateList(list as Array<Record<string, unknown>>, opts);
  const items = wantsFields ? page.items.map((it) => pickFields(it, opts.fields)) : page.items;

  return {
    ...r,
    [listKey]: items,
    pagination: { total: page.total, offset: page.offset, returned: page.returned, hasMore: page.hasMore },
  };
}
