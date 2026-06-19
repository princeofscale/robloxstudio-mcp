import {
  buildScreenGuiLuau,
  buildGuiObjectLuau,
  buildApplyLayoutLuau,
  buildMobileFriendlyLuau,
  type GuiObjectClass,
  type ScreenGuiOptions,
  type GuiObjectOptions,
  type LayoutOptions,
} from '../builders/ui-builders.js';
import {
  buildSetTimeOfDayLuau,
  buildLightingPresetLuau,
  buildAtmosphereLuau,
  buildSkyLuau,
  buildDayNightCycleScriptLuau,
  type AtmospherePreset,
  type SkyOptions,
  type DayNightCycleOptions,
} from '../builders/environment-builders.js';
import {
  buildBaseplateLuau,
  buildIslandLuau,
  buildMountainsLuau,
  buildWaterLuau,
  buildPaintMaterialLuau,
  buildClearRegionLuau,
  boxVolume,
  regionVolume,
  type BaseplateOptions,
  type IslandOptions,
  type MountainsOptions,
  type WaterOptions,
  type PaintMaterialOptions,
  type ClearRegionOptions,
} from '../builders/terrain-builders.js';
import {
  buildObbyTemplateLuau,
  buildSimulatorTemplateLuau,
  buildTycoonTemplateLuau,
  buildRoundTemplateLuau,
  type ObbyTemplateOptions,
  type SimulatorTemplateOptions,
  type TycoonTemplateOptions,
  type RoundTemplateOptions,
} from '../builders/template-builders.js';
import type { OperationKind } from '../safety/safety-manager.js';
import { errorMessage, type SafetyOptions, type ToolContent } from './runtime-support.js';

type GeneratedToolRuntime = {
  runGeneratedLuau(code: string, instance_id?: string): Promise<{ content: ToolContent[] }>;
  safetyGate(
    kind: OperationKind,
    detail: string,
    input: { path?: string; count?: number; scriptSize?: number; code?: string },
    options?: SafetyOptions,
  ): { content: ToolContent[] } | null;
  recordOperation(kind: string, summary: string): void;
};

export class GeneratedBuilderTools {
  constructor(private readonly runtime: GeneratedToolRuntime) {}

  // --- UI builder tools ---

  async uiCreateScreenGui(options: ScreenGuiOptions, instance_id?: string) {
    if (!options?.name) throw new Error('name is required for ui_create_screen_gui');
    const result = await this.runtime.runGeneratedLuau(buildScreenGuiLuau(options), instance_id);
    this.runtime.recordOperation('ui_create', `ScreenGui ${options.name}`);
    return result;
  }

  private async _uiCreate(className: GuiObjectClass, options: GuiObjectOptions, instance_id?: string) {
    if (!options?.parentPath) throw new Error(`parentPath is required for ui_create_${className.toLowerCase()}`);
    const result = await this.runtime.runGeneratedLuau(buildGuiObjectLuau(className, options), instance_id);
    this.runtime.recordOperation('ui_create', `${className} under ${options.parentPath}`);
    return result;
  }

  async uiCreateFrame(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('Frame', options, instance_id); }
  async uiCreateTextLabel(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('TextLabel', options, instance_id); }
  async uiCreateTextButton(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('TextButton', options, instance_id); }
  async uiCreateImageLabel(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('ImageLabel', options, instance_id); }
  async uiCreateImageButton(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('ImageButton', options, instance_id); }

  async uiApplyLayout(options: LayoutOptions & { targetPath: string }, instance_id?: string) {
    if (!options?.targetPath) throw new Error('targetPath is required for ui_apply_layout');
    return this.runtime.runGeneratedLuau(buildApplyLayoutLuau(options.targetPath, options), instance_id);
  }

  async uiMakeMobileFriendly(targetPath: string, instance_id?: string) {
    if (!targetPath) throw new Error('targetPath is required for ui_make_mobile_friendly');
    return this.runtime.runGeneratedLuau(buildMobileFriendlyLuau(targetPath), instance_id);
  }

  // --- Environment tools ---

  async environmentSetTimeOfDay(time: number | string, instance_id?: string) {
    if (time === undefined || time === null) throw new Error('time is required for environment_set_time_of_day');
    return this.runtime.runGeneratedLuau(buildSetTimeOfDayLuau(time), instance_id);
  }

  async environmentSetLightingPreset(preset: string, withPostFx?: boolean, instance_id?: string) {
    // buildLightingPresetLuau throws on an unknown preset; surface that as a
    // clean tool result instead of a transport error.
    let code: string;
    try {
      code = buildLightingPresetLuau(preset, withPostFx ?? false);
    } catch (error) {
      return { content: [{ type: 'text', text: errorMessage(error) }] as ToolContent[] };
    }
    const result = await this.runtime.runGeneratedLuau(code, instance_id);
    this.runtime.recordOperation('environment', `lighting preset ${preset}${withPostFx ? ' +postFx' : ''}`);
    return result;
  }

  async environmentSetAtmosphere(options: AtmospherePreset, instance_id?: string) {
    return this.runtime.runGeneratedLuau(buildAtmosphereLuau(options ?? {}), instance_id);
  }

  async environmentSetSky(options: SkyOptions, instance_id?: string) {
    return this.runtime.runGeneratedLuau(buildSkyLuau(options ?? {}), instance_id);
  }

