import { describe, it, expect, afterEach, vi } from 'vitest';
import { setTransport } from './lm';
import { learningList, learningRead, learningPlan, learningWrite, learningSetEnabled, proposalPayload, scopeLearning, type LearningRecord } from './learning';

const record: LearningRecord = { id: '12345678', domain: 'demo', revision: 'revision-1', project: 'alm' };
describe('learning bridge', () => {
  afterEach(() => { setTransport(vi.fn()); });
  it('keeps inspection read-only and scopes references', async () => {
    const transport = vi.fn().mockResolvedValue({ exit_code: 0, result: { records: [] } }); setTransport(transport);
    await learningList('candidate'); await learningRead('candidate', record);
    expect(transport.mock.calls[0][1].argv).toEqual(['learn', 'candidate', 'list', '--all-domains', '--actor', 'viewer']);
    expect(transport.mock.calls[1][1].argv).toEqual(['learn', 'candidate', 'read', record.id, '--domain', 'demo', '--actor', 'viewer']);
  });
  it('binds review to the exact candidate revision', async () => {
    const transport = vi.fn().mockResolvedValue({ exit_code: 0, result: {} }); setTransport(transport);
    await learningPlan(record);
    expect(JSON.parse(transport.mock.calls[0][1].stdin)).toEqual({ expected_revision: 'revision-1' });
    await learningWrite('candidate', 'reject', record);
    expect(JSON.parse(transport.mock.calls[1][1].stdin).expected_revision).toBe(record.revision);
  });
  it('separates domain controls from the global switch', async () => {
    const transport = vi.fn().mockResolvedValue({ exit_code: 0, result: {} }); setTransport(transport);
    await learningSetEnabled(false); await learningSetEnabled(true, 'demo');
    expect(JSON.parse(transport.mock.calls[0][1].stdin)).toEqual({ enabled: false, global: true });
    expect(JSON.parse(transport.mock.calls[1][1].stdin)).toEqual({ enabled: true, global: false });
  });
  it('keeps the approved version\'s tags when a procedure is edited as a proposal', () => {
    const content = { title: 'T', body: 'B', use_when: ['u'], do_not_use_when: ['', 'x'], steps: ['s1', 's2'], done_when: ['d'], fallback: 'f' };
    const version: LearningRecord = { ...record, id: '12345678.2', content, evidence_ids: ['e1'], tags: ['technology/git'] };
    const payload = proposalPayload({ ...record, current_version: 2 }, version, content, [['e1']], true);
    expect(payload).toMatchObject({ tags: ['technology/git'], procedure_id: record.id, project: 'alm', evidence_ids: ['e1'], step_evidence: [['e1'], []] });
    expect(payload.content.do_not_use_when).toEqual(['x']);
  });
  it('never mixes another project into a selected project queue', () => {
    expect(scopeLearning([record, { ...record, id: 'other', project: 'other' }], 'alm')).toEqual([record]);
  });
});
