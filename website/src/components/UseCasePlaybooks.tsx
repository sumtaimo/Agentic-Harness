import { useState, type ReactNode } from 'react';
import { ArrowUpCircle, Cloud, FolderGit2, Gauge, Info, Rocket, TriangleAlert } from 'lucide-react';
import { Cmd, Section, TierPill } from './ui';
import { INSTALL_CMD } from '../site';
import { Rich, useLang } from '../lib/lang';
import type { Dict } from '../data/i18n';

type C = { cmd: string; comment?: string; prompt?: string };
interface Step { title: string; body?: ReactNode; cmds?: C[] }
interface Playbook { id: keyof Dict['pb']['tabs']; icon: ReactNode; summary: string; steps: Step[]; callout?: { tone: 'info' | 'warn'; text: string } }

/** Commands stay in English; every sentence comes from the dictionary. */
function playbooks(t: Dict): Playbook[] {
  const p = t.pb;
  const R = (s: string) => <Rich text={s} />;
  return [
    {
      id: 'new', icon: <Rocket size={15} />, summary: p.new.summary,
      steps: [
        { title: p.new.s1.title, body: R(p.new.s1.body), cmds: [{ cmd: 'git init && git commit --allow-empty -m "init"' }] },
        { title: p.new.s2.title, body: R(p.new.s2.body), cmds: [{ cmd: INSTALL_CMD, comment: p.new.s2.c1 }] },
        { title: p.new.sReset.title, body: R(p.new.sReset.body), cmds: [{ cmd: 'node install.mjs --reset', comment: p.new.sReset.c1 }] },
        { title: p.new.s3.title, body: R(p.new.s3.body), cmds: [{ cmd: 'node .harness/doctor.mjs' }] },
        { title: p.new.s4.title, body: R(p.new.s4.body) },
        { title: p.new.s5.title, body: R(p.new.s5.body), cmds: [{ cmd: '/harness:team', prompt: '›' }, { cmd: '/harness:run Add a /health endpoint with tests', prompt: '›' }] },
      ],
    },
    {
      id: 'existing', icon: <FolderGit2 size={15} />, summary: p.existing.summary,
      steps: [
        { title: p.existing.s1.title, body: R(p.existing.s1.body), cmds: [{ cmd: 'git status' }] },
        { title: p.existing.s2.title, cmds: [{ cmd: INSTALL_CMD }] },
        { title: p.existing.s3.title, body: <ul className="list-disc space-y-1.5 pl-5">{p.existing.s3.items.map((x) => <li key={x}><Rich text={x} /></li>)}</ul> },
        { title: p.existing.s4.title, cmds: [{ cmd: 'git diff --stat' }, { cmd: 'node .harness/doctor.mjs' }] },
      ],
    },
    {
      id: 'tokens', icon: <Gauge size={15} />, summary: p.tokens.summary,
      steps: [
        {
          title: p.tokens.s1.title,
          body: (
            <div className="space-y-2">
              <p><Rich text={p.tokens.s1.body} /></p>
              <div className="grid gap-2 sm:grid-cols-3">
                <TierBox tier="fast" model="haiku" text={p.tokens.s1.fast} />
                <TierBox tier="medium" model="sonnet" text={p.tokens.s1.medium} />
                <TierBox tier="high" model="opus" text={p.tokens.s1.high} />
              </div>
              <p><Rich text={p.tokens.s1.after} /></p>
            </div>
          ),
        },
        { title: p.tokens.s2.title, cmds: [{ cmd: 'grep MODEL_TIER .harness/telemetry.log', comment: p.tokens.s2.c1 }] },
        { title: p.tokens.s3.title, body: R(p.tokens.s3.body), cmds: [{ cmd: 'node .harness/dispatch.mjs --goal "Rename util to helpers" --model fast --wait' }] },
      ],
      callout: { tone: 'info', text: p.tokens.callout },
    },
    {
      id: 'cloud', icon: <Cloud size={15} />, summary: p.cloud.summary,
      steps: [
        { title: p.cloud.s1.title, body: R(p.cloud.s1.body), cmds: [{ cmd: 'docker run -it --rm -v "$PWD":/work -w /work node:22 bash' }, { cmd: 'npm install -g @anthropic-ai/claude-code' }] },
        { title: p.cloud.s2.title, body: R(p.cloud.s2.body), cmds: [{ cmd: 'claude', comment: p.cloud.s2.c1 }, { cmd: 'export ANTHROPIC_API_KEY=…', comment: p.cloud.s2.c2 }] },
        { title: p.cloud.s3.title, body: R(p.cloud.s3.body), cmds: [{ cmd: 'node .harness/daemon.mjs', comment: p.cloud.s3.c1 }, { cmd: 'node .harness/dispatch.mjs --goal "…" --hierarchy --max-cost 2 --wait' }] },
      ],
      callout: { tone: 'warn', text: p.cloud.callout },
    },
    {
      id: 'upgrade', icon: <ArrowUpCircle size={15} />, summary: p.upgrade.summary,
      steps: [
        { title: p.upgrade.s1.title, cmds: [{ cmd: 'git status' }] },
        { title: p.upgrade.s2.title, body: R(p.upgrade.s2.body), cmds: [{ cmd: 'npx --yes github:sumtaimo/Agentic-Harness#main .' }] },
        { title: p.upgrade.s3.title, cmds: [{ cmd: 'node .harness/doctor.mjs' }, { cmd: 'node .harness/team.mjs sync-agents', comment: p.upgrade.s3.c1 }] },
      ],
      callout: { tone: 'warn', text: p.upgrade.callout },
    },
  ];
}

