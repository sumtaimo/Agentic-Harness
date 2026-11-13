/**
 * Isometric drawings: solid objects (light top, two shaded sides, thin ink outline), not boxes and arrows.
 *   - FIGURES: five small stations of the workflow (you → controller → orchestrator → agents → report)
 *   - HarnessMachine: the whole harness as one labelled machine, for the top of the page
 */
type P3 = [number, number, number];
type Shape =
  | { kind: 'box'; at: P3; size: P3; tone?: 'ink' }
  | { kind: 'line'; pts: P3[]; bold?: boolean };

const C = 0.866;
const proj = ([x, y, z]: P3): [number, number] => [(x - y) * C, (x + y) * 0.5 - z];

function boxFaces({ at: [x, y, z], size: [w, d, h] }: { at: P3; size: P3 }) {
  const top: P3[] = [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]];
  const right: P3[] = [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]];
  const left: P3[] = [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]];
  return { top, right, left };
}

const pts = (p: P3[]) => p.map((q) => proj(q).map((v) => v.toFixed(1)).join(',')).join(' ');
const shapePoints = (s: Shape) => (s.kind === 'box' ? Object.values(boxFaces(s)).flat() : s.pts).map(proj);

function bounds(points: [number, number][], padX: number, padY: number) {
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  return [Math.min(...xs) - padX, Math.min(...ys) - padY, Math.max(...xs) - Math.min(...xs) + padX * 2, Math.max(...ys) - Math.min(...ys) + padY * 2];
}

function Solid({ s }: { s: Shape }) {
  if (s.kind === 'line') return <polyline points={pts(s.pts)} fill="none" stroke="var(--iso-ink)" strokeWidth={s.bold ? 1.3 : 0.7} />;
  const f = boxFaces(s);
  const ink = s.tone === 'ink';
  return (
    <g stroke="var(--iso-ink)" strokeWidth={0.75}>
      <polygon points={pts(f.left)} fill={ink ? 'var(--iso-ink-a)' : 'var(--iso-a)'} />
      <polygon points={pts(f.right)} fill={ink ? 'var(--iso-ink-b)' : 'var(--iso-b)'} />
      <polygon points={pts(f.top)} fill={ink ? 'var(--iso-ink-top)' : 'var(--iso-top)'} />
    </g>
  );
}

export function Iso({ shapes }: { shapes: Shape[] }) {
  const vb = bounds(shapes.flatMap(shapePoints), 4, 4);
  return (
    <svg viewBox={vb.map((v) => v.toFixed(1)).join(' ')} className="h-full w-full" aria-hidden="true" strokeLinejoin="round" strokeLinecap="round">
      {shapes.map((s, i) => <Solid key={i} s={s} />)}
    </svg>
  );
}

const box = (at: P3, size: P3, tone?: 'ink'): Shape => ({ kind: 'box', at, size, tone });
const line = (p: P3[], bold = false): Shape => ({ kind: 'line', pts: p, bold });

/* ── The five stations ─────────────────────────────────────────────── */

/** You: a laptop with a goal on the screen. */
const YOU: Shape[] = [
  box([0, 0, 0], [44, 30, 3]),
  ...[9, 14, 19].map((y) => line([[6, y, 3], [38, y, 3]])),
  box([0, 0, 3], [44, 2, 28]),
  line([[8, 2, 22], [30, 2, 22]], true), line([[8, 2, 15], [36, 2, 15]]), line([[8, 2, 10], [26, 2, 10]]),
];

/** Controller: a gate on a plinth (the check every task passes through). */
const CONTROLLER: Shape[] = [
  box([-6, -4, 0], [58, 22, 4]),
  box([0, 2, 4], [9, 9, 34]),
  box([37, 2, 4], [9, 9, 34]),
  box([-2, 2, 38], [50, 9, 7], 'ink'),
  line([[9, 7, 22], [37, 7, 22]], true),
];

/** Orchestrator: a stepped tower (the plan, level by level). */
const ORCHESTRATOR: Shape[] = [
  box([0, 0, 0], [40, 40, 8]),
  box([7, 7, 8], [26, 26, 8]),
  box([14, 14, 16], [12, 12, 10], 'ink'),
];

/** Agents: three blocks working side by side. */
const AGENTS: Shape[] = [
  box([0, 0, 0], [18, 18, 18]),
  box([25, 0, 0], [18, 18, 18], 'ink'),
  box([50, 0, 0], [18, 18, 18]),
];

