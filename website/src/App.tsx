import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { RunLog } from './components/Showcase';
import { Controller, Flow, Gate, Limits, People, Task } from './components/Sections';
import { RoutingSimulator } from './components/RoutingSimulator';
import { UseCasePlaybooks } from './components/UseCasePlaybooks';
import { CommandReference } from './components/CommandReference';
import { CopyButton, GithubMark, P } from './components/ui';
import { INSTALL_CMD, REPO_URL, TESTS_PASSING } from './site';
import { LangProvider, Rich, useLang } from './lib/lang';
import { fmt, type Dict, type Lang } from './data/i18n';

/** Page order. The number shown next to each section title is its position here. */
const ORDER: (keyof Dict['sections'])[] = ['flow', 'controller', 'task', 'gate', 'models', 'setup', 'people', 'commands', 'limits'];
const SECTION_ID: Record<keyof Dict['sections'], string> = {
  flow: 'flow', controller: 'controller', task: 'task', gate: 'gate', models: 'models', setup: 'setup', people: 'people', commands: 'commands', limits: 'limits',
};

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('ah-theme', dark ? 'dark' : 'light'); } catch { /* storage may be blocked */ }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

/** The id of the section currently at the top of the screen. */
function useActiveSection() {
  const [active, setActive] = useState('top');
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-section]'));
    const onScroll = () => {
      let id = 'top';
      for (const el of els) if (el.getBoundingClientRect().top < window.innerHeight * 0.3) id = el.id;
      setActive(id);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return active;
}

export function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-fg" />
      <path d="M9 22 16 9l7 13" fill="none" className="stroke-bg" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Contents as a pipeline rail: stations you have passed are filled, the current one is ringed. */
function Sidebar({ active }: { active: string }) {
  const { t } = useLang();
  const at = ORDER.findIndex((k) => SECTION_ID[k] === active);
  return (
    <nav aria-label={t.nav.menu} className="sticky top-10 hidden self-start lg:block">
      <a href="#top" className="flex items-center gap-2 text-[13.5px] font-medium text-fg"><Logo />Agentic Harness</a>
      <ol className="relative mt-8">
        <span className="absolute bottom-2 left-[4px] top-2 w-px bg-line" aria-hidden="true" />
        <span className="absolute left-[4px] top-2 w-px bg-fg transition-all duration-500" style={{ height: at < 0 ? 0 : `calc(${(at / (ORDER.length - 1)) * 100}% - 16px)` }} aria-hidden="true" />
        {ORDER.map((k, i) => {
          const cur = i === at; const done = i < at;
          return (
            <li key={k}>
              <a href={`#${SECTION_ID[k]}`} aria-current={cur ? 'true' : undefined} className={`group relative flex items-center gap-3 py-[5px] text-[13.5px] transition ${cur ? 'text-fg' : 'text-muted hover:text-fg'}`}>
                <span className={`relative z-10 h-[9px] w-[9px] shrink-0 rounded-full border transition ${cur ? 'border-fg bg-bg ring-2 ring-fg/15' : done ? 'border-fg bg-fg' : 'border-line-strong bg-bg group-hover:border-fg'}`} aria-hidden="true" />
                {t.sections[k]}
              </a>
            </li>
          );
        })}
      </ol>
      <div className="mt-8 space-y-1 border-t border-line pt-4 text-[13px]">
        <a href="#setup" className="block text-muted transition hover:text-fg">{t.hero.install} ↓</a>
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="block text-muted transition hover:text-fg">{t.nav.github} ↗</a>
      </div>
    </nav>
  );
}

const LANGS: { id: Lang; label: string }[] = [{ id: 'en', label: 'EN' }, { id: 'kh', label: 'ខ្មែរ' }];

