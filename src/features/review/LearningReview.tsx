import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConnection } from '../../lib/connection';
import { domains as listDomains } from '../../lib/lm';
import { learningConfig, learningEvaluate, learningList, learningPlan, learningRead, learningRetirePlan, learningSetEnabled, learningWrite, proposalPayload, scopeLearning,
  type LearningContent, type LearningRecord } from '../../lib/learning';
import { useCurrentProject } from '../projects/useProject';
import { Section } from '../../ui/Page';
import { Modal } from '../../ui/Modal';
import { PlanDialog } from '../plans/PlanDialog';
import { refreshStore } from '../../lib/refresh';

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Learning records always come from LM, never from local drafts or the filesystem. */
export function LearningReview() {
  const client = useQueryClient();
  const supported = useConnection(s => s.commands.includes('learn'));
  const capability = useConnection(s => s.capabilities?.learning ?? 0);
  const enabled = supported && capability >= 1;
  const { project } = useCurrentProject();
  const candidates = useQuery({ queryKey: ['learning', 'candidates'], queryFn: () => learningList('candidate'), enabled });
  const procedures = useQuery({ queryKey: ['learning', 'procedures'], queryFn: () => learningList('procedure'), enabled });
  const settings = useQuery({ queryKey: ['learning', 'config'], queryFn: () => learningConfig(), enabled });
  const availableDomains = useQuery({ queryKey: ['domains'], queryFn: listDomains, enabled });
  const [selected, setSelected] = useState<LearningRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = scopeLearning(candidates.data?.records ?? [], project?.slug).filter(r => r.state === 'draft' || r.state === 'deferred');
  const published = scopeLearning(procedures.data?.records ?? [], project?.slug);
  const domains = [...new Set([...(availableDomains.data?.domains ?? []).map(d => d.name), ...list.map(r => r.domain), ...published.map(r => r.domain)])];
  const refresh = () => { setSelected(null); refreshStore(client); };
  const toggle = async (on: boolean, domain?: string) => {
    try { await learningSetEnabled(on, domain); setError(null); refreshStore(client); }
    catch (e) { setError(message(e)); }
  };
  if (!supported) return <p className="muted">Learning review needs a Living Memory installation with the learn command.</p>;
  return <Section title="Learning" count={list.length} loading={candidates.isLoading}
    error={error ?? (candidates.error ? message(candidates.error) : undefined)}>
    {!enabled && <p className="muted">The connected backend does not advertise learning capability 1.</p>}
    {enabled && <>
      <label><input type="checkbox" checked={settings.data?.config.enabled ?? true}
        disabled={!settings.data} onChange={e => toggle(e.target.checked)} /> Collect new learning in all domains</label>
      <p className="muted small">Agents explicitly submit evidence and proposals, and new procedures require your review. Turning collection off
        stops new evidence and proposals; approved procedures stay published (suspend or retire one to unpublish it). No transcript collection or background model runs.</p>
      {domains.map(domain => <label key={domain} className="learning-field"><input type="checkbox"
        checked={settings.data?.config.domains[domain] ?? true} disabled={!settings.data}
        onChange={e => toggle(e.target.checked, domain)} /> Collect new learning in {domain}</label>)}
      {[...(candidates.data?.problems ?? []), ...(procedures.data?.problems ?? [])].map(p =>
        <p key={p.path} role="alert">Unreadable learning record {p.path}: {p.problem}. Run doctor, or restore it from a backup.</p>)}
      {!list.length && <p className="muted">No learned procedures are waiting for review.</p>}
      {list.map(c => <div className="work-group" key={c.id}>
        <div className="work-head"><span className="badge">{c.state}</span><strong>{c.content?.title}</strong></div>
        <p>{c.domain}{c.project ? ` · ${c.project}` : ''} · {c.evidence_ids?.length ?? 0} evidence records</p>
        <button onClick={() => setSelected(c)}>Review proposal…</button>
      </div>)}
      {!!published.length && <details><summary>Approved procedures ({published.length})</summary>
        {published.map(p => <div className="work-group" key={p.id}>
          <span className="badge">{p.state}</span> {p.title ?? 'Procedure'} · {p.domain} · version {p.current_version}
          <button onClick={() => setSelected(p)}>Evidence and history…</button>
        </div>)}
      </details>}
    </>}
    {selected && <LearningDetail key={selected.id} record={selected} procedure={!selected.content} onClose={refresh} />}
  </Section>;
}

