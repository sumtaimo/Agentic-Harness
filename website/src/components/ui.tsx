import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { Rich, useLang } from '../lib/lang';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts / older browsers
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const { t: dict } = useLang();
  const [done, setDone] = useState(false);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(t.current), []);
  return (
    <button
      type="button"
      onClick={async () => { if (await copyText(text)) { setDone(true); window.clearTimeout(t.current); t.current = window.setTimeout(() => setDone(false), 1400); } }}
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-fg ${className}`}
      aria-label={done ? dict.common.copied : `${dict.common.copy}: ${text}`}
      title={done ? dict.common.copied : dict.common.copy}
    >
      {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </button>
  );
}

/** A command line: light, quiet, with a copy button. */
export function Cmd({ cmd, prompt = '$' }: { cmd: string; prompt?: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[12.5px] leading-6">
      <span className="select-none text-faint">{prompt}</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-fg">{cmd}</code>
      <CopyButton text={cmd} />
    </div>
  );
}

/** A numbered section: "Title ———— 03". Notes go to the right margin on wide screens, below the text otherwise. */
export function Section({ id, n, title, children }: { id: string; n: number; title: string; children: ReactNode }) {
  return (
    <section id={id} data-section className="pt-20">
      <h2 className="flex items-center gap-4">
        <span className="font-medium text-fg">{title}</span>
        <span className="h-px flex-1 bg-line" aria-hidden="true" />
        <span className="font-serif text-lg italic text-faint">{String(n).padStart(2, '0')}</span>
      </h2>
      <div className="mt-6 space-y-5">{children}</div>
    </section>
  );
}

/** A paragraph with an optional margin note (footnote). */
export function P({ text, note, n, muted = false }: { text: string; note?: string; n?: number; muted?: boolean }) {
  return (
    <div className="relative">
      <p className={`text-pretty leading-7 ${muted ? 'text-muted' : 'text-fg'}`}><Rich text={text} /></p>
      {note && (
        <aside className="mt-2 flex gap-2 text-[12.5px] leading-5 text-faint xl:absolute xl:left-[calc(100%+48px)] xl:top-1 xl:mt-0 xl:w-[190px]">
          <span>{n}</span><span><Rich text={note} /></span>
        </aside>
      )}
    </div>
  );
}

/** A white card with label / content rows, like a form. */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-surface px-5 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] ${className}`}>{children}</div>;
}

export function Row({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-line py-3.5 last:border-0 sm:grid-cols-[150px_1fr] sm:gap-5">
      <div className="text-[13.5px] text-muted">{k}</div>
      <div className="min-w-0 text-[14.5px] leading-6 text-fg">{children}</div>
    </div>
  );
}

/** "01  Title. text" with a hairline above each step. */
export function Steps({ items }: { items: { t?: string; d: ReactNode }[] }) {
  return (
    <ol>
      {items.map((s, i) => (
        <li key={i} className="grid grid-cols-[34px_1fr] gap-2 border-t border-line py-3.5">
          <span className="pt-px font-mono text-[12px] text-faint">{String(i + 1).padStart(2, '0')}</span>
          <div className="min-w-0 leading-7 text-muted">{s.t && <span className="mr-1.5 font-medium text-fg">{s.t}</span>}{s.d}</div>
        </li>
      ))}
    </ol>
  );
}

/** Small segmented control: text options, the chosen one in ink. */
export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1">
      {options.map((o) => (
        <button key={String(o.v)} type="button" role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)}
          className={`rounded-full border px-3 py-1 text-[12.5px] transition ${value === o.v ? 'border-fg bg-fg text-bg' : 'border-line bg-surface text-muted hover:border-line-strong hover:text-fg'}`}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

const TIER_STYLE = {
  fast: 'text-ok border-ok/30 bg-ok-soft',
  medium: 'text-fg border-line-strong bg-surface-2',
  high: 'text-warn border-warn/30 bg-warn-soft',
} as const;

export function TierPill({ tier }: { tier: keyof typeof TIER_STYLE }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-px font-mono text-[11px] ${TIER_STYLE[tier]}`}>{tier}</span>;
}

export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
