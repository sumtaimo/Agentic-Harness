import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DICTS, type Dict, type Lang } from '../data/i18n';

const KEY = 'ah-lang';

function initialLang(): Lang {
  try { return localStorage.getItem(KEY) === 'kh' ? 'kh' : 'en'; } catch { return 'en'; }
}

const Ctx = createContext<{ lang: Lang; t: Dict; setLang: (l: Lang) => void }>({ lang: 'en', t: DICTS.en, setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = DICTS[lang].meta.htmlLang;
    try { localStorage.setItem(KEY, lang); } catch { /* storage may be blocked */ }
  }, [lang]);
  return <Ctx.Provider value={{ lang, t: DICTS[lang], setLang }}>{children}</Ctx.Provider>;
}

export const useLang = () => useContext(Ctx);

/**
 * Render dictionary markup: `code` → <code>, **bold** → <b>, *italic* → serif italic, ^1 → footnote mark.
 * Everything else is plain text (no HTML injection).
 */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\^\d)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') ? <code key={i} className="rounded-[5px] bg-surface-2 px-1.5 py-px font-mono text-[0.84em] text-fg">{p.slice(1, -1)}</code>
          : p.startsWith('**') ? <b key={i} className="font-medium text-fg">{p.slice(2, -2)}</b>
          : p.startsWith('*') ? <em key={i} className="font-serif text-[1.08em] italic">{p.slice(1, -1)}</em>
          : p.startsWith('^') ? <sup key={i} className="ml-0.5 text-[0.7em] text-faint">{p.slice(1)}</sup>
          : <span key={i}>{p}</span>,
      )}
    </>
  );
}
