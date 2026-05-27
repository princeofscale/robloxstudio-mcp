import { v4 as uuidv4 } from 'uuid';

export interface PluginInstance {
  // Internal: per-plugin GUID, regenerated on every plugin load.
  // Used as the /poll URL parameter so the server can identify which plugin
  // process is asking for work. Not user-facing — MCP tools and the LLM
  // operate on `instanceId` (the place identifier) plus `role`.
  pluginSessionId: string;
  // User-facing routing key: identifies the place file.
  // Format: "place:${PlaceId}" for published places, "anon:${uuid}" for
  // unpublished places (where the UUID lives on ServerStorage's
  // __MCPPlaceId attribute and travels with the .rbxl).
  instanceId: string;
  role: string;
  placeId: number;
  placeName: string;
  dataModelName: string;
  isRunning: boolean;
  lastActivity: number;
  connectedAt: number;
}

interface PendingRequest {
  id: string;
  endpoint: string;
  data: any;
  targetInstanceId: string;
  targetRole: string;
  timestamp: number;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export type RoutingErrorCode =
  | 'multiple_instances_connected'
  | 'ambiguous_target'
  | 'target_role_required'
  | 'target_role_not_present_on_instance'
  | 'unrecognized_instance_id';

export interface RoutingError {
  code: RoutingErrorCode;
  message: string;
  data: { instances: PublicPluginInstance[]; count: number };
}

// Thrown by tools when resolveTarget returns an error. Caught at the MCP
// transport layer and surfaced as a structured tool-call error so the LLM
// can recover (e.g. pick an instance_id from data.instances) without an
// extra get_connected_instances round-trip.
export class RoutingFailure extends Error {
  readonly routingError: RoutingError;
  constructor(routingError: RoutingError) {
    super(routingError.message);
    this.name = 'RoutingFailure';
    this.routingError = routingError;
  }
}

// Shape exposed to MCP tool callers — strips the internal pluginSessionId.
export interface PublicPluginInstance {
  instanceId: string;
  role: string;
  placeId: number;
  placeName: string;
  dataModelName: string;
  isRunning: boolean;
  lastActivity: number;
  connectedAt: number;
}

export interface ResolveTargetInput {
  instance_id?: string;
  target?: string;
}

export type ResolveTargetResult =
  | { ok: true; mode: 'single'; targetInstanceId: string; targetRole: string }
  | { ok: true; mode: 'fanout'; targets: { targetInstanceId: string; targetRole: string }[] }
  | { ok: false; error: RoutingError };

export interface RegisterInstanceInput {
  pluginSessionId: string;
  instanceId: string;
  role: string;
  placeId?: number;
  placeName?: string;
  dataModelName?: string;
  isRunning?: boolean;
}

export type RegisterInstanceResult =
  | { ok: true; assignedRole: string; instanceId: string }
  | { ok: false; error: { code: 'duplicate_instance_role'; message: string; existing: PublicPluginInstance } };

export function toPublic(inst: PluginInstance): PublicPluginInstance {
  return {
    instanceId: inst.instanceId,
    role: inst.role,
    placeId: inst.placeId,
    placeName: inst.placeName,
    dataModelName: inst.dataModelName,
    isRunning: inst.isRunning,
    lastActivity: inst.lastActivity,
    connectedAt: inst.connectedAt,
  };
}

const STALE_INSTANCE_MS = 30000;

export class BridgeService {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  // Keyed by pluginSessionId (the per-plugin GUID).
  private instances: Map<string, PluginInstance> = new Map();
  private requestTimeout = 30000;

