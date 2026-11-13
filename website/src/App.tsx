import { useEffect, useState } from 'react';
import { Navbar, Logo } from './components/Navbar';
import { Hero } from './components/Hero';
import { HowItWorks } from './components/HowItWorks';
import { RoutingSimulator } from './components/RoutingSimulator';
import { UseCasePlaybooks } from './components/UseCasePlaybooks';
import { PipelineDiagram } from './components/PipelineDiagram';
import { CommandReference } from './components/CommandReference';
import { GithubMark } from './components/ui';
import { REPO_URL } from './site';
import { LangProvider, useLang } from './lib/lang';

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('ah-theme', dark ? 'dark' : 'light'); } catch { /* storage may be blocked */ }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

function Page() {
  const { dark, toggle } = useTheme();
  const { t } = useLang();
  return (
    <>
      <a href="#how" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-fg focus:px-3 focus:py-1.5 focus:text-bg">{t.nav.skip}</a>
      <Navbar dark={dark} onToggleTheme={toggle} />
      <main>
        <Hero />
        <HowItWorks />
        <RoutingSimulator />
        <UseCasePlaybooks />
        <PipelineDiagram />
        <CommandReference />
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 text-sm text-muted sm:flex-row sm:items-center sm:px-6">
          <div className="flex items-center gap-2.5 text-fg"><Logo /><span className="font-medium">Agentic-Harness</span></div>
          <p className="sm:ml-4">{t.footer.tagline}</p>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 hover:text-fg sm:ml-auto"><GithubMark size={15} /> sumtaimo/Agentic-Harness</a>
        </div>
      </footer>
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
