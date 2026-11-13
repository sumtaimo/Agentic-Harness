import { useState } from 'react';
import { Menu, Moon, Sun, X } from 'lucide-react';
import { GithubMark } from './ui';
import { REPO_URL } from '../site';
import { useLang } from '../lib/lang';
import type { Lang } from '../data/i18n';

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" className="fill-fg" />
      <path d="M8 22 16 8l8 14" fill="none" className="stroke-bg" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="19" r="2.4" className="fill-accent" />
    </svg>
  );
}

const LANGS: { id: Lang; label: string; full: string }[] = [
  { id: 'en', label: 'EN', full: 'English' },
  { id: 'kh', label: 'ខ្មែរ', full: 'ភាសាខ្មែរ (Khmer)' },
];

function LangSwitch() {
  const { lang, setLang, t } = useLang();
  return (
    <div role="radiogroup" aria-label={t.meta.switchLabel} className="flex h-8 items-center rounded-md border border-line p-0.5">
      {LANGS.map((l) => (
        <button key={l.id} type="button" role="radio" aria-checked={lang === l.id} title={l.full} onClick={() => setLang(l.id)}
          className={`h-full rounded px-2 text-xs transition ${lang === l.id ? 'bg-surface-2 font-medium text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]' : 'text-muted hover:text-fg'} ${l.id === 'kh' ? 'font-[Noto_Sans_Khmer]' : 'font-mono'}`}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

export function Navbar({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const [open, setOpen] = useState(false);
  const { t } = useLang();
  const links = [
    { href: '#how', label: t.nav.how },
    { href: '#simulator', label: t.nav.simulator },
    { href: '#use-cases', label: t.nav.useCases },
    { href: '#architecture', label: t.nav.architecture },
    { href: '#commands', label: t.nav.commands },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6" aria-label="Main">
        <a href="#top" className="flex shrink-0 items-center gap-2.5 font-semibold tracking-tight text-fg">
          <Logo />
          <span className="hidden min-[400px]:inline">Agentic-Harness</span>
        </a>
        <div className="hidden items-center gap-1 lg:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted transition hover:bg-surface-2 hover:text-fg">{l.label}</a>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <LangSwitch />
          <button type="button" onClick={onToggleTheme} aria-label={dark ? t.nav.toLight : t.nav.toDark}
            className="grid h-8 w-8 place-items-center rounded-md border border-line text-muted transition hover:text-fg">
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <a href={REPO_URL} target="_blank" rel="noreferrer"
            className="hidden h-8 items-center gap-2 rounded-md border border-line px-3 text-sm text-muted transition hover:text-fg sm:inline-flex">
            <GithubMark size={15} /> GitHub
          </a>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-label={t.nav.menu} aria-expanded={open}
            className="grid h-8 w-8 place-items-center rounded-md border border-line text-muted lg:hidden">
            {open ? <X size={15} /> : <Menu size={15} />}
          </button>
        </div>
      </nav>
      {open && (
        <div className="border-t border-line px-4 py-2 lg:hidden">
          {[...links, { href: REPO_URL, label: 'GitHub' }].map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="block rounded-md px-2 py-2 text-sm text-muted hover:text-fg">{l.label}</a>
          ))}
        </div>
      )}
    </header>
  );
}
