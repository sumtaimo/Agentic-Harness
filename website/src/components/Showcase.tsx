import { useEffect, useState } from 'react';
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
            <div className={`h-[72px] w-full max-w-[92px] transition duration-300 sm:h-[86px] ${at === i ? '-translate-y-1' : 'opacity-75 group-hover:opacity-100'}`}><Iso shapes={fig} /></div>
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