function Header({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const { t, lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <header className="relative flex items-center gap-3">
      <p className="min-w-0 flex-1 truncate text-[14.5px]">
        <span className="font-medium text-fg lg:hidden">Agentic Harness</span>
        <span className="hidden text-faint sm:inline"><span className="lg:hidden"> · </span>{t.hero.kind}</span>
      </p>
      <div role="radiogroup" aria-label={t.meta.switchLabel} className="flex items-center text-[12.5px]">
        {LANGS.map((l, i) => (
          <span key={l.id} className="flex items-center">
            {i > 0 && <span className="px-1 text-line-strong" aria-hidden="true">/</span>}
            <button type="button" role="radio" aria-checked={lang === l.id} onClick={() => setLang(l.id)}
              className={`transition ${lang === l.id ? 'text-fg' : 'text-faint hover:text-fg'} ${l.id === 'kh' ? 'font-[Noto_Sans_Khmer]' : ''}`}>{l.label}</button>
          </span>
        ))}
      </div>
      <button type="button" onClick={onToggleTheme} aria-label={dark ? t.nav.toLight : t.nav.toDark} title={dark ? t.nav.toLight : t.nav.toDark}
        className="grid h-7 w-7 place-items-center rounded-md text-faint transition hover:text-fg">
        {dark ? <Sun size={15} /> : <Moon size={15} />}
      </button>
      <a href={REPO_URL} target="_blank" rel="noreferrer" aria-label="GitHub" className="grid h-7 w-7 place-items-center rounded-md text-faint transition hover:text-fg"><GithubMark size={15} /></a>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-[12.5px] text-muted hover:text-fg lg:hidden">{t.nav.menu}</button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-56 rounded-xl border border-line bg-surface p-3 shadow-lg lg:hidden">
          {ORDER.map((k) => <a key={k} href={`#${SECTION_ID[k]}`} onClick={() => setOpen(false)} className="block py-1 text-[13.5px] text-muted hover:text-fg">{t.sections[k]}</a>)}
        </div>
      )}
    </header>
  );
}

function Intro() {
  const { t } = useLang();
  const h = t.hero;
  return (
    <div id="top" data-section className="xl:w-[calc(100%+258px)]">
      <div className="mt-14 grid gap-10 xl:grid-cols-[minmax(0,1fr)_380px] xl:gap-12">
        <div className="min-w-0">
          <h1 className="text-balance text-[26px] font-medium leading-[1.3] tracking-tight text-fg sm:text-[30px]"><Rich text={h.line} /></h1>
          <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-faint">
            <span>{fmt(h.tests, { n: TESTS_PASSING })}</span>
            <span aria-hidden="true">·</span><span>{h.license}</span>
            <span aria-hidden="true">·</span><span>Node 18+</span>
          </p>
          <div className="mt-7 space-y-4">
            <P text={h.p1} />
            <P text={h.p2} note={h.note1} n={1} inline />
          </div>
          <div className="mt-6 flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12.5px]">
            <span className="select-none text-faint">$</span>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-fg">{INSTALL_CMD}</code>
            <CopyButton text={INSTALL_CMD} />
          </div>
          <p className="mt-3 text-[13px] text-faint"><a href="#setup" className="ink-link text-muted">{h.install} ↓</a></p>
        </div>
        <RunLog />
      </div>
      <div className="mt-10"><P text={h.p3} muted /></div>
    </div>
  );
}

function Page() {
  const { dark, toggle } = useTheme();
  const active = useActiveSection();
  const { t } = useLang();
  const sections = {
    flow: Flow, controller: Controller, task: Task, gate: Gate, models: RoutingSimulator,
    setup: UseCasePlaybooks, people: People, commands: CommandReference, limits: Limits,
  } as const;
  return (
    <>
      <a href="#flow" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-fg focus:px-3 focus:py-1.5 focus:text-bg">{t.nav.skip}</a>
      <div className="mx-auto grid max-w-[1160px] gap-14 px-4 pb-24 pt-10 sm:px-6 lg:grid-cols-[170px_minmax(0,600px)] xl:grid-cols-[170px_minmax(0,600px)_210px]">
        <Sidebar active={active} />
        <main className="min-w-0">
          <Header dark={dark} onToggleTheme={toggle} />
          <Intro />
          {ORDER.map((k, i) => { const S = sections[k]; return <S key={k} n={i + 1} />; })}
          <footer className="mt-24 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-6 text-[12.5px] text-faint">
            <Logo /><span className="text-muted">Agentic Harness</span><span>{t.footer.tagline}</span>
          </footer>
        </main>
      </div>
    </>
  );
}

export default function App() {
  return (
    <LangProvider>
      <Page />
    </LangProvider>
  );
}