function LearningDetail({ record, procedure, onClose }: { record: LearningRecord; procedure: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState(record);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<number | 'promote' | 'retire' | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LearningContent | null>(null);
  const [stepEvidence, setStepEvidence] = useState<string[][]>([]);
  const [busy, setBusy] = useState(false);
  const version = useQuery({ queryKey: ['learning', 'version', current.domain, current.id, current.current_version],
    queryFn: () => learningRead('version', { domain: current.domain, id: `${current.id}.${current.current_version}` }), enabled: procedure });
  const item = procedure ? version.data?.record : current;
  const evaluation = useQuery({ queryKey: ['learning', 'evaluation', current.id, current.revision],
    queryFn: () => learningEvaluate(current), enabled: !procedure });
  const evidence = useQuery({ queryKey: ['learning', 'evidence', current.domain, item?.evidence_ids],
    queryFn: () => Promise.all((item?.evidence_ids ?? []).map(id => learningRead('evidence', { domain: current.domain, id }))), enabled: !!item });
  const attempts = useQuery({ queryKey: ['learning', 'attempts', current.domain], queryFn: () => learningList('attempt'), enabled: true });
  const tasks = useQuery({ queryKey: ['learning', 'tasks'], queryFn: () => learningList('task') });
  const versions = useQuery({ queryKey: ['learning', 'versions', current.id], queryFn: () => learningList('version'), enabled: procedure });
  const uses = useQuery({ queryKey: ['learning', 'uses', current.id], queryFn: () => learningList('use'), enabled: procedure });
  const feedback = useQuery({ queryKey: ['learning', 'feedback', current.id], queryFn: () => learningList('feedback'), enabled: procedure });
  const act = async (action: string) => {
    setBusy(true);
    try { await learningWrite(procedure ? 'procedure' : 'candidate', action, current); onClose(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      if (!draft) return;
      const result = await learningWrite('candidate', procedure ? 'create' : 'update', current,
        proposalPayload(current, item, draft, stepEvidence, procedure));
      if (procedure) onClose(); else { setCurrent(result.record); setEditing(false); setError(null); }
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <>
    <Modal title={item?.content?.title ?? 'Procedure evidence'} onClose={onClose}>
      <p>{current.domain} · {procedure ? `Approved version ${current.current_version} (${current.state})` : 'Proposed content — not yet approved'}</p>
      {error && <p role="alert">{error}</p>}
      {version.error && <p role="alert">{message(version.error)}</p>}
      {item?.content && <>
        <p>{item.content.body}</p>
        <p><strong>Use when:</strong> {item.content.use_when.join('; ')}</p>
        <p><strong>Do not use when:</strong> {item.content.do_not_use_when.join('; ') || 'No additional exclusions stated.'}</p>
        <ol>{item.content.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        <p><strong>Done when:</strong> {item.content.done_when.join('; ')}</p>
        <p><strong>Fallback:</strong> {item.content.fallback}</p>
      </>}
      {evaluation.data && <div><p>{evaluation.data.supporting_tasks} tasks · {evaluation.data.attempt_families} attempt families</p>
        {[...evaluation.data.errors, ...evaluation.data.warnings].map((s, i) => <p key={i}>{s}</p>)}</div>}
      {evaluation.error && <p role="alert">{message(evaluation.error)}</p>}
      <h3>Evidence and limitations</h3>
      {evidence.error && <p role="alert">{message(evidence.error)}</p>}
      {evidence.data?.map(({ record: e }) => {
        const a = attempts.data?.records.find(a => a.id === e.attempt_id && a.domain === e.domain);
        const t = tasks.data?.records.find(t => t.id === a?.task_id && t.domain === e.domain);
        return <details key={e.id}><summary>{e.criterion}: {e.result} ({e.method})</summary>
          <p>{t?.objective ?? 'Task details unavailable'} · outcome: {a?.outcome ?? 'unknown'}</p><pre>{e.excerpt}</pre><p>{e.limitations}</p></details>;
      })}
      {editing && draft ? <div>
        {(['title', 'body', 'fallback'] as const).map(field => <label key={field} className="learning-field">
          {field === 'body' ? 'Summary' : field === 'title' ? 'Title' : 'Fallback'}
          <textarea rows={field === 'title' ? 1 : 3} value={draft[field]}
            onChange={e => setDraft({ ...draft, [field]: e.target.value })} /></label>)}
        {(['use_when', 'do_not_use_when', 'steps', 'done_when'] as const).map(field => <label key={field} className="learning-field">
          {{ use_when: 'Use when', do_not_use_when: 'Do not use when', steps: 'Steps', done_when: 'Done when' }[field]} (one per line)
          <textarea rows={3} value={draft[field].join('\n')}
            onChange={e => setDraft({ ...draft, [field]: e.target.value.split('\n') })} /></label>)}
        {draft.steps.map((step, i) => <fieldset key={i}><legend>Evidence for step {i+1}: {step}</legend>
          {evidence.data?.map(({ record: e }) => <label key={e.id} className="learning-field"><input type="checkbox"
            checked={(stepEvidence[i] ?? []).includes(e.id)} onChange={event => setStepEvidence(previous => {
              const next = [...previous]; const ids = next[i] ?? [];
              next[i] = event.target.checked ? [...ids, e.id] : ids.filter(id => id !== e.id); return next;
            })} /> {e.criterion}: {e.result}</label>)}
        </fieldset>)}
        <button disabled={busy} onClick={save}>Save proposal</button><button onClick={() => setEditing(false)}>Cancel edit</button></div>
        : item?.content && !(procedure && current.state === 'retired') && <button onClick={() => { setDraft(item.content!); setStepEvidence(item.step_evidence ?? []); setEditing(true); }}>Edit as proposal…</button>}
      <div className="actions">
        {!procedure && <><button disabled={busy || !evaluation.data?.eligible || editing} onClick={() => setPlan('promote')}>Review approval…</button>
          <button disabled={busy} onClick={() => act('reject')}>Reject</button><button disabled={busy} onClick={() => act('defer')}>Defer</button></>}
        {procedure && current.state !== 'retired' && <>
          <button disabled={busy} onClick={() => act(current.state === 'active' ? 'suspend' : 'resume')}>{current.state === 'active' ? 'Suspend' : 'Resume'}</button>
          <button disabled={busy} onClick={() => setPlan('retire')}>Retire…</button></>}
        <button onClick={onClose}>Close</button>
      </div>
      {procedure && <><h3>Versions</h3>{versions.data?.records.filter(v => v.procedure_id === current.id && v.domain === current.domain).map(v =>
        <p key={v.id}>Version {v.version}: {v.content?.title} {v.version !== current.current_version && current.state !== 'retired' && <button onClick={() => setPlan(v.version!)}>Review rollback…</button>}</p>)}
        <h3>Reported uses</h3>{uses.data?.records.filter(u => u.procedure_id === current.id && u.domain === current.domain).map(u =>
          <p key={u.id}>Version {u.version}: {u.usage}. {feedback.data?.records.filter(f => f.use_id === u.id && f.domain === u.domain).map(f => `${f.outcome}; contribution ${f.contribution}`).join(' · ') || 'No outcome reported.'}</p>)}</>}
    </Modal>
    {plan === 'retire' && <PlanDialog title="Retire learned procedure"
      intro={<p>The runbook is archived and leaves search and context. Its versions, evidence and reported uses stay readable. A retired procedure cannot be revised; propose a new one instead.</p>}
      make={() => learningRetirePlan(current)} applyLabel="Retire procedure"
      onApplied={onClose} onClose={() => setPlan(null)} />}
    {plan !== null && plan !== 'retire' && <PlanDialog title={plan === 'promote' ? 'Approve learned procedure' : 'Review procedure rollback'}
      intro={<p>Approval applies only to this exact proposal and evidence revision. It does not grant permission for future external actions.</p>}
      make={() => learningPlan(current, plan === 'promote' ? undefined : plan)} applyLabel="Approve procedure"
      onApplied={onClose} onClose={() => setPlan(null)} />}
  </>;
}
