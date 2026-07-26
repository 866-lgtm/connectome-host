import { AgentFramework } from '@animalabs/agent-framework';
import type { Recipe } from './recipe.js';

type AgentConfig = Parameters<typeof AgentFramework.create>[0]['agents'][number];

export type FrameworkAgentConfig = AgentConfig & {
  // Forward recipe fields that newer Agent Framework releases understand
  // while remaining structurally compatible with older installs.
  refusalHandling?: Recipe['agent']['refusalHandling'];
  sameRoundThinkTextPolicy?: 'public' | 'private';
};

export function buildFrameworkAgentConfig(
  recipe: Recipe,
  agentName: string,
  model: string,
  strategy: FrameworkAgentConfig['strategy'],
): FrameworkAgentConfig {
  return {
    name: agentName,
    model,
    systemPrompt: recipe.agent.systemPrompt,
    maxTokens: recipe.agent.maxTokens ?? 16384,
    maxStreamTokens: recipe.agent.maxStreamTokens ?? 150000,
    contextBudgetTokens: recipe.agent.contextBudgetTokens,
    ...(recipe.agent.cacheTtl && { cacheTtl: recipe.agent.cacheTtl }),
    // Bedrock legacy Claude models reject cache_control outright
    // ("your request did not allow prompt caching") — suppress markers.
    ...(recipe.agent.provider === 'bedrock' && { promptCaching: false }),
    // Prefill scaffold (anthropic-xml formatter), e.g. chapterx CLI-sim's
    // '<cmd>cat untitled.txt</cmd>' — part of migrating prefill-era bots.
    ...(recipe.agent.prefillUserMessage && { prefillUserMessage: recipe.agent.prefillUserMessage }),
    ...((recipe.agent.provider === 'openai-responses' || recipe.agent.provider === 'openai-codex') && {
      providerParams: {
        reasoning: {
          effort: recipe.agent.responses?.reasoningEffort ?? 'high',
          context: recipe.agent.responses?.reasoningContext ?? 'all_turns',
        },
        ...(recipe.agent.provider === 'openai-responses' ? {
          ...(recipe.agent.responses?.serviceTier ? {
            service_tier: recipe.agent.responses.serviceTier,
          } : {}),
          ...(recipe.agent.responses?.compactThreshold ? {
            context_management: [{
              type: 'compaction',
              compact_threshold: recipe.agent.responses.compactThreshold,
            }],
          } : {}),
        } : {}),
      },
    }),
    // OpenAI-compatible Chat Completions (LiteRouter et al.) accepts the same
    // unified `reasoning` object, but only its `effort` key — `context` is a
    // Responses-API field. Probed against LiteRouter/gpt-5.1 on 2026-07-25:
    //   - `reasoning: {effort}`  → reasons AND returns the trace on
    //     `message.reasoning` / `delta.reasoning`, which the openai-compatible
    //     provider converts into thinking blocks. This is the spelling we want.
    //   - `reasoning_effort`     → reasons but hides the trace entirely.
    //   - effort above 'high' ('xhigh'/'max') is accepted but normalized
    //     upstream, so 'high' is the effective ceiling for this model.
    // Emitted only when the recipe names an effort: other openai-compatible
    // recipes (base models, non-reasoning endpoints) must not receive the param.
    ...(recipe.agent.provider === 'openai-compatible' && recipe.agent.responses?.reasoningEffort && {
      providerParams: {
        reasoning: { effort: recipe.agent.responses.reasoningEffort },
      },
    }),
    strategy,
    ...(recipe.agent.thinking && { thinking: recipe.agent.thinking }),
    ...(recipe.agent.refusalHandling && { refusalHandling: recipe.agent.refusalHandling }),
    ...(recipe.agent.sameRoundThinkTextPolicy !== undefined
      ? { sameRoundThinkTextPolicy: recipe.agent.sameRoundThinkTextPolicy }
      : {}),
  };
}
