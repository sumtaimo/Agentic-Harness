/**
 * Isometric drawings: solid objects (light top, two shaded sides, thin ink outline), not boxes and arrows.
 *   - FIGURES: five small stations of the workflow (you → controller → orchestrator → agents → report)
 *   - HarnessMachine: the whole harness as one labelled machine, for the top of the page
 */
import type { ReactElement } from 'react';

type P3 = [number, number, number];
/** Optional motion: a CSS animation class (see index.css), a travel vector for slides, and a start delay. */
type Motion = { anim?: 'iso-slide' | 'iso-blink' | 'iso-led' | 'iso-bob' | 'iso-stamp' | 'iso-draw'; move?: P3; delay?: number };
type Shape = Motion & (
  | { kind: 'box'; at: P3; size: P3; tone?: 'ink'; r?: number }
  | { kind: 'line'; pts: P3[]; bold?: boolean }
  | { kind: 'dot'; at: P3; r?: number; tone?: 'ok' | 'ink' });

const C = 0.866;
const proj = ([x, y, z]: P3): [number, number] => [(x - y) * C, (x + y) * 0.5 - z];

function boxFaces({ at: [x, y, z], size: [w, d, h] }: { at: P3; size: P3 }) {
  const top: P3[] = [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]];
  const right: P3[] = [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]];
  const left: P3[] = [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]];
  return { top, right, left };
}

const pts = (p: P3[]) => p.map((q) => proj(q).map((v) => v.toFixed(1)).join(',')).join(' ');
const shapePoints = (s: Shape) => (s.kind === 'box' ? Object.values(boxFaces(s)).flat() : s.kind === 'dot' ? [s.at] : s.pts).map(proj);

function bounds(points: [number, number][], padX: number, padY: number) {
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  return [Math.min(...xs) - padX, Math.min(...ys) - padY, Math.max(...xs) - Math.min(...xs) + padX * 2, Math.max(...ys) - Math.min(...ys) + padY * 2];
}

/**
 * The plan outline of a box with rounded corners: points on the XY plane with their outward normals.
 * Corner radius defaults to a little (never more than a quarter of the shorter side).
 */
function roundedPlan(x: number, y: number, w: number, d: number, r: number, steps = 5) {
  const rr = Math.max(0.01, Math.min(r, w / 2 - 0.01, d / 2 - 0.01));
  const corners: [number, number, number][] = [[x + w - rr, y + rr, -90], [x + w - rr, y + d - rr, 0], [x + rr, y + d - rr, 90], [x + rr, y + rr, 180]];
  const out: { p: [number, number]; n: [number, number] }[] = [];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= steps; k++) {
      const a = ((a0 + (90 * k) / steps) * Math.PI) / 180;
      out.push({ p: [cx + rr * Math.cos(a), cy + rr * Math.sin(a)], n: [Math.cos(a), Math.sin(a)] });
    }
  }
  return out;
}

const defaultRadius = (w: number, d: number) => Math.min(2.2, Math.min(w, d) / 4);

/** A box drawn as a modern solid: rounded vertical edges with smooth shading, a rounded top, a soft outline. */
function RoundedBox({ s }: { s: Extract<Shape, { kind: 'box' }> }) {
  const [x, y, z] = s.at; const [w, d, h] = s.size;
  const plan = roundedPlan(x, y, w, d, s.r ?? defaultRadius(w, d));
  const ink = s.tone === 'ink';
  const A = ink ? 'var(--iso-ink-a)' : 'var(--iso-a)';
  const B = ink ? 'var(--iso-ink-b)' : 'var(--iso-b)';
  const P = (q: [number, number], zz: number) => proj([q[0], q[1], zz]).map((v) => v.toFixed(2)).join(',');
  const sides: ReactElement[] = []; const bottom: ReactElement[] = []; const verticals: ReactElement[] = [];
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i]; const b = plan[(i + 1) % plan.length];
    const nx = (a.n[0] + b.n[0]) / 2; const ny = (a.n[1] + b.n[1]) / 2;
    const seen = nx + ny > 0.02;
    const prevSeen = (() => { const c = plan[(i - 1 + plan.length) % plan.length]; return (c.n[0] + a.n[0]) / 2 + (c.n[1] + a.n[1]) / 2 > 0.02; })();
    if (seen !== prevSeen && h > 0.6) verticals.push(<line key={`v${i}`} x1={proj([a.p[0], a.p[1], z])[0]} y1={proj([a.p[0], a.p[1], z])[1]} x2={proj([a.p[0], a.p[1], z + h])[0]} y2={proj([a.p[0], a.p[1], z + h])[1]} />);
    if (!seen || h <= 0) continue;
    const pctA = Math.round((Math.atan2(Math.max(0, ny), Math.max(0, nx)) / (Math.PI / 2)) * 100);
    sides.push(<polygon key={i} points={`${P(a.p, z)} ${P(b.p, z)} ${P(b.p, z + h)} ${P(a.p, z + h)}`} fill={`color-mix(in srgb, ${A} ${pctA}%, ${B})`} stroke={`color-mix(in srgb, ${A} ${pctA}%, ${B})`} strokeWidth={0.3} />);
    bottom.push(<line key={`b${i}`} x1={proj([a.p[0], a.p[1], z])[0]} y1={proj([a.p[0], a.p[1], z])[1]} x2={proj([b.p[0], b.p[1], z])[0]} y2={proj([b.p[0], b.p[1], z])[1]} />);
  }
  return (
    <g>
      {sides}
      <g stroke="var(--iso-ink)" strokeWidth={0.7}>{bottom}{verticals}</g>
      <polygon points={plan.map((q) => P(q.p, z + h)).join(' ')} fill={ink ? 'var(--iso-ink-top)' : 'var(--iso-top)'} stroke="var(--iso-ink)" strokeWidth={0.7} />
    </g>
  );
}

/** A soft shadow on the ground under every box that stands on z = 0. */
function Shadows({ shapes }: { shapes: Shape[] }) {
  return (
    <g fill="var(--fg)" opacity={0.06}>
      {shapes.map((s, i) => {
        if (s.kind !== 'box' || s.at[2] !== 0 || s.size[2] < 1) return null;
        const [x, y] = s.at; const [w, d] = s.size;
        const plan = roundedPlan(x + 2.5, y + 2.5, w, d, (s.r ?? defaultRadius(w, d)) + 1.5);
        return <polygon key={i} points={plan.map((q) => proj([q.p[0], q.p[1], 0]).map((v) => v.toFixed(2)).join(',')).join(' ')} />;
      })}
    </g>
  );
}

function Solid({ s }: { s: Shape }) {
  if (!s.anim) return <Plain s={s} />;
  const [mx, my] = s.move ? proj(s.move) : [0, 0];
  const style = { ['--mx' as string]: `${mx.toFixed(1)}px`, ['--my' as string]: `${my.toFixed(1)}px`, animationDelay: `${s.delay ?? 0}s` };
  return <g className={s.anim} style={style}><Plain s={s} /></g>;
}

function Plain({ s }: { s: Shape }) {
  if (s.kind === 'dot') { const [x, y] = proj(s.at); return <circle cx={x} cy={y} r={s.r ?? 1.6} fill={s.tone === 'ink' ? 'var(--iso-ink-b)' : 'var(--ok)'} />; }
  if (s.kind === 'line') return <polyline points={pts(s.pts)} fill="none" stroke="var(--iso-ink)" strokeWidth={s.bold ? 1.3 : 0.7} pathLength={1} />;
  return <RoundedBox s={s as Extract<Shape, { kind: 'box' }>} />;
}

export function Iso({ shapes }: { shapes: Shape[] }) {
  const vb = bounds(shapes.flatMap(shapePoints), 4, 4);
  return (
    <svg viewBox={vb.map((v) => v.toFixed(1)).join(' ')} className="h-full w-full" aria-hidden="true" strokeLinejoin="round" strokeLinecap="round">
      <Shadows shapes={shapes} />
      {shapes.map((s, i) => <Solid key={i} s={s} />)}
    </svg>
  );
}

const box = (at: P3, size: P3, tone?: 'ink', r?: number): Shape => ({ kind: 'box', at, size, tone, r });
const line = (p: P3[], bold = false): Shape => ({ kind: 'line', pts: p, bold });
/** Give a shape some motion. */
const moving = (sh: Shape, anim: NonNullable<Motion['anim']>, opts: { move?: P3; delay?: number } = {}): Shape => ({ ...sh, anim, ...opts });