  registerInstance(input: RegisterInstanceInput): RegisterInstanceResult {
    const { pluginSessionId, instanceId, role } = input;
    let assignedRole = role;

    // Client roles get lowest-unused-N, scoped globally (across all places)
    // for now. Two playtests in two different edit instances simultaneously
    // would share the client-N namespace; documented as out-of-scope for
    // v2.12.0 in the briefing.
    if (role === 'client') {
      const used = new Set<number>();
      for (const inst of this.instances.values()) {
        const match = inst.role.match(/^client-(\d+)$/);
        if (match) used.add(Number(match[1]));
      }
      let idx = 1;
      while (used.has(idx)) idx++;
      assignedRole = `client-${idx}`;
    }

    // Reject duplicate (instanceId, role) tuples. This should not be
    // reachable through normal Studio + Team Create usage, but defense in
    // depth: surface it loudly rather than silently misrouting.
    const existing = Array.from(this.instances.values()).find(
      (i) => i.instanceId === instanceId && i.role === assignedRole && i.pluginSessionId !== pluginSessionId,
    );
    if (existing) {
      return {
        ok: false,
        error: {
          code: 'duplicate_instance_role',
          message: `Another plugin is already registered as (${instanceId}, ${assignedRole}).`,
          existing: toPublic(existing),
        },
      };
    }

    this.instances.set(pluginSessionId, {
      pluginSessionId,
      instanceId,
      role: assignedRole,
      placeId: input.placeId ?? 0,
      placeName: input.placeName ?? '',
      dataModelName: input.dataModelName ?? '',
      isRunning: input.isRunning ?? false,
      lastActivity: Date.now(),
      connectedAt: Date.now(),
    });

    return { ok: true, assignedRole, instanceId };
  }

  unregisterInstance(pluginSessionId: string) {
    const removed = this.instances.get(pluginSessionId);
    this.instances.delete(pluginSessionId);

    if (!removed) return;

    // Reject any pending requests targeted at this (instanceId, role) tuple
    // if no other plugin handles it.
    for (const [id, req] of this.pendingRequests.entries()) {
      const stillHasHandler = Array.from(this.instances.values()).some(
        (i) => i.instanceId === req.targetInstanceId && i.role === req.targetRole,
      );
      if (!stillHasHandler) {
        clearTimeout(req.timeoutId);
        this.pendingRequests.delete(id);
        req.reject(new Error(`Target (${req.targetInstanceId}, ${req.targetRole}) disconnected`));
      }
    }
  }

  getInstances(): PluginInstance[] {
    return Array.from(this.instances.values());
  }

  getPublicInstances(): PublicPluginInstance[] {
    return this.getInstances().map(toPublic);
  }

  getInstanceBySessionId(pluginSessionId: string): PluginInstance | undefined {
    return this.instances.get(pluginSessionId);
  }

  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  updateInstanceActivity(pluginSessionId: string) {
    const inst = this.instances.get(pluginSessionId);
    if (inst) {
      inst.lastActivity = Date.now();
    }
  }

  updateInstanceMetadata(pluginSessionId: string, metadata: Partial<Pick<PluginInstance, 'placeId' | 'placeName' | 'dataModelName' | 'isRunning'>>) {
    const inst = this.instances.get(pluginSessionId);
    if (!inst) return;
    if (metadata.placeId !== undefined) inst.placeId = metadata.placeId;
    if (metadata.placeName !== undefined) inst.placeName = metadata.placeName;
    if (metadata.dataModelName !== undefined) inst.dataModelName = metadata.dataModelName;
    if (metadata.isRunning !== undefined) inst.isRunning = metadata.isRunning;
  }

  cleanupStaleInstances() {
    const now = Date.now();
    for (const [id, inst] of this.instances.entries()) {
      if (now - inst.lastActivity > STALE_INSTANCE_MS) {
        this.unregisterInstance(id);
      }
    }
  }

