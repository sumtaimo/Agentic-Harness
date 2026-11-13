import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Ban, Check, RotateCcw, ShieldAlert, Terminal } from 'lucide-react';
import { Cmd, Section, TierPill } from './ui';
import {
  ENGINES, ROLE_JOB, chooseModelTier, engineCli, modelFor, planEngineRouting,
  type Engine, type Reason, type Role, type TierInput,
} from '../lib/routing';
import { Rich, useLang } from '../lib/lang';
import { fmt, type Dict } from '../data/i18n';

interface Row { who: string; role: Role; input: TierInput }

// Row i's description is t.sim.rows[i].
const ROWS: Row[] = [
  { who: 'orchestrator', role: 'PO_ARCHITECT', input: { kind: 'plan', level: 'orchestrator', role: 'PO_ARCHITECT' } },
  { who: 'lead-ba', role: 'BA_ANALYST', input: { kind: 'plan', level: 'lead', role: 'BA_ANALYST' } },
  { who: 'lead-dev', role: 'DEV_ENGINEER', input: { kind: 'plan', level: 'lead', role: 'DEV_ENGINEER' } },
  { who: 'lead-qa', role: 'QA_AUDITOR', input: { kind: 'plan', level: 'lead', role: 'QA_AUDITOR' } },
  { who: 'lead-ba worker', role: 'BA_ANALYST', input: { kind: 'work', role: 'BA_ANALYST', targetFiles: ['docs/feature.md'], promptChars: 400 } },
  { who: 'lead-dev worker', role: 'DEV_ENGINEER', input: { kind: 'work', role: 'DEV_ENGINEER', targetFiles: ['src/util.js'], promptChars: 300 } },
  { who: 'lead-dev worker', role: 'DEV_ENGINEER', input: { kind: 'work', role: 'DEV_ENGINEER', targetFiles: ['src/api.js', 'src/db.js', 'src/routes.js'], promptChars: 1800 } },
  { who: 'lead-qa worker', role: 'QA_AUDITOR', input: { kind: 'work', role: 'QA_AUDITOR', targetFiles: ['tests/api.test.js'], promptChars: 500 } },
];

function reasonText(r: Reason, t: Dict): string {
  const s = t.sim.reasons[r.code];
  if (r.code === 'escalated') return fmt(s, { from: r.from, to: r.to, retry: r.retry });
  return 'files' in r ? fmt(s, { files: r.files }) : s;
}