  async environmentCreateDayNightCycleScript(options: DayNightCycleOptions, instance_id?: string) {
    const result = await this.runtime.runGeneratedLuau(buildDayNightCycleScriptLuau(options ?? {}), instance_id);
    this.runtime.recordOperation('environment', `day-night cycle script (${options?.minutesPerDay ?? 10} min/day)`);
    return result;
  }

  // --- Terrain tools ---

  private _terrainGate(volume: number, detail: string, options?: SafetyOptions): { content: ToolContent[] } | null {
    return this.runtime.safetyGate('terrain_fill', `${detail} (~${Math.round(volume)} studs³)`, { count: volume }, options);
  }

  async terrainGenerateBaseplate(options: BaseplateOptions & SafetyOptions, instance_id?: string) {
    if (!options?.size) throw new Error('size is required for terrain_generate_baseplate');
    const gated = this._terrainGate(boxVolume(options.size), 'baseplate', options);
    if (gated) return gated;
    const result = await this.runtime.runGeneratedLuau(buildBaseplateLuau(options), instance_id);
    this.runtime.recordOperation('terrain', `baseplate ${options.size.join('x')}`);
    return result;
  }

  async terrainGenerateIsland(options: IslandOptions & SafetyOptions, instance_id?: string) {
    if (!options?.radius) throw new Error('radius is required for terrain_generate_island');
    const volume = (4 / 3) * Math.PI * Math.pow(options.radius, 3);
    const gated = this._terrainGate(volume, 'island', options);
    if (gated) return gated;
    const result = await this.runtime.runGeneratedLuau(buildIslandLuau(options), instance_id);
    this.runtime.recordOperation('terrain', `island r=${options.radius}`);
    return result;
  }

  async terrainGenerateMountains(options: MountainsOptions & SafetyOptions, instance_id?: string) {
    if (!options?.extent || options.maxHeight === undefined) throw new Error('extent and maxHeight are required for terrain_generate_mountains');
    const volume = Math.abs(options.extent[0]) * Math.abs(options.extent[1]) * Math.abs(options.maxHeight);
    const gated = this._terrainGate(volume, 'mountains', options);
    if (gated) return gated;
    const result = await this.runtime.runGeneratedLuau(buildMountainsLuau(options), instance_id);
    this.runtime.recordOperation('terrain', `mountains ${options.extent.join('x')}`);
    return result;
  }

  async terrainGenerateWater(options: WaterOptions & SafetyOptions, instance_id?: string) {
    if (!options?.size) throw new Error('size is required for terrain_generate_water');
    const gated = this._terrainGate(boxVolume(options.size), 'water', options);
    if (gated) return gated;
    const result = await this.runtime.runGeneratedLuau(buildWaterLuau(options), instance_id);
    this.runtime.recordOperation('terrain', `water ${options.size.join('x')}`);
    return result;
  }

  async terrainPaintMaterial(options: PaintMaterialOptions & SafetyOptions, instance_id?: string) {
    if (!options?.min || !options?.max || !options?.material) throw new Error('min, max, and material are required for terrain_paint_material');
    const gated = this._terrainGate(regionVolume(options.min, options.max), `paint ${options.material}`, options);
    if (gated) return gated;
    const result = await this.runtime.runGeneratedLuau(buildPaintMaterialLuau(options), instance_id);
    this.runtime.recordOperation('terrain', `paint ${options.material}`);
    return result;
  }

  async terrainClearRegion(options: ClearRegionOptions & SafetyOptions, instance_id?: string) {
    if (!options?.min || !options?.max) throw new Error('min and max are required for terrain_clear_region');
    const gated = this.runtime.safetyGate('terrain_clear', `clear region (~${Math.round(regionVolume(options.min, options.max))} studs³)`, { count: regionVolume(options.min, options.max) }, options);
    if (gated) return gated;
    const result = await this.runtime.runGeneratedLuau(buildClearRegionLuau(options), instance_id);
    this.runtime.recordOperation('terrain', `cleared region`);
    return result;
  }

  // --- Game-template tools ---
  // Each scaffolds a complete starter game (geometry, services, leaderstats,
  // gameplay scripts). Generation is idempotent, so re-running refreshes the
  // template in place rather than duplicating it.

  async templateCreateObbyGame(options: ObbyTemplateOptions, instance_id?: string) {
    const result = await this.runtime.runGeneratedLuau(buildObbyTemplateLuau(options ?? {}), instance_id);
    this.runtime.recordOperation('template', `obby game (${options?.checkpoints ?? 5} checkpoints)`);
    return result;
  }

  async templateCreateSimulatorGame(options: SimulatorTemplateOptions, instance_id?: string) {
    const result = await this.runtime.runGeneratedLuau(buildSimulatorTemplateLuau(options ?? {}), instance_id);
    this.runtime.recordOperation('template', `simulator game (${options?.currencyName ?? 'Coins'})`);
    return result;
  }

  async templateCreateTycoonGame(options: TycoonTemplateOptions, instance_id?: string) {
    const result = await this.runtime.runGeneratedLuau(buildTycoonTemplateLuau(options ?? {}), instance_id);
    this.runtime.recordOperation('template', `tycoon game`);
    return result;
  }

  async templateCreateRoundGame(options: RoundTemplateOptions, instance_id?: string) {
    const result = await this.runtime.runGeneratedLuau(buildRoundTemplateLuau(options ?? {}), instance_id);
    this.runtime.recordOperation('template', `round game (${options?.roundSeconds ?? 90}s)`);
    return result;
  }
}
