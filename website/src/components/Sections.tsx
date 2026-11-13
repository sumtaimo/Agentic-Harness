import { useState } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { Card, CopyButton, P, Row, Section, Segmented, Steps, TierPill } from './ui';
import { Rich, useLang } from '../lib/lang';
import { fmt } from '../data/i18n';
import { TIERS } from '../lib/routing';
import { Pipeline } from './Showcase';

export function Flow({ n }: { n: number }) {
  const { t } = useLang();
  const f = t.flow;
  return (
    <Section id="flow" n={n} title={t.sections.flow}>
      <P text={f.intro} muted />
      <Pipeline />
      <P text={f.after} note={f.note2} n={2} />
    </Section>
  );
}

/** Where each duty is decided (shown on the tile, same in every language). */
const DUTY_TAGS = ['charter.md', 'targetFiles', 'fast · medium · high', 'git worktree', 'exit code', '401 · 429'];

export function Controller({ n }: { n: number }) {
  const { t } = useLang();
  const c = t.controller;
  return (
    <Section id="controller" n={n} title={t.sections.controller}>
      <P text={c.intro} />
      <ul className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
        {c.rows.map((r, i) => (
          <li key={r.k} className="bg-surface px-5 py-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-fg">{r.k}</span>
              <code className="shrink-0 font-mono text-[11px] text-faint">{DUTY_TAGS[i]}</code>
            </div>
            <p className="mt-1.5 text-[14px] leading-6 text-muted"><Rich text={r.v} /></p>
          </li>
        ))}
      </ul>
      <P text={c.after} muted />
    </Section>
  );
}

export function Task({ n }: { n: number }) {
  const { t } = useLang();
  const k = t.task;
  return (
    <Section id="task" n={n} title={t.sections.task}>
      <P text={k.intro} note={k.note3} n={3} />
      <Card>
        {k.rows.map((r) => (
          <Row key={r.cmd} k={r.k}>
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1">
                <span className="text-faint">{r.cmd}</span>
                {r.arg && <span> {r.arg}</span>}
                {r.tag && <code className="ml-2 rounded-[5px] bg-surface-2 px-1.5 py-px font-mono text-[11.5px] text-muted">{r.tag}</code>}
              </p>
              <CopyButton text={`${r.cmd}${r.arg ? ` ${r.arg}` : ''}`} />
            </div>
          </Row>
        ))}
      </Card>
      <P text={k.after} muted />
    </Section>
  );
}

export function Gate({ n }: { n: number }) {
  const { t } = useLang();
  const g = t.gate;
  const [passOn, setPassOn] = useState(2); // 1..3, or 4 = never
  const tries = [1, 2, 3].filter((c) => c <= Math.min(passOn, 3));
  return (
    <Section id="gate" n={n} title={t.sections.gate}>
      <P text={g.intro} muted />
      <Steps items={g.stages.map((s) => ({ t: `${s.t}.`, d: <Rich text={s.d} /> }))} />

      <Card className="py-5">
        <p className="text-[14.5px] text-fg">{g.tryTitle}</p>
        <div className="mt-3">
          <Segmented label={g.tryTitle} value={passOn} onChange={setPassOn} options={g.passOn.map((l, i) => ({ v: i + 1, l }))} />
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2" aria-live="polite">
          {tries.map((c, i) => {
            const ok = c === passOn;
            return (
              <div key={c} className="flex items-center gap-2">
                {i > 0 && <ArrowRight size={13} className="text-faint" aria-hidden="true" />}
                <div className="flex items-center gap-2 rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px]">
                  <span className="text-muted">{fmt(g.cycleN, { n: c })}</span>
                  <TierPill tier={TIERS[c - 1]} />
                  <span className={`inline-flex items-center gap-1 ${ok ? 'text-ok' : 'text-danger'}`}>{ok ? <Check size={12} /> : <X size={12} />}{ok ? g.passed : g.failed}</span>
                </div>
              </div>
            );
          })}
        </div>
        <p className={`mt-4 text-[14px] leading-6 ${passOn <= 3 ? 'text-fg' : 'text-warn'}`}>
          {passOn <= 3 ? fmt(g.kept, { n: passOn, tries: passOn === 1 ? g.one : g.many }) : g.rolled}
        </p>
        <p className="mt-1 text-[12.5px] text-faint">{g.tierNote}</p>
      </Card>

      <div className="flex flex-wrap items-center gap-2 text-[13px]" aria-label={`${g.branch.worker} → ${g.branch.uat} → ${g.branch.you} → ${g.branch.main}`}>
        {[g.branch.worker, g.branch.uat, g.branch.you, g.branch.main].map((x, i) => (
          <span key={x} className="flex items-center gap-2">
            {i > 0 && <ArrowRight size={13} className="text-faint" aria-hidden="true" />}
            <span className={`rounded-full border px-2.5 py-0.5 ${i === 3 ? 'border-fg text-fg' : 'border-line bg-surface text-muted'} ${i === 2 ? '' : 'font-mono text-[12px]'}`}>{x}</span>
          </span>
        ))}
      </div>
    </Section>
  );
}

export function People({ n }: { n: number }) {
  const { t } = useLang();
  const p = t.people;
  return (
    <Section id="people" n={n} title={t.sections.people}>
      <P text={p.intro} />
      <Card className="overflow-x-auto py-1">
        <table className="w-full min-w-[440px] text-[14px]">
          <thead>
            <tr className="border-b border-line text-left text-[12.5px] text-faint">
              {p.head.map((h, i) => <th key={i} className="py-2.5 pr-4 font-normal">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r[0]} className="border-b border-line last:border-0">
                <td className="py-3 pr-4 text-muted"><Rich text={r[0]} /></td>
                <td className="py-3 pr-4 text-fg"><Rich text={r[1]} /></td>
                <td className="py-3 text-fg"><Rich text={r[2]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <P text={p.after} muted />
    </Section>
  );
}

export function Limits({ n }: { n: number }) {
  const { t } = useLang();
  const l = t.limits;
  return (
    <Section id="limits" n={n} title={t.sections.limits}>
      <P text={l.intro} muted />
      <Steps items={l.items.map((x) => ({ d: <span className="text-fg"><Rich text={x} /></span> }))} />
    </Section>
  );
}
