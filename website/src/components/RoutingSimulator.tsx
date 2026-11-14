import { useMemo, useState } from 'react';
import { Card, Cmd, P, Section, Segmented, TierPill } from './ui';
import {
  ENGINES, ROLE_JOB, chooseModelTier, engineCli, modelFor, planEngineRouting,
  type Engine, type Reason, type Role, type TierInput,
} from '../lib/routing';
import { Rich, useLang } from '../lib/lang';
import { fmt, type Dict } from '../data/i18n';

interface RowDef { who: string; role: Role; input: TierInput }

// Row i's description is t.models.rows[i]. Rows 0-3 plan, rows 4-7 are example workers.
const ROWS: RowDef[] = [
  { who: 'orchestrator', role: 'PO_ARCHITECT', input: { kind: 'plan', level: 'orchestrator', role: 'PO_ARCHITECT' } },
  { who: 'lead-ba', role: 'BA_ANALYST', input: { kind: 'plan', level: 'lead', role: 'BA_ANALYST' } },
  { who: 'lead-dev', role: 'DEV_ENGINEER', input: { kind: 'plan', level: 'lead', role: 'DEV_ENGINEER' } },
  { who: 'lead-qa', role: 'QA_AUDITOR', input: { kind: 'plan', level: 'lead', role: 'QA_AUDITOR' } },
  { who: 'ba worker', role: 'BA_ANALYST', input: { kind: 'work', role: 'BA_ANALYST', targetFiles: ['docs/feature.md'], promptChars: 400 } },
  { who: 'dev worker', role: 'DEV_ENGINEER', input: { kind: 'work', role: 'DEV_ENGINEER', targetFiles: ['src/util.js'], promptChars: 300 } },
  { who: 'dev worker', role: 'DEV_ENGINEER', input: { kind: 'work', role: 'DEV_ENGINEER', targetFiles: ['src/api.js', 'src/db.js', 'src/routes.js'], promptChars: 1800 } },
  { who: 'qa worker', role: 'QA_AUDITOR', input: { kind: 'work', role: 'QA_AUDITOR', targetFiles: ['tests/api.test.js'], promptChars: 500 } },
];

function reasonText(r: Reason, t: Dict): string {
  const s = t.models.reasons[r.code];
  if (r.code === 'escalated') return fmt(s, { from: r.from, to: r.to, retry: r.retry });
  return 'files' in r ? fmt(s, { files: r.files }) : s;
}

export function RoutingSimulator({ n }: { n: number }) {
  const { t } = useLang();
  const s = t.models;
  const [installed, setInstalled] = useState<Record<Engine, boolean>>({ claude: true, antigravity: false, codex: false });
  const [cycle, setCycle] = useState(1);
  const key = ENGINES.map((e) => e.id).filter((id) => installed[id]).join();
  const routing = useMemo(() => planEngineRouting(key ? (key.split(',') as Engine[]) : []), [key]);

  return (
    <Section id="models" n={n} title={t.sections.models}>
      <P text={s.intro} />
      <Card className="py-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <fieldset className="flex flex-wrap items-center gap-1.5">
            <legend className="sr-only">{s.installed}</legend>
            {ENGINES.map((e) => {
              const on = installed[e.id];
              return (
                <label key={e.id} className={`cursor-pointer rounded-full border px-3 py-1 font-mono text-[12px] transition focus-within:outline-2 focus-within:outline-fg ${on ? 'border-fg bg-fg text-bg' : 'border-line bg-surface text-muted hover:border-line-strong hover:text-fg'}`}>
                  <input type="checkbox" className="sr-only" checked={on} onChange={() => setInstalled((x) => ({ ...x, [e.id]: !x[e.id] }))} />
                  {e.cli}
                </label>
              );
            })}
          </fieldset>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-faint">{s.cycle}</span>
            <Segmented label={s.cycle} value={cycle} onChange={setCycle} options={[1, 2, 3].map((c) => ({ v: c, l: c === 1 ? s.cycle1 : fmt(s.retry, { n: c - 1 }) }))} />
          </div>
        </div>

        <div className="mt-4 overflow-x-auto" aria-live="polite">
          {!routing ? (
            <div className="py-10 text-center">
              <p className="text-fg">{s.noneTitle}</p>
              <p className="mt-1 text-[13.5px] text-muted"><Rich text={s.noneBody} /></p>
            </div>
          ) : (
            <table className="w-full min-w-[520px] text-left text-[13.5px]">
              <thead>
                <tr className="border-y border-line text-[12px] text-faint">
                  <th className="py-2 pr-3 font-normal">{s.cols.agent}</th>
                  <th className="py-2 pr-3 font-normal">{s.cols.engine}</th>
                  <th className="py-2 pr-3 font-normal">{s.cols.tier}</th>
                  <th className="py-2 font-normal">{s.cols.model}</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r, i) => {
                  const engine = routing[ROLE_JOB[r.role]];
                  const worker = r.input.kind === 'work';
                  const { tier, reasons } = chooseModelTier({ ...r.input, cycle: worker ? cycle : 1 });
                  const model = modelFor(engine, tier);
                  return (
                    <tr key={i} className={`border-b border-line last:border-0 ${i === 4 ? 'border-t border-t-line-strong' : ''}`}>
                      <td className="py-2.5 pr-3 align-top">
                        <div className="font-mono text-[12.5px] text-fg">{r.who}</div>
                        <div className="text-[12px] text-faint">{s.rows[i]}</div>
                      </td>
                      <td className="py-2.5 pr-3 align-top font-mono text-[12.5px] text-fg">{engineCli(engine)}</td>
                      <td className="py-2.5 pr-3 align-top">
                        <TierPill tier={tier} />
                        <div className="mt-0.5 text-[11.5px] leading-4 text-faint">{reasons.map((x) => reasonText(x, t)).join(' · ')}</div>
                      </td>
                      <td className="py-2.5 align-top font-mono text-[12.5px]">{model ? <span className="text-fg">{model}</span> : <span className="font-sans text-faint">{s.noModel}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>
      <P text={s.after} note={s.note4} n={4} muted />
      <div>
        <p className="mb-2 text-[13px] text-faint">{s.apply}</p>
        <Cmd cmd="node .harness/team.mjs auto-assign --dry-run" />
      </div>
    </Section>
  );
}
