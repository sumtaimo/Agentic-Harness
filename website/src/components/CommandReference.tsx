import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { CopyButton, Section } from './ui';
import { useLang } from '../lib/lang';
import { fmt, type Dict } from '../data/i18n';

type Group = Exclude<keyof Dict['cmd']['groups'], 'all'>;
interface Command { cmd: string; where: 'claude' | 'terminal'; group: Group; key: keyof Dict['cmd']['items'] }

const COMMANDS: Command[] = [
  { cmd: '/harness:run <goal>', where: 'claude', group: 'run', key: 'run' },
  { cmd: '/harness:team', where: 'claude', group: 'team', key: 'team' },
  { cmd: '/harness:auto', where: 'claude', group: 'auto', key: 'auto' },
  { cmd: '/harness:tick', where: 'claude', group: 'auto', key: 'tick' },
  { cmd: '/harness:status', where: 'claude', group: 'inspect', key: 'status' },
  { cmd: '/harness:doctor', where: 'claude', group: 'inspect', key: 'doctor' },
  { cmd: '/harness:teach <rule>', where: 'claude', group: 'memory', key: 'teach' },
  { cmd: 'node .harness/team.mjs auto-assign --dry-run', where: 'terminal', group: 'team', key: 'autoAssign' },
  { cmd: 'node .harness/team.mjs show', where: 'terminal', group: 'team', key: 'show' },
  { cmd: 'node .harness/team.mjs validate', where: 'terminal', group: 'team', key: 'validate' },
  { cmd: 'node .harness/team.mjs sync-agents', where: 'terminal', group: 'team', key: 'sync' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --wait', where: 'terminal', group: 'run', key: 'direct' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --auto-plan --wait', where: 'terminal', group: 'run', key: 'autoPlan' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --hierarchy --max-cost 2 --wait', where: 'terminal', group: 'run', key: 'hierarchy' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --model fast --wait', where: 'terminal', group: 'run', key: 'model' },
  { cmd: 'node .harness/dispatch.mjs --goal "<goal>" --branch uat --wait', where: 'terminal', group: 'run', key: 'branch' },
  { cmd: 'node .harness/daemon.mjs', where: 'terminal', group: 'auto', key: 'daemon' },
  { cmd: 'npm run auto', where: 'terminal', group: 'auto', key: 'npmAuto' },
  { cmd: 'node .harness/backlog.mjs add "<title>" --status READY', where: 'terminal', group: 'auto', key: 'backlogAdd' },
  { cmd: 'node .harness/doctor.mjs', where: 'terminal', group: 'inspect', key: 'doctorCli' },
  { cmd: 'node .harness/status.mjs --log 15', where: 'terminal', group: 'inspect', key: 'statusCli' },
  { cmd: 'node .harness/memory.mjs remember "<rule>"', where: 'terminal', group: 'memory', key: 'remember' },
  { cmd: 'npx github:sumtaimo/Agentic-Harness --reset', where: 'terminal', group: 'setup', key: 'reset' },
];

const GROUPS: ('all' | Group)[] = ['all', 'run', 'team', 'auto', 'inspect', 'memory', 'setup'];

export function CommandReference() {
  const { t } = useLang();
  const c = t.cmd;
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'all' | Group>('all');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    // Search matches the command itself and its description in the language being shown.
    return COMMANDS.filter((x) => (group === 'all' || x.group === group) && (!s || `${x.cmd} ${c.items[x.key]} ${c.where[x.where]}`.toLowerCase().includes(s)));
  }, [q, group, c]);

  return (
    <Section id="commands" eyebrow={c.eyebrow} title={c.title} intro={c.intro}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">{c.searchLabel}</span>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={c.search}
            className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none" />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={c.filterLabel}>
          {GROUPS.map((g) => (
            <button key={g} type="button" onClick={() => setGroup(g)} aria-pressed={group === g}
              className={`rounded-md border px-2.5 py-1 text-xs transition ${group === g ? 'border-fg bg-fg text-bg' : 'border-line text-muted hover:text-fg'}`}>{c.groups[g]}</button>
          ))}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-line">
        <ul className="divide-y divide-line">
          {rows.map((x) => (
            <li key={x.cmd} className="grid gap-2 bg-surface px-4 py-3.5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:items-center md:gap-6">
              <div className="flex min-w-0 items-center gap-2 rounded-lg bg-term px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[12.5px] text-term-fg">{x.cmd}</code>
                <CopyButton text={x.cmd} />
              </div>
              <div className="text-sm leading-6 text-muted">
                <span className={`mr-2 inline-block rounded px-1.5 py-0.5 font-mono text-[10.5px] ${x.where === 'claude' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}>{c.where[x.where]}</span>
                {c.items[x.key]}
              </div>
            </li>
          ))}
          {!rows.length && <li className="bg-surface px-4 py-10 text-center text-sm text-muted">{fmt(c.noMatch, { q })}</li>}
        </ul>
      </div>
    </Section>
  );
}