/* ── The five stations ─────────────────────────────────────────────── */

const dot = (at: P3, r?: number, tone?: 'ok' | 'ink'): Shape => ({ kind: 'dot', at, r, tone });
/** Four tiny screws, one near each top corner of a plate: the small detail that makes it read as an object. */
const screws = (x: number, y: number, w: number, d: number, z: number, inset = 2.6): Shape[] =>
  [[x + inset, y + inset], [x + w - inset, y + inset], [x + w - inset, y + d - inset], [x + inset, y + d - inset]].map(([a, b]) => dot([a, b, z], 0.55, 'ink'));
const lanes = (x0: number, x1: number, ys: number[], z: number, w = 9): Shape[] => [
  ...ys.map((y) => box([x0, y, z], [x1 - x0, w, 1])),
  ...ys.map((y) => line([[x0 + 3, y + w / 2, z + 1], [x1 - 3, y + w / 2, z + 1]])),
];

/** You: a laptop with the goal typed on the screen. */
const YOU: Shape[] = [
  box([0, 0, 0], [46, 32, 3]),
  // keyboard: three rows of keys, and a trackpad
  ...[7, 12, 17].flatMap((y) => [6, 13, 20, 27, 34].map((x) => box([x, y, 3], [5, 3.4, 0.8]))),
  box([16, 23, 3], [14, 6, 0.4]),
  // screen with a bezel and the goal on it
  box([0, 0, 3], [46, 2.5, 30]),
  box([3, 2.5, 6], [40, 0.4, 24]),
  line([[7, 2.9, 25], [24, 2.9, 25]], true),
  line([[7, 2.9, 20], [37, 2.9, 20]]), line([[7, 2.9, 16], [31, 2.9, 16]]),
  moving(box([26, 2.9, 23.5], [1.4, 0.3, 3], 'ink'), 'iso-blink'),
  dot([23, 2.6, 31.3], 0.6, 'ink'),
  moving(dot([41, 28, 3], 0.8), 'iso-led'),
];

/** Controller: a dark gate across three lanes; one packet waits at the gate. */
const CONTROLLER: Shape[] = [
  box([0, 0, 0], [52, 40, 5]),
  ...screws(0, 0, 52, 40, 5, 1.6),
  ...lanes(2, 50, [5, 16, 27], 5),
  moving(box([4, 29.5, 6], [5, 5, 5], 'ink'), 'iso-slide', { move: [40, 0, 0] }),
  box([24, 0, 6], [6, 5, 28]),
  box([24, 35, 6], [6, 5, 28]),
  box([22, -1, 34], [10, 42, 6], 'ink'),
  moving(dot([27, 41, 37], 0.9), 'iso-led'),
];

/** Orchestrator: a stepped tower that splits the goal into three lanes. */
const ORCHESTRATOR: Shape[] = [
  ...lanes(30, 62, [6, 17, 28], 0),
  box([0, 4, 0], [30, 34, 9]),
  ...screws(0, 4, 30, 34, 9, 2.2),
  box([5, 9, 9], [20, 24, 9]),
  box([10, 15, 18], [10, 12, 10], 'ink'),
  moving(dot([15, 27, 23], 0.9), 'iso-led'),
  ...[6, 17, 28].map((y, i) => moving(box([32, y + 2, 1], [5, 5, 5]), 'iso-slide', { move: [22, 0, 0], delay: i * 0.5 })),
];

/** Agents: three blocks, one per lane, each with its light on. */
const AGENTS: Shape[] = [
  box([0, 0, 0], [60, 44, 4]),
  ...screws(0, 0, 60, 44, 4, 1.4),
  ...lanes(2, 58, [4, 18, 32], 4),
  moving(box([8, 4, 5], [14, 9, 14]), 'iso-bob'),
  moving(dot([12, 13, 15]), 'iso-led'),
  moving(box([26, 18, 5], [14, 9, 14], 'ink'), 'iso-bob', { delay: 0.4 }),
  moving(dot([30, 27, 15]), 'iso-led', { delay: 0.4 }),
  moving(box([16, 32, 5], [14, 9, 14]), 'iso-bob', { delay: 0.8 }),
  moving(dot([20, 41, 15]), 'iso-led', { delay: 0.8 }),
];

