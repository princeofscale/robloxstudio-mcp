import { StudioHttpClient } from './studio-client.js';
import { BridgeService, RoutingFailure } from '../bridge-service.js';
import { runBuildExecutor } from './build-executor.js';
import { OpenCloudClient } from '../opencloud-client.js';
import { RobloxCookieClient } from '../roblox-cookie-client.js';
import { rgbaToJpeg } from '../jpeg-encoder.js';
import { rgbaToPng } from '../png-encoder.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type RawImageCaptureResponse = {
  success?: boolean;
  error?: string;
  width?: number;
  height?: number;
  data?: string;
  instancePath?: string;
  instanceName?: string;
  cameraPreset?: string;
};

// Encodes the raw RGBA capture into the requested image format.
// - 'png': lossless — sharpest text/UI, but a busy 3D scene can be large.
// - 'jpeg': default; quality 92 with 4:4:4 chroma (no subsampling) keeps text
//   crisp at ~1/3 the size. The image rides back inline as an MCP tool result,
//   so JPEG is the safe default for staying under client result-size caps.
function encodeImageFromRgbaResponse(
  response: RawImageCaptureResponse,
  format: 'jpeg' | 'png',
  quality: number,
): { buffer: Buffer; mimeType: string } {
  if (!response.data || response.width === undefined || response.height === undefined) {
    throw new Error('Render response missing data, width, or height');
  }
  const rgbaBuffer = Buffer.from(response.data, 'base64');
  if (format === 'png') {
    return { buffer: rgbaToPng(rgbaBuffer, response.width, response.height), mimeType: 'image/png' };
  }
  return {
    buffer: rgbaToJpeg(rgbaBuffer, response.width, response.height, quality),
    mimeType: 'image/jpeg',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RobloxStudioTools {
  private client: StudioHttpClient;
  private bridge: BridgeService;
  private openCloudClient: OpenCloudClient;
  private cookieClient: RobloxCookieClient;

  constructor(bridge: BridgeService) {
    this.client = new StudioHttpClient(bridge);
    this.bridge = bridge;
    this.openCloudClient = new OpenCloudClient();
    this.cookieClient = new RobloxCookieClient();
  }

  // Resolve (instance_id, target-role) → concrete (instanceId, role) and
  // dispatch a single request. Throws RoutingFailure if the resolution is
  // ambiguous, missing, or asks for fanout on a non-fanout-capable tool —
  // the MCP transport layer surfaces it as a structured error result so
  // the LLM can recover via the embedded data.instances list.
  private async _callSingle(
    endpoint: string,
    data: any,
    target: string | undefined,
    instance_id: string | undefined,
  ): Promise<any> {
    // Pass target through as-is so resolveTarget can tell "caller didn't
    // specify" (target=undefined → multiple_instances_connected) apart
    // from "caller picked edit explicitly" (target='edit' → ambiguous_target).
    // Tools that intrinsically need a specific role pass it as a string
    // literal here; tools without a target arg pass undefined.
    const r = this.bridge.resolveTarget({ instance_id, target });
    if (!r.ok) throw new RoutingFailure(r.error);
    if (r.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    return this.client.request(endpoint, data, r.targetInstanceId, r.targetRole);
  }

  // Resolves which connected place a tool should target and whether a playtest
  // CLIENT peer is present on it. Used by capture/input to auto-route to the
  // running client (where the live viewport + input pipeline are) without the
  // caller having to pass target. Throws RoutingFailure with the standard
  // instance list if the place is ambiguous (multiple connected, no instance_id).
  private _resolveRuntime(instance_id?: string): { instanceId: string; clientRole?: string } {
    const r = this.bridge.resolveTarget({ instance_id, target: undefined });
    if (!r.ok) throw new RoutingFailure(r.error);
    // resolveTarget(target=undefined) prefers the edit role and always returns
    // a single target, so targetInstanceId is the resolved place.
    const resolvedId = (r as { targetInstanceId: string }).targetInstanceId;
    const roles = this.bridge
      .getInstances()
      .filter((i) => i.instanceId === resolvedId)
      .map((i) => i.role);
    // Prefer client-1 when several clients are connected (multi-client playtest).
    const clientRoles = roles.filter((role) => role.startsWith('client')).sort();
    return { instanceId: resolvedId, clientRole: clientRoles[0] };
  }

  private _resolveInstanceIdOnly(instance_id?: string): string {
    const instances = this.bridge.getInstances();
    const publicList = this.bridge.getPublicInstances();
    const errorData = { instances: publicList, count: publicList.length };

    if (instance_id !== undefined) {
      if (!instances.some((i) => i.instanceId === instance_id)) {
        throw new RoutingFailure({
          code: 'unrecognized_instance_id',
          message: `instance_id "${instance_id}" is not connected. Pass one from data.instances.`,
          data: errorData,
        });
      }
      return instance_id;
    }

    const distinct = Array.from(new Set(instances.map((i) => i.instanceId)));
    if (distinct.length === 0) {
      throw new RoutingFailure({
        code: 'unrecognized_instance_id',
        message: 'No Studio plugin is connected.',
        data: errorData,
      });
    }
    if (distinct.length > 1) {
      throw new RoutingFailure({
        code: 'multiple_instances_connected',
        message: 'Multiple Studio places are connected. Pass instance_id to disambiguate.',
        data: errorData,
      });
    }
    return distinct[0];
  }

  private _resolveSingleTarget(target: string, instance_id?: string): { instanceId: string; role: string } {
    const resolved = this.bridge.resolveTarget({ instance_id, target });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'Pick a specific target role for this tool.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    return { instanceId: resolved.targetInstanceId, role: resolved.targetRole };
  }

  private _rolesForInstance(instanceId: string): string[] {
    return this.bridge.getInstances()
      .filter((i) => i.instanceId === instanceId)
      .map((i) => i.role);
  }

  private _clientRolesForInstance(instanceId: string): string[] {
    return this._rolesForInstance(instanceId)
      .filter((role) => /^client-\d+$/.test(role))
      .sort((a, b) => Number(a.slice('client-'.length)) - Number(b.slice('client-'.length)));
  }

  private async _waitForRuntimeRoles(
    instanceId: string,
    opts: { server?: boolean; clientCount?: number; absentRole?: string; noRuntime?: boolean },
    timeoutSec = 30,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const roles = this._rolesForInstance(instanceId);
      const hasServer = !opts.server || roles.includes('server');
      const hasClients = opts.clientCount === undefined || this._clientRolesForInstance(instanceId).length >= opts.clientCount;
      const absent = opts.absentRole === undefined || !roles.includes(opts.absentRole);
      const runtimeAbsent = !opts.noRuntime || !roles.some((role) => role === 'server' || /^client-\d+$/.test(role));
      if (hasServer && hasClients && absent && runtimeAbsent) {
        return { ok: true, roles, timedOut: false };
      }
      await sleep(250);
    }
    return { ok: false, roles: this._rolesForInstance(instanceId), timedOut: true };
  }

  private async _waitForExactClientCount(
    instanceId: string,
    expectedClientCount: number,
    timeoutSec = 30,
    stableMs = 3000,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean; extraClients: boolean; clientCount: number }> {
    const deadline = Date.now() + timeoutSec * 1000;
    let exactSince: number | undefined;

    while (Date.now() < deadline) {
      const roles = this._rolesForInstance(instanceId);
      const clientCount = this._clientRolesForInstance(instanceId).length;
      if (clientCount > expectedClientCount) {
        return { ok: false, roles, timedOut: false, extraClients: true, clientCount };
      }
      if (roles.includes('server') && clientCount === expectedClientCount) {
        exactSince ??= Date.now();
        if (Date.now() - exactSince >= stableMs) {
          return { ok: true, roles, timedOut: false, extraClients: false, clientCount };
        }
      } else {
        exactSince = undefined;
      }
      await sleep(250);
    }

    const roles = this._rolesForInstance(instanceId);
    const clientCount = this._clientRolesForInstance(instanceId).length;
    return { ok: false, roles, timedOut: true, extraClients: clientCount > expectedClientCount, clientCount };
  }

  private async _waitForRuntimeRolesFresh(
    instanceId: string,
    connectedAfter: number,
    requiredRoles: string[],
    timeoutSec = 60,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const instances = this.bridge.getInstances().filter((i) => i.instanceId === instanceId);
      const roles = instances.map((i) => i.role);
      const freshRoles = new Set(
        instances
          .filter((i) => i.connectedAt >= connectedAfter)
          .map((i) => i.role),
      );
      if (requiredRoles.every((role) => freshRoles.has(role))) {
        return { ok: true, roles, timedOut: false };
      }
      await sleep(250);
    }
    return { ok: false, roles: this._rolesForInstance(instanceId), timedOut: true };
  }


  async getFileTree(path: string = '', instance_id?: string) {
    const response = await this._callSingle('/api/file-tree', { path }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async searchFiles(query: string, searchType: string = 'name', instance_id?: string) {
    const response = await this._callSingle('/api/search-files', { query, searchType }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getPlaceInfo(instance_id?: string) {
    const response = await this._callSingle('/api/place-info', {}, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getServices(serviceName?: string, instance_id?: string) {
    const response = await this._callSingle('/api/services', { serviceName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async searchObjects(query: string, searchType: string = 'name', propertyName?: string, instance_id?: string) {
    const response = await this._callSingle('/api/search-objects', {
      query,
      searchType,
      propertyName
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getInstanceProperties(instancePath: string, excludeSource?: boolean, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_instance_properties');
    }
    const response = await this._callSingle('/api/instance-properties', { instancePath, excludeSource }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getInstanceChildren(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_instance_children');
    }
    const response = await this._callSingle('/api/instance-children', { instancePath }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async searchByProperty(propertyName: string, propertyValue: string, instance_id?: string) {
    if (!propertyName || !propertyValue) {
      throw new Error('Property name and value are required for search_by_property');
    }
    const response = await this._callSingle('/api/search-by-property', {
      propertyName,
      propertyValue
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getClassInfo(className: string, instance_id?: string) {
    if (!className) {
      throw new Error('Class name is required for get_class_info');
    }
    const response = await this._callSingle('/api/class-info', { className }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getProjectStructure(path?: string, maxDepth?: number, scriptsOnly?: boolean, instance_id?: string) {
    const response = await this._callSingle('/api/project-structure', {
      path,
      maxDepth,
      scriptsOnly
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }



  async setProperty(instancePath: string, propertyName: string, propertyValue: any, instance_id?: string) {
    if (!instancePath || !propertyName) {
      throw new Error('Instance path and property name are required for set_property');
    }
    const response = await this._callSingle('/api/set-property', {
      instancePath,
      propertyName,
      propertyValue
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async setProperties(instancePath: string, properties: Record<string, any>, instance_id?: string) {
    if (!instancePath || !properties) {
      throw new Error('instancePath and properties are required for set_properties');
    }
    const response = await this._callSingle('/api/set-properties', { instancePath, properties }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async massSetProperty(paths: string[], propertyName: string, propertyValue: any, instance_id?: string) {
    if (!paths || paths.length === 0 || !propertyName) {
      throw new Error('Paths array and property name are required for mass_set_property');
    }
    const response = await this._callSingle('/api/mass-set-property', {
      paths,
      propertyName,
      propertyValue
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async massGetProperty(paths: string[], propertyName: string, instance_id?: string) {
    if (!paths || paths.length === 0 || !propertyName) {
      throw new Error('Paths array and property name are required for mass_get_property');
    }
    const response = await this._callSingle('/api/mass-get-property', {
      paths,
      propertyName
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async createObject(className: string, parent: string, name?: string, properties?: Record<string, any>, instance_id?: string) {
    if (!className || !parent) {
      throw new Error('Class name and parent are required for create_object');
    }
    const response = await this._callSingle('/api/create-object', {
      className,
      parent,
      name,
      properties
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async massCreateObjects(objects: Array<{className: string, parent: string, name?: string, properties?: Record<string, any>}>, instance_id?: string) {
    if (!objects || objects.length === 0) {
      throw new Error('Objects array is required for mass_create_objects');
    }
    const response = await this._callSingle('/api/mass-create-objects', { objects }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async deleteObject(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for delete_object');
    }
    const response = await this._callSingle('/api/delete-object', { instancePath }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async smartDuplicate(
    instancePath: string,
    count: number,
    options?: {
      namePattern?: string;
      positionOffset?: [number, number, number];
      rotationOffset?: [number, number, number];
      scaleOffset?: [number, number, number];
      propertyVariations?: Record<string, any[]>;
      targetParents?: string[];
    },
    instance_id?: string
  ) {
    if (!instancePath || count < 1) {
      throw new Error('Instance path and count > 0 are required for smart_duplicate');
    }
    const response = await this._callSingle('/api/smart-duplicate', {
      instancePath,
      count,
      options
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async massDuplicate(
    duplications: Array<{
      instancePath: string;
      count: number;
      options?: {
        namePattern?: string;
        positionOffset?: [number, number, number];
        rotationOffset?: [number, number, number];
        scaleOffset?: [number, number, number];
        propertyVariations?: Record<string, any[]>;
        targetParents?: string[];
      }
    }>,
    instance_id?: string
  ) {
    if (!duplications || duplications.length === 0) {
      throw new Error('Duplications array is required for mass_duplicate');
    }
    const response = await this._callSingle('/api/mass-duplicate', { duplications }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }




  async getScriptSource(instancePath: string, startLine?: number, endLine?: number, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_script_source');
    }
    const response = await this._callSingle('/api/get-script-source', { instancePath, startLine, endLine }, undefined, instance_id);

    if (response.error) {
      return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
    }

    const scriptTypeInfo: Record<string, string> = {
      'Script': 'Server Script, runs on the server only',
      'LocalScript': 'Local Script, runs on the client',
      'ModuleScript': 'Module Script, shared library loaded via require()',
    };

    const serviceInfo: Record<string, string> = {
      'Workspace': 'Workspace, 3D world replicated to all clients',
      'ServerScriptService': 'ServerScriptService, server only',
      'ServerStorage': 'ServerStorage, server only storage',
      'StarterGui': 'StarterGui, UI templates copied to each player',
      'StarterPlayerScripts': 'StarterPlayerScripts, client scripts',
      'StarterCharacterScripts': 'StarterCharacterScripts, character scripts',
      'ReplicatedStorage': 'ReplicatedStorage, shared server and client',
      'ReplicatedFirst': 'ReplicatedFirst, first to load on client',
    };

    const pathStr = (response.instancePath as string) || instancePath;
    const pathSegments = pathStr.split('.');
    const topService =
      typeof response.topService === 'string' && response.topService.length > 0
        ? response.topService
        : pathSegments[0] === 'game' ? (pathSegments[1] ?? 'game') : pathSegments[0];
    const typeNote = scriptTypeInfo[response.className as string] || (response.className as string);
    const serviceNote = serviceInfo[topService] || topService;

    const headerLines: string[] = [
      `Path:     ${pathStr}`,
      `Type:     ${typeNote}`,
      `Location: ${serviceNote}`,
      `Lines:    ${response.lineCount} total${
        response.isPartial ? ` (showing ${response.startLine}-${response.endLine})` : ''
      }`,
    ];

    if (response.enabled === false) {
      headerLines.push(`Status:   DISABLED`);
    }

    if (response.truncated) {
      headerLines.push(`Note:     Truncated to first 1000 lines, use startLine/endLine to read more`);
    }

    const header = headerLines.join('\n');
    const code = (response.numberedSource || response.source) as string;

    return {
      content: [{
        type: 'text',
        text: `${header}\n\n${code}`,
      }]
    };
  }

  async setScriptSource(instancePath: string, source: string, instance_id?: string) {
    if (!instancePath || typeof source !== 'string') {
      throw new Error('Instance path and source code string are required for set_script_source');
    }
    const response = await this._callSingle('/api/set-script-source', { instancePath, source }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async editScriptLines(instancePath: string, oldString: string, newString: string, startLine?: number, instance_id?: string) {
    if (!instancePath || typeof oldString !== 'string' || typeof newString !== 'string') {
      throw new Error('Instance path, old_string, and new_string are required for edit_script_lines');
    }
    const payload: Record<string, unknown> = { instancePath, old_string: oldString, new_string: newString };
    if (startLine !== undefined) payload.startLine = startLine;
    const response = await this._callSingle('/api/edit-script-lines', payload, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async insertScriptLines(instancePath: string, afterLine: number, newContent: string, instance_id?: string) {
    if (!instancePath || typeof newContent !== 'string') {
      throw new Error('Instance path and newContent are required for insert_script_lines');
    }
    const response = await this._callSingle('/api/insert-script-lines', { instancePath, afterLine: afterLine || 0, newContent }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async deleteScriptLines(instancePath: string, startLine: number, endLine: number, instance_id?: string) {
    if (!instancePath || !startLine || !endLine) {
      throw new Error('Instance path, startLine, and endLine are required for delete_script_lines');
    }
    const response = await this._callSingle('/api/delete-script-lines', { instancePath, startLine, endLine }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async grepScripts(
    pattern: string,
    options?: {
      caseSensitive?: boolean;
      usePattern?: boolean;
      contextLines?: number;
      maxResults?: number;
      maxResultsPerScript?: number;
      filesOnly?: boolean;
      path?: string;
      classFilter?: string;
    },
    instance_id?: string
  ) {
    if (!pattern) {
      throw new Error('Pattern is required for grep_scripts');
    }
    const response = await this._callSingle('/api/grep-scripts', {
      pattern,
      ...options
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async setAttribute(instancePath: string, attributeName: string, attributeValue: any, valueType?: string, instance_id?: string) {
    if (!instancePath || !attributeName) {
      throw new Error('Instance path and attribute name are required for set_attribute');
    }
    const response = await this._callSingle('/api/set-attribute', { instancePath, attributeName, attributeValue, valueType }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getAttributes(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_attributes');
    }
    const response = await this._callSingle('/api/get-attributes', { instancePath }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async deleteAttribute(instancePath: string, attributeName: string, instance_id?: string) {
    if (!instancePath || !attributeName) {
      throw new Error('Instance path and attribute name are required for delete_attribute');
    }
    const response = await this._callSingle('/api/delete-attribute', { instancePath, attributeName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getTags(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_tags');
    }
    const response = await this._callSingle('/api/get-tags', { instancePath }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async addTag(instancePath: string, tagName: string, instance_id?: string) {
    if (!instancePath || !tagName) {
      throw new Error('Instance path and tag name are required for add_tag');
    }
    const response = await this._callSingle('/api/add-tag', { instancePath, tagName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async removeTag(instancePath: string, tagName: string, instance_id?: string) {
    if (!instancePath || !tagName) {
      throw new Error('Instance path and tag name are required for remove_tag');
    }
    const response = await this._callSingle('/api/remove-tag', { instancePath, tagName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getTagged(tagName: string, instance_id?: string) {
    if (!tagName) {
      throw new Error('Tag name is required for get_tagged');
    }
    const response = await this._callSingle('/api/get-tagged', { tagName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getSelection(instance_id?: string) {
    const response = await this._callSingle('/api/get-selection', {}, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async executeLuau(code: string, target?: string, instance_id?: string) {
    if (!code) {
      throw new Error('Code is required for execute_luau');
    }
    const response = await this._callSingle('/api/execute-luau', { code }, target || 'edit', instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async evalServerRuntime(code: string, instance_id?: string) {
    if (!code) {
      throw new Error('Code is required for eval_server_runtime');
    }
    const response = await this._callSingle('/api/eval-runtime', { code }, 'server', instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async evalClientRuntime(code: string, target?: string, instance_id?: string) {
    if (!code) {
      throw new Error('Code is required for eval_client_runtime');
    }
    const clientTarget = target || 'client-1';
    if (!clientTarget.startsWith('client-')) {
      throw new Error(`eval_client_runtime requires target=client-N (got: ${clientTarget})`);
    }
    const response = await this._callSingle('/api/eval-runtime', { code }, clientTarget, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getRuntimeLogs(target?: string, since?: number, tail?: number, filter?: string, instance_id?: string) {
    // Per-capture in-memory log buffer (see studio-plugin RuntimeLogBuffer.ts).
    // target="all" (default) fans out to every connected instance except
    // edit-proxy (which has no buffer, just polls for stop-playtest), merges
    // by (ts, seq) and dedups same-message-and-level entries captured within
    // 2 seconds in different buffers. Ordinary Studio playtests reflect logs
    // across edit/server/client, so capturedBy is not a reliable origin peer;
    // only StudioTestService multiplayer sessions get a peer attribution.
    const tgt = target ?? 'all';
    const data: Record<string, unknown> = {};
    if (since !== undefined) data.since = since;
    if (tail !== undefined) data.tail = tail;
    if (filter !== undefined) data.filter = filter;

    // Resolve once. Single mode → one request and pass-through. Fanout
    // mode → iterate the resolved (instanceId, role) tuples; results keyed
    // by role within the selected instance, so duplicate roles across
    // different places no longer collapse (the v2.11.x bug).
    const resolved = this.bridge.resolveTarget({ instance_id, target: tgt });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);

    if (resolved.mode === 'single') {
      const originPeerReliable = await this._isMultiplayerTestRunning(resolved.targetInstanceId);
      const response = (await this.client.request(
        '/api/get-runtime-logs',
        data,
        resolved.targetInstanceId,
        resolved.targetRole,
      )) as { capturedBy?: string; peer?: string; entries?: Array<{ capturedBy?: string; peer?: string }> } & Record<string, unknown>;
      // The plugin-side handler can only report generic "client" because the
      // client DM doesn't know its server-assigned client-N role. Normalize to
      // the resolved capture buffer, but do not claim script-origin peer unless
      // the selected place is running a StudioTestService multiplayer test.
      response.capturedBy = resolved.targetRole;
      delete response.peer;
      response.originPeerReliable = originPeerReliable;
      response.peerAttribution = originPeerReliable ? 'guaranteed_multiplayer' : 'unavailable_shared_logservice';
      if (originPeerReliable) response.peer = resolved.targetRole;
      if (Array.isArray(response.entries)) {
        for (const e of response.entries) {
          e.capturedBy = resolved.targetRole;
          delete e.peer;
          if (originPeerReliable) e.peer = resolved.targetRole;
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
      };
    }

    const targets = resolved.targets.filter((t) => t.targetRole !== 'edit-proxy');

    type PeerResponse = {
      capturedBy?: string;
      entries?: Entry[];
      totalDropped?: number;
      nextSince?: number;
      error?: string;
    };
    type Entry = { seq: number; ts: number; level: string; message: string; capturedBy?: string; peer?: string };
    const originPeerReliable = targets.length > 0
      ? await this._isMultiplayerTestRunning(targets[0].targetInstanceId)
      : false;

    const responses = await Promise.allSettled(
      targets.map(async (t) => {
        const r = (await this.client.request(
          '/api/get-runtime-logs',
          data,
          t.targetInstanceId,
          t.targetRole,
        )) as PeerResponse;
        return { ...r, capturedBy: t.targetRole };
      }),
    );

    const merged: Entry[] = [];
    const perCaptureNextSince: Record<string, number> = {};
    const perCaptureErrors: Record<string, string> = {};
    let totalDropped = 0;

    for (const r of responses) {
      if (r.status !== 'fulfilled') continue;
      const v = r.value;
      const capturedBy = v.capturedBy ?? 'unknown';
      if (v.error) {
        perCaptureErrors[capturedBy] = v.error;
        continue;
      }
      if (v.nextSince !== undefined) perCaptureNextSince[capturedBy] = v.nextSince;
      totalDropped += v.totalDropped ?? 0;
      for (const e of v.entries ?? []) {
        const entry = { ...e };
        delete entry.peer;
        merged.push({ ...entry, capturedBy });
      }
    }

    merged.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.seq - b.seq));

    // Cross-peer dedup. LogService reflects prints across peers in Studio
    // Play, so the same message can land in multiple peers' buffers within
    // ~250ms (client batch) + ~700ms (peer-listener startup skew). 2s window
    // matches the LogBuffer primitive's heuristic.
    const DEDUP_WINDOW = 2.0;
    const deduped: Entry[] = [];
    for (const e of merged) {
      const isDup = deduped.some(
        (d) =>
          d.message === e.message &&
          d.level === e.level &&
          Math.abs(d.ts - e.ts) <= DEDUP_WINDOW &&
          d.capturedBy !== e.capturedBy,
      );
      if (!isDup) deduped.push(e);
    }

    // Re-apply tail post-merge since per-peer tail may have over-returned.
    let final = deduped;
    if (tail !== undefined && deduped.length > tail) {
      final = deduped.slice(deduped.length - tail);
    }
    const finalEntries = originPeerReliable
      ? final.map((e) => ({ ...e, peer: e.capturedBy }))
      : final;

    const body: Record<string, unknown> = {
      entries: finalEntries,
      totalDropped,
      perCaptureNextSince,
      originPeerReliable,
      peerAttribution: originPeerReliable ? 'guaranteed_multiplayer' : 'unavailable_shared_logservice',
    };
    if (originPeerReliable) {
      body.perPeerNextSince = perCaptureNextSince;
    }
    if (Object.keys(perCaptureErrors).length > 0) {
      body.perCaptureErrors = perCaptureErrors;
      if (originPeerReliable) body.perPeerErrors = perCaptureErrors;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }

  async startPlaytest(mode: string, numPlayers?: number, instance_id?: string) {
    if (mode !== 'play' && mode !== 'run') {
      throw new Error('mode must be "play" or "run"');
    }
    if (numPlayers !== undefined) {
      throw new Error('start_playtest is single-player only. Use multiplayer_test_start for multi-client StudioTestService sessions.');
    }
    const data: Record<string, unknown> = { mode };
    const startedAt = Date.now();
    const resolved = this.bridge.resolveTarget({ instance_id, target: undefined });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    const response = await this.client.request(
      '/api/start-playtest',
      data,
      resolved.targetInstanceId,
      resolved.targetRole,
    );
    let wait: { ok: boolean; roles: string[]; timedOut: boolean } | undefined;
    if (response?.success === true) {
      const requiredRoles = mode === 'play' ? ['server', 'client-1'] : ['server'];
      wait = await this._waitForRuntimeRolesFresh(resolved.targetInstanceId, startedAt, requiredRoles);
    }
    const body = wait
      ? {
        ...response,
        runtimeReady: wait.ok,
        timedOut: wait.timedOut,
        roles: wait.roles,
      }
      : response;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(body)
        }
      ]
    };
  }

  async stopPlaytest(instance_id?: string) {
    // The edit DM's stopPlaytest handler sets a plugin:SetSetting flag that
    // StopPlayMonitor reads from inside the play-server DM (the only DM where
    // StudioTestService:EndTest is legal). No edit-proxy peer registration is
    // involved — the cross-DM signal works regardless of MCP server state,
    // peer-role bookkeeping, or restart cycles.
    const response = await this._callSingle('/api/stop-playtest', {}, 'edit', instance_id);
    return {
      content: [{ type: 'text', text: JSON.stringify(response) }],
    };
  }

  async getPlaytestOutput(target?: string, instance_id?: string) {
    const response = await this._callSingle('/api/get-playtest-output', {}, target || 'edit', instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  private async _buildMultiplayerState(instanceId: string): Promise<Record<string, unknown>> {
    const peers = this.bridge.getPublicInstances()
      .filter((i) => i.instanceId === instanceId)
      .sort((a, b) => a.role.localeCompare(b.role));

    const body: Record<string, unknown> = {
      instanceId,
      peers,
      peerCount: peers.length,
    };

    const edit = peers.find((p) => p.role === 'edit');
    const server = peers.find((p) => p.role === 'server');

    let editState: any | undefined;
    let serverState: any | undefined;

    if (edit) {
      try {
        editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        body.edit = editState;
      } catch (err) {
        body.edit = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (server) {
      try {
        serverState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'server');
        body.server = serverState;
      } catch (err) {
        body.server = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const session = editState?.session;
    const rawPhase = typeof session?.phase === 'string' ? session.phase : undefined;
    const hasRuntime = peers.some((p) => p.role === 'server' || p.role.startsWith('client-'));
    body.phase = rawPhase === 'starting' && hasRuntime ? 'running' : (rawPhase ?? (hasRuntime ? 'running' : 'idle'));
    body.testId = session?.testId;
    body.numPlayers = session?.numPlayers;
    body.testArgs = session?.testArgs ?? serverState?.testArgs;
    body.result = session?.result;
    body.error = session?.error;
    body.players = serverState?.players ?? [];
    body.playerCount = serverState?.playerCount ?? 0;
    body.clientRoles = this._clientRolesForInstance(instanceId);

    return body;
  }

  private async _waitForMultiplayerEditDone(instanceId: string, timeoutSec = 30): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (!this._rolesForInstance(instanceId).includes('edit')) return false;
      try {
        const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        const phase = editState?.session?.phase;
        if (phase === 'completed' || phase === 'failed') return true;
      } catch {
        // The edit peer may be temporarily busy while Studio tears down.
      }
      await sleep(250);
    }
    return false;
  }

  private async _isMultiplayerTestRunning(instanceId: string): Promise<boolean> {
    if (!this._rolesForInstance(instanceId).includes('edit')) return false;
    try {
      const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
      const phase = editState?.session?.phase;
      return phase === 'starting' || phase === 'running';
    } catch {
      return false;
    }
  }

  private async _waitForMultiplayerStart(
    instanceId: string,
    clientCount: number,
    timeoutSec = 30,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean; phase?: string; error?: unknown }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const exact = await this._waitForExactClientCount(instanceId, clientCount, 0.25, 0);
      if (exact.ok || exact.extraClients) {
        return { ok: exact.ok, roles: exact.roles, timedOut: false, error: exact.extraClients ? `Expected ${clientCount} client(s), but Studio registered ${exact.clientCount}.` : undefined };
      }
      try {
        const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        const session = editState?.session;
        if (session?.phase === 'failed' || session?.phase === 'completed') {
          return { ok: false, roles: this._rolesForInstance(instanceId), timedOut: false, phase: session.phase, error: session.error };
        }
      } catch {
        // Keep waiting; normal startup is driven by runtime peers registering.
      }
      await sleep(250);
    }
    return { ok: false, roles: this._rolesForInstance(instanceId), timedOut: true };
  }

  async multiplayerTestStart(numPlayers: number, testArgs?: unknown, timeout?: number, instance_id?: string) {
    if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 8) {
      throw new Error('numPlayers must be an integer from 1 to 8');
    }
    const editTarget = this._resolveSingleTarget('edit', instance_id);
    const response = await this.client.request(
      '/api/multiplayer-test-start',
      { numPlayers, testArgs: testArgs ?? {} },
      editTarget.instanceId,
      editTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }

    const wait = await this._waitForMultiplayerStart(editTarget.instanceId, numPlayers, timeout ?? 30);
    const state = await this._buildMultiplayerState(editTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          ready: wait.ok,
          timedOut: wait.timedOut,
          wait,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestState(instance_id?: string) {
    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const state = await this._buildMultiplayerState(instanceId);
    return { content: [{ type: 'text', text: JSON.stringify(state) }] };
  }

  async multiplayerTestAddPlayers(numPlayers: number, timeout?: number, instance_id?: string) {
    if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 8) {
      throw new Error('numPlayers must be an integer from 1 to 8');
    }
    const serverTarget = this._resolveSingleTarget('server', instance_id);
    const before = this._clientRolesForInstance(serverTarget.instanceId).length;
    const response = await this.client.request(
      '/api/multiplayer-test-add-players',
      { numPlayers, timeout: timeout ?? 10 },
      serverTarget.instanceId,
      serverTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const wait = await this._waitForExactClientCount(serverTarget.instanceId, before + numPlayers, timeout ?? 30);
    const state = await this._buildMultiplayerState(serverTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          ready: wait.ok,
          timedOut: wait.timedOut,
          wait,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestLeaveClient(target: string = 'client-1', timeout?: number, instance_id?: string) {
    if (!/^client-\d+$/.test(target)) {
      throw new Error(`multiplayer_test_leave_client requires target=client-N (got: ${target})`);
    }
    const clientTarget = this._resolveSingleTarget(target, instance_id);
    const response = await this.client.request(
      '/api/multiplayer-test-leave-client',
      {},
      clientTarget.instanceId,
      clientTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const wait = await this._waitForRuntimeRoles(
      clientTarget.instanceId,
      { absentRole: clientTarget.role },
      timeout ?? 30,
    );
    const state = await this._buildMultiplayerState(clientTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          left: wait.ok,
          timedOut: wait.timedOut,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestEnd(value?: unknown, timeout?: number, instance_id?: string) {
    const serverTarget = this._resolveSingleTarget('server', instance_id);
    const response = await this.client.request(
      '/api/multiplayer-test-end',
      { value: value ?? 'ended_by_mcp' },
      serverTarget.instanceId,
      serverTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const editDone = await this._waitForMultiplayerEditDone(serverTarget.instanceId, timeout ?? 30);
    const wait = await this._waitForRuntimeRoles(
      serverTarget.instanceId,
      { noRuntime: true },
      timeout ?? 30,
    );
    const state = await this._buildMultiplayerState(serverTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          ended: wait.ok,
          editDone,
          timedOut: wait.timedOut,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async getConnectedInstances() {
    const instances = this.bridge.getPublicInstances();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ instances, count: instances.length })
        }
      ]
    };
  }

  async undo(instance_id?: string) {
    const response = await this._callSingle('/api/undo', {}, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async redo(instance_id?: string) {
    const response = await this._callSingle('/api/redo', {}, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  private static findProjectRoot(startDir: string): string | null {
    let dir = path.resolve(startDir);
    let previous = '';
    while (dir !== previous) {
      if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
        return dir;
      }
      previous = dir;
      dir = path.dirname(dir);
    }
    return null;
  }

  private static isDirectory(candidate: string | null | undefined): candidate is string {
    if (!candidate) return false;
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  private static ensureWritableDirectory(candidate: string, label: string): string {
    const resolved = path.resolve(candidate);
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (error) {
      throw new Error(`Unable to create ${label} build-library directory at ${resolved}: ${(error as Error).message}`);
    }
    if (!RobloxStudioTools.isDirectory(resolved)) {
      throw new Error(`${label} build-library path is not a directory: ${resolved}`);
    }
    try {
      fs.accessSync(resolved, fs.constants.W_OK);
    } catch (error) {
      throw new Error(`${label} build-library directory is not writable: ${resolved}. ${(error as Error).message}`);
    }
    return resolved;
  }

  private static _cachedLibraryPath: string | undefined;

  private static findLibraryPath(): string {
    if (RobloxStudioTools._cachedLibraryPath) return RobloxStudioTools._cachedLibraryPath;

    const overridePath = process.env.ROBLOXSTUDIO_MCP_BUILD_LIBRARY || process.env.BUILD_LIBRARY_PATH;
    const cwd = path.resolve(process.cwd());
    const projectRoot = RobloxStudioTools.findProjectRoot(cwd);
    const homeLibraryPath = path.join(os.homedir(), '.robloxstudio-mcp', 'build-library');
    const projectLibraryPath = projectRoot ? path.join(projectRoot, 'build-library') : null;
    const cwdLibraryPath = path.join(cwd, 'build-library');

    let result: string;

    if (overridePath) {
      result = RobloxStudioTools.ensureWritableDirectory(overridePath, 'override');
    } else {
      const existing = [projectLibraryPath, cwdLibraryPath].find(
        c => c && RobloxStudioTools.isDirectory(c) && (() => { try { fs.accessSync(c, fs.constants.W_OK); return true; } catch { return false; } })()
      );
      if (existing) {
        result = path.resolve(existing);
      } else if (projectLibraryPath) {
        try {
          result = RobloxStudioTools.ensureWritableDirectory(projectLibraryPath, 'project-root');
        } catch (err) {
          console.error(`Warning: could not create build-library at project root (${projectLibraryPath}): ${(err as Error).message}. Falling back to home directory.`);
          result = RobloxStudioTools.ensureWritableDirectory(homeLibraryPath, 'home');
        }
      } else {
        result = RobloxStudioTools.ensureWritableDirectory(homeLibraryPath, 'home');
      }
    }

    RobloxStudioTools._cachedLibraryPath = result;
    return result;
  }

  async exportBuild(instancePath: string, outputId?: string, style: string = 'misc', instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for export_build');
    }
    const response = await this._callSingle('/api/export-build', {
      instancePath,
      outputId,
      style
    }, undefined, instance_id) as any;

    // Auto-save to library
    if (response && response.success && response.buildData) {
      const buildData = response.buildData;
      const buildId = buildData.id || `${style}/exported`;
      const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${buildId}.json`);
      const dirPath = path.dirname(filePath);

      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));
      response.savedTo = filePath;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  private normalizePalette(palette: Record<string, unknown>): Record<string, [string, string]> {
    if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
      throw new Error('palette must be an object mapping keys to [BrickColor, Material] tuples');
    }
    const normalized: Record<string, [string, string]> = {};
    for (const [key, value] of Object.entries(palette)) {
      if (!Array.isArray(value) || value.length < 2) {
        throw new Error(`Palette key "${key}" must map to [BrickColor, Material]`);
      }
      normalized[key] = [String(value[0]), String(value[1])];
    }
    if (Object.keys(normalized).length === 0) {
      throw new Error('palette must contain at least one key');
    }
    return normalized;
  }

  private normalizeBuildParts(parts: unknown, paletteKeys: Set<string>): any[][] {
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('parts must be a non-empty array');
    }

    const ALLOWED_SHAPES = new Set(['Block', 'Wedge', 'Cylinder', 'Ball', 'CornerWedge']);
    const normalized: any[][] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (Array.isArray(part)) {
        if (part.length < 10) {
          throw new Error(`Part ${i} must have at least 10 elements`);
        }
        const [px, py, pz, sx, sy, sz, rx, ry, rz, paletteKey, ...rest] = part;
        if (typeof paletteKey !== 'string' || !paletteKeys.has(paletteKey)) {
          throw new Error(`Part ${i} references unknown palette key "${paletteKey}"`);
        }
        const tuple: any[] = [px, py, pz, sx, sy, sz, rx, ry, rz, paletteKey];
        if (rest[0] !== undefined) {
          if (!ALLOWED_SHAPES.has(rest[0])) throw new Error(`Part ${i} has invalid shape "${rest[0]}"`);
          tuple.push(rest[0]);
        }
        if (rest[1] !== undefined) {
          if (!rest[0]) tuple.push('Block');
          tuple.push(rest[1]);
        }
        normalized.push(tuple);
        continue;
      }

      if (!part || typeof part !== 'object') {
        throw new Error(`Part ${i} must be an array or object`);
      }

      const r = part as Record<string, unknown>;
      const position = r.position as number[];
      const size = r.size as number[];
      const rotation = r.rotation as number[];
      const pk = r.paletteKey as string;

      if (!Array.isArray(position) || position.length !== 3) throw new Error(`Part ${i}: position must be [x,y,z]`);
      if (!Array.isArray(size) || size.length !== 3) throw new Error(`Part ${i}: size must be [x,y,z]`);
      if (!Array.isArray(rotation) || rotation.length !== 3) throw new Error(`Part ${i}: rotation must be [x,y,z]`);
      if (typeof pk !== 'string' || !paletteKeys.has(pk)) throw new Error(`Part ${i} references unknown palette key "${pk}"`);

      const tuple: any[] = [...position, ...size, ...rotation, pk];
      if (r.shape !== undefined) {
        if (!ALLOWED_SHAPES.has(r.shape as string)) throw new Error(`Part ${i} has invalid shape "${r.shape}"`);
        tuple.push(r.shape);
      }
      if (r.transparency !== undefined) {
        if (!r.shape) tuple.push('Block');
        tuple.push(r.transparency);
      }
      normalized.push(tuple);
    }

    return normalized;
  }

  async createBuild(
    id: string,
    style: string,
    palette: Record<string, any>,
    parts: unknown,
    bounds?: [number, number, number]
  ) {
    if (!id) {
      throw new Error('id is required for create_build');
    }

    const normalizedPalette = this.normalizePalette(palette);
    const normalizedParts = this.normalizeBuildParts(parts, new Set(Object.keys(normalizedPalette)));

    // Auto-compute bounds if not provided
    const computedBounds = bounds || this.computeBounds(normalizedParts);

    const buildData = { id, style, bounds: computedBounds, palette: normalizedPalette, parts: normalizedParts };

    const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${id}.json`);
    const dirPath = path.dirname(filePath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            id,
            style,
            bounds: computedBounds,
            partCount: normalizedParts.length,
            paletteKeys: Object.keys(normalizedPalette),
            savedTo: filePath
          })
        }
      ]
    };
  }

  private computeBounds(parts: any[][]): [number, number, number] {
    let maxX = 0, maxY = 0, maxZ = 0;
    for (const p of parts) {
      const px = Math.abs(p[0]) + p[3] / 2;
      const py = Math.abs(p[1]) + p[4] / 2;
      const pz = Math.abs(p[2]) + p[5] / 2;
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
      maxZ = Math.max(maxZ, pz);
    }
    return [
      Math.round(maxX * 2 * 10) / 10,
      Math.round(maxY * 2 * 10) / 10,
      Math.round(maxZ * 2 * 10) / 10
    ];
  }

  async generateBuild(
    id: string,
    style: string,
    palette: Record<string, [string, string]>,
    code: string,
    seed?: number
  ) {
    if (!id || !palette || !code) {
      throw new Error('id, palette, and code are required for generate_build');
    }

    // Validate palette
    for (const [key, value] of Object.entries(palette)) {
      if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
        throw new Error(`Palette key "${key}" must map to [BrickColor, Material] or [BrickColor, Material, MaterialVariant]`);
      }
    }

    // Run the build executor
    const result = runBuildExecutor(code, palette, seed);

    const buildData: Record<string, any> = {
      id,
      style,
      bounds: result.bounds,
      palette,
      parts: result.parts,
      generatorCode: code,
    };
    if (seed !== undefined) buildData.generatorSeed = seed;

    const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${id}.json`);
    const dirPath = path.dirname(filePath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            id,
            style,
            bounds: result.bounds,
            partCount: result.partCount,
            paletteKeys: Object.keys(palette),
            savedTo: filePath
          })
        }
      ]
    };
  }

  async importBuild(buildData: Record<string, any> | string, targetPath: string, position?: [number, number, number], instance_id?: string) {
    if (!buildData || !targetPath) {
      throw new Error('buildData (or library ID string) and targetPath are required for import_build');
    }

    // If buildData is a string, treat it as a library ID and load the file
    let resolved: Record<string, any>;
    if (typeof buildData === 'string') {
      const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${buildData}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Build not found in library: ${buildData}`);
      }
      resolved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else if (buildData.id && !buildData.parts) {
      // Object with just an id - try loading from library
      const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${buildData.id}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Build not found in library: ${buildData.id}`);
      }
      resolved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else {
      resolved = buildData;
    }

    const response = await this._callSingle('/api/import-build', {
      buildData: resolved,
      targetPath,
      position
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async listLibrary(style?: string) {
    const libraryPath = RobloxStudioTools.findLibraryPath();
    const styles = style ? [style] : ['medieval', 'modern', 'nature', 'scifi', 'misc'];
    const builds: Array<{ id: string; style: string; bounds: number[]; partCount: number }> = [];

    for (const s of styles) {
      const dirPath = path.join(libraryPath, s);
      if (!fs.existsSync(dirPath)) continue;

      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
          const data = JSON.parse(content);
          builds.push({
            id: data.id || `${s}/${file.replace('.json', '')}`,
            style: data.style || s,
            bounds: data.bounds || [0, 0, 0],
            partCount: Array.isArray(data.parts) ? data.parts.length : 0
          });
        } catch {
          // Skip invalid JSON files
        }
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ builds, total: builds.length })
        }
      ]
    };
  }

  async searchMaterials(query?: string, maxResults?: number, instance_id?: string) {
    const response = await this._callSingle('/api/search-materials', {
      query: query ?? '',
      maxResults: maxResults ?? 50
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getBuild(id: string) {
    if (!id) {
      throw new Error('Build ID is required for get_build');
    }

    const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${id}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Build not found in library: ${id}`);
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Return metadata + code (but not the full parts array to save tokens)
    const result: Record<string, any> = {
      id: data.id,
      style: data.style,
      bounds: data.bounds,
      partCount: Array.isArray(data.parts) ? data.parts.length : 0,
      paletteKeys: data.palette ? Object.keys(data.palette) : [],
      palette: data.palette,
    };

    if (data.generatorCode) {
      result.generatorCode = data.generatorCode;
      result.generatorSeed = data.generatorSeed;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result)
        }
      ]
    };
  }

  async importScene(
    sceneData: {
      models?: Record<string, string>;
      place?: Array<
        [string, number[], number[]?]
        | { modelKey: string; position: number[]; rotation?: number[] }
      >;
      custom?: Array<{ n: string; o: number[]; palette: Record<string, [string, string]>; parts: any[][] }>;
    },
    targetPath: string = 'game.Workspace',
    instance_id?: string
  ) {
    if (!sceneData) {
      throw new Error('sceneData is required for import_scene');
    }

    const libraryPath = RobloxStudioTools.findLibraryPath();
    const expandedBuilds: Array<{ buildData: Record<string, any>; position: number[]; rotation: number[]; name: string }> = [];

    // Resolve model references from library
    const modelMap = sceneData.models || {};
    const placements = sceneData.place || [];

    const isVec3Tuple = (value: unknown): value is [number, number, number] => {
      return Array.isArray(value)
        && value.length === 3
        && value.every(component => typeof component === 'number' && Number.isFinite(component));
    };

    for (const [placementIndex, placement] of placements.entries()) {
      let modelKey: string;
      let position: [number, number, number];
      let rotation: [number, number, number] | undefined;
      let validatedKeyPath: string;

      if (Array.isArray(placement)) {
        if (placement.length < 2 || placement.length > 3) {
          throw new Error(
            `Invalid sceneData.place[${placementIndex}]: expected [modelKey, [x,y,z], [rotX?,rotY?,rotZ?]]`
          );
        }
        const [tupleModelKey, tuplePosition, tupleRotation] = placement;
        if (typeof tupleModelKey !== 'string' || tupleModelKey.trim() === '') {
          throw new Error(`Invalid sceneData.place[${placementIndex}][0]: model key must be a non-empty string`);
        }
        modelKey = tupleModelKey.trim();
        validatedKeyPath = `sceneData.place[${placementIndex}][0]`;
        if (!isVec3Tuple(tuplePosition)) {
          throw new Error(`Invalid sceneData.place[${placementIndex}][1]: position must be a numeric [x,y,z] tuple`);
        }
        position = tuplePosition;
        if (tupleRotation !== undefined) {
          if (!isVec3Tuple(tupleRotation)) {
            throw new Error(
              `Invalid sceneData.place[${placementIndex}][2]: rotation must be a numeric [x,y,z] tuple when provided`
            );
          }
          rotation = tupleRotation;
        }
      } else if (placement && typeof placement === 'object') {
        const placementRecord = placement as Record<string, unknown>;
        const objectModelKey = placementRecord.modelKey;
        const objectPosition = placementRecord.position;
        const objectRotation = placementRecord.rotation;
        if (typeof objectModelKey !== 'string' || objectModelKey.trim() === '') {
          throw new Error(`Invalid sceneData.place[${placementIndex}].modelKey: model key must be a non-empty string`);
        }
        if (!isVec3Tuple(objectPosition)) {
          throw new Error(`Invalid sceneData.place[${placementIndex}].position: must be a numeric [x,y,z] tuple`);
        }
        if (objectRotation !== undefined && !isVec3Tuple(objectRotation)) {
          throw new Error(
            `Invalid sceneData.place[${placementIndex}].rotation: must be a numeric [x,y,z] tuple when provided`
          );
        }
        modelKey = objectModelKey.trim();
        validatedKeyPath = `sceneData.place[${placementIndex}].modelKey`;
        position = objectPosition;
        rotation = objectRotation as [number, number, number] | undefined;
      } else {
        throw new Error(
          `Invalid sceneData.place[${placementIndex}]: expected an object placement or [modelKey, [x,y,z], [rotX?,rotY?,rotZ?]] tuple`
        );
      }

      const buildId = modelMap[modelKey];
      if (!buildId) {
        throw new Error(
          `Invalid ${validatedKeyPath}: model key "${modelKey}" is not defined in sceneData.models`
        );
      }

      // Load build data from library
      const filePath = path.join(libraryPath, `${buildId}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Build not found in library: ${buildId}`);
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const buildData = JSON.parse(content);
      const buildName = buildId.split('/').pop() || buildId;

      expandedBuilds.push({
        buildData,
        position,
        rotation: rotation || [0, 0, 0],
        name: buildName
      });
    }

    // Add custom inline builds
    const customs = sceneData.custom || [];
    for (const custom of customs) {
      expandedBuilds.push({
        buildData: {
          palette: custom.palette,
          parts: custom.parts
        },
        position: custom.o || [0, 0, 0],
        rotation: [0, 0, 0],
        name: custom.n || 'Custom'
      });
    }

    if (expandedBuilds.length === 0) {
      throw new Error('No builds to import - check model references and library');
    }

    // Send expanded builds to plugin
    const response = await this._callSingle('/api/import-scene', {
      expandedBuilds,
      targetPath
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  // === Asset Tools ===

  async searchAssets(
    assetType: string,
    query?: string,
    maxResults?: number,
    sortBy?: string,
    verifiedCreatorsOnly?: boolean
  ) {
    if (!this.openCloudClient.hasApiKey()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'ROBLOX_OPEN_CLOUD_API_KEY environment variable is not set. Set it to use Creator Store asset tools.' })
        }]
      };
    }

    const response = await this.openCloudClient.searchAssets({
      searchCategoryType: assetType as any,
      query,
      maxPageSize: maxResults,
      sortCategory: sortBy as any,
      includeOnlyVerifiedCreators: verifiedCreatorsOnly,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getAssetDetails(assetId: number) {
    if (!assetId) {
      throw new Error('Asset ID is required for get_asset_details');
    }

    if (this.cookieClient.hasCookie() && !this.openCloudClient.hasApiKey()) {
      const results = await this.cookieClient.getAssetDetails([assetId]);
      const asset = results[0];
      if (!asset) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Asset not found or not owned by authenticated user' }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(asset) }] };
    }

    if (!this.openCloudClient.hasApiKey()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'No auth configured. Set ROBLOSECURITY or ROBLOX_OPEN_CLOUD_API_KEY env var.' })
        }]
      };
    }

    const response = await this.openCloudClient.getAssetDetails(assetId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getAssetThumbnail(assetId: number, size?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for get_asset_thumbnail');
    }
    if (!this.openCloudClient.hasApiKey()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'ROBLOX_OPEN_CLOUD_API_KEY environment variable is not set. Set it to use Creator Store asset tools.' })
        }]
      };
    }

    const result = await this.openCloudClient.getAssetThumbnail(assetId, size as any);
    if (!result) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Thumbnail not available for this asset' })
        }]
      };
    }

    return {
      content: [{
        type: 'image',
        data: result.base64,
        mimeType: result.mimeType,
      }]
    };
  }

  async insertAsset(assetId: number, parentPath?: string, position?: { x: number; y: number; z: number }, instance_id?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for insert_asset');
    }
    const response = await this._callSingle('/api/insert-asset', {
      assetId,
      parentPath: parentPath || 'game.Workspace',
      position
    }, undefined, instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async previewAsset(assetId: number, includeProperties?: boolean, maxDepth?: number, instance_id?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for preview_asset');
    }
    const response = await this._callSingle('/api/preview-asset', {
      assetId,
      includeProperties: includeProperties ?? true,
      maxDepth: maxDepth ?? 10
    }, undefined, instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  // Decal asset IDs are the wrapper asset; ImageLabel.Image needs the underlying image
  // content ID. The only reliable cross-auth way to resolve this is InsertService:LoadAsset
  // via the connected Studio plugin - the unauthenticated economy endpoint returns 401.
  private async resolveImageId(decalAssetId: string): Promise<string | null> {
    const code = `
      local InsertService = game:GetService("InsertService")
      local ok, result = pcall(function() return InsertService:LoadAsset(${decalAssetId}) end)
      if not ok then return nil end
      local decal = result:FindFirstChildWhichIsA("Decal", true)
      local id = decal and decal.Texture:match("(%d+)") or nil
      result:Destroy()
      return id
    `;
    try {
      const response = await this._callSingle('/api/execute-luau', { code }, 'edit', undefined) as { returnValue?: unknown };
      const returnValue = response?.returnValue;
      if (returnValue !== undefined && returnValue !== null && /^\d+$/.test(String(returnValue))) {
        return String(returnValue);
      }
    } catch {
      // plugin not connected or luau execution failed
    }
    return null;
  }

  async uploadAsset(
    filePath: string,
    assetType: string,
    displayName: string,
    description?: string,
    userId?: string,
    groupId?: string
  ) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    if (assetType === 'Decal' && this.cookieClient.hasCookie()) {
      const result = await this.cookieClient.uploadDecal(fileContent, displayName, description || '');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            done: true,
            response: {
              assetId: String(result.assetId),
              displayName,
              assetType,
              decalId: String(result.assetId),
              imageId: String(result.backingAssetId),
            },
          })
        }]
      };
    }

    if (!this.openCloudClient.hasApiKey()) {
      const cookieHint = assetType === 'Decal'
        ? ' Alternatively, set ROBLOSECURITY to use cookie auth.'
        : '';
      throw new Error(
        `No auth configured for ${assetType} upload. Set ROBLOX_OPEN_CLOUD_API_KEY (needs asset:write scope).${cookieHint}`
      );
    }

    const resolvedGroupId = groupId || process.env.ROBLOX_CREATOR_GROUP_ID;
    const resolvedUserId = userId || process.env.ROBLOX_CREATOR_USER_ID;

    if (!resolvedUserId && !resolvedGroupId) {
      throw new Error(
        'Creator identity required for Open Cloud upload. Set ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID, or pass userId/groupId as parameters.'
      );
    }

    const creator: { userId?: string; groupId?: string } = {};
    if (resolvedGroupId) {
      creator.groupId = resolvedGroupId;
    } else {
      creator.userId = resolvedUserId;
    }

    const result = await this.openCloudClient.createAsset(
      {
        assetType: assetType as 'Audio' | 'Decal' | 'Model' | 'Animation' | 'Video',
        displayName,
        description: description || '',
        creationContext: { creator },
      },
      fileContent,
      fileName
    );

    // Decals: also resolve the underlying image content ID for ImageLabel.Image usage.
    if (assetType === 'Decal') {
      const decalId = result.response?.assetId;
      const imageId = decalId ? await this.resolveImageId(decalId) : null;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...result,
            decalId: decalId ?? null,
            imageId,
          })
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result)
      }]
    };
  }

  async simulateMouseInput(action: string, x: number, y: number, button?: string, scrollDirection?: string, target?: string, instance_id?: string) {
    if (!action) {
      throw new Error('action is required for simulate_mouse_input');
    }
    // Default to the running playtest client (where the input pipeline lives)
    // when the caller didn't pick a target; fall back to edit otherwise.
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const response = await this._callSingle('/api/simulate-mouse-input', {
      action, x, y, button
    }, target || clientRole || 'edit', instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async simulateKeyboardInput(keyCode?: string, action?: string, duration?: number, text?: string, target?: string, instance_id?: string) {
    if (!keyCode && text === undefined) {
      throw new Error('keyCode or text is required for simulate_keyboard_input');
    }
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const response = await this._callSingle('/api/simulate-keyboard-input', {
      keyCode, action, duration, text
    }, target || clientRole || 'edit', instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async characterNavigation(position?: number[], instancePath?: string, waitForCompletion?: boolean, timeout?: number, target?: string, instance_id?: string) {
    if (!position && !instancePath) {
      throw new Error('Either position or instancePath is required for character_navigation');
    }
    const response = await this._callSingle('/api/character-navigation', {
      position, instancePath, waitForCompletion, timeout
    }, target || 'edit', instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async cloneObject(instancePath: string, targetParentPath: string, instance_id?: string) {
    if (!instancePath || !targetParentPath) {
      throw new Error('instancePath and targetParentPath are required for clone_object');
    }
    const response = await this._callSingle('/api/clone-object', { instancePath, targetParentPath }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async getDescendants(instancePath: string, maxDepth?: number, classFilter?: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('instancePath is required for get_descendants');
    }
    const response = await this._callSingle('/api/get-descendants', { instancePath, maxDepth, classFilter }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async compareInstances(instancePathA: string, instancePathB: string, instance_id?: string) {
    if (!instancePathA || !instancePathB) {
      throw new Error('instancePathA and instancePathB are required for compare_instances');
    }
    const response = await this._callSingle('/api/compare-instances', { instancePathA, instancePathB }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async getOutputLog(maxEntries?: number, messageType?: string, instance_id?: string) {
    const response = await this._callSingle('/api/get-output-log', { maxEntries, messageType }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async bulkSetAttributes(instancePath: string, attributes: Record<string, unknown>, instance_id?: string) {
    if (!instancePath || !attributes) {
      throw new Error('instancePath and attributes are required for bulk_set_attributes');
    }
    const response = await this._callSingle('/api/bulk-set-attributes', { instancePath, attributes }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async findAndReplaceInScripts(
    pattern: string,
    replacement: string,
    options?: {
      caseSensitive?: boolean;
      usePattern?: boolean;
      path?: string;
      classFilter?: string;
      dryRun?: boolean;
      maxReplacements?: number;
    },
    instance_id?: string
  ) {
    if (!pattern) {
      throw new Error('pattern is required for find_and_replace_in_scripts');
    }
    if (replacement === undefined || replacement === null) {
      throw new Error('replacement is required for find_and_replace_in_scripts');
    }
    const response = await this._callSingle('/api/find-and-replace-in-scripts', {
      pattern,
      replacement,
      ...options
    }, undefined, instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getMemoryBreakdown(target?: string, tags?: string[], instance_id?: string) {
    const tgt = target ?? 'all';
    const data: Record<string, unknown> = {};
    if (tags !== undefined) data.tags = tags;

    const resolved = this.bridge.resolveTarget({ instance_id, target: tgt });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);

    if (resolved.mode === 'single') {
      const response = await this.client.request(
        '/api/get-memory-breakdown',
        data,
        resolved.targetInstanceId,
        resolved.targetRole,
      );
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }

    const targets = resolved.targets.filter((t) => t.targetRole !== 'edit-proxy');

    const responses = await Promise.allSettled(
      targets.map(async (t) => ({
        peer: t.targetRole,
        result: await this.client.request(
          '/api/get-memory-breakdown',
          data,
          t.targetInstanceId,
          t.targetRole,
        ),
      })),
    );

    const body: Record<string, unknown> = {};
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      const peer = targets[i].targetRole;
      if (r.status === 'fulfilled') {
        body[peer] = r.value.result;
      } else {
        body[peer] = { error: 'disconnected' };
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  async getSceneAnalysis(mode?: string, target?: string, topN?: number, raw?: boolean, instance_id?: string) {
    const tgt = target ?? 'all';
    const data: Record<string, unknown> = {};
    if (mode !== undefined) data.mode = mode;
    if (topN !== undefined) data.topN = topN;
    if (raw !== undefined) data.raw = raw;

    const resolved = this.bridge.resolveTarget({ instance_id, target: tgt });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);

    if (resolved.mode === 'single') {
      const response = await this.client.request(
        '/api/get-scene-analysis',
        data,
        resolved.targetInstanceId,
        resolved.targetRole,
      );
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }

    const targets = resolved.targets.filter((t) => t.targetRole !== 'edit-proxy');

    const responses = await Promise.allSettled(
      targets.map(async (t) => ({
        peer: t.targetRole,
        result: await this.client.request(
          '/api/get-scene-analysis',
          data,
          t.targetInstanceId,
          t.targetRole,
        ),
      })),
    );

    const body: Record<string, unknown> = {};
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      const peer = targets[i].targetRole;
      if (r.status === 'fulfilled') {
        body[peer] = r.value.result;
      } else {
        body[peer] = { error: 'disconnected' };
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  async exportRbxm(instancePaths: string[], outputPath: string, target?: string, instance_id?: string) {
    if (!Array.isArray(instancePaths) || instancePaths.length === 0) {
      throw new Error('instance_paths must be a non-empty array for export_rbxm');
    }
    if (!outputPath || typeof outputPath !== 'string') {
      throw new Error('output_path is required for export_rbxm');
    }
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') {
      throw new Error(`export_rbxm target must be "edit" or "server" (got: ${tgt})`);
    }

    const response = await this._callSingle(
      '/api/export-rbxm',
      { instance_paths: instancePaths },
      tgt,
      instance_id,
    ) as { error?: string; base64?: string; instance_count?: number };

    if (response.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }] };
    }
    if (!response.base64) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'plugin returned no base64 payload' }) }] };
    }

    const bytes = Buffer.from(response.base64, 'base64');
    const resolved = path.resolve(outputPath);
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, bytes);
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `failed to write ${resolved}: ${(err as Error).message}` }) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          bytes_written: bytes.length,
          instance_count: response.instance_count ?? instancePaths.length,
          output_path: resolved,
        }),
      }],
    };
  }

  async importRbxm(
    source: { path?: string; url?: string; base64?: string } | undefined,
    parentPath: string,
    target?: string,
    instance_id?: string
  ) {
    if (!source || typeof source !== 'object') {
      throw new Error('source is required for import_rbxm');
    }
    if (!parentPath || typeof parentPath !== 'string') {
      throw new Error('parent_path is required for import_rbxm');
    }
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') {
      throw new Error(`import_rbxm target must be "edit" or "server" (got: ${tgt})`);
    }

    const modes = ['path', 'url', 'base64'].filter((k) => (source as Record<string, unknown>)[k] !== undefined);
    if (modes.length !== 1) {
      throw new Error(`source must contain exactly one of { path, url, base64 } (got: ${modes.join(', ') || 'none'})`);
    }

    let bytes: Buffer;
    let sourceLabel: string;
    if (source.path !== undefined) {
      const resolved = path.resolve(source.path);
      try {
        bytes = fs.readFileSync(resolved);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `failed to read ${resolved}: ${(err as Error).message}` }) }] };
      }
      sourceLabel = resolved;
    } else if (source.url !== undefined) {
      // SSRF guard: only http(s). Blocks file://, ftp://, gopher://, etc.
      // Does NOT block requests to internal IPs (127.0.0.1, 169.254.x, RFC1918) —
      // a local MCP server has legitimate reasons to hit localhost, so internal-IP
      // blocking should be opt-in if needed.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(source.url);
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `import_rbxm url is not a valid URL: ${source.url}` }) }] };
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `import_rbxm url must use http(s); got ${parsedUrl.protocol}` }) }] };
      }

      // 50 MiB matches the project's existing express.json('50mb') cap and is
      // empirically well within the Studio plugin's HttpService:RequestAsync
      // response ceiling (probed up to 100 MiB without issue, 150+ stalls on
      // Studio memory, not protocol). Far above any realistic rbxm size.
      const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
      try {
        const res = await fetch(source.url);
        if (!res.ok) {
          const snippet = (await res.text()).slice(0, 500);
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url} returned ${res.status}: ${snippet}` }) }] };
        }
        const claimed = Number(res.headers.get('content-length') ?? '0');
        if (claimed > MAX_IMPORT_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url}: content-length ${claimed} exceeds ${MAX_IMPORT_BYTES} byte cap` }) }] };
        }
        const arr = await res.arrayBuffer();
        if (arr.byteLength > MAX_IMPORT_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url}: downloaded ${arr.byteLength} bytes exceeds ${MAX_IMPORT_BYTES} byte cap` }) }] };
        }
        bytes = Buffer.from(arr);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url} failed: ${(err as Error).message}` }) }] };
      }
      sourceLabel = source.url;
    } else {
      try {
        bytes = Buffer.from(source.base64 as string, 'base64');
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `base64 decode failed: ${(err as Error).message}` }) }] };
      }
      sourceLabel = `base64(${bytes.length}B)`;
    }

    const response = await this._callSingle(
      '/api/import-rbxm',
      {
        base64: bytes.toString('base64'),
        parent_path: parentPath,
        source_label: sourceLabel,
      },
      tgt,
      instance_id,
    );

    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async captureScreenshot(instance_id?: string, format?: string, quality?: number) {
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);

    let response: RawImageCaptureResponse;
    if (clientRole) {
      // Play mode. The running game VM can trigger CaptureScreenshot but can't
      // read the resulting temp texture back (privilege gate). So capture on
      // the client to get the rbxtemp:// id, then read it back in the edit DM —
      // the rbxtemp handle is process-scoped and the edit/plugin identity is
      // allowed to promote it into a readable EditableImage.
      const begin = await this._callSingle('/api/capture-begin', {}, clientRole, instanceId) as { contentId?: string; error?: string };
      if (begin.error) {
        return { content: [{ type: 'text', text: begin.error }] };
      }
      if (!begin.contentId) {
        return { content: [{ type: 'text', text: 'Screenshot capture failed: no content id returned from client.' }] };
      }
      response = await this._callSingle('/api/capture-read', { contentId: begin.contentId }, 'edit', instanceId) as RawImageCaptureResponse;
    } else {
      // Edit mode: capture and read back in the same (edit) context.
      response = await this._callSingle('/api/capture-screenshot', {}, 'edit', instanceId) as RawImageCaptureResponse;
    }

    if (response.error) {
      let text = response.error;
      if (
        clientRole &&
        response.error.includes('Failed to load texture, unexpected format') &&
        await this._isMultiplayerTestRunning(instanceId)
      ) {
        text =
          'Screenshot capture reached the multiplayer client, but Roblox returned a temporary screenshot texture ' +
          'that the edit peer cannot read in StudioTestService multiplayer sessions. Regular start_playtest capture ' +
          'works because the temporary rbxtemp:// handle is readable from the edit process; multiplayer client handles ' +
          `appear to be scoped to the client process. Raw error: ${response.error}`;
      }
      return {
        content: [{
          type: 'text',
          text,
        }]
      };
    }

    const w = response.width;
    const h = response.height;
    if (w === undefined || h === undefined) {
      return { content: [{ type: 'text', text: 'Screenshot response missing dimensions.' }] };
    }

    const fmt: 'jpeg' | 'png' = format === 'png' ? 'png' : 'jpeg';
    const q = quality === undefined ? 92 : Math.max(1, Math.min(100, Math.floor(quality)));

    // Cap the inline image size. Measured empirically: an ~8MB image (11MB
    // base64) returns fine, but ~16MB (22MB base64) CLOSES the MCP connection
    // and drops every Studio registration — a catastrophic failure, not a
    // graceful error. 6MB is in the proven-safe range with comfortable margin.
    // For PNG we refuse (rather than silently dropping the lossless guarantee
    // the caller asked for); for JPEG we step quality down so the call still
    // succeeds.
    const MAX_IMAGE_BYTES = 6_000_000;
    const encoded = encodeImageFromRgbaResponse(response, fmt, q);
    let { buffer } = encoded;
    const { mimeType } = encoded;
    let usedQ = q;
    let note = '';

    if (buffer.length > MAX_IMAGE_BYTES) {
      if (fmt === 'png') {
        const mb = (buffer.length / 1048576).toFixed(1);
        return {
          content: [{
            type: 'text',
            text:
              `PNG screenshot is ${mb}MB, over the ~${(MAX_IMAGE_BYTES / 1048576).toFixed(0)}MB inline image limit. ` +
              `Use the default jpeg format (optionally with a "quality" value) or make the Studio window smaller for a lossless capture.`,
          }],
        };
      }
      while (buffer.length > MAX_IMAGE_BYTES && usedQ > 25) {
        usedQ = Math.max(25, usedQ - 20);
        buffer = encodeImageFromRgbaResponse(response, 'jpeg', usedQ).buffer;
      }
      note = ` — auto-reduced to q${usedQ} to fit the inline size limit; enlarge the Studio window or capture a smaller region for finer detail`;
    }

    // Explicit coordinate contract: the image is returned at native viewport
    // resolution and is never downscaled, so its pixel grid IS the coordinate
    // space simulate_mouse_input expects. Stating the dimensions removes any
    // ambiguity about what (x, y) mean.

    return {
      content: [
        {
          type: 'text',
          text:
            `Screenshot ${w}x${h}px (${fmt}${fmt === 'jpeg' ? ` q${usedQ}` : ''})${note}. ` +
            `For simulate_mouse_input, x/y are pixel coordinates in this exact image with (0,0) at the ` +
            `top-left; it is not downscaled, so use coordinates as you read them off the image.`,
        },
        {
          type: 'image',
          data: buffer.toString('base64'),
          mimeType,
        },
      ],
    };
  }
}
