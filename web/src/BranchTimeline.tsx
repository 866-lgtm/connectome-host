/**
 * Branch Timeline — Horizontal chronological view of branch lineage.
 *
 * X axis = time (branch.created), Y axis = lane per branch identity.
 * Fork edges overlay the timeline to show parent→child relationships
 * across lanes. Inspired by AnimaChat's conversation timeline style.
 *
 * Replaces the depth-based DAG in BranchGraph with a true temporal layout
 * while preserving pan/zoom, checkout, color coding, and orphan safety.
 */

import { createEffect, createSignal, For, Show } from 'solid-js';
import type { BranchRow } from '@conhost/web/protocol';

interface TimelineNode {
  branch: BranchRow;
  x: number;
  y: number;
  lane: number;
}

interface BranchTimelineProps {
  branches: BranchRow[];
  currentId: string | null;
  readOnly: boolean;
  onCheckout(name: string): void;
  onShowList(): void;
  onShowGraph(): void;
  onShowConversation(): void;
  onClose(): void;
}

const NODE_W = 160;
const NODE_H = 48;
const LANE_GAP = 18;
const TIME_PAD_LEFT = 72;
const TIME_PAD_RIGHT = 48;
const AXIS_H = 28;
const PAD_TOP = 16;

/** Assign each branch a vertical lane. Main/root branches get lane 0+,
 *  children are placed below their parent's subtree. Orphans float to top. */
function assignLanes(branches: BranchRow[]): Map<string, number> {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const children = new Map<string, BranchRow[]>();
  const roots: BranchRow[] = [];

  for (const b of branches) {
    if (b.parentId !== undefined && byId.has(b.parentId)) {
      const list = children.get(b.parentId) ?? [];
      list.push(b);
      children.set(b.parentId, list);
    } else {
      roots.push(b);
    }
  }

  // Sort roots by creation time so the oldest root gets lane 0
  roots.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));

  const lanes = new Map<string, number>();
  let nextLane = 0;
  const seen = new Set<string>();

  // DFS assigns contiguous lanes to each subtree
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    lanes.set(id, nextLane++);
    const kids = (children.get(id) ?? []).slice()
      .sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));
    for (const kid of kids) visit(kid.id);
  };

  for (const r of roots) visit(r.id);

  // Orphans (parentId pointing at pruned branch) get top lanes
  for (const b of branches) {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      lanes.set(b.id, nextLane++);
    }
  }

  return lanes;
}

function fmtAxisDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtNodeDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function branchColor(branch: BranchRow, current: boolean): string {
  if (current) return '#22d3ee';
  const name = branch.name.toLowerCase();
  if (name.startsWith('rollback-at-')) return '#a78bfa';
  if (name.startsWith('undo-')) return '#f472b6';
  if (name.includes('checkpoint')) return '#f59e0b';
  if (name.includes('branchto')) return '#34d399';
  return '#64748b';
}

/** Compute nice round time ticks for the axis. */
function computeTimeTicks(minT: number, maxT: number, widthPx: number): number[] {
  const range = maxT - minT;
  if (range <= 0) return [minT];

  // Target ~80-150px between ticks
  const targetCount = Math.max(2, Math.floor(widthPx / 120));
  const rawStep = range / targetCount;

  // Snap to human-friendly intervals
  const intervals = [
    60_000,        // 1 min
    300_000,       // 5 min
    900_000,       // 15 min
    3_600_000,     // 1 hr
    14_400_000,    // 4 hr
    86_400_000,    // 1 day
    604_800_000,   // 1 week
  ];
  let step = intervals.find((i) => i >= rawStep) ?? rawStep;

  const ticks: number[] = [];
  const start = Math.ceil(minT / step) * step;
  for (let t = start; t <= maxT; t += step) {
    ticks.push(t);
  }
  return ticks;
}