/** Report: a sheet with lines and a tick, and a dark PASSED stamp. */
const REPORT: Shape[] = [
  box([0, 0, 0], [36, 48, 2]),
  ...[8, 14, 20, 26].map((y, i) => line([[6, y, 2], [i === 0 ? 16 : 20, y, 2]], i === 0)),
  moving(box([24, 5, 2], [8, 9, 3], 'ink'), 'iso-stamp'),
  moving(line([[8, 36, 2], [13, 41, 2], [26, 32, 2]], true), 'iso-draw'),
  dot([2.6, 12, 2], 0.8, 'ink'), dot([2.6, 36, 2], 0.8, 'ink'),
];

export const FIGURES = [YOU, CONTROLLER, ORCHESTRATOR, AGENTS, REPORT];

/* ── The whole harness as one machine ──────────────────────────────── */

// Three lanes run left → right across the plinth. Work starts at the orchestrator, passes the gate, lands on the report.
const LANES = [12, 39, 66];
const AGENT_AT: P3[] = [[40, 12, 9.2], [24, 39, 9.2], [52, 66, 9.2]];
const AGENT_SIZE: P3 = [18, 14, 15];

const TOWER: Shape[] = [
  box([-40, 24, 0], [30, 44, 10]),
  box([-34, 30, 10], [18, 32, 10]),
  box([-29, 37, 20], [8, 18, 10], 'ink'),
];
const PLINTH: Shape[] = [
  box([0, 0, 0], [122, 92, 8]),
  ...LANES.map((y) => box([4, y, 8], [114, 14, 1.2])),
  ...LANES.map((y) => line([[8, y + 7, 9.2], [116, y + 7, 9.2]])),
  ...screws(0, 0, 122, 92, 8, 2),
];
const BACK_POST = box([86, 1, 9.2], [7, 7, 34]);
const FRONT_POST = box([86, 84, 9.2], [7, 7, 34]);
const BEAM = box([84, -1, 43.2], [11, 94, 6], 'ink');
const REPORT_TRAY: Shape[] = [
  box([132, 28, 0], [30, 40, 2]),
  ...[35, 40, 45].map((y) => line([[137, y, 2], [156, y, 2]])),
];
/** The tick on the report, drawn when the packet lands. */
const REPORT_TICK = line([[139, 54, 2], [143, 59, 2], [154, 50, 2]], true);

const agentBox = (i: number) => box(AGENT_AT[i], AGENT_SIZE);
const LED = (i: number): P3 => [AGENT_AT[i][0] + 4, AGENT_AT[i][1] + AGENT_SIZE[1], AGENT_AT[i][2] + 10];

/** An agent's status light: a small green lamp with a dark rim, so it reads as a light even when dim. */
function Led({ i }: { i: number }) {
  const [x, y] = proj(LED(i));
  return (
    <g>
      <circle cx={x} cy={y} r={1.9} fill="var(--iso-ink-b)" />
      <circle cx={x} cy={y} r={1.3} className="machine-led" style={{ animationDelay: `${i * 0.5}s` }} />
    </g>
  );
}

type Label = { at: P3; text: string; side: 'l' | 'r'; dy?: number };

