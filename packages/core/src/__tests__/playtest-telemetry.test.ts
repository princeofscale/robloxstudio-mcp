import { buildPlaytestSampleLuau } from '../builders/playtest-telemetry.js';

describe('buildPlaytestSampleLuau', () => {
  it('samples all domains by default', () => {
    const code = buildPlaytestSampleLuau();
    expect(code).toContain('if true then'); // every mask on
    expect(code).not.toContain('if false then');
    expect(code).toContain('Players:GetPlayers()');
    expect(code).toContain('FindFirstChildOfClass("Humanoid")');
    expect(code).toContain('d:IsA("ValueBase")');
    expect(code).toContain('d:IsA("Sound")');
    expect(code).toContain('RunService:IsServer()');
  });

  it('masks out domains not requested', () => {
    const code = buildPlaytestSampleLuau(['players']);
    // players block on, the other three off
    const onCount = (code.match(/if true then/g) ?? []).length;
    const offCount = (code.match(/if false then/g) ?? []).length;
    expect(onCount).toBe(1);
    expect(offCount).toBe(3);
  });

  it('reads health/team/tool defensively via pcall', () => {
    const code = buildPlaytestSampleLuau(['players']);
    expect(code).toContain('FindFirstChildOfClass("Tool")');
    expect(code).toContain('pcall(function() return plr.Team');
    expect(code).toContain('pcall(function() return tostring(hum:GetState())');
  });
});