export function BranchTimeline(props: BranchTimelineProps) {
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  let viewport!: HTMLDivElement;
  let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };

  const layout = () => {
    const branches = props.branches;
    if (branches.length === 0) return { nodes: [] as TimelineNode[], edges: [] as Array<{ p: TimelineNode; c: TimelineNode }>, width: 0, height: 0, minT: 0, maxT: 0, lanes: new Map<string, number>() };

    const lanes = assignLanes(branches);
    const times = branches.map((b) => b.created);
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const timeRange = maxT - minT || 1;

    // Content width: ensure minimum spacing even for single-instant data
    const contentW = Math.max(600, timeRange > 0 ? timeRange / 1000 : 600);
    const totalW = TIME_PAD_LEFT + contentW + TIME_PAD_RIGHT;

    const maxLane = Math.max(0, ...Array.from(lanes.values()));
    const totalH = PAD_TOP + (maxLane + 1) * (NODE_H + LANE_GAP) + AXIS_H + 8;

    const nodeMap = new Map<string, TimelineNode>();
    const nodes: TimelineNode[] = [];
    for (const b of branches) {
      const lane = lanes.get(b.id) ?? 0;
      const x = TIME_PAD_LEFT + ((b.created - minT) / timeRange) * contentW;
      const y = PAD_TOP + lane * (NODE_H + LANE_GAP);
      const node: TimelineNode = { branch: b, x, y, lane };
      nodes.push(node);
      nodeMap.set(b.id, node);
    }

    // Build edges from parent→child
    const edgeList: Array<{ p: TimelineNode; c: TimelineNode }> = [];
    for (const b of branches) {
      if (b.parentId !== undefined) {
        const parent = nodeMap.get(b.parentId);
        const child = nodeMap.get(b.id);
        if (parent && child) {
          edgeList.push({ p: parent, c: child });
        }
      }
    }

    return { nodes, edges: edgeList, width: totalW, height: totalH, minT, maxT, lanes };
  };

  const graph = () => layout();

  const fit = () => {
    const g = graph();
    if (!viewport || g.width <= 0 || g.height <= 0) return;
    const scaleX = (viewport.clientWidth - 24) / g.width;
    const scaleY = (viewport.clientHeight - 24) / g.height;
    const scale = Math.min(scaleX, scaleY, 1);
    setZoom(Math.max(0.25, scale));
    setPan({
      x: Math.max(12, (viewport.clientWidth - g.width * scale) / 2),
      y: Math.max(12, (viewport.clientHeight - g.height * scale) / 2),
    });
  };

  createEffect(() => {
    props.branches.length;
    requestAnimationFrame(fit);
  });

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const next = Math.max(0.25, Math.min(3, zoom() * (event.deltaY < 0 ? 1.1 : 0.9)));
    setZoom(next);
  };

  const onPointerDown = (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    setDragging(true);
    dragStart = { x: event.clientX, y: event.clientY, panX: pan().x, panY: pan().y };
    viewport.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging()) return;
    setPan({ x: dragStart.panX + event.clientX - dragStart.x, y: dragStart.panY + event.clientY - dragStart.y });
  };
  const onPointerUp = () => setDragging(false);

  const g = () => graph();
  const ticks = () => {
    const { minT, maxT, width } = g();
    return computeTimeTicks(minT, maxT, width);
  };

  return (
    <div class="border-l border-neutral-800 w-[min(58rem,70vw)] shrink-0 bg-neutral-950 flex flex-col h-full">
      <div class="border-b border-neutral-800 px-3 py-2 flex items-center gap-2">
        <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">timeline</span>
        <span class="text-neutral-500 text-xs">{props.branches.length || ''}</span>
        <div class="ml-auto flex gap-1">
          <button type="button" class="px-2 py-0.5 bg-fuchsia-950/50 hover:bg-fuchsia-900/50 text-fuchsia-300 rounded text-xs" onClick={props.onShowConversation}>conversation</button>
          <button type="button" class="px-2 py-0.5 bg-emerald-950/50 hover:bg-emerald-900/50 text-emerald-300 rounded text-xs" onClick={props.onShowGraph}>graph</button>
          <button type="button" class="px-2 py-0.5 bg-cyan-950/50 hover:bg-cyan-900/50 text-cyan-300 rounded text-xs" onClick={props.onShowList}>list</button>
          <button type="button" class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs" onClick={() => setZoom(Math.min(3, zoom() + 0.15))}>+</button>
          <button type="button" class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs" onClick={() => setZoom(Math.max(0.25, zoom() - 0.15))}>−</button>
          <button type="button" class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs" onClick={fit}>fit</button>
          <button type="button" class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs" onClick={props.onClose}>close</button>
        </div>
      </div>
      <div
        ref={viewport}
        class="relative flex-1 min-h-0 overflow-hidden select-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ cursor: dragging() ? 'grabbing' : 'grab' }}
      >
        <Show when={props.branches.length > 0} fallback={<div class="p-4 text-neutral-600 italic">No branches.</div>}>
          <svg width={g().width} height={g().height} class="absolute origin-top-left" style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})` }}>
            {/* Lane backgrounds */}
            <For each={Array.from(new Set(g().nodes.map((n) => n.lane))).sort((a, b) => a - b)}>{(lane) => (
              <rect
                x={0}
                y={PAD_TOP + lane * (NODE_H + LANE_GAP) - LANE_GAP / 2}
                width={g().width}
                height={NODE_H + LANE_GAP}
                fill={lane % 2 === 0 ? '#0a0a0a' : '#111113'}
              />
            )}</For>

            {/* Time axis ticks */}
            <For each={ticks()}>{(t) => {
              const { minT, maxT, width } = g();
              const timeRange = maxT - minT || 1;
              const contentW = width - TIME_PAD_LEFT - TIME_PAD_RIGHT;
              const x = TIME_PAD_LEFT + ((t - minT) / timeRange) * contentW;
              return (
                <g>
                  <line x1={x} y1={PAD_TOP - 4} x2={x} y2={g().height - AXIS_H} stroke="#27272a" stroke-width="1" stroke-dasharray="3,4" />
                  <text x={x} y={g().height - 8} fill="#52525b" font-size="9" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" text-anchor="middle">{fmtAxisDate(t)}</text>
                </g>
              );
            }}</For>

            {/* Axis baseline */}
            <line x1={TIME_PAD_LEFT} y1={g().height - AXIS_H} x2={g().width - TIME_PAD_RIGHT} y2={g().height - AXIS_H} stroke="#3f3f46" stroke-width="1" />

            {/* Fork edges */}
            <For each={g().edges}>{(edge) => {
              const sx = edge.p.x + NODE_W;
              const sy = edge.p.y + NODE_H / 2;
              const ex = edge.c.x;
              const ey = edge.c.y + NODE_H / 2;
              // Route: horizontal from parent right, then vertical to child lane, then horizontal to child left
              const midX = sx + (ex - sx) * 0.5;
              return (
                <path
                  d={`M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ey}, ${ex} ${ey}`}
                  fill="none"
                  stroke="#3f3f46"
                  stroke-width="1.5"
                  opacity="0.7"
                />
              );
            }}</For>

            {/* Branch nodes */}
            <For each={g().nodes}>{(node) => {
              const current = node.branch.id === props.currentId;
              const color = branchColor(node.branch, current);
              return (
                <g transform={`translate(${node.x}, ${node.y})`}>
                  <rect width={NODE_W} height={NODE_H} rx="6" fill="#18181b" stroke={color} stroke-width={current ? 2.5 : 1} />
                  <circle cx="12" cy="15" r="4" fill={color} />
                  <text x="22" y="18" fill="#e4e4e7" font-size="11" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
                    {node.branch.name.slice(0, 18)}{node.branch.name.length > 18 ? '…' : ''}
                  </text>
                  <text x="10" y="36" fill="#71717a" font-size="9" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
                    @{node.branch.branchPoint ?? 0} · {fmtNodeDate(node.branch.created)}
                  </text>
                  <Show when={current}>
                    <text x={NODE_W - 44} y="14" fill="#22d3ee" font-size="7" font-weight="bold">CURRENT</text>
                  </Show>
                  <title>{`${node.branch.name} · head @${node.branch.head}${node.branch.branchPoint !== undefined ? ` · forked @${node.branch.branchPoint}` : ''}`}</title>
                  <Show when={!current && !props.readOnly}>
                    <rect x={NODE_W - 58} y={NODE_H - 18} width="50" height="14" rx="3" fill="#27272a" />
                    <text x={NODE_W - 52} y={NODE_H - 8} fill="#d4d4d8" font-size="7">checkout</text>
                    <rect x={NODE_W - 58} y={NODE_H - 18} width="50" height="14" fill="transparent" onClick={() => props.onCheckout(node.branch.name)} />
                  </Show>
                </g>
              );
            }}</For>
          </svg>
        </Show>
      </div>
      <div class="border-t border-neutral-800 px-3 py-2 flex gap-3 text-[10px] text-neutral-600 font-mono">
        <span>drag to pan</span><span>scroll to zoom</span><span>x-axis = time</span><span>y-axis = branch lane</span>
      </div>
    </div>
  );
}