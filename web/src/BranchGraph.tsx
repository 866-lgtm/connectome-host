/**
 * Branch Graph — Vertical tree layout mirroring AnimaChat's ConversationTree.
 *
 * Y axis = tree depth (root at top, children below), X axis = sibling spread.
 * Edges are cubic Béziers from parent bottom-center to child top-center.
 * Active path (current branch → root) is highlighted in cyan.
 * Pan/zoom via pointer drag + wheel. Checkout on non-current nodes.
 *
 * Replaces the previous depth-based horizontal DAG with a true vertical
 * hierarchical tree matching the AnimaChat reference implementation.
 */

import { createEffect, createSignal, For, Show } from 'solid-js';
import type { BranchRow } from '@conhost/web/protocol';

interface TreeNode {
  branch: BranchRow;
  x: number;
  y: number;
  depth: number;
  children: TreeNode[];
  parent: TreeNode | null;
}

interface BranchGraphProps {
  branches: BranchRow[];
  currentId: string | null;
  readOnly: boolean;
  onCheckout(name: string): void;
  /** Navigate to a specific branch (checkout if needed) and scroll to its branch-point message. */
  onNavigateToBranch?(branchId: string, branchName: string): void;
  onShowList(): void;
  onShowTimeline(): void;
  onShowConversation(): void;
  onClose(): void;
}

const NODE_W = 172;
const NODE_H = 52;
const H_GAP = 24;
const V_GAP = 48;
const PAD = 40;

function sortBranches(a: BranchRow, b: BranchRow): number {
  return (a.branchPoint ?? 0) - (b.branchPoint ?? 0) || a.created - b.created || a.name.localeCompare(b.name);
}

/** Build tree from flat branch list. Orphans become roots. Cycle-safe. */
function buildRoots(branches: BranchRow[]): TreeNode[] {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const childMap = new Map<string, BranchRow[]>();
  const roots: BranchRow[] = [];

  for (const b of branches) {
    if (b.parentId && byId.has(b.parentId)) {
      const list = childMap.get(b.parentId) ?? [];
      list.push(b);
      childMap.set(b.parentId, list);
    } else {
      roots.push(b);
    }
  }

  const seen = new Set<string>();
  const visit = (branch: BranchRow, depth: number, parent: TreeNode | null): TreeNode | null => {
    if (seen.has(branch.id)) return null;
    seen.add(branch.id);
    const node: TreeNode = { branch, x: 0, y: 0, depth, children: [], parent };
    const kids = (childMap.get(branch.id) ?? []).slice().sort(sortBranches);
    for (const kid of kids) {
      const child = visit(kid, depth + 1, node);
      if (child) node.children.push(child);
    }
    return node;
  };

  const result = roots.slice().sort(sortBranches)
    .map((r) => visit(r, 0, null))
    .filter((n): n is TreeNode => n !== null);

  // Surface any branches missed due to corrupt lineage
  for (const b of branches) {
    if (!seen.has(b.id)) {
      const node = visit(b, 0, null);
      if (node) result.push(node);
    }
  }
  return result;
}

/** Assign x,y positions using a simple Reingold-Tilford-style walk.
 *  Leaves get sequential X slots; parents center over their children. */