/** Report: a sheet with lines and a tick. */
const REPORT: Shape[] = [
  box([0, 0, 0], [34, 46, 2]),
  ...[8, 14, 20, 26].map((y) => line([[6, y, 2], [28, y, 2]])),
  line([[8, 35, 2], [13, 40, 2], [26, 31, 2]], true),
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
];
const BACK_POST = box([86, 1, 9.2], [7, 7, 34]);
const FRONT_POST = box([86, 84, 9.2], [7, 7, 34]);
const BEAM = box([84, -1, 43.2], [11, 94, 6], 'ink');
const REPORT_TRAY: Shape[] = [
  box([132, 28, 0], [30, 40, 2]),
  ...[35, 40, 45].map((y) => line([[137, y, 2], [156, y, 2]])),
  line([[139, 54, 2], [143, 59, 2], [154, 50, 2]], true),
];

const agentBox = (i: number) => box(AGENT_AT[i], AGENT_SIZE);
const LED = (i: number): P3 => [AGENT_AT[i][0] + 4, AGENT_AT[i][1] + AGENT_SIZE[1], AGENT_AT[i][2] + 10];

type Label = { at: P3; text: string; side: 'l' | 'r'; dy?: number };

/** The machine, with each part named in two clean columns (left and right). Labels come from the dictionary. */
export function HarnessMachine({ labels, bare = false, className = '' }: { labels: { orchestrator: string; gate: string; report: string; rules: string }; bare?: boolean; className?: string }) {
  const parts: Label[] = [
    { at: [-25, 46, 30], text: labels.orchestrator, side: 'l', dy: -14 },
    { at: [44, 12, 24.2], text: 'lead-ba', side: 'l', dy: -10 },
    { at: [24, 46, 18], text: 'lead-dev', side: 'l', dy: 6 },
    { at: [56, 80, 14], text: 'lead-qa', side: 'l', dy: 14 },
    { at: [89, 20, 49.2], text: labels.gate, side: 'r', dy: -12 },
    { at: [150, 48, 2], text: labels.report, side: 'r', dy: 2 },
    { at: [110, 92, 4], text: labels.rules, side: 'r', dy: 16 },
  ];
  const all = [TOWER, PLINTH, [BACK_POST, FRONT_POST, BEAM], REPORT_TRAY, AGENT_AT.map((_, i) => agentBox(i))].flat();
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
  // A packet of work travels along the middle lane, under the gate, towards the report.
  const [px, py] = proj([70, 0, 0]);
  return (
    <svg viewBox={vb.map((v) => v.toFixed(1)).join(' ')} className={`h-auto w-full ${className}`} role="img" aria-label={`${labels.orchestrator} → lead-ba · lead-dev · lead-qa → ${labels.gate} → ${labels.report}`}
      strokeLinejoin="round" strokeLinecap="round" style={{ ['--px' as string]: `${px.toFixed(1)}px`, ['--py' as string]: `${py.toFixed(1)}px` }}>
      {TOWER.map((s, i) => <Solid key={`t${i}`} s={s} />)}
      {PLINTH.map((s, i) => <Solid key={`p${i}`} s={s} />)}
      <Solid s={agentBox(0)} />
      <Solid s={agentBox(1)} />
      <g className="machine-packet"><Solid s={box([46, 43, 9.2], [6, 6, 6], 'ink')} /></g>
      <Solid s={BACK_POST} />
      <Solid s={agentBox(2)} />
      <Solid s={BEAM} />
      <Solid s={FRONT_POST} />
      {REPORT_TRAY.map((s, i) => <Solid key={`r${i}`} s={s} />)}
      {[0, 1, 2].map((i) => { const [x, y] = proj(LED(i)); return <circle key={i} cx={x} cy={y} r={1.5} className="machine-led" style={{ animationDelay: `${i * 0.45}s` }} />; })}
      {!bare && placed.map((p) => {
        const tx = p.side === 'l' ? left : right;
        return (
          <g key={p.text}>
            <polyline points={`${p.x},${p.y} ${p.x + (tx - p.x) * 0.25},${p.ty} ${tx},${p.ty}`} fill="none" stroke="var(--faint)" strokeWidth={0.45} />
            <circle cx={p.x} cy={p.y} r={1.3} fill="var(--fg)" />
            <text x={p.side === 'l' ? tx - 3 : tx + 3} y={p.ty + 2.4} textAnchor={p.side === 'l' ? 'end' : 'start'} fontSize={7} className="fill-muted" style={{ fontFamily: 'var(--font-mono)' }}>{p.text}</text>
          </g>
        );
      })}
    </svg>
  );
}
