// Runtime / playtest / eval / simulation tools, split out of the RobloxStudioTools
// monolith: synchronous + async Luau execution and job polling, runtime eval on
// live server/client peers, network + device-simulator state, runtime logs, the
// script profiler, breakpoints, screenshots/device-matrix capture, single- and
// multi-client playtest lifecycle (start/stop + StudioTestService multiplayer),
// undo/redo, synthetic mouse/keyboard input + character navigation, and the
// playtest-telemetry / gameplay-assertion QA primitives.
//
// This is the most stateful domain: it owns peer routing (_resolveRuntime and the
// role-set helpers), the runtime-role wait loops, image capture/encoding, and the
// multiplayer-session state builder. The facade delegates here with identical
// public signatures so the schema-parity invariants hold (instance_id stays the
// last optional param). _safetyGate and _runGeneratedLuau stay in the facade
// (shared with non-runtime domains); the safety gate + recordOperation are injected.

import { StudioHttpClient } from './studio-client.js';
import { BridgeService, RoutingFailure } from '../bridge-service.js';
import type { OperationKind } from '../safety/safety-manager.js';
import { buildPlaytestSampleLuau, type TelemetryDomain } from '../builders/playtest-telemetry.js';
import { buildGameplayAssertionsLuau, type GameplayAssertion } from '../builders/gameplay-assertions.js';
import type { EpisodeStore } from './episode-store.js';
import {
  diffEpisodes,
  proposeNextAction,
  failedAssertionsOf,
  implicatedScriptsOf,
} from './episode-reasoning.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_DEVICE_MATRIX_ENTRIES,
  MAX_INLINE_IMAGE_BYTES,
  SIMULATION_PERSISTENCE_NOTES,
  buildDeviceSimulatorLuau,
  buildNetworkProfileLuau,
  buildNetworkStateLuau,
  encodeImageFromRgbaResponse,
  errorMessage,
  hasDeviceSimulatorSettings,
  normalizeExecuteLuauToolResult,
  normalizeDeviceSimulatorSettings,
  normalizeNetworkProfile,
  sleep,
  type DeviceSimulatorMatrixEntry,
  type DeviceSimulatorSettings,
  type EncodedViewportCapture,
  type RawImageCaptureResponse,
  type SafetyOptions,
  type SimulationInclude,
  type ToolContent,
  wrapToolJsonText,
} from './runtime-support.js';

type RuntimeToolRuntime = {
  bridge: BridgeService;
  client: StudioHttpClient;
  callSingle(endpoint: string, data: unknown, target: string | undefined, instance_id: string | undefined): Promise<any>;
  safetyGate(
    kind: OperationKind,
    detail: string,
    input: { path?: string; count?: number; scriptSize?: number; code?: string },
    options?: SafetyOptions,
  ): { content: ToolContent[] } | null;
  recordOperation(kind: OperationKind, summary: string): void;
  episodes: EpisodeStore;
};

export class RuntimeTools {
  constructor(private readonly runtime: RuntimeToolRuntime) {}

  private get bridge(): BridgeService { return this.runtime.bridge; }
  private get client(): StudioHttpClient { return this.runtime.client; }
  private _callSingle(endpoint: string, data: any, target: string | undefined, instance_id: string | undefined): Promise<any> {
    return this.runtime.callSingle(endpoint, data, target, instance_id);
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
    const equivalentIds = new Set(this.bridge.getEquivalentInstanceIds(resolvedId));
    const instances = this.bridge
      .getInstances()
      .filter((i) => equivalentIds.has(i.instanceId));
    // Prefer client-1 when several clients are connected (multi-client playtest).
    const client = instances
      .filter((inst) => inst.role.startsWith('client'))
      .sort((a, b) => a.role.localeCompare(b.role))[0];
    return { instanceId: client?.instanceId ?? resolvedId, clientRole: client?.role };
  }