function layoutTree(roots: TreeNode[]): { width: number; height: number } {
  let nextX = PAD;
  let maxDepth = 0;

  const assignX = (node: TreeNode): void => {
    maxDepth = Math.max(maxDepth, node.depth);
    node.y = PAD + node.depth * (NODE_H + V_GAP);

    if (node.children.length === 0) {
      node.x = nextX;
      nextX += NODE_W + H_GAP;
      return;
    }
    for (const child of node.children) assignX(child);
    // Center parent over first and last child
    const first = node.children[0]!;
    const last = node.children[node.children.length - 1]!;
    node.x = (first.x + last.x) / 2;
  };

  for (const root of roots) assignX(root);

  return {
    width: Math.max(NODE_W + PAD * 2, nextX - H_GAP + PAD),
    height: Math.max(NODE_H + PAD * 2, PAD + (maxDepth + 1) * (NODE_H + V_GAP)),
  };
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (n: TreeNode) => {
    out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

function collectEdges(nodes: TreeNode[]): Array<{ parent: TreeNode; child: TreeNode }> {
  const out: Array<{ parent: TreeNode; child: TreeNode }> = [];
  for (const n of nodes) {
    for (const c of n.children) out.push({ parent: n, child: c });
  }
  return out;
}

/** Trace from current node up to root, returning set of node IDs on active path. */
function activePathIds(nodes: TreeNode[], currentId: string | null): Set<string> {
  const ids = new Set<string>();
  if (!currentId) return ids;
  const map = new Map(nodes.map((n) => [n.branch.id, n]));
  let cur = map.get(currentId);
  while (cur) {
    ids.add(cur.branch.id);
    cur = cur.parent ?? undefined;
  }
  return ids;
}

const fmtDate = (ts: number): string => {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function branchColor(branch: BranchRow, current: boolean, onActivePath: boolean): string {
  if (current) return '#22d3ee';
  if (onActivePath) return '#67e8f9';
  const name = branch.name.toLowerCase();
  if (name.startsWith('rollback-at-')) return '#a78bfa';
  if (name.startsWith('undo-')) return '#f472b6';
  if (name.includes('checkpoint')) return '#f59e0b';
  if (name.includes('branchto')) return '#34d399';
  return '#64748b';
}

export function BranchGraph(props: BranchGraphProps) {
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  let viewport!: HTMLDivElement;
  let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
  /** Track whether a pointerdown/move/up sequence was actually a drag.
   *  If the pointer moved less than this threshold, treat it as a click
   *  and let the target element's onClick fire normally. */
  const DRAG_THRESHOLD = 4;
  let pointerMoved = false;

  const tree = () => {
    const roots = buildRoots(props.branches);
    const dims = layoutTree(roots);
    const nodes = flatten(roots);
    const edges = collectEdges(nodes);
    const active = activePathIds(nodes, props.currentId);
    return { ...dims, nodes, edges, active };
  };

  const fit = () => {
    const t = tree();
    if (!viewport || t.width <= 0 || t.height <= 0) return;
    const scale = Math.min(
      (viewport.clientWidth - 24) / t.width,
      (viewport.clientHeight - 24) / t.height,
      1,
    );
    setZoom(Math.max(0.3, scale));
    setPan({
      x: Math.max(12, (viewport.clientWidth - t.width * scale) / 2),
      y: Math.max(12, (viewport.clientHeight - t.height * scale) / 2),
    });
  };

  createEffect(() => {
    props.branches.length;
    requestAnimationFrame(fit);
  });

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const next = Math.max(0.3, Math.min(2.5, zoom() * (event.deltaY < 0 ? 1.1 : 0.9)));
    setZoom(next);
  };

  const onPointerDown = (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    // Don't capture pointer on node/rect/text elements — let their onClick fire
    if ((event.target as SVGElement).closest?.('g[style*="cursor: pointer"]')) return;
    setDragging(true);
    pointerMoved = false;
    dragStart = { x: event.clientX, y: event.clientY, panX: pan().x, panY: pan().y };
    viewport.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging()) return;
    const dx = event.clientX - dragStart.x;
    const dy = event.clientY - dragStart.y;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      pointerMoved = true;
    }
    setPan({ x: dragStart.panX + dx, y: dragStart.panY + dy });
  };
  const onPointerUp = (event: PointerEvent) => {
    setDragging(false);
    try { viewport.releasePointerCapture(event.pointerId); } catch {}
  };

  const t = () => tree();

  return (
    <div class="border-l border-neutral-800 w-[min(58rem,70vw)] shrink-0 bg-neutral-950 flex flex-col h-full">
      <div class="border-b border-neutral-800 px-3 py-2 flex items-center gap-2">
        <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">branch graph</span>
        <span class="text-neutral-500 text-xs">{props.branches.length || ''}</span>
        <div class="ml-auto flex gap-1 relative z-20" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" class="px-2 py-0.5 bg-fuchsia-950/50 hover:bg-fuchsia-900/50 text-fuchsia-300 rounded text-xs cursor-pointer opacity-50" title="View switch disabled in graph mode — use list view tabs instead">conversation</button>
          <button type="button" class="px-2 py-0.5 bg-amber-950/50 hover:bg-amber-900/50 text-amber-300 rounded text-xs cursor-pointer opacity-50" title="View switch disabled in graph mode — use list view tabs instead">timeline</button>
          <button type="button" class="px-2 py-0.5 bg-cyan-950/50 hover:bg-cyan-900/50 text-cyan-300 rounded text-xs cursor-pointer opacity-50" title="View switch disabled in graph mode — use list view tabs instead">list</button>
          <button type="button" class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs cursor-pointer" onClick={(e) => { e.stopPropagation(); setZoom(Math.min(2.5, zoom() + 0.15)); }}>+</button>
          <button type="button" class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs cursor-pointer" onClick={(e) => { e.stopPropagation(); setZoom(Math.max(0.3, zoom() - 0.15)); }}>−</button>
          <button type="button" class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs cursor-pointer" onClick={(e) => { e.stopPropagation(); fit(); }}>fit</button>
          <button type="button" class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs cursor-pointer" onClick={(e) => { e.stopPropagation(); props.onClose(); }}>close</button>
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
          <svg width={t().width} height={t().height} class="absolute origin-top-left" style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})` }}>
            {/* Edges: vertical cubic Bézier from parent bottom-center to child top-center */}
            <For each={t().edges}>{(edge) => {
              const sx = edge.parent.x + NODE_W / 2;
              const sy = edge.parent.y + NODE_H;
              const ex = edge.child.x + NODE_W / 2;
              const ey = edge.child.y;
              const my = sy + (ey - sy) * 0.5;
              const isActive = t().active.has(edge.parent.branch.id) && t().active.has(edge.child.branch.id);
              return (
                <path
                  d={`M ${sx} ${sy} C ${sx} ${my}, ${ex} ${my}, ${ex} ${ey}`}
                  fill="none"
                  stroke={isActive ? '#22d3ee' : '#3f3f46'}
                  stroke-width={isActive ? 2 : 1.5}
                  opacity={isActive ? 1 : 0.6}
                />
              );
            }}</For>

            {/* Nodes */}
            <For each={t().nodes}>{(node) => {
              const current = node.branch.id === props.currentId;
              const onPath = t().active.has(node.branch.id);
              const color = branchColor(node.branch, current, onPath);
              /** Click a non-current node to navigate: checkout that branch
               *  and scroll to its branch-point message. Stops propagation so
               *  the viewport pan handler doesn't swallow the click. */
              const handleNodeClick = (e: MouseEvent) => {
                e.stopPropagation();
                if (current || props.readOnly) return;
                if (props.onNavigateToBranch) {
                  props.onNavigateToBranch(node.branch.id, node.branch.name);
                } else {
                  props.onCheckout(node.branch.name);
                }
              };
              return (
                <g
                  transform={`translate(${node.x}, ${node.y})`}
                  style={{ cursor: !current && !props.readOnly ? 'pointer' : 'default' }}
                  onClick={handleNodeClick}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx="7"
                    fill="#18181b"
                    stroke={color}
                    stroke-width={current ? 2.5 : onPath ? 1.8 : 1}
                  />
                  <circle cx="14" cy="16" r="5" fill={color} />
                  <text x="26" y="19" fill="#e4e4e7" font-size="11" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
                    {node.branch.name.slice(0, 19)}{node.branch.name.length > 19 ? '…' : ''}
                  </text>
                  <text x="10" y="38" fill="#71717a" font-size="9" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
                    @{node.branch.branchPoint ?? 0} → @{node.branch.head} · {fmtDate(node.branch.created)}
                  </text>
                  <Show when={current}>
                    <text x={NODE_W - 48} y="14" fill="#22d3ee" font-size="8" font-weight="bold">CURRENT</text>
                  </Show>
                  <title>{`${node.branch.name} · head @${node.branch.head}${node.branch.branchPoint !== undefined ? ` · forked @${node.branch.branchPoint}` : ''}`}</title>
                  <Show when={!current && !props.readOnly}>
                    <rect x={NODE_W - 60} y={NODE_H - 18} width="52" height="14" rx="3" fill="#27272a" />
                    <text x={NODE_W - 54} y={NODE_H - 8} fill="#d4d4d8" font-size="7">checkout</text>
                    <rect x={NODE_W - 60} y={NODE_H - 18} width="52" height="14" fill="transparent" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); props.onCheckout(node.branch.name); }} />
                  </Show>
                </g>
              );
            }}</For>
          </svg>
        </Show>
      </div>
      <div class="border-t border-neutral-800 px-3 py-2 flex gap-3 text-[10px] text-neutral-600 font-mono">
        <span>drag to pan</span><span>scroll to zoom</span><span>vertical tree · active path highlighted</span>
      </div>
    </div>
  );
}