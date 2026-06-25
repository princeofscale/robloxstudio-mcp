// Token-lean tool discovery layer. The full catalog is ~120 tools; loading every
// schema upfront is the single biggest source of wasted tokens (and degrades the
// model's tool-selection accuracy past ~30-50 tools). This module groups tools
// into semantic domains and powers two meta-tools — `tool_catalog_search` (find a
// tool by task/domain without its full schema) and `load_toolset` (pull in a whole
// domain on demand). Pure functions here are unit-tested; the server wires them in.

import type { ToolDefinition } from './definitions.js';

export type ToolDomain =
  | 'core'
  | 'scene'
  | 'mutation'
  | 'scripts'
  | 'runtime'
  | 'assets'
  | 'ui'
  | 'environment'
  | 'terrain'
  | 'build'
  | 'media'
  | 'sync'
  | 'safety';

export const TOOL_DOMAINS: ToolDomain[] = [
  'core', 'scene', 'mutation', 'scripts', 'runtime',
  'assets', 'ui', 'environment', 'terrain', 'build', 'media', 'sync', 'safety',
];

// Always-on tools: the minimum an agent needs to orient and act before it has
// loaded any toolset. Kept tiny on purpose. The two meta-tools are added by the
// server, not listed here (they live outside TOOL_DEFINITIONS).
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'tool_catalog_search',
  'load_toolset',
  'get_connected_instances',
  'get_scene_summary',
  'execute_luau',
  'get_runtime_logs',
  'preview_asset',
  'insert_asset',
]);

// Exact-name overrides for tools whose domain isn't obvious from a prefix.
const DOMAIN_OVERRIDES: Record<string, ToolDomain> = {
  // safety / history
  get_operation_history: 'safety',
  list_script_backups: 'safety',
  restore_script_backup: 'safety',
  undo: 'safety',
  redo: 'safety',
  // assets / marketplace / io
  marketplace_search: 'assets',
  marketplace_search_and_insert: 'assets',
  import_rbxm: 'assets',
  export_rbxm: 'assets',
  import_scene: 'assets',
  asset_preflight_insert: 'assets',
  plan_asset_insert: 'assets',
  list_library: 'assets',
  search_materials: 'assets',
  asset_apply_texture: 'media',
  capture_screenshot: 'runtime',
  // scripts
  diagnose_scripts: 'scripts',
  grep_scripts: 'scripts',
  find_and_replace_in_scripts: 'scripts',
  get_selection: 'scene',
  // runtime
  character_navigation: 'runtime',
  simulate_mouse_input: 'runtime',
  simulate_keyboard_input: 'runtime',
  eval_server_runtime: 'runtime',
  eval_client_runtime: 'runtime',
  capture_device_matrix: 'runtime',
  capture_script_profiler: 'runtime',
  breakpoints: 'runtime',
  execute_luau_async: 'runtime',
  get_job_status: 'runtime',
  get_job_result: 'runtime',
  cancel_job: 'runtime',
  playtest_sample_state: 'runtime',
  run_gameplay_assertions: 'runtime',
  run_playtest_episode: 'runtime',
  summarize_episode: 'runtime',
  propose_next_action: 'runtime',
  get_reproduction_bundle: 'runtime',
  // scene read
  compare_instances: 'scene',
  get_memory_breakdown: 'scene',
  get_scene_analysis: 'scene',
  get_descendants: 'scene',
  get_changes_since: 'scene',
  scene_search: 'scene',
  // mutation
  clone_object: 'mutation',
  smart_duplicate: 'mutation',
  mass_duplicate: 'mutation',
  bulk_set_attributes: 'mutation',
  apply_mutation_plan: 'mutation',
  list_recipes: 'build',
  apply_recipe: 'build',
  generate_model_native: 'assets',
  asset_source_search: 'assets',
  import_external_asset: 'assets',
  get_asset_provenance: 'assets',
  design_lint: 'ui',
  design_review: 'ui',
  apply_theme: 'ui',
  ui_component_catalog: 'ui',
};

// Ordered prefix rules, applied after CORE and OVERRIDES.
const PREFIX_RULES: Array<[RegExp, ToolDomain]> = [
  [/^ui_/, 'ui'],
  [/^environment_/, 'environment'],
  [/^terrain_/, 'terrain'],
  [/^template_/, 'build'],
  [/^sync_/, 'sync'],
  [/^audio_|^animation_/, 'media'],
  [/^image_/, 'assets'],
  [/^marketplace_/, 'assets'],
  [/^multiplayer_|^start_playtest|^stop_playtest|playtest|simulation|device_simulator|network_profile/, 'runtime'],
  [/^get_asset|^search_assets|^upload_asset|asset_thumbnail/, 'assets'],
  [/script_source|script_lines|^get_script|^set_script|^edit_script|^insert_script|^delete_script/, 'scripts'],
  [/^export_build|^create_build|^generate_build|^import_build|^get_build/, 'build'],
  [/^set_attribute|^get_attributes|^delete_attribute|_tag$|^get_tags|^add_tag|^remove_tag|^get_tagged/, 'mutation'],
  [/^set_propert|^mass_set|^mass_get|^create_object|^mass_create|^delete_object/, 'mutation'],
  [/^get_|^search_|^compare_/, 'scene'],
];

/** Classify a tool name into a semantic domain. Every known tool maps to a domain. */
export function classifyDomain(name: string): ToolDomain {
  if (CORE_TOOLS.has(name)) return 'core';
  if (DOMAIN_OVERRIDES[name]) return DOMAIN_OVERRIDES[name];
  for (const [re, domain] of PREFIX_RULES) {
    if (re.test(name)) return domain;
  }
  // Conservative default: anything unmatched is a scene-level read/utility.
  return 'scene';
}

export interface CatalogEntry {
  name: string;
  domain: ToolDomain;
  mode: 'read' | 'write';
  /** One-line "when to use", derived from the tool description. */
  whenToUse: string;
  requiredArgs: string[];
}

/** First sentence of a description, trimmed to keep the catalog token-lean. */
function firstSentence(desc: string, max = 120): string {
  const text = String(desc ?? '').trim();
  const dot = text.indexOf('. ');
  const head = dot > 0 ? text.slice(0, dot) : text;
  return head.length > max ? head.slice(0, max - 1).trimEnd() + '…' : head;
}

/** Build the searchable catalog from the full tool definitions. */
export function buildCatalog(defs: ToolDefinition[]): CatalogEntry[] {
  return defs.map((d) => ({
    name: d.name,
    domain: classifyDomain(d.name),
    mode: d.category === 'write' ? 'write' : 'read',
    whenToUse: firstSentence(d.description),
    requiredArgs: Array.isArray((d.inputSchema as any)?.required)
      ? ((d.inputSchema as any).required as string[])
      : [],
  }));
}

export interface CatalogSearchParams {
  query: string;
  domains?: ToolDomain[];
  readOnly?: boolean;
  limit?: number;
}

/**
 * Rank catalog entries against a free-text task query. Scores name and
 * whenToUse matches, biases toward the requested domains, and returns a short,
 * compact list so an agent can pick a tool (then load_toolset to get its schema).
 */
export function searchCatalog(catalog: CatalogEntry[], params: CatalogSearchParams): CatalogEntry[] {
  const q = String(params.query ?? '').trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const domainSet = params.domains && params.domains.length ? new Set(params.domains) : undefined;
  const limit = Math.max(1, Math.min(20, Math.floor(params.limit ?? 8)));

  const score = (e: CatalogEntry): number => {
    if (domainSet && !domainSet.has(e.domain)) return -1;
    if (params.readOnly === true && e.mode !== 'read') return -1;
    const name = e.name.toLowerCase();
    const haystack = `${name} ${e.domain} ${e.whenToUse.toLowerCase()}`;
    if (!q) return 0;
    let s = 0;
    if (name === q) s += 100;
    if (name.includes(q)) s += 30;
    for (const w of words) {
      if (name.includes(w)) s += 10;
      else if (haystack.includes(w)) s += 4;
    }
    return s;
  };

  return catalog
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s >= 0 && (q === '' || x.s > 0))
    .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map((x) => x.e);
}

export interface ToolsetRecommendation {
  domain: ToolDomain;
  recommendedTools: string[];
  load: { tool: 'load_toolset'; args: { toolsets: ToolDomain[] } };
}

/**
 * Build a machine-readable "what to load next" recommendation from search matches,
 * so an agent (or a lazy-loading client) knows to call load_toolset rather than
 * having to guess. Groups matched tools by domain, most-matched first.
 */
export function recommendToolsets(matches: CatalogEntry[]): ToolsetRecommendation[] {
  const byDomain = new Map<ToolDomain, string[]>();
  for (const m of matches) {
    if (m.domain === 'core') continue; // core is always loaded
    const list = byDomain.get(m.domain) ?? [];
    list.push(m.name);
    byDomain.set(m.domain, list);
  }
  return Array.from(byDomain.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, recommendedTools]) => ({
      domain,
      recommendedTools,
      load: { tool: 'load_toolset' as const, args: { toolsets: [domain] } },
    }));
}

/**
 * Resolve a list of requested toolset selectors (domain names, or `domain.suffix`
 * shorthands like `scene.inspect`) into the set of tool names to expose. Unknown
 * selectors are ignored. Core tools are always included.
 */
export function expandToolsets(catalog: CatalogEntry[], selectors: string[]): Set<string> {
  const wanted = new Set<string>(CORE_TOOLS);
  const requestedDomains = new Set<ToolDomain>();
  for (const raw of selectors ?? []) {
    const head = String(raw ?? '').split('.')[0].trim() as ToolDomain;
    if (TOOL_DOMAINS.includes(head)) requestedDomains.add(head);
  }
  for (const e of catalog) {
    if (requestedDomains.has(e.domain)) wanted.add(e.name);
  }
  return wanted;
}
