import { checkNodeVersion, formatDoctorReport, DoctorCheck } from '../doctor.js';

describe('checkNodeVersion', () => {
  it('passes for Node 18 and above', () => {
    expect(checkNodeVersion('v18.0.0').status).toBe('ok');
    expect(checkNodeVersion('v20.11.1').status).toBe('ok');
  });
  it('fails for Node below 18', () => {
    const check = checkNodeVersion('v16.20.0');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/18/);
  });
});

describe('formatDoctorReport', () => {
  it('renders a status symbol for each check and an overall summary', () => {
    const checks: DoctorCheck[] = [
      { name: 'Node version', status: 'ok', detail: 'v20.0.0' },
      { name: 'Plugin installed', status: 'warn', detail: 'not found' },
      { name: 'Studio reachable', status: 'fail', detail: 'no response' },
    ];
    const report = formatDoctorReport(checks);
    expect(report).toContain('Node version');
    expect(report).toContain('Plugin installed');
    expect(report).toContain('Studio reachable');
    // Overall worst-status summary should reflect the failure.
    expect(report).toMatch(/fail|problem|FAIL/i);
  });

  it('reports all-clear when every check is ok', () => {
    const report = formatDoctorReport([{ name: 'X', status: 'ok', detail: 'fine' }]);
    expect(report).toMatch(/ok|pass|all/i);
  });
});
