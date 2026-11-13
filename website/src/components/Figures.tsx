/**
 * Five small isometric drawings, one per step of the workflow: you → controller → orchestrator → agents → report.
 * Drawn as plain SVG solids (top face light, side faces shaded), so they read as objects, not boxes and arrows.
 */
type P3 = [number, number, number];
type Shape = { kind: 'box'; at: P3; size: P3 } | { kind: 'line'; pts: P3[]; bold?: boolean };

const C = 0.866;
const proj = ([x, y, z]: P3): [number, number] => [(x - y) * C, (x + y) * 0.5 - z];

function boxFaces({ at: [x, y, z], size: [w, d, h] }: { at: P3; size: P3 }) {
  const top: P3[] = [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]];
  const right: P3[] = [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]];
  const left: P3[] = [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]];
  return { top, right, left };
}

const pts = (p: P3[]) => p.map((q) => proj(q).map((v) => v.toFixed(1)).join(',')).join(' ');

function Iso({ shapes }: { shapes: Shape[] }) {
  // Fit the viewBox to the drawing.
  const all: [number, number][] = shapes.flatMap((s) => (s.kind === 'box' ? Object.values(boxFaces(s)).flat() : s.pts).map(proj));
  const xs = all.map((p) => p[0]); const ys = all.map((p) => p[1]);
  const pad = 4;
  const vb = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2];
  return (
    <svg viewBox={vb.map((v) => v.toFixed(1)).join(' ')} className="h-full w-full" aria-hidden="true" strokeLinejoin="round" strokeLinecap="round">
      {shapes.map((s, i) => {
        if (s.kind === 'line') return <polyline key={i} points={pts(s.pts)} fill="none" className="stroke-faint" strokeWidth={s.bold ? 1.4 : 0.8} />;
        const f = boxFaces(s);
        return (
          <g key={i} className="stroke-line-strong" strokeWidth={0.8}>
            <polygon points={pts(f.left)} className="fill-surface-2" />
            <polygon points={pts(f.right)} className="fill-[color-mix(in_srgb,var(--surface-2)_70%,var(--border-strong))]" />
            <polygon points={pts(f.top)} className="fill-surface" />
          </g>
        );
      })}
    </svg>
  );
}

const box = (at: P3, size: P3): Shape => ({ kind: 'box', at, size });
const line = (p: P3[], bold = false): Shape => ({ kind: 'line', pts: p, bold });

/** You: a laptop. */
const YOU: Shape[] = [
  box([0, 0, 0], [44, 30, 3]),
  ...[8, 13, 18].map((y) => line([[6, y, 3], [38, y, 3]])),
  box([0, 0, 3], [44, 2, 28]),
  line([[8, 2, 12], [36, 2, 12]]), line([[8, 2, 18], [28, 2, 18]]), line([[8, 2, 24], [32, 2, 24]]),
];

/** Controller: a gate on a plinth. */
const CONTROLLER: Shape[] = [
  box([-6, -4, 0], [58, 22, 4]),
  box([0, 2, 4], [9, 9, 34]),
  box([37, 2, 4], [9, 9, 34]),
  box([-2, 2, 38], [50, 9, 7]),
  line([[9, 7, 22], [37, 7, 22]], true),
];

/** Orchestrator: a stepped tower (the plan, level by level). */
const ORCHESTRATOR: Shape[] = [
  box([0, 0, 0], [40, 40, 8]),
  box([7, 7, 8], [26, 26, 8]),
  box([14, 14, 16], [12, 12, 10]),
];

/** Agents: three blocks working side by side. */
const AGENTS: Shape[] = [
  box([0, 0, 0], [18, 18, 18]),
  box([25, 0, 0], [18, 18, 18]),
  box([50, 0, 0], [18, 18, 18]),
];

/** Report: a sheet with lines and a tick. */
const REPORT: Shape[] = [
  box([0, 0, 0], [34, 46, 2]),
  ...[8, 14, 20, 26].map((y) => line([[6, y, 2], [28, y, 2]])),
  line([[8, 35, 2], [13, 40, 2], [26, 31, 2]], true),
];

const FIGURES = [YOU, CONTROLLER, ORCHESTRATOR, AGENTS, REPORT];

export function FigureStrip({ labels, href }: { labels: string[]; href: string }) {
  return (
    <div className="border-y border-line py-4">
      <ul className="grid grid-cols-5 gap-2 sm:gap-4">
        {FIGURES.map((f, i) => (
          <li key={i}>
            <a href={href} className="group block text-center" aria-label={labels[i]}>
              <div className="mx-auto h-16 w-full max-w-[96px] transition duration-300 group-hover:-translate-y-1 sm:h-20"><Iso shapes={f} /></div>
              <span className="mt-2 block truncate text-[11.5px] text-faint transition group-hover:text-fg">{labels[i]}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
