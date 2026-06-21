// Mutation tools, split out of the RobloxStudioTools monolith: the scene-writing
// surface — set/mass-set properties, create/delete/clone/duplicate instances,
// attributes, CollectionService tags, and the transactional apply_mutation_plan.
// The bulk/destructive ops (mass_create, delete, apply_mutation_plan) consult the
// shared safety layer (gate + history) via injected runtime functions. All run
// through the shared single-target runtime; the facade delegates with identical
// public signatures so the schema-parity invariants hold.

import { compactText } from '../compact.js';
import { buildMutationPlanLuau, type MutationOp } from '../builders/mutation-plan.js';
import type { OperationKind } from '../safety/safety-manager.js';
import { normalizeExecuteLuauToolResult, wrapToolJsonText, type SafetyOptions, type ToolContent } from './runtime-support.js';

type MutationToolRuntime = {
  callSingle(endpoint: string, data: unknown, target: string | undefined, instance_id: string | undefined): Promise<any>;
  safetyGate(
    kind: OperationKind,
    detail: string,
    input: { path?: string; count?: number; scriptSize?: number; code?: string },
    options?: SafetyOptions,
  ): { content: ToolContent[] } | null;
  recordOperation(kind: string, summary: string): void;
};

export class MutationTools {
  constructor(private readonly runtime: MutationToolRuntime) {}

  async setProperty(instancePath: string, propertyName: string, propertyValue: any, instance_id?: string) {
    if (!instancePath || !propertyName) {
      throw new Error('Instance path and property name are required for set_property');
    }
    const response = await this.runtime.callSingle('/api/set-property', { instancePath, propertyName, propertyValue }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async setProperties(instancePath: string, properties: Record<string, any>, instance_id?: string) {
    if (!instancePath || !properties) {
      throw new Error('instancePath and properties are required for set_properties');
    }
    const response = await this.runtime.callSingle('/api/set-properties', { instancePath, properties }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async massSetProperty(paths: string[], propertyName: string, propertyValue: any, instance_id?: string) {
    if (!paths || paths.length === 0 || !propertyName) {
      throw new Error('Paths array and property name are required for mass_set_property');
    }
    const response = await this.runtime.callSingle('/api/mass-set-property', { paths, propertyName, propertyValue }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async massGetProperty(paths: string[], propertyName: string, instance_id?: string) {
    if (!paths || paths.length === 0 || !propertyName) {
      throw new Error('Paths array and property name are required for mass_get_property');
    }
    const response = await this.runtime.callSingle('/api/mass-get-property', { paths, propertyName }, undefined, instance_id);
    return compactText(response);
  }

  async createObject(className: string, parent: string, name?: string, properties?: Record<string, any>, instance_id?: string) {
    if (!className || !parent) {
      throw new Error('Class name and parent are required for create_object');
    }
    const response = await this.runtime.callSingle('/api/create-object', { className, parent, name, properties }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async massCreateObjects(objects: Array<{className: string, parent: string, name?: string, properties?: Record<string, any>}>, instance_id?: string, options?: SafetyOptions) {
    if (!objects || objects.length === 0) {
      throw new Error('Objects array is required for mass_create_objects');
    }
    const gated = this.runtime.safetyGate('bulk_create', `create ${objects.length} objects`, { count: objects.length }, options);
    if (gated) return gated;
    const response = await this.runtime.callSingle('/api/mass-create-objects', { objects }, undefined, instance_id);
    this.runtime.recordOperation('bulk_create', `created ${objects.length} objects`);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async deleteObject(instancePath: string, instance_id?: string, options?: SafetyOptions) {
    if (!instancePath) {
      throw new Error('Instance path is required for delete_object');
    }
    const gated = this.runtime.safetyGate('delete', `delete ${instancePath}`, { path: instancePath }, options);
    if (gated) return gated;
    const response = await this.runtime.callSingle('/api/delete-object', { instancePath }, undefined, instance_id);
    this.runtime.recordOperation('delete', `deleted ${instancePath}`);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async cloneObject(instancePath: string, targetParentPath: string, instance_id?: string) {
    if (!instancePath || !targetParentPath) {
      throw new Error('instancePath and targetParentPath are required for clone_object');
    }
    const response = await this.runtime.callSingle('/api/clone-object', { instancePath, targetParentPath }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
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
    const response = await this.runtime.callSingle('/api/smart-duplicate', { instancePath, count, options }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
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
    const response = await this.runtime.callSingle('/api/mass-duplicate', { duplications }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async setAttribute(instancePath: string, attributeName: string, attributeValue: any, valueType?: string, instance_id?: string) {
    if (!instancePath || !attributeName) {
      throw new Error('Instance path and attribute name are required for set_attribute');
    }
    const response = await this.runtime.callSingle('/api/set-attribute', { instancePath, attributeName, attributeValue, valueType }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async getAttributes(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_attributes');
    }
    const response = await this.runtime.callSingle('/api/get-attributes', { instancePath }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async deleteAttribute(instancePath: string, attributeName: string, instance_id?: string) {
    if (!instancePath || !attributeName) {
      throw new Error('Instance path and attribute name are required for delete_attribute');
    }
    const response = await this.runtime.callSingle('/api/delete-attribute', { instancePath, attributeName }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async bulkSetAttributes(instancePath: string, attributes: Record<string, unknown>, instance_id?: string) {
    if (!instancePath || !attributes) {
      throw new Error('instancePath and attributes are required for bulk_set_attributes');
    }
    const response = await this.runtime.callSingle('/api/bulk-set-attributes', { instancePath, attributes }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async getTags(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_tags');
    }
    const response = await this.runtime.callSingle('/api/get-tags', { instancePath }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async addTag(instancePath: string, tagName: string, instance_id?: string) {
    if (!instancePath || !tagName) {
      throw new Error('Instance path and tag name are required for add_tag');
    }
    const response = await this.runtime.callSingle('/api/add-tag', { instancePath, tagName }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async removeTag(instancePath: string, tagName: string, instance_id?: string) {
    if (!instancePath || !tagName) {
      throw new Error('Instance path and tag name are required for remove_tag');
    }
    const response = await this.runtime.callSingle('/api/remove-tag', { instancePath, tagName }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async getTagged(tagName: string, instance_id?: string) {
    if (!tagName) {
      throw new Error('Tag name is required for get_tagged');
    }
    const response = await this.runtime.callSingle('/api/get-tagged', { tagName }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  // Transactional batch mutations: apply many small edits in one round-trip with a
  // dry-run diff and a ready-to-run reverse plan in the receipt (stateless rollback).
  async applyMutationPlan(operations: MutationOp[], dryRun?: boolean, confirm?: boolean, instance_id?: string) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error('operations (a non-empty array) is required for apply_mutation_plan');
    }
    // Only gate the apply path; dry-run is a safe preview that should always run.
    if (!dryRun) {
      const gated = this.runtime.safetyGate('bulk_mutate', `apply ${operations.length} mutation(s)`, { count: operations.length }, { confirm });
      if (gated) return gated;
    }
    const response = await this.runtime.callSingle('/api/execute-luau', { code: buildMutationPlanLuau(operations, !!dryRun) }, 'edit', instance_id);
    if (!dryRun) this.runtime.recordOperation('bulk_mutate', `mutation plan: ${operations.length} ops`);
    return wrapToolJsonText(normalizeExecuteLuauToolResult(response, {
      applied: !dryRun,
      dryRun: !!dryRun,
      results: [],
      rollback: [],
      summary: { total: operations.length, succeeded: 0, failed: operations.length },
      error: 'apply_mutation_plan returned non-object execute-luau output',
    }));
  }
}
