import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Card, CopyButton, Section } from './ui';
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

  return (
    <Section id="commands" n={n} title={t.sections.commands}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line">
        {(['claude', 'terminal'] as const).map((w) => (
          <button key={w} type="button" aria-pressed={!q && where === w} onClick={() => { setWhere(w); setQ(''); }}
            className={`-mb-px border-b py-2 text-[13.5px] transition ${!q && where === w ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg'}`}>{c.where[w]}</button>
        ))}
        <label className="relative mb-1 ml-auto w-full sm:w-56">
          <span className="sr-only">{c.searchLabel}</span>
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={c.search}
            className="h-8 w-full rounded-lg border border-line bg-surface pl-8 pr-2 text-[13px] text-fg placeholder:text-faint focus:border-line-strong focus:outline-none" />
        </label>
      </div>
      <Card className="py-1">
        {rows.map((x) => (
          <div key={x.cmd} className="flex items-start gap-3 border-b border-line py-3 last:border-0">
            <div className="min-w-0 flex-1">
              <code className="block overflow-x-auto whitespace-pre font-mono text-[12.5px] text-fg">{x.cmd}</code>
              <p className="mt-0.5 text-[13px] leading-5 text-muted">{c.items[x.key]}</p>
            </div>
            <CopyButton text={x.cmd} />
          </div>
        ))}
        {!rows.length && <p className="py-8 text-center text-[13.5px] text-muted">{fmt(c.noMatch, { q })}</p>}
      </Card>
    </Section>
  );
}
