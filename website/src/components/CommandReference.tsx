import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { CopyButton, Section } from './ui';
import { useLang } from '../lib/lang';
import { fmt, type Dict } from '../data/i18n';

interface Command { cmd: string; where: 'claude' | 'terminal'; key: keyof Dict['cmd']['items'] }

const COMMANDS: Command[] = [
  { cmd: '/harness:run <goal>', where: 'claude', key: 'run' },
  { cmd: '/harness:auto', where: 'claude', key: 'auto' },
  { cmd: '/harness:team', where: 'claude', key: 'team' },
  { cmd: '/harness:status', where: 'claude', key: 'status' },
  { cmd: '/harness:doctor', where: 'claude', key: 'doctor' },
  { cmd: '/harness:teach <rule>', where: 'claude', key: 'teach' },
  { cmd: '/harness:tick', where: 'claude', key: 'tick' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --wait', where: 'terminal', key: 'direct' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --auto-plan --wait', where: 'terminal', key: 'autoPlan' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --hierarchy --max-cost 2 --wait', where: 'terminal', key: 'hierarchy' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --model fast --wait', where: 'terminal', key: 'model' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --branch uat --wait', where: 'terminal', key: 'branch' },
  { cmd: 'node .harness/daemon.mjs', where: 'terminal', key: 'daemon' },
  { cmd: 'npm run auto', where: 'terminal', key: 'npmAuto' },
  { cmd: 'node .harness/backlog.mjs add "<title>" --status READY', where: 'terminal', key: 'backlogAdd' },
  { cmd: 'node .harness/backlog.mjs approve <id>', where: 'terminal', key: 'approve' },
  { cmd: 'node .harness/engines.mjs', where: 'terminal', key: 'engines' },
  { cmd: 'node .harness/usage.mjs', where: 'terminal', key: 'usage' },
  { cmd: 'node .harness/team.mjs auto-assign --dry-run', where: 'terminal', key: 'autoAssign' },
  { cmd: 'node .harness/team.mjs show', where: 'terminal', key: 'show' },
  { cmd: 'node .harness/team.mjs validate', where: 'terminal', key: 'validate' },
  { cmd: 'node .harness/team.mjs sync-agents', where: 'terminal', key: 'sync' },
  { cmd: 'node .harness/doctor.mjs', where: 'terminal', key: 'doctorCli' },
  { cmd: 'node .harness/status.mjs --log 15', where: 'terminal', key: 'statusCli' },
  { cmd: 'node .harness/memory.mjs remember "<rule>"', where: 'terminal', key: 'remember' },
  { cmd: 'npx github:sumtaimo/Agentic-Harness --reset', where: 'terminal', key: 'reset' },
];

export function CommandReference({ n }: { n: number }) {
  const { t } = useLang();
  const c = t.cmd;
  const [q, setQ] = useState('');
  const [where, setWhere] = useState<'claude' | 'terminal'>('claude');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    // Typing searches everything; otherwise show one place at a time.
    return COMMANDS.filter((x) => (s ? `${x.cmd} ${c.items[x.key]}`.toLowerCase().includes(s) : x.where === where));
  }, [q, where, c]);

  const count = (w: 'claude' | 'terminal') => COMMANDS.filter((x) => x.where === w).length;

  return (
    <Section id="commands" n={n} title={t.sections.commands}>
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label={t.sections.commands} className="inline-flex rounded-full border border-line bg-surface p-0.5">
          {(['claude', 'terminal'] as const).map((w) => {
            const on = !q && where === w;
            return (
              <button key={w} type="button" role="radio" aria-checked={on} onClick={() => { setWhere(w); setQ(''); }}
                className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1 text-[13px] transition ${on ? 'bg-fg text-bg' : 'text-muted hover:text-fg'}`}>
                {c.where[w]}<span className={`font-mono text-[11px] ${on ? 'text-bg/60' : 'text-faint'}`}>{count(w)}</span>
              </button>
            );
          })}
        </div>
        <label className="relative ml-auto w-full sm:w-60">
          <span className="sr-only">{c.searchLabel}</span>
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={c.search}
            className="h-8 w-full rounded-full border border-line bg-surface pl-8 pr-3 text-[13px] text-fg placeholder:text-faint focus:border-line-strong focus:outline-none" />
        </label>
      </div>
      <div className="relative overflow-hidden rounded-2xl border border-line bg-surface">
        <ul className="cmd-scroll max-h-[440px] overflow-y-auto px-2 pb-6 pt-2" tabIndex={0} aria-label={t.sections.commands}>
          {rows.map((x) => (
            <li key={x.cmd} className="group flex items-start gap-3 rounded-xl px-3 py-2.5 transition hover:bg-surface-2">
              <span className="mt-[3px] w-3 shrink-0 select-none text-center font-mono text-[12px] text-faint">{x.where === 'claude' ? '›' : '$'}</span>
              <div className="min-w-0 flex-1">
                <code className="block whitespace-pre-wrap break-words font-mono text-[12.5px] leading-5 text-fg">{x.cmd}</code>
                <p className="mt-0.5 text-[13px] leading-5 text-muted">{c.items[x.key]}</p>
              </div>
              <CopyButton text={x.cmd} className="opacity-60 group-hover:opacity-100" />
            </li>
          ))}
          {!rows.length && <li className="py-10 text-center text-[13.5px] text-muted">{fmt(c.noMatch, { q })}</li>}
        </ul>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface to-transparent" aria-hidden="true" />
      </div>
    </Section>
  );
}
