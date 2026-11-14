/**
 * .harness/lib/consent.mjs — ask a person ONCE before the harness uses an AI tool that is already
 * installed and logged in on their machine (it spends their own subscription / quota).
 * The answer is saved per person in .harness/approvals.json (git-ignored); after a yes the tool is used automatically.
 */
import readline from 'node:readline/promises';
import { probeEngine, engineConsent, setEngineConsent } from './common.mjs';

const LABEL = { claude: 'Claude Code', antigravity: 'Antigravity (agy)', codex: 'OpenAI Codex' };

/** Engines among `names` that are installed, pass the flag probe, and were never answered. */
export function undecidedEngines(config, names) {
  return [...new Set(names)].filter((k) => {
    const p = config.profiles?.[k];
    if (!p || engineConsent(k) !== undefined) return false;
    const probe = probeEngine(p);
    return probe.installed && probe.compatible;
  });
}

/**
 * Ask in the terminal about each undecided engine. Returns the list of names answered "yes".
 * Without a terminal nothing is asked and nothing is saved (returns []).
 */
export async function askEngineConsent(config, names, { input = process.stdin, output = process.stdout } = {}) {
  const todo = undecidedEngines(config, names);
  if (!todo.length || !input.isTTY) return [];
  const rl = readline.createInterface({ input, output });
  const yes = [];
  try {
    for (const k of todo) {
      const p = config.profiles[k];
      const ans = (await rl.question(`Found ${LABEL[k] || k} ('${p.binary}') installed on this machine. Let the harness use it? It spends your own subscription / quota. [y/n] `)).trim().toLowerCase();
      const ok = ans === 'y' || ans === 'yes';
      setEngineConsent(k, ok);
      if (ok) yes.push(k);
      output.write(`  ${ok ? '✔ allowed' : '✖ not allowed'}: ${k} (saved in .harness/approvals.json; change it any time: node .harness/engines.mjs ${ok ? 'deny' : 'allow'} ${k})\n`);
    }
  } finally { rl.close(); }
  return yes;
}

export { LABEL as ENGINE_LABELS };
