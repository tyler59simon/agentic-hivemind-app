import { run } from './lm';
import type { Plan } from './lm';

export interface LearningContent {
  title: string; body: string; use_when: string[]; do_not_use_when: string[];
  steps: string[]; done_when: string[]; fallback: string;
}
export interface LearningRecord {
  id: string; domain: string; revision: string; project?: string | null; state?: string;
  title?: string;
  content?: LearningContent; evidence_ids?: string[]; step_evidence?: string[][]; tags?: string[];
  contradictions?: string[]; procedure_id?: string | null; current_version?: number;
  version?: number; note_id?: string; outcome?: string; usage?: string;
  contribution?: string; excerpt?: string; criterion?: string; result?: string;
  method?: string; limitations?: string; attempt_id?: string; task_id?: string;
  use_id?: string; objective?: string; source_candidate?: string;
}
export interface LearningEvaluation {
  eligible: boolean; errors: string[]; warnings: string[]; supporting_tasks: number; attempt_families: number;
}
const args = (entity: string, action: string, domain?: string, id?: string) =>
  ['learn', entity, action, ...(id ? [id] : []), ...(domain ? ['--domain', domain] : [])];
export interface LearningProblem { path: string; problem: string }
/** Malformed records are reported in `problems` and never hide the readable ones. */
export const learningList = (entity: string) =>
  run<{ records: LearningRecord[]; problems?: LearningProblem[] }>([...args(entity, 'list'), '--all-domains', '--actor', 'viewer']);
export const learningRead = (entity: string, record: Pick<LearningRecord, 'id' | 'domain'>) =>
  run<{ record: LearningRecord }>([...args(entity, 'read', record.domain, record.id), '--actor', 'viewer']);
export const learningEvaluate = (record: LearningRecord) =>
  run<LearningEvaluation>([...args('candidate', 'evaluate', record.domain, record.id), '--actor', 'viewer']);
export const learningWrite = (entity: string, action: string, record: LearningRecord, payload: Record<string, unknown> = {}) =>
  run<{ record: LearningRecord; candidate_id?: string }>(args(entity, action, record.domain, record.id),
    JSON.stringify({ expected_revision: record.revision, ...payload }));
/** What "Save proposal" sends for `current`, whose shown content is `item` (the approved version for a procedure).
 *  Editing a procedure creates a new candidate, which gets no tags unless they are sent, so the version's tags go along. */
export const proposalPayload = (current: LearningRecord, item: LearningRecord | undefined, content: LearningContent,
  stepEvidence: string[][], procedure: boolean) => ({
  content: { ...content, do_not_use_when: content.do_not_use_when.filter(s => s.trim()) }, evidence_ids: item?.evidence_ids,
  step_evidence: content.steps.map((_, i) => stepEvidence[i] ?? []),
  project: current.project, procedure_id: procedure ? current.id : current.procedure_id, contradictions: current.contradictions ?? [],
  tags: item?.tags,
});
export const learningPlan =(record: LearningRecord, rollbackVersion?: number) =>
  run<Plan>(args(rollbackVersion ? 'procedure' : 'candidate', rollbackVersion ? 'rollback-plan' : 'promote-plan', record.domain, record.id),
    JSON.stringify({ expected_revision: record.revision, ...(rollbackVersion ? { version: rollbackVersion } : {}) }));
/** Archives the runbook and retires the procedure once the plan is applied. */
export const learningRetirePlan = (record: LearningRecord) =>
  run<Plan>(args('procedure', 'retire-plan', record.domain, record.id), JSON.stringify({ expected_revision: record.revision }));
export const learningConfig = (domain?: string) =>
  run<{ config: { enabled: boolean; effective: boolean; domains: Record<string, boolean> } }>([...args('config', 'status', domain), '--actor', 'viewer']);
export const learningSetEnabled = (enabled: boolean, domain?: string) =>
  run(args('config', 'set', domain), JSON.stringify({ enabled, global: !domain }));

export const scopeLearning = (records: LearningRecord[], project?: string) =>
  records.filter(r => !project || r.project === project);
