import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { Iso, FIGURES } from './Figures';
import { Rich, useLang } from '../lib/lang';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Plays `count` steps one after another, then holds and starts again. */
function usePlayhead(count: number, stepMs: number, holdMs: number, paused = false) {
  const [i, setI] = useState(() => (reduced() ? count : 0));
  useEffect(() => {
    if (paused || reduced()) return;
    const id = window.setTimeout(() => setI((x) => (x >= count ? 0 : x + 1)), i >= count ? holdMs : stepMs);
    return () => window.clearTimeout(id);
  }, [i, count, stepMs, holdMs, paused]);
  return i;
}

/**
 * A replay of a real run: the demo project's "Add a slugify helper" task, as the controller logged it
 * (brief → assign → three named agents in parallel → verify → PASSED).
 */
const RUN: { who: string; what: string; ok?: boolean; tone?: 'agent' | 'ctrl' | 'you' }[] = [
  { who: 'you', what: '/harness:auto', tone: 'you' },
  { who: 'controller', what: 'brief · task DEMO-001', tone: 'ctrl' },
  { who: 'orchestrator', what: 'assign · 3 files → 3 agents' },
  { who: 'lead-ba', what: 'docs/slugify.md', ok: true, tone: 'agent' },
  { who: 'lead-dev', what: 'src/slugify.js', ok: true, tone: 'agent' },
  { who: 'lead-qa', what: 'tests/slugify.test.js', ok: true, tone: 'agent' },
  { who: 'controller', what: 'node --test → exit 0', tone: 'ctrl' },
];

export function RunLog() {
  const { t } = useLang();
  const r = t.hero.run;
  const shown = usePlayhead(RUN.length + 1, 650, 3200);
  return (
    <figure className="self-start rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03),0_12px_32px_-18px_rgba(0,0,0,0.18)]">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-line-strong" /><span className="h-2 w-2 rounded-full bg-line-strong" /><span className="h-2 w-2 rounded-full bg-line-strong" />
        <span className="ml-2 font-mono text-[11.5px] text-faint">demo-project</span>
        <span className="ml-auto text-[11.5px] text-faint">{r.title}</span>
      </div>
      <ol className="min-h-[248px] space-y-1.5 px-4 py-4 font-mono text-[12px] leading-5" aria-live="off">
        {RUN.map((l, i) => (
          <li key={i} className={`grid grid-cols-[96px_1fr_auto] gap-2 transition duration-300 ${i < shown ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}>
            <span className={l.tone === 'agent' ? 'text-fg' : l.tone === 'you' ? 'text-faint' : 'text-muted'}>{l.tone === 'you' ? '›' : l.who}</span>
            <span className={`min-w-0 truncate ${l.tone === 'you' ? 'text-fg' : 'text-muted'}`}>{l.what}</span>
            {l.ok && <Check size={13} className="mt-1 text-ok" aria-hidden="true" />}
          </li>
        ))}
        <li className={`mt-3 flex items-center gap-2 border-t border-line pt-3 transition duration-300 ${shown > RUN.length ? 'opacity-100' : 'opacity-0'}`}>
          <span className="rounded-full bg-ok-soft px-2 py-px font-medium text-ok">PASSED</span>
          <span className="font-sans text-[12px] text-faint">{r.after}</span>
        </li>
      </ol>
      <figcaption className="border-t border-line px-4 py-2.5 text-[11.5px] leading-5 text-faint">{r.caption}</figcaption>
    </figure>
  );
}

/** The five stations of the workflow as one line; plays by itself until the reader picks a station. */
export function Pipeline() {
  const { t } = useLang();
  const f = t.flow;
  const [picked, setPicked] = useState<number | null>(null);
  const auto = usePlayhead(f.steps.length - 1, 2600, 2600, picked !== null);
  const at = picked ?? auto;
  const s = f.steps[at];
  return (
    <div>
      <div role="tablist" aria-label={t.sections.flow} className="relative grid grid-cols-5 gap-1">
        <span className="absolute left-[10%] right-[10%] top-[80px] h-px bg-line sm:top-[94px]" aria-hidden="true" />
        <span className="absolute left-[10%] top-[80px] h-px bg-fg transition-all duration-700 sm:top-[94px]" style={{ width: `${(at / 4) * 80}%` }} aria-hidden="true" />
        {FIGURES.map((fig, i) => (
          <button key={i} type="button" role="tab" aria-selected={at === i} onClick={() => setPicked(i)} className="group relative flex flex-col items-center">
            <div className={`h-[72px] w-full max-w-[92px] transition duration-300 sm:h-[86px] ${at === i ? '-translate-y-1' : 'opacity-55 group-hover:opacity-100'}`}><Iso shapes={fig} /></div>
            <span className={`relative z-10 mt-1 h-2.5 w-2.5 rounded-full border transition ${i <= at ? 'border-fg bg-fg' : 'border-line-strong bg-bg'}`} aria-hidden="true" />
            <span className={`mt-2 max-w-full truncate text-[11.5px] transition ${at === i ? 'text-fg' : 'text-faint group-hover:text-fg'}`}>{t.hero.figures[i]}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-5 flex gap-4 rounded-2xl border border-line bg-surface px-5 py-4">
        <span className="pt-0.5 font-mono text-[12px] text-faint">{String(at + 1).padStart(2, '0')}/05</span>
        <p className="leading-7 text-muted"><span className="mr-1.5 font-medium text-fg">{s.t}</span><Rich text={s.d} /></p>
      </div>
    </div>
  );
}