  // Resolves (instance_id, target-role) MCP arguments to a concrete
  // routing decision: either a single (instanceId, role) tuple or a fanout
  // list. Returns an error result with the full instance list embedded so
  // the caller (tool layer) can surface it without a second round-trip.
  resolveTarget(input: ResolveTargetInput): ResolveTargetResult {
    const instances = this.getInstances();
    const publicList = instances.map(toPublic);
    const errorData = { instances: publicList, count: publicList.length };

    const { instance_id, target } = input;
    const isFanout = target === 'all';
    const role = target && target !== 'all' ? target : undefined;

    // Case 1: instance_id provided
    if (instance_id !== undefined) {
      const matchingInstances = instances.filter((i) => i.instanceId === instance_id);
      if (matchingInstances.length === 0) {
        return {
          ok: false,
          error: {
            code: 'unrecognized_instance_id',
            message: `instance_id "${instance_id}" is not connected. Pass one from data.instances.`,
            data: errorData,
          },
        };
      }

      if (isFanout) {
        // Fan out across all roles of that instance (e.g. edit + server + client-N).
        return {
          ok: true,
          mode: 'fanout',
          targets: matchingInstances.map((i) => ({
            targetInstanceId: i.instanceId,
            targetRole: i.role,
          })),
        };
      }

      if (role) {
        const exact = matchingInstances.find((i) => i.role === role);
        if (!exact) {
          return {
            ok: false,
            error: {
              code: 'target_role_not_present_on_instance',
              message: `instance "${instance_id}" has no role "${role}". Available roles: ${matchingInstances.map((i) => i.role).join(', ')}.`,
              data: errorData,
            },
          };
        }
        return { ok: true, mode: 'single', targetInstanceId: instance_id, targetRole: role };
      }

      // role omitted, instance_id provided
      if (matchingInstances.length === 1) {
        return {
          ok: true,
          mode: 'single',
          targetInstanceId: instance_id,
          targetRole: matchingInstances[0].role,
        };
      }
      // Multiple roles for that instance — prefer edit if present.
      const edit = matchingInstances.find((i) => i.role === 'edit');
      if (edit) {
        return { ok: true, mode: 'single', targetInstanceId: instance_id, targetRole: 'edit' };
      }
      return {
        ok: false,
        error: {
          code: 'target_role_required',
          message: `instance "${instance_id}" has multiple roles connected: ${matchingInstances.map((i) => i.role).join(', ')}. Pass target=<role>.`,
          data: errorData,
        },
      };
    }

    // Case 2: instance_id omitted — distinct instanceIds across connected plugins
    const distinctInstanceIds = new Set(instances.map((i) => i.instanceId));
    if (distinctInstanceIds.size === 0) {
      // No connected instances at all. Caller will hit a separate timeout/
      // not-connected error; return a clear routing error here too.
      return {
        ok: false,
        error: {
          code: 'unrecognized_instance_id',
          message: 'No Studio plugin is connected.',
          data: errorData,
        },
      };
    }
    if (distinctInstanceIds.size > 1) {
      const errorCode: RoutingErrorCode = role ? 'ambiguous_target' : 'multiple_instances_connected';
      const msg = role
        ? `target=${role} is ambiguous: multiple places have this role. Pass instance_id.`
        : 'Multiple Studio places are connected. Pass instance_id to disambiguate.';
      return { ok: false, error: { code: errorCode, message: msg, data: errorData } };
    }

    // Exactly one distinct instance_id connected. Apply role resolution
    // identically to the instance_id-provided path.
    const onlyInstanceId = instances[0].instanceId;
    return this.resolveTarget({ instance_id: onlyInstanceId, target });
  }

  async sendRequest(
    endpoint: string,
    data: any,
    targetInstanceId: string,
    targetRole: string,
  ): Promise<any> {
    const requestId = uuidv4();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, this.requestTimeout);

      const request: PendingRequest = {
        id: requestId,
        endpoint,
        data,
        targetInstanceId,
        targetRole,
        timestamp: Date.now(),
        resolve,
        reject,
        timeoutId,
      };

      this.pendingRequests.set(requestId, request);
    });
  }

  getPendingRequest(
    callerInstanceId: string,
    callerRole: string,
  ): { requestId: string; request: { endpoint: string; data: any } } | null {
    let oldestRequest: PendingRequest | null = null;

    for (const request of this.pendingRequests.values()) {
      if (request.targetInstanceId !== callerInstanceId) continue;
      if (request.targetRole !== callerRole) continue;
      if (!oldestRequest || request.timestamp < oldestRequest.timestamp) {
        oldestRequest = request;
      }
    }

    if (oldestRequest) {
      return {
        requestId: oldestRequest.id,
        request: {
          endpoint: oldestRequest.endpoint,
          data: oldestRequest.data,
        },
      };
    }

    return null;
  }

  resolveRequest(requestId: string, response: any) {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      clearTimeout(request.timeoutId);
      this.pendingRequests.delete(requestId);
      request.resolve(response);
    }
  }

  rejectRequest(requestId: string, error: any) {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      clearTimeout(request.timeoutId);
      this.pendingRequests.delete(requestId);
      request.reject(error);
    }
  }

  cleanupOldRequests() {
    const now = Date.now();
    for (const [id, request] of this.pendingRequests.entries()) {
      if (now - request.timestamp > this.requestTimeout) {
        clearTimeout(request.timeoutId);
        this.pendingRequests.delete(id);
        request.reject(new Error('Request timeout'));
      }
    }
  }

  clearAllPendingRequests() {
    for (const [, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeoutId);
      request.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }
}
