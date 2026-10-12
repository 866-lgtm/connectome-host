import { For, Show } from 'solid-js';

export interface ConversationGraphNode {
  id: string;
  sequence: number;
  participant: 'user' | 'assistant';
  text: string;
  timestamp?: number;
  branchId: string;
  forkPoint?: number;
  forkAnchorId?: string;
}

export function ConversationGraphPanel(props: {
  nodes: ConversationGraphNode[];
  currentId: string | null;
  onClose(): void;
}) {
  const nodes = () => props.nodes.filter((n) => n.participant === 'user' || n.participant === 'assistant');
  return <div class="border-l border-neutral-800 w-[min(58rem,70vw)] shrink-0 bg-neutral-950 flex flex-col h-full">
    <div class="border-b border-neutral-800 px-3 py-2 flex items-center gap-2">
      <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">conversation graph</span>
      <span class="text-neutral-500 text-xs">{nodes().length || ''}</span>
      <button type="button" class="ml-auto px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs" onClick={props.onClose}>close</button>
    </div>
    <div class="flex-1 overflow-auto p-4 space-y-2">
      <Show when={nodes().length > 0} fallback={<div class="text-neutral-600 italic">No user/model turns available.</div>}>
        <For each={nodes()}>{(node, index) => <div class="relative pl-8" data-seq={node.sequence}>
          <Show when={index() > 0}><div class="absolute left-[11px] -top-2 h-4 border-l border-neutral-700" /></Show>
          <div class={`rounded border px-3 py-2 ${node.id === nodes()[nodes().length - 1]?.id ? 'border-cyan-700 bg-cyan-950/20' : 'border-neutral-800 bg-neutral-900/40'}`}>
            <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider">
              <span class={node.participant === 'user' ? 'text-emerald-400' : 'text-fuchsia-400'}>{node.participant}</span>
              <span class="text-neutral-600">@{node.sequence}</span>
              <Show when={node.forkAnchorId}><span class="text-amber-400">fork anchor</span></Show>
            </div>
            <div class="mt-1 text-xs text-neutral-300 whitespace-pre-wrap">{node.text || '(no text)'}</div>
          </div>
        </div>}</For>
      </Show>
    </div>
  </div>;
}