/** The machine, with each part named in two clean columns (left and right). Labels come from the dictionary. */
export function HarnessMachine({ labels, bare = false, className = '' }: { labels: { orchestrator: string; gate: string; report: string; rules: string }; bare?: boolean; className?: string }) {
  const parts: Label[] = [
    { at: [-25, 46, 30], text: labels.orchestrator, side: 'l', dy: -14 },
    { at: [49, 12, 24.2], text: 'lead-ba', side: 'r', dy: -22 },
    { at: [24, 46, 18], text: 'lead-dev', side: 'l', dy: 6 },
    { at: [56, 80, 14], text: 'lead-qa', side: 'l', dy: 14 },
    { at: [89, 20, 49.2], text: labels.gate, side: 'r', dy: -12 },
    { at: [150, 48, 2], text: labels.report, side: 'r', dy: 2 },
    { at: [110, 92, 4], text: labels.rules, side: 'r', dy: 16 },
  ];
  const all = [TOWER, PLINTH, [BACK_POST, FRONT_POST, BEAM, REPORT_TICK], REPORT_TRAY, AGENT_AT.map((_, i) => agentBox(i))].flat();
  const geo = all.flatMap(shapePoints);
  const gx = geo.map((p) => p[0]);
  const left = Math.min(...gx) - 10; const right = Math.max(...gx) + 10;
  const charW = 4.25; // 7-unit monospace
  // Place each label beside the drawing at its anchor's height, then push apart so none overlap.
  const placed = parts.map((p) => { const [x, y] = proj(p.at); return { ...p, x, y, ty: y + (p.dy ?? 0) }; });
  for (const side of ['l', 'r'] as const) {
    const col = placed.filter((p) => p.side === side).sort((a, b) => a.ty - b.ty);
    for (let i = 1; i < col.length; i++) if (col[i].ty - col[i - 1].ty < 13) col[i].ty = col[i - 1].ty + 13;
  }
  const widest = (side: 'l' | 'r') => Math.max(0, ...placed.filter((p) => p.side === side).map((p) => p.text.length * charW));
  const ys = [...geo.map((p) => p[1]), ...placed.map((p) => p.ty)];
  const vb = bare ? bounds(geo, 6, 6) : [left - widest('l') - 4, Math.min(...ys) - 10, right - left + widest('l') + widest('r') + 8, Math.max(...ys) - Math.min(...ys) + 20];
  // One story on a loop: a packet of finished work leaves lead-dev's lane, passes under the controller gate
  // (its light flashes green: the check passed), drops onto the report, and the report gets its tick.
  const [ax, ay] = proj([50, 0, 0]);
  const [bx, by] = proj([76, 0, -7.2]);
  const [gx2, gy2] = proj([89.5, 93, 46.2]);
  return (
    <svg viewBox={vb.map((v) => v.toFixed(1)).join(' ')} className={`h-auto w-full ${className}`} role="img" aria-label={`${labels.orchestrator} → lead-ba · lead-dev · lead-qa → ${labels.gate} → ${labels.report}`}
      strokeLinejoin="round" strokeLinecap="round" style={{ ['--ax' as string]: `${ax.toFixed(1)}px`, ['--ay' as string]: `${ay.toFixed(1)}px`, ['--bx' as string]: `${bx.toFixed(1)}px`, ['--by' as string]: `${by.toFixed(1)}px` }}>
      {TOWER.map((s, i) => <Solid key={`t${i}`} s={s} />)}
      {PLINTH.map((s, i) => <Solid key={`p${i}`} s={s} />)}
      <g className="machine-agent" style={{ animationDelay: `0.0s` }}>
        <Solid s={agentBox(0)} />
        <Led i={0} />
      </g>
      <g className="machine-agent" style={{ animationDelay: `0.5s` }}>
        <Solid s={agentBox(1)} />
        <Led i={1} />
      </g>
      <Solid s={BACK_POST} />
      <g className="machine-agent" style={{ animationDelay: `1.0s` }}>
        <Solid s={agentBox(2)} />
        <Led i={2} />
      </g>
      <Solid s={FRONT_POST} />
      <Solid s={BEAM} />
      <circle cx={gx2} cy={gy2} r={1.6} className="machine-gate" />
      {REPORT_TRAY.map((s, i) => <Solid key={`r${i}`} s={s} />)}
      <g className="machine-tick"><Solid s={REPORT_TICK} /></g>
      <g className="machine-packet"><Solid s={box([64, 43, 9.2], [6, 6, 6], 'ink')} /></g>
      {!bare && placed.map((p) => {
        const tx = p.side === 'l' ? left : right;
        return (
          <g key={p.text}>
            <polyline points={`${p.x},${p.y} ${p.x + (tx - p.x) * 0.25},${p.ty} ${tx},${p.ty}`} fill="none" stroke="var(--faint)" strokeWidth={0.45} />
            <text x={p.side === 'l' ? tx - 3 : tx + 3} y={p.ty + 2.4} textAnchor={p.side === 'l' ? 'end' : 'start'} fontSize={7} className="fill-muted" style={{ fontFamily: 'var(--font-mono)' }}>{p.text}</text>
          </g>
        );
      })}
    </svg>
  );
}
