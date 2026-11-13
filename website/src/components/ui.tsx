import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useLang } from '../lib/lang';

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
  const label = dict.common.copy;
  const [done, setDone] = useState(false);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(t.current), []);
  return (
    <button
      type="button"
      onClick={async () => { if (await copyText(text)) { setDone(true); window.clearTimeout(t.current); t.current = window.setTimeout(() => setDone(false), 1400); } }}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-term-line px-2 py-1 text-xs text-term-muted transition hover:border-term-muted hover:text-term-fg focus-visible:outline-2 focus-visible:outline-accent ${className}`}
      aria-label={done ? dict.common.copied : `${label}: ${text}`}
    >
      {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
      <span>{done ? dict.common.copied : label}</span>
    </button>
  );
}

/** A terminal-style command line with a copy button. Always dark, in both themes. */
export function Cmd({ cmd, comment, prompt = '$' }: { cmd: string; comment?: string; prompt?: string }) {
  return (
    <div className="group flex items-start gap-3 rounded-lg border border-term-line bg-term px-3.5 py-2.5 font-mono text-[13px] leading-6">
      <span className="select-none text-term-muted">{prompt}</span>
      <div className="min-w-0 flex-1 overflow-x-auto">
        <code className="whitespace-pre text-term-fg">{cmd}</code>
        {comment && <div className="whitespace-normal text-term-muted"># {comment}</div>}
      </div>
      <CopyButton text={cmd} />
    </div>
  );
}

export function Section({ id, eyebrow, title, intro, children }: { id: string; eyebrow: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="border-t border-line">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <header className="mx-auto max-w-3xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-accent">{eyebrow}</p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-fg sm:text-[36px]">{title}</h2>
          {intro && <div className="mx-auto mt-4 max-w-2xl text-pretty text-[15px] leading-7 text-muted">{intro}</div>}
        </header>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

const TIER_STYLE = {
  fast: 'bg-ok-soft text-ok border-ok/30',
  medium: 'bg-accent-soft text-accent border-accent/30',
  high: 'bg-warn-soft text-warn border-warn/30',
} as const;

export function TierPill({ tier }: { tier: keyof typeof TIER_STYLE }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium ${TIER_STYLE[tier]}`}>{tier}</span>;
}

export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
