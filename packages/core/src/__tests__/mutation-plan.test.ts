import { buildMutationPlanLuau, type MutationOp } from '../builders/mutation-plan.js';

const ops: MutationOp[] = [
  { op: 'set_property', target: 'game.Workspace.Part', property: 'Anchored', value: true },
  { op: 'add_tag', target: 'game.Workspace.Part', tag: 'Checkpoint' },
  { op: 'set_attribute', target: 'game.Workspace.Part', name: 'RoundId', value: 3 },
];

describe('buildMutationPlanLuau', () => {
  it('decodes ops via JSONDecode (no code injection) and handles all four op kinds', () => {
    const code = buildMutationPlanLuau(ops, false);
    expect(code).toContain('HttpService:JSONDecode(');
    expect(code).toContain('op.op == "set_property"');
    expect(code).toContain('op.op == "set_attribute"');
    expect(code).toContain('op.op == "add_tag"');
    expect(code).toContain('op.op == "remove_tag"');
    expect(code).toContain('inst[op.property] = op.value');
    expect(code).toContain('CollectionService:AddTag(inst, op.tag)');
  });

  it('captures before-values and builds a reverse rollback plan', () => {
    const code = buildMutationPlanLuau(ops, false);
    expect(code).toContain('rollback = rollback');
    expect(code).toContain('op = "set_property", target = op.target, property = op.property, value = ser(before)');
    // add_tag rolls back to remove_tag only when the tag wasn't already present
    expect(code).toContain('if not had then table.insert(rollback, { op = "remove_tag"');
  });

  it('dry-run reports wouldSet without applying', () => {
    const code = buildMutationPlanLuau(ops, true);
    expect(code).toContain('local dryRun = true');
    expect(code).toContain('r.wouldSet = ser(op.value)');
    expect(code).toContain('applied = not dryRun');
  });

  it('is injection-safe by construction: ops come from JSONDecode, used as runtime values', () => {
    const hostile: MutationOp[] = [{ op: 'set_property', target: 'x"]; os.exit() --', property: 'Name', value: 'a"]; --' }];
    const code = buildMutationPlanLuau(hostile, false);
    // Targets/values are never interpolated into code — they ride inside a JSON
    // string parsed by JSONDecode and are used as runtime variables.
    expect(code).toContain('HttpService:JSONDecode(');
    expect(code).toContain('resolvePath(op.target)');
    expect(code).not.toContain('resolvePath("x"]'); // not interpolated into a code path
  });
});