export function RoutingSimulator() {
  const { t } = useLang();
  const s = t.sim;
  const [installed, setInstalled] = useState<Record<Engine, boolean>>({ claude: true, antigravity: false, codex: false, gemini: false });
  const [cycle, setCycle] = useState(1);
  const available = ENGINES.map((e) => e.id).filter((id) => installed[id]);
  const key = available.join();
  const routing = useMemo(() => planEngineRouting(key ? (key.split(',') as Engine[]) : []), [key]);
  const mode = available.length >= 3 ? s.mode3 : available.length === 2 ? s.mode2 : s.mode1;

  return (
    <Section id="simulator" eyebrow={s.eyebrow} title={s.title} intro={<Rich text={s.intro} />}>
      <div className="grid gap-6 lg:grid-cols-[290px_1fr]">
        <div className="min-w-0 space-y-6">
          <fieldset>
            <legend className="text-sm font-medium text-fg">{s.installed}</legend>
            <div className="mt-3 space-y-2">
              {ENGINES.map((e) => {
                const on = installed[e.id];
                return (
                  <label key={e.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition ${on ? 'border-accent/50 bg-accent-soft' : 'border-line bg-surface hover:border-line-strong'}`}>
                    <input type="checkbox" className="sr-only" checked={on} onChange={() => setInstalled((x) => ({ ...x, [e.id]: !x[e.id] }))} />
                    <span className={`grid h-4.5 w-4.5 place-items-center rounded border ${on ? 'border-accent bg-accent text-bg' : 'border-line-strong'}`} aria-hidden="true">
                      {on && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span className="text-sm text-fg">{e.label}</span>
                    <code className="ml-auto font-mono text-xs text-faint">{e.cli}</code>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="flex items-center gap-2 text-sm font-medium text-fg"><RotateCcw size={14} /> {s.cycle}</legend>
            <p className="mt-1 text-xs leading-5 text-muted">{s.cycleHelp}</p>
            <div className="mt-3 inline-flex flex-wrap rounded-lg border border-line bg-surface p-0.5" role="radiogroup" aria-label={s.cycle}>
              {[1, 2, 3].map((c) => (
                <button key={c} type="button" role="radio" aria-checked={cycle === c} onClick={() => setCycle(c)}
                  className={`rounded-md px-3 py-1 text-xs transition ${cycle === c ? 'bg-fg text-bg' : 'text-muted hover:text-fg'}`}>
                  {c === 1 ? s.cycle1 : fmt(s.retry, { n: c - 1 })}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2 text-xs leading-5 text-muted">
            <Note icon={<ShieldAlert size={14} className="text-danger" />}><Rich text={s.fatal} /></Note>
            <Note icon={<AlertTriangle size={14} className="text-warn" />}><Rich text={s.fallback} /></Note>
            <Note icon={<Ban size={14} className="text-faint" />}><Rich text={s.fable} /></Note>
          </div>
        </div>

        <div className="min-w-0 rounded-xl border border-line bg-surface" aria-live="polite">
          {!routing ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
              <div className="grid h-10 w-10 place-items-center rounded-full bg-warn-soft text-warn"><AlertTriangle size={18} /></div>
              <p className="font-medium text-fg">{s.noneTitle}</p>
              <p className="max-w-sm text-sm text-muted"><Rich text={s.noneBody} /></p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-4 py-3 text-sm">
                <span className="font-medium text-fg" data-mode>{mode}</span>
                <span className="text-xs text-muted">{s.planning} → <b className="font-mono text-fg">{engineCli(routing.plan)}</b></span>
                <span className="text-xs text-muted">{s.coding} → <b className="font-mono text-fg">{engineCli(routing.code)}</b></span>
                <span className="text-xs text-muted">{s.qa} → <b className="font-mono text-fg">{engineCli(routing.qa)}</b></span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wider text-faint">
                      <th className="px-4 py-2.5 font-medium">{s.cols.agent}</th>
                      <th className="px-4 py-2.5 font-medium">{s.cols.engine}</th>
                      <th className="px-4 py-2.5 font-medium">{s.cols.tier}</th>
                      <th className="px-4 py-2.5 font-medium">{s.cols.model}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((r, i) => {
                      const engine = routing[ROLE_JOB[r.role]];
                      const worker = r.input.kind === 'work';
                      const { tier, reasons } = chooseModelTier({ ...r.input, cycle: worker ? cycle : 1 });
                      const model = modelFor(engine, tier);
                      return (
                        <tr key={i} className={`border-b border-line last:border-0 ${i === 4 ? 'border-t-2 border-t-line-strong' : ''}`}>
                          <td className="px-4 py-3 align-top">
                            <div className="font-mono text-[13px] text-fg">{r.who}</div>
                            <div className="mt-0.5 text-xs text-faint">{s.rows[i]}</div>
                          </td>
                          <td className="px-4 py-3 align-top font-mono text-[13px] text-fg">{engineCli(engine)}</td>
                          <td className="px-4 py-3 align-top">
                            <TierPill tier={tier} />
                            <div className="mt-1 max-w-[230px] text-[11px] leading-4 text-faint">{reasons.map((x) => reasonText(x, t)).join(' · ')}</div>
                          </td>
                          <td className="px-4 py-3 align-top text-[12px]">
                            {model ? <span className="font-mono text-fg">--model {model}</span> : <span className="text-faint">{s.noModel}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-line p-4">
                <p className="mb-2 flex items-center gap-2 text-xs text-muted"><Terminal size={13} className="shrink-0" /> {s.apply}</p>
                <Cmd cmd="node .harness/team.mjs auto-assign --dry-run" comment={s.applyComment} />
              </div>
            </>
          )}
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-faint"><Rich text={s.footnote} /></p>
    </Section>
  );
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className="flex gap-2.5 rounded-lg border border-line bg-surface p-3"><span className="mt-0.5 shrink-0">{icon}</span><p>{children}</p></div>;
}