export function UseCasePlaybooks() {
  const { t } = useLang();
  const all = playbooks(t);
  const [active, setActive] = useState<Playbook['id']>('new');
  const pb = all.find((p) => p.id === active)!;
  return (
    <Section id="use-cases" eyebrow={t.pb.eyebrow} title={t.pb.title} intro={t.pb.intro}>
      <div role="tablist" aria-label={t.pb.tabsLabel} className="mx-auto flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
        {all.map((p) => (
          <button key={p.id} role="tab" type="button" aria-selected={active === p.id} aria-controls={`pb-${p.id}`} onClick={() => setActive(p.id)}
            className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm transition ${active === p.id ? 'bg-surface-2 text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]' : 'text-muted hover:text-fg'}`}>
            {p.icon}{t.pb.tabs[p.id]}
          </button>
        ))}
      </div>

      <div id={`pb-${pb.id}`} role="tabpanel" className="mt-6 rounded-xl border border-line bg-surface p-5 sm:p-7">
        <p className="text-[15px] text-muted">{pb.summary}</p>
        <ol className="mt-6 space-y-7">
          {pb.steps.map((s, i) => (
            <li key={i} className="grid grid-cols-[28px_1fr] gap-4">
              <span className="grid h-7 w-7 place-items-center rounded-full border border-line-strong font-mono text-xs text-muted">{i + 1}</span>
              <div className="min-w-0">
                <h3 className="pt-0.5 font-medium text-fg">{s.title}</h3>
                {s.body && <div className="mt-1.5 text-sm leading-6 text-muted">{s.body}</div>}
                {s.cmds && <div className="mt-3 space-y-2">{s.cmds.map((c) => <Cmd key={c.cmd} {...c} />)}</div>}
              </div>
            </li>
          ))}
        </ol>
        {pb.callout && (
          <div className={`mt-7 flex gap-3 rounded-lg border p-4 text-sm leading-6 text-fg ${pb.callout.tone === 'warn' ? 'border-warn/30 bg-warn-soft' : 'border-accent/30 bg-accent-soft'}`}>
            {pb.callout.tone === 'warn' ? <TriangleAlert size={16} className="mt-1 shrink-0 text-warn" /> : <Info size={16} className="mt-1 shrink-0 text-accent" />}
            <p><Rich text={pb.callout.text} /></p>
          </div>
        )}
      </div>
    </Section>
  );
}

function TierBox({ tier, model, text }: { tier: 'fast' | 'medium' | 'high'; model: string; text: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex items-center justify-between"><TierPill tier={tier} /><code className="font-mono text-xs text-fg">{model}</code></div>
      <p className="mt-2 text-xs leading-5">{text}</p>
    </div>
  );
}
