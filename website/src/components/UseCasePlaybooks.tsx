import { useState } from 'react';
import { Cmd, P, Section } from './ui';
import { INSTALL_CMD, REPO_URL } from '../site';
import { Rich, useLang } from '../lib/lang';
import type { Dict } from '../data/i18n';

type Tab = keyof Dict['setup']['tabs'];
type C = { cmd: string; prompt?: string };

/** Commands stay in English; every sentence comes from the dictionary (step i's title is t.setup[tab][i]). */
const COMMANDS: Record<Tab, C[][]> = {
  demo: [
    [{ cmd: `git clone ${REPO_URL}.git` }, { cmd: 'cd Agentic-Harness' }],
    [{ cmd: 'npm run demo' }],
    [{ cmd: '/harness:auto', prompt: '›' }],
  ],
  new: [
    [{ cmd: 'git init && git commit --allow-empty -m "init"' }],
    [{ cmd: INSTALL_CMD }],
    [{ cmd: 'node .harness/doctor.mjs' }],
    [{ cmd: '/harness:run Add a /health endpoint with tests', prompt: '›' }],
  ],
  existing: [
    [{ cmd: 'git status' }],
    [{ cmd: INSTALL_CMD }],
    [{ cmd: 'git diff --stat' }, { cmd: 'node .harness/doctor.mjs' }],
  ],
  tools: [
    [{ cmd: 'npm install -g @anthropic-ai/claude-code' }, { cmd: 'claude' }],
    [{ cmd: "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + \";$HOME\\.gemini\\bin\", 'User')", prompt: 'PS>' }, { cmd: 'agy models' }, { cmd: 'agy -p "say hi"' }],
    [{ cmd: 'npm install -g @openai/codex' }, { cmd: 'codex login' }],
    [{ cmd: 'node .harness/doctor.mjs' }, { cmd: 'node .harness/team.mjs auto-assign' }],
  ],
  cloud: [
    [{ cmd: 'npm install -g @anthropic-ai/claude-code' }],
    [{ cmd: 'claude' }],
    [{ cmd: 'node .harness/daemon.mjs' }, { cmd: 'node .harness/dispatch.mjs --goal "…" --hierarchy --max-cost 2 --wait' }],
  ],
  upgrade: [
    [{ cmd: 'git status' }],
    [{ cmd: 'npx --yes github:sumtaimo/Agentic-Harness#main .' }],
    [{ cmd: 'node .harness/doctor.mjs' }, { cmd: 'node .harness/team.mjs sync-agents' }],
  ],
};

const NOTES: Partial<Record<Tab, keyof Dict['setup']>> = { new: 'newNote', existing: 'existingNote', tools: 'toolsNote', cloud: 'cloudNote', upgrade: 'upgradeNote' };

export function UseCasePlaybooks({ n }: { n: number }) {
  const { t } = useLang();
  const s = t.setup;
  const [tab, setTab] = useState<Tab>('demo');
  const titles = s[tab] as string[];
  const noteKey = NOTES[tab];
  return (
    <Section id="setup" n={n} title={t.sections.setup}>
      <P text={s.intro} muted />
      <div role="tablist" aria-label={t.sections.setup} className="flex flex-wrap gap-x-5 gap-y-1 border-b border-line">
        {(Object.keys(s.tabs) as Tab[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-controls="setup-panel" onClick={() => setTab(k)}
            className={`-mb-px border-b py-2 text-[13.5px] transition ${tab === k ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg'}`}>
            {s.tabs[k]}
          </button>
        ))}
      </div>
      <ol id="setup-panel" role="tabpanel">
        {titles.map((title, i) => (
          <li key={`${tab}-${i}`} className="grid grid-cols-[34px_1fr] gap-2 border-b border-line py-4 last:border-0">
            <span className="pt-px font-mono text-[12px] text-faint">{String(i + 1).padStart(2, '0')}</span>
            <div className="min-w-0">
              <p className="leading-7 text-fg"><Rich text={title} /></p>
              <div className="mt-2 space-y-1.5">{COMMANDS[tab][i]?.map((c) => <Cmd key={c.cmd} {...c} />)}</div>
            </div>
          </li>
        ))}
      </ol>
      {noteKey && <P text={s[noteKey] as string} muted />}
    </Section>
  );
}