  private _resolveInstanceIdOnly(instance_id?: string): string {
    const instances = this.bridge.getInstances();
    const publicList = this.bridge.getPublicInstances();
    const errorData = { instances: publicList, count: publicList.length };

    if (instance_id !== undefined) {
      const resolvedInstanceId = this.bridge.resolveInstanceId(instance_id);
      if (!instances.some((i) => i.instanceId === resolvedInstanceId)) {
        throw new RoutingFailure({
          code: 'unrecognized_instance_id',
          message: `instance_id "${instance_id}" is not connected. Pass one from data.instances.`,
          data: errorData,
        });
      }
      return resolvedInstanceId;
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

  private _rolesForEquivalentInstances(instanceId: string): string[] {
    const instanceIds = new Set(this.bridge.getEquivalentInstanceIds(instanceId));
    return this.bridge.getInstances()
      .filter((i) => instanceIds.has(i.instanceId))
      .map((i) => i.role);
  }

  private _clientRolesForInstance(instanceId: string): string[] {
    return this._rolesForInstance(instanceId)
      .filter((role) => /^client-\d+$/.test(role))
      .sort((a, b) => Number(a.slice('client-'.length)) - Number(b.slice('client-'.length)));
  }

  private _runtimeTargetsForEquivalentInstances(instanceId: string): { instanceId: string; role: string }[] {
    const instanceIds = new Set(this.bridge.getEquivalentInstanceIds(instanceId));
    return this.bridge.getInstances()
      .filter((i) => instanceIds.has(i.instanceId) && (i.role === 'server' || /^client-\d+$/.test(i.role)))
      .map((i) => ({ instanceId: i.instanceId, role: i.role }));
  }

  private _resolveDeviceSimulatorSingleTarget(
    target: string | undefined,
    instance_id: string | undefined,
    toolName: string,
  ): { instanceId: string; role: string; selectedTarget: string } {
    const selectedTarget = target ?? 'edit';
    if (selectedTarget === 'server' || selectedTarget === 'all' || selectedTarget === 'all-clients' || selectedTarget === 'edit-proxy') {
      throw new Error(`${toolName} target must be "edit" or "client-N" (got: ${selectedTarget})`);
    }
    if (selectedTarget !== 'edit' && !/^client-\d+$/.test(selectedTarget)) {
      throw new Error(`${toolName} target must be "edit" or "client-N" (got: ${selectedTarget})`);
    }
    const resolved = this._resolveSingleTarget(selectedTarget, instance_id);
    return { ...resolved, selectedTarget };
  }

  private _resolveDeviceSimulatorSetTargets(
    target: string | undefined,
    instance_id: string | undefined,
  ): { instanceId: string; selectedTarget: string; roles: string[] } {
    const selectedTarget = target ?? 'edit';
    if (selectedTarget === 'all-clients') {
      const instanceId = this._resolveInstanceIdOnly(instance_id);
      const roles = this._clientRolesForInstance(instanceId);
      if (roles.length === 0) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no connected playtest client roles. Start a playtest first.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      return { instanceId, selectedTarget, roles };
    }

    const resolved = this._resolveDeviceSimulatorSingleTarget(selectedTarget, instance_id, 'set_device_simulator');
    return { instanceId: resolved.instanceId, selectedTarget, roles: [resolved.role] };
  }

  private _normalizeSimulationInclude(include: string | undefined): SimulationInclude {
    const selectedInclude = include ?? 'both';
    if (selectedInclude !== 'network' && selectedInclude !== 'deviceSimulator' && selectedInclude !== 'both') {
      throw new Error(`get_simulation_state include must be "network", "deviceSimulator", or "both" (got: ${selectedInclude})`);
    }
    return selectedInclude;
  }

  private _resolveSimulationTargets(
    target: string | undefined,
    instance_id: string | undefined,
    toolName: string,
  ): { instanceId: string; selectedTarget: string; roles: string[]; warnings: string[] } {
    const selectedTarget = target ?? 'edit-and-clients';
    if (selectedTarget === 'server' || selectedTarget === 'all' || selectedTarget === 'edit-proxy') {
      throw new Error(`${toolName} target must be "edit", "client-N", "all-clients", or "edit-and-clients" (got: ${selectedTarget})`);
    }

    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const connectedRoles = this._rolesForInstance(instanceId);
    const clientRoles = this._clientRolesForInstance(instanceId);
    const warnings: string[] = [];
    let roles: string[];

    if (selectedTarget === 'edit') {
      if (!connectedRoles.includes('edit')) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no role "edit". Available roles: ${connectedRoles.join(', ') || 'none'}.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      roles = ['edit'];
    } else if (selectedTarget === 'all-clients') {
      roles = clientRoles;
      if (roles.length === 0) {
        warnings.push(`No connected playtest client roles found for instance "${instanceId}".`);
      }
    } else if (selectedTarget === 'edit-and-clients') {
      roles = [];
      if (connectedRoles.includes('edit')) {
        roles.push('edit');
      } else {
        warnings.push(`No edit role found for instance "${instanceId}".`);
      }
      roles.push(...clientRoles);
    } else if (/^client-\d+$/.test(selectedTarget)) {
      if (!clientRoles.includes(selectedTarget)) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no role "${selectedTarget}". Available client roles: ${clientRoles.join(', ') || 'none'}.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      roles = [selectedTarget];
    } else {
      throw new Error(`${toolName} target must be "edit", "client-N", "all-clients", or "edit-and-clients" (got: ${selectedTarget})`);
    }

    return { instanceId, selectedTarget, roles, warnings };
  }

  private _parseExecuteLuauJsonResponse(response: unknown, toolName: string): unknown {
    const r = response as { success?: boolean; error?: string; message?: string; returnValue?: unknown };
    if (r?.success === false) {
      throw new Error(r.error || r.message || `${toolName} Luau execution failed`);
    }
    if (typeof r?.returnValue !== 'string') {
      return response;
    }
    if (r.returnValue === '') {
      return {};
    }
    try {
      return JSON.parse(r.returnValue);
    } catch {
      throw new Error(`${toolName} returned non-JSON data: ${r.returnValue}`);
    }
  }

  private async _executeNetworkStateOperation(
    instanceId: string,
    role: string,
    operation: 'get' | 'reset',
  ): Promise<unknown> {
    const code = buildNetworkStateLuau(operation);
    const response = await this.client.request('/api/execute-luau', { code }, instanceId, role);
    return this._parseExecuteLuauJsonResponse(response, `network simulation ${operation}`);
  }

  private async _executeDeviceSimulatorOperation(
    instanceId: string,
    role: string,
    operation: 'get' | 'set',
    options: Record<string, unknown>,
  ): Promise<unknown> {
    const code = buildDeviceSimulatorLuau(operation, options);
    const response = await this.client.request('/api/execute-luau', { code }, instanceId, role);
    return this._parseExecuteLuauJsonResponse(response, `device simulator ${operation}`);
  }

  private _settingsFromDeviceSimulatorState(state: unknown): DeviceSimulatorSettings | { stopSimulation: true } {
    const s = state as {
      isSimulating?: boolean;
      activeDeviceId?: unknown;
      orientation?: unknown;
      resolution?: unknown;
      pixelDensity?: unknown;
      scalingMode?: unknown;
    };
    if (!s || s.isSimulating !== true || typeof s.activeDeviceId !== 'string' || s.activeDeviceId === 'default') {
      return { stopSimulation: true };
    }
    return normalizeDeviceSimulatorSettings({
      deviceId: s.activeDeviceId,
      orientation: s.orientation,
      resolution: s.resolution,
      pixelDensity: s.pixelDensity,
      scalingMode: s.scalingMode,
    });
  }

  private _deviceSimulatorStateWithoutDeviceList(state: unknown): unknown {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      return state;
    }
    const { devices: _devices, ...rest } = state as Record<string, unknown>;
    return rest;
  }

  private _assertCanRestoreDeviceSimulatorState(state: unknown): void {
    const s = state as {
      isSimulating?: boolean;
      activeDeviceId?: unknown;
      devices?: unknown;
    };
    if (!s || s.isSimulating !== true || typeof s.activeDeviceId !== 'string' || s.activeDeviceId === 'default') {
      return;
    }
    const devices = Array.isArray(s.devices) ? s.devices : [];
    const isBuiltIn = devices.some((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
      const device = entry as { DeviceId?: unknown; deviceId?: unknown; Id?: unknown; id?: unknown; IsCustom?: unknown };
      const id = device.DeviceId ?? device.deviceId ?? device.Id ?? device.id;
      return id === s.activeDeviceId && device.IsCustom !== true;
    });
    if (!isBuiltIn) {
      throw new Error(
        `capture_device_matrix cannot safely restore active custom device "${s.activeDeviceId}". ` +
        'Switch the simulator to default or a built-in preset first, or pass restoreAfter=false only if you intentionally accept changing the simulator state.',
      );
    }
  }

  private async _waitForRuntimeRoles(
    instanceId: string,
    opts: { server?: boolean; clientCount?: number; absentRole?: string; noRuntime?: boolean },
    timeoutSec = 30,
    equivalentInstances = false,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const roles = equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId);
      const clientRoles = equivalentInstances
        ? roles.filter((role) => /^client-\d+$/.test(role))
        : this._clientRolesForInstance(instanceId);
      const hasServer = !opts.server || roles.includes('server');
      const hasClients = opts.clientCount === undefined || clientRoles.length >= opts.clientCount;
      const absent = opts.absentRole === undefined || !roles.includes(opts.absentRole);
      const runtimeAbsent = !opts.noRuntime || !roles.some((role) => role === 'server' || /^client-\d+$/.test(role));
      if (hasServer && hasClients && absent && runtimeAbsent) {
        return { ok: true, roles, timedOut: false };
      }
      await sleep(250);
    }
    return {
      ok: false,
      roles: equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId),
      timedOut: true,
    };
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
    equivalentInstances = false,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const instanceIds = equivalentInstances ? new Set(this.bridge.getEquivalentInstanceIds(instanceId)) : new Set([instanceId]);
      const instances = this.bridge.getInstances().filter((i) => instanceIds.has(i.instanceId));
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
    return {
      ok: false,
      roles: equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId),
      timedOut: true,
    };
  }

  async executeLuau(code: string, target?: string, instance_id?: string, options?: SafetyOptions) {
    if (!code) {
      throw new Error('Code is required for execute_luau');
    }
    const gated = this.runtime.safetyGate('execute_luau', 'run Luau in Studio', { code }, options);
    if (gated) return gated;
    const response = await this._callSingle('/api/execute-luau', { code }, target || 'edit', instance_id);
    this.runtime.recordOperation('execute_luau', `ran Luau (${code.length} chars)`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  // Async Luau jobs: start returns a jobId immediately; status/result are polled.
  // Same safety gate as execute_luau, since arbitrary code still runs.
  async executeLuauAsync(code: string, target?: string, instance_id?: string, options?: SafetyOptions) {
    if (!code) {
      throw new Error('Code is required for execute_luau_async');
    }
    const gated = this.runtime.safetyGate('execute_luau', 'run Luau in Studio (async)', { code }, options);
    if (gated) return gated;
    const response = await this._callSingle('/api/execute-luau-async', { code }, target || 'edit', instance_id);
    this.runtime.recordOperation('execute_luau', `started async Luau job (${code.length} chars)`);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] as ToolContent[] };
  }

  async getJobStatus(jobId: string, target?: string, instance_id?: string) {
    if (!jobId) throw new Error('jobId is required for get_job_status');
    const response = await this._callSingle('/api/get-job-status', { jobId }, target || 'edit', instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] as ToolContent[] };
  }

  async getJobResult(jobId: string, target?: string, instance_id?: string) {
    if (!jobId) throw new Error('jobId is required for get_job_result');
    const response = await this._callSingle('/api/get-job-result', { jobId }, target || 'edit', instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] as ToolContent[] };
  }

  async cancelJob(jobId: string, target?: string, instance_id?: string) {
    if (!jobId) throw new Error('jobId is required for cancel_job');
    const response = await this._callSingle('/api/cancel-job', { jobId }, target || 'edit', instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] as ToolContent[] };
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

  async setNetworkProfile(profile: string, target?: string, overrides?: Record<string, unknown>, instance_id?: string) {
    const values = normalizeNetworkProfile(profile, overrides);
    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const clientRoles = this._clientRolesForInstance(instanceId);
    const selectedTarget = target ?? 'client-1';

    let targetRoles: string[];
    if (selectedTarget === 'all-clients') {
      targetRoles = clientRoles;
    } else if (/^client-\d+$/.test(selectedTarget)) {
      if (!clientRoles.includes(selectedTarget)) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no role "${selectedTarget}". Available client roles: ${clientRoles.join(', ') || 'none'}.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      targetRoles = [selectedTarget];
    } else {
      throw new Error(`set_network_profile target must be "client-N" or "all-clients" (got: ${selectedTarget})`);
    }

    if (targetRoles.length === 0) {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: `instance "${instanceId}" has no connected playtest client roles. Start a playtest first.`,
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }

    const code = buildNetworkProfileLuau(profile, values);
    const responses = await Promise.allSettled(
      targetRoles.map(async (role) => {
        const response = await this.client.request('/api/execute-luau', { code }, instanceId, role);
        const result = this._parseExecuteLuauJsonResponse(response, 'set_network_profile');
        return { role, result };
      }),
    );

    const body: Record<string, unknown> = {
      profile,
      target: selectedTarget,
      applied: values,
      targets: {},
    };
    const targetResults = body.targets as Record<string, unknown>;
    const failures: string[] = [];
    for (let i = 0; i < responses.length; i++) {
      const role = targetRoles[i];
      const response = responses[i];
      if (response.status === 'fulfilled') {
        targetResults[role] = response.value.result;
      } else {
        const message = errorMessage(response.reason);
        targetResults[role] = { error: message };
        failures.push(`${role}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`set_network_profile failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(body)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(body),
        },
      ],
    };
  }

  async getSimulationState(include?: string, target?: string, instance_id?: string) {
    const selectedInclude = this._normalizeSimulationInclude(include);
    const includeNetwork = selectedInclude === 'network' || selectedInclude === 'both';
    const includeDeviceSimulator = selectedInclude === 'deviceSimulator' || selectedInclude === 'both';
    const resolved = this._resolveSimulationTargets(target, instance_id, 'get_simulation_state');

    const roleEntries = await Promise.all(resolved.roles.map(async (role) => {
      const state: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      if (includeNetwork) {
        try {
          state.network = await this._executeNetworkStateOperation(resolved.instanceId, role, 'get');
        } catch (error) {
          errors.network = errorMessage(error);
        }
      }

      if (includeDeviceSimulator) {
        try {
          state.deviceSimulator = await this._executeDeviceSimulatorOperation(
            resolved.instanceId,
            role,
            'get',
            { includeDeviceList: false },
          );
        } catch (error) {
          errors.deviceSimulator = errorMessage(error);
        }
      }

      if (Object.keys(errors).length > 0) {
        state.errors = errors;
      }
      return { role, state };
    }));

    const roles: Record<string, unknown> = {};
    for (const entry of roleEntries) {
      roles[entry.role] = entry.state;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          include: selectedInclude,
          target: resolved.selectedTarget,
          roles,
          warnings: resolved.warnings,
          persistenceNotes: SIMULATION_PERSISTENCE_NOTES,
        }),
      }],
    };
  }

  async resetSimulationState(target?: string, network?: boolean, deviceSimulator?: boolean, instance_id?: string) {
    const resetNetwork = network !== false;
    const resetDeviceSimulator = deviceSimulator !== false;
    if (!resetNetwork && !resetDeviceSimulator) {
      throw new Error('reset_simulation_state requires network=true and/or deviceSimulator=true; both default to true');
    }

    const resolved = this._resolveSimulationTargets(target, instance_id, 'reset_simulation_state');
    const roleEntries = await Promise.all(resolved.roles.map(async (role) => {
      const result: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      if (resetNetwork) {
        try {
          result.network = await this._executeNetworkStateOperation(resolved.instanceId, role, 'reset');
        } catch (error) {
          errors.network = errorMessage(error);
        }
      }

      if (resetDeviceSimulator) {
        try {
          result.deviceSimulator = await this._executeDeviceSimulatorOperation(
            resolved.instanceId,
            role,
            'set',
            { stopSimulation: true },
          );
        } catch (error) {
          errors.deviceSimulator = errorMessage(error);
        }
      }

      if (Object.keys(errors).length > 0) {
        result.errors = errors;
      }
      return { role, result };
    }));

    const roles: Record<string, unknown> = {};
    const failures: string[] = [];
    for (const entry of roleEntries) {
      roles[entry.role] = entry.result;
      const errors = (entry.result as { errors?: Record<string, string> }).errors;
      if (errors) {
        for (const [kind, message] of Object.entries(errors)) {
          failures.push(`${entry.role}.${kind}: ${message}`);
        }
      }
    }

    const body = {
      target: resolved.selectedTarget,
      network: resetNetwork,
      deviceSimulator: resetDeviceSimulator,
      roles,
      warnings: resolved.warnings,
      persistenceNotes: SIMULATION_PERSISTENCE_NOTES,
    };

    if (failures.length > 0) {
      throw new Error(`reset_simulation_state failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(body)}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(body),
      }],
    };
  }

  async getDeviceSimulatorState(target?: string, deviceId?: string, includeDeviceList?: boolean, instance_id?: string) {
    if (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.trim() === '')) {
      throw new Error('deviceId must be a non-empty string when provided');
    }
    const resolved = this._resolveDeviceSimulatorSingleTarget(target, instance_id, 'get_device_simulator_state');
    const state = await this._executeDeviceSimulatorOperation(
      resolved.instanceId,
      resolved.role,
      'get',
      {
        includeDeviceList: includeDeviceList !== false,
        deviceId,
      },
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          target: resolved.selectedTarget,
          role: resolved.role,
          ...(state as Record<string, unknown>),
        }),
      }],
    };
  }

  async setDeviceSimulator(
    target?: string,
    deviceId?: string,
    orientation?: string,
    resolution?: unknown,
    pixelDensity?: number,
    scalingMode?: string,
    stopSimulation?: boolean,
    instance_id?: string,
  ) {
    const settings = normalizeDeviceSimulatorSettings({ deviceId, orientation, resolution, pixelDensity, scalingMode });
    if (stopSimulation === true && hasDeviceSimulatorSettings(settings)) {
      throw new Error('stopSimulation=true cannot be combined with deviceId, orientation, resolution, pixelDensity, or scalingMode');
    }
    if (stopSimulation !== true && !hasDeviceSimulatorSettings(settings)) {
      throw new Error('set_device_simulator requires stopSimulation=true or at least one simulator setting');
    }

    const resolved = this._resolveDeviceSimulatorSetTargets(target, instance_id);
    const responses = await Promise.allSettled(
      resolved.roles.map(async (role) => {
        const result = await this._executeDeviceSimulatorOperation(
          resolved.instanceId,
          role,
          'set',
          stopSimulation === true ? { stopSimulation: true } : { settings },
        );
        return { role, result };
      }),
    );

    const body: Record<string, unknown> = {
      target: resolved.selectedTarget,
      targets: {},
    };
    const targets = body.targets as Record<string, unknown>;
    const failures: string[] = [];
    for (let i = 0; i < responses.length; i++) {
      const role = resolved.roles[i];
      const response = responses[i];
      if (response.status === 'fulfilled') {
        targets[role] = response.value.result;
      } else {
        const message = errorMessage(response.reason);
        targets[role] = { error: message };
        failures.push(`${role}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`set_device_simulator failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(body)}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(body),
      }],
    };
  }

  async captureDeviceMatrix(
    entries: unknown,
    target?: string,
    format?: string,
    quality?: number,
    settleSeconds?: number,
    restoreAfter?: boolean,
    instance_id?: string,
  ) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('capture_device_matrix requires a non-empty entries array');
    }
    if (entries.length > MAX_DEVICE_MATRIX_ENTRIES) {
      throw new Error(`capture_device_matrix supports at most ${MAX_DEVICE_MATRIX_ENTRIES} entries per call; split larger matrices into multiple calls`);
    }

    const matrixEntries: DeviceSimulatorMatrixEntry[] = entries.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`entries[${index}] must be an object`);
      }
      const raw = entry as Record<string, unknown>;
      if (raw.label !== undefined && typeof raw.label !== 'string') {
        throw new Error(`entries[${index}].label must be a string when provided`);
      }
      return {
        ...normalizeDeviceSimulatorSettings({
          deviceId: raw.deviceId,
          orientation: raw.orientation,
          resolution: raw.resolution,
          pixelDensity: raw.pixelDensity,
          scalingMode: raw.scalingMode,
        }),
        label: raw.label as string | undefined,
      };
    });

    const resolved = this._resolveDeviceSimulatorSingleTarget(target, instance_id, 'capture_device_matrix');
    if (resolved.role.startsWith('client-') && await this._isMultiplayerTestRunning(resolved.instanceId)) {
      throw new Error('capture_device_matrix does not support StudioTestService multiplayer client targets because Roblox scopes temporary screenshot textures per client process');
    }

    const settleMs = settleSeconds === undefined ? 300 : Math.max(0, Math.floor(settleSeconds * 1000));
    const shouldRestore = restoreAfter !== false;
    const before = await this._executeDeviceSimulatorOperation(
      resolved.instanceId,
      resolved.role,
      'get',
      { includeDeviceList: shouldRestore },
    );
    if (shouldRestore) {
      this._assertCanRestoreDeviceSimulatorState(before);
    }

    const summary: Record<string, unknown> = {
      target: resolved.selectedTarget,
      role: resolved.role,
      restoreAfter: shouldRestore,
      before: this._deviceSimulatorStateWithoutDeviceList(before),
      entries: [],
    };
    const entrySummaries = summary.entries as Array<Record<string, unknown>>;
    const content: ToolContent[] = [];
    const failures: string[] = [];

    try {
      for (let i = 0; i < matrixEntries.length; i++) {
        const entry = matrixEntries[i];
        const label = entry.label ?? `entry-${i + 1}`;
        const entrySummary: Record<string, unknown> = {
          index: i,
          label,
          settings: entry,
        };
        entrySummaries.push(entrySummary);

        try {
          const { label: _label, ...settings } = entry;
          const applied = await this._executeDeviceSimulatorOperation(
            resolved.instanceId,
            resolved.role,
            'set',
            { settings },
          );
          entrySummary.applied = applied;
          if (settleMs > 0) await sleep(settleMs);

          const capture = await this._captureViewportImage(resolved.instanceId, resolved.role, format, quality);
          if (capture.success) {
            entrySummary.screenshot = {
              width: capture.width,
              height: capture.height,
              format: capture.format,
              quality: capture.quality,
              mimeType: capture.mimeType,
            };
            content.push({
              type: 'text',
              text: `capture_device_matrix ${i + 1}/${matrixEntries.length} ${label}: ${capture.message}`,
            });
            content.push({
              type: 'image',
              data: capture.data,
              mimeType: capture.mimeType,
            });
          } else {
            entrySummary.error = capture.error;
            failures.push(`${label}: ${capture.error}`);
            content.push({
              type: 'text',
              text: `capture_device_matrix ${i + 1}/${matrixEntries.length} ${label}: ${capture.error}`,
            });
          }
        } catch (error) {
          const message = errorMessage(error);
          entrySummary.error = message;
          failures.push(`${label}: ${message}`);
          content.push({
            type: 'text',
            text: `capture_device_matrix ${i + 1}/${matrixEntries.length} ${label}: ${message}`,
          });
        }
      }
    } finally {
      if (shouldRestore) {
        try {
          const restoreSettings = this._settingsFromDeviceSimulatorState(before);
          if ('stopSimulation' in restoreSettings) {
            summary.restore = await this._executeDeviceSimulatorOperation(
              resolved.instanceId,
              resolved.role,
              'set',
              { stopSimulation: true },
            );
          } else {
            summary.restore = await this._executeDeviceSimulatorOperation(
              resolved.instanceId,
              resolved.role,
              'set',
              { settings: restoreSettings },
            );
          }
        } catch (error) {
          const message = errorMessage(error);
          summary.restoreError = message;
          failures.push(`restore: ${message}`);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`capture_device_matrix failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(summary)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary),
        },
        ...content,
      ],
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

  async captureScriptProfiler(target?: string, request: Record<string, unknown> = {}, instance_id?: string) {
    const targetRole = target ?? 'server';
    const data: Record<string, unknown> = { ...request };
    const outputPath = data.output_path;
    delete data.output_path;

    if (outputPath !== undefined && typeof outputPath !== 'string') {
      throw new Error('output_path must be a string when provided');
    }
    if (outputPath) {
      data.__mcp_include_raw_json = true;
    }

    const resolved = this.bridge.resolveTarget({ instance_id, target: targetRole });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'capture_script_profiler profiles one runtime peer at a time. Pick target="server" or a specific "client-N".',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }

    data.__mcp_instance_id = resolved.targetInstanceId;
    data.__mcp_target_role = resolved.targetRole;
    const response = await this.client.request(
      '/api/capture-script-profiler',
      data,
      resolved.targetInstanceId,
      resolved.targetRole,
    );

    const body: unknown = response !== null && typeof response === 'object' && !Array.isArray(response)
      ? { ...response, target: resolved.targetRole }
      : response;

    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const mutable = body as Record<string, unknown>;
      const rawJson = mutable.raw_json;
      if (typeof rawJson === 'string') {
        if (typeof outputPath === 'string' && outputPath !== '') {
          const resolvedOutputPath = path.resolve(outputPath);
          fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
          fs.writeFileSync(resolvedOutputPath, rawJson, 'utf8');
          mutable.output_path = resolvedOutputPath;
        }
        delete mutable.raw_json;
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }

  async breakpoints(action: string, request: Record<string, unknown> = {}, target?: string, instance_id?: string) {
    if (!action || typeof action !== 'string') {
      throw new Error('breakpoints requires action=set|remove|clear|list');
    }

    const targetRole = target ?? 'edit';
    const data: Record<string, unknown> = { ...request, action };
    delete data.target;
    delete data.instance_id;

    const resolved = this.bridge.resolveTarget({ instance_id, target: targetRole });
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

    data.__mcp_instance_id = resolved.targetInstanceId;
    data.__mcp_target_role = resolved.targetRole;
    const response = await this.client.request(
      '/api/breakpoints',
      data,
      resolved.targetInstanceId,
      resolved.targetRole,
    );

    const body = response !== null && typeof response === 'object' && !Array.isArray(response)
      ? { ...response, target: resolved.targetRole }
      : response;

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
      wait = await this._waitForRuntimeRolesFresh(resolved.targetInstanceId, startedAt, requiredRoles, 60, true);
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
    // The edit DM's stopPlaytest handler writes a plugin:SetSetting request
    // that StopPlayMonitor reads from inside the play-server DM (the only DM where
    // StudioTestService:EndTest is legal). No edit-proxy peer registration is
    // involved — the cross-DM signal works regardless of MCP server state,
    // peer-role bookkeeping, or restart cycles.
    const { instanceId } = this._resolveSingleTarget('edit', instance_id);
    let response: Record<string, unknown>;
    let stopRequestError: string | undefined;
    try {
      response = await this.client.request('/api/stop-playtest', {}, instanceId, 'edit');
    } catch (error) {
      stopRequestError = errorMessage(error);
      response = {
        success: false,
        error: 'Edit stop request failed.',
        detail: stopRequestError,
      };
    }
    let wait: { ok: boolean; roles: string[]; timedOut: boolean } | undefined;
    if (response?.success === true) {
      wait = await this._waitForRuntimeRoles(instanceId, { noRuntime: true }, 15, true);
    } else if (this._runtimeTargetsForEquivalentInstances(instanceId).length > 0) {
      wait = {
        ok: false,
        roles: this._rolesForEquivalentInstances(instanceId),
        timedOut: false,
      };
    }
    const body = wait
      ? {
        ...response,
        runtimeStopped: wait.ok,
        timedOut: wait.timedOut,
        roles: wait.roles,
      }
      : response;
    if (wait && !wait.ok) {
      const runtimeRoles = wait.roles.filter((role) => role === 'server' || /^client-\d+$/.test(role));
      const failureBody = {
        ...body,
        success: false,
        error: 'Playtest teardown did not complete.',
        message: response?.success === true
          ? wait.timedOut
            ? 'Stop signal was accepted, but runtime peers did not disconnect before timeout.'
            : 'Stop signal was accepted, but runtime peers are still connected.'
          : 'Edit stop request failed, and runtime peers are still connected.',
        stopSignalAccepted: response?.success === true,
        stopRequestError,
        runtimeRoles,
        possibleCause:
          'A game shutdown hook such as BindToClose may be blocking Studio teardown. ' +
          'No runtime hard-stop or synthetic keyboard fallback was attempted.',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(failureBody) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
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
    const roles = this._rolesForInstance(instanceId);
    const hasServer = roles.includes('server');
    const clientCount = roles.filter((role) => role.startsWith('client-')).length;
    if (roles.includes('edit')) {
      try {
        const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        const phase = editState?.session?.phase;
        if (phase === 'starting' || phase === 'running') return true;
      } catch {
        // Fall through to the runtime-shape heuristic below. Direct/manual
        // StudioTestService multiplayer sessions do not update the edit peer's
        // MCP-managed session state, but they still expose distinct server and
        // client plugin peers.
      }
    }
    return hasServer && clientCount >= 2;
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

  // Live playtest telemetry: sample runtime state (players/world/audio/runtime) on
  // a running peer. Defaults to the live server DataModel.
  async playtestSampleState(domains?: TelemetryDomain[], target?: string, instance_id?: string) {
    const code = buildPlaytestSampleLuau(domains ?? []);
    const response = await this._callSingle('/api/execute-luau', { code }, target || 'server', instance_id);
    return wrapToolJsonText(normalizeExecuteLuauToolResult(response, {
      error: 'playtest_sample_state returned non-object execute-luau output',
    })) as { content: ToolContent[] };
  }

  // Gameplay assertions: run named boolean checks against the DataModel, structured
  // pass/fail — the prove-the-fix QA primitive.
  async runGameplayAssertions(assertions: GameplayAssertion[], target?: string, instance_id?: string) {
    if (!Array.isArray(assertions) || assertions.length === 0) {
      throw new Error('assertions (a non-empty array) is required for run_gameplay_assertions');
    }
    const response = await this._callSingle('/api/execute-luau', { code: buildGameplayAssertionsLuau(assertions) }, target || 'edit', instance_id);
    return wrapToolJsonText(normalizeExecuteLuauToolResult(response, {
      results: [],
      summary: { total: assertions.length, passed: 0, failed: assertions.length },
      allPassed: false,
      error: 'run_gameplay_assertions returned non-object execute-luau output',
    })) as { content: ToolContent[] };
  }

  // Pull the JSON object back out of a {content:[{text}]} tool envelope (our sibling
  // runtime tools return that shape). Best-effort — a non-JSON body yields {}.
  private _parseToolEnvelope(r: { content?: ReadonlyArray<unknown> }): Record<string, unknown> {
    try {
      const text = (r?.content?.[0] as { text?: string } | undefined)?.text;
      return typeof text === 'string' ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  // One-shot runtime episode: start → (hold) → gather logs/assertions/state → stop,
  // returning a single verdict-bearing object so the agent can drive edit→playtest→
  // observe→assert→fix without hand-orchestrating the lifecycle. Composes the existing
  // playtest primitives (no new plugin endpoint). ponytail: returns the episode inline
  // — no resource plane / replay / fix_from_episode until dogfooding asks for them.
  async runPlaytestEpisode(
    mode: string = 'play',
    assertions?: GameplayAssertion[],
    sampleDomains?: TelemetryDomain[],
    durationS?: number,
    instance_id?: string,
  ) {
    const m = mode || 'play';
    if (m !== 'play' && m !== 'run') throw new Error('mode must be "play" or "run"');
    const episodeId = `ep_${Date.now().toString(36)}`;
    const startedAt = Date.now();

    // 1. Start and wait for a ready runtime (startPlaytest already polls for peers).
    const start = this._parseToolEnvelope(await this.startPlaytest(m, undefined, instance_id));
    const runtimeReady = start.runtimeReady === true || (start.runtimeReady === undefined && start.success === true);
    const episodeUri = `roblox://playtest/episode/${episodeId}`;
    if (!runtimeReady) {
      const episode = {
        episodeId, episodeUri, mode: m, verdict: 'error', runtimeReady: false,
        error: start.error ?? 'Playtest did not reach a ready runtime.',
        start,
        hint: 'Could not start the playtest — check the place compiles and that no other playtest is already running.',
      };
      this.runtime.episodes.add({ ...episode, createdAt: Date.now() });
      return wrapToolJsonText(episode) as { content: ToolContent[] };
    }

    // 2. Let gameplay actually happen before we observe (bounded 0–30s).
    const holdMs = Math.min(Math.max(0, Math.floor((durationS ?? 3) * 1000)), 30000);
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));

    // 3. Gather the evidence.
    let assertionsResult: Record<string, unknown> | undefined;
    if (assertions && assertions.length > 0) {
      assertionsResult = this._parseToolEnvelope(await this.runGameplayAssertions(assertions, 'server', instance_id));
    }
    let state: Record<string, unknown> | undefined;
    if (sampleDomains && sampleDomains.length > 0) {
      state = this._parseToolEnvelope(await this.playtestSampleState(sampleDomains, 'server', instance_id));
    }
    const logs = this._parseToolEnvelope(await this.getRuntimeLogs(undefined, startedAt, 200, undefined, instance_id));
    const entries = Array.isArray(logs.entries) ? (logs.entries as Array<Record<string, unknown>>) : [];
    const levelOf = (e: Record<string, unknown>) => String(e.level ?? e.type ?? '').toLowerCase();
    const errorEntries = entries.filter((e) => levelOf(e).includes('error'));
    const warnEntries = entries.filter((e) => levelOf(e).includes('warn'));

    // 4. Stop the playtest.
    const stop = this._parseToolEnvelope(await this.stopPlaytest(instance_id));

    // 5. Verdict: fail on any failed assertion or any logged runtime error.
    const assertionsFailed = assertionsResult ? assertionsResult.allPassed === false : false;
    const hadErrors = errorEntries.length > 0;
    const verdict = assertionsFailed || hadErrors ? 'fail' : 'pass';

    const episode = {
      episodeId, episodeUri, mode: m, durationS: holdMs / 1000, runtimeReady: true, verdict,
      assertions: assertionsResult,
      state,
      logs: {
        errorCount: errorEntries.length,
        warningCount: warnEntries.length,
        errors: errorEntries.slice(0, 20),
        warnings: warnEntries.slice(0, 10),
      },
      stopped: stop.success !== false,
      hint: verdict === 'pass'
        ? 'Episode passed — no runtime errors and all assertions held.'
        : assertionsFailed
          ? 'Assertions failed — inspect "assertions.results" for the failing checks, fix, then re-run run_playtest_episode to confirm.'
          : 'Runtime errors were logged — inspect "logs.errors", fix, then re-run run_playtest_episode to confirm.',
    };
    // Persist so the agent can re-read / compare it across turns via the resource
    // plane (roblox://playtest/episode/{id}) and summarize_episode without re-running.
    this.runtime.episodes.add({ ...episode, createdAt: Date.now() });
    return wrapToolJsonText(episode) as { content: ToolContent[] };
  }

  // Distill a stored episode into the few facts that matter — verdict, what failed
  // (failed assertions + error log lines), the scripts those errors implicate, and a
  // suggested next step. Optionally diff against a prior episode to PROVE a fix
  // (fail→pass = fixed). Reads the in-memory store; no Studio round-trip.
  summarizeEpisode(episodeId: string, comparedToEpisodeId?: string) {
    const ep = this.runtime.episodes.get(episodeId);
    if (!ep) {
      return wrapToolJsonText({
        error: `No episode "${episodeId}" in the store (it may have aged out).`,
        known: this.runtime.episodes.list().slice(0, 10),
      }) as { content: ToolContent[] };
    }
    const logs = (ep.logs ?? {}) as { errors?: Array<{ message?: string }>; errorCount?: number; warningCount?: number };
    const errorLines = (logs.errors ?? []).map((e) => String(e.message ?? '')).filter(Boolean);
    const failedAssertions = failedAssertionsOf(ep);
    const implicatedScripts = implicatedScriptsOf(ep);

    let comparison: Record<string, unknown> | undefined;
    if (comparedToEpisodeId) {
      const prev = this.runtime.episodes.get(comparedToEpisodeId);
      comparison = prev
        ? { ...diffEpisodes(prev, ep, comparedToEpisodeId) }
        : { comparedTo: comparedToEpisodeId, error: 'comparison episode not found' };
    }

    return wrapToolJsonText({
      episodeId, verdict: ep.verdict, mode: ep.mode,
      errorCount: logs.errorCount ?? errorLines.length,
      warningCount: logs.warningCount ?? 0,
      failedAssertions,
      topErrors: errorLines.slice(0, 5),
      implicatedScripts,
      comparison,
      suggestion: ep.verdict === 'pass'
        ? 'Episode is clean. If this confirms a fix, pass comparedToEpisodeId of the failing run to prove fail→pass.'
        : failedAssertions.length
          ? `Inspect the failing assertion(s) [${failedAssertions.join(', ')}], edit the implicated script, then run_playtest_episode again and summarize with comparedToEpisodeId="${episodeId}".`
          : `Open the implicated script(s) [${implicatedScripts.join(', ') || 'see topErrors'}], fix the error, then re-run run_playtest_episode and compare.`,
    }) as { content: ToolContent[] };
  }

  /** Read a stored episode verbatim (backs the roblox://playtest/episode/{id} resource). */
  getEpisode(episodeId: string) {
    const ep = this.runtime.episodes.get(episodeId);
    return wrapToolJsonText(ep ?? { error: `No episode "${episodeId}" in the store.` }) as { content: ToolContent[] };
  }

  /** Newest-first index of stored episodes (backs roblox://playtest/episodes). */
  listEpisodes() {
    return wrapToolJsonText({ episodes: this.runtime.episodes.list() }) as { content: ToolContent[] };
  }

  // Deterministic "what should I do next" over the stored episodes (Track E). With
  // no episodeId it uses the most recent episode; it also locates the most recent
  // earlier FAILING episode so a clean run is recognized as a fix to prove. Reads
  // the in-memory store only — no Studio round-trip, no LLM turn spent picking the
  // obvious next step in the edit→playtest→observe→fix loop.
  proposeNextAction(episodeId?: string) {
    const rows = this.runtime.episodes.list(); // newest-first
    if (rows.length === 0) {
      return wrapToolJsonText(proposeNextAction(undefined)) as { content: ToolContent[] };
    }
    const targetId = episodeId ?? rows[0].episodeId;
    const latest = this.runtime.episodes.get(targetId);
    if (!latest) {
      return wrapToolJsonText({
        error: `No episode "${targetId}" in the store (it may have aged out).`,
        known: rows.slice(0, 10),
      }) as { content: ToolContent[] };
    }
    // Most recent episode older than the target that did not pass.
    const targetIdx = rows.findIndex((r) => r.episodeId === targetId);
    let priorFailing = undefined;
    for (let i = targetIdx + 1; i < rows.length; i++) {
      if (rows[i].verdict !== 'pass') {
        priorFailing = this.runtime.episodes.get(rows[i].episodeId);
        break;
      }
    }
    const proposal = proposeNextAction(latest, priorFailing);
    return wrapToolJsonText({ episodeId: targetId, ...proposal }) as { content: ToolContent[] };
  }

  private async _captureViewportImage(
    instanceId: string,
    targetRole: string,
    format?: string,
    quality?: number,
  ): Promise<EncodedViewportCapture> {
    let response: RawImageCaptureResponse;
    if (targetRole.startsWith('client-')) {
      // Play mode. The running game VM can trigger CaptureScreenshot but can't
      // read the resulting temp texture back (privilege gate). So capture on
      // the client to get the rbxtemp:// id, then read it back in the edit DM —
      // the rbxtemp handle is process-scoped and the edit/plugin identity is
      // allowed to promote it into a readable EditableImage.
      const begin = await this._callSingle('/api/capture-begin', {}, targetRole, instanceId) as { contentId?: string; error?: string };
      if (begin.error) {
        return { success: false, error: begin.error };
      }
      if (!begin.contentId) {
        return { success: false, error: 'Screenshot capture failed: no content id returned from client.' };
      }
      response = await this._callSingle('/api/capture-read', { contentId: begin.contentId }, 'edit', instanceId) as RawImageCaptureResponse;
    } else {
      // Edit mode: capture and read back in the same (edit) context.
      response = await this._callSingle('/api/capture-screenshot', {}, 'edit', instanceId) as RawImageCaptureResponse;
    }

    if (response.error) {
      let text = response.error;
      if (
        targetRole.startsWith('client-') &&
        response.error.includes('Failed to load texture, unexpected format') &&
        await this._isMultiplayerTestRunning(instanceId)
      ) {
        text =
          'Screenshot capture reached the multiplayer client, but Roblox returned a temporary screenshot texture ' +
          'that the edit peer cannot read in StudioTestService multiplayer sessions. Regular start_playtest capture ' +
          'works because the temporary rbxtemp:// handle is readable from the edit process; multiplayer client handles ' +
          `appear to be scoped to the client process. Raw error: ${response.error}`;
      }
      return { success: false, error: text };
    }

    const w = response.width;
    const h = response.height;
    if (w === undefined || h === undefined) {
      return { success: false, error: 'Screenshot response missing dimensions.' };
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
    const encoded = encodeImageFromRgbaResponse(response, fmt, q);
    let { buffer } = encoded;
    const { mimeType } = encoded;
    let usedQ = q;
    let note = '';

    if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
      if (fmt === 'png') {
        const mb = (buffer.length / 1048576).toFixed(1);
        return {
          success: false,
          error:
            `PNG screenshot is ${mb}MB, over the ~${(MAX_INLINE_IMAGE_BYTES / 1048576).toFixed(0)}MB inline image limit. ` +
            `Use the default jpeg format (optionally with a "quality" value) or make the Studio window smaller for a lossless capture.`,
        };
      }
      while (buffer.length > MAX_INLINE_IMAGE_BYTES && usedQ > 25) {
        usedQ = Math.max(25, usedQ - 20);
        buffer = encodeImageFromRgbaResponse(response, 'jpeg', usedQ).buffer;
      }
      note = ` — auto-reduced to q${usedQ} to fit the inline size limit; enlarge the Studio window or capture a smaller region for finer detail`;
    }

    // Explicit coordinate contract: the image is returned at native viewport
    // resolution and is never downscaled, so its pixel grid IS the coordinate
    // space simulate_mouse_input expects. Stating the dimensions removes any
    // ambiguity about what (x, y) mean.

    const message =
      `Screenshot ${w}x${h}px (${fmt}${fmt === 'jpeg' ? ` q${usedQ}` : ''})${note}. ` +
      `For simulate_mouse_input, x/y are pixel coordinates in this exact image with (0,0) at the ` +
      `top-left; it is not downscaled, so use coordinates as you read them off the image.`;

    return {
      success: true,
      width: w,
      height: h,
      format: fmt,
      quality: fmt === 'jpeg' ? usedQ : undefined,
      note,
      data: buffer.toString('base64'),
      mimeType,
      message,
    };
  }

  async captureScreenshot(instance_id?: string, format?: string, quality?: number) {
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const capture = await this._captureViewportImage(instanceId, clientRole ?? 'edit', format, quality);
    if (!capture.success) {
      return { content: [{ type: 'text', text: capture.error }] };
    }

    return {
      content: [
        {
          type: 'text',
          text: capture.message,
        },
        {
          type: 'image',
          data: capture.data,
          mimeType: capture.mimeType,
        },
      ],
    };
  }
}
