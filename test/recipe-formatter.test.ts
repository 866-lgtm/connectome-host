import { describe, test, expect } from 'bun:test';
import { AnthropicXmlFormatter, Membrane, NativeFormatter, OpenAIResponsesFormatter } from '@animalabs/membrane';
import type { NormalizedMessage } from '@animalabs/membrane';
import { recipeFormatter } from '../src/recipe-formatter.js';

describe('recipeFormatter', () => {
  test('anthropic-xml is pinned to XML tool mode, not left to membrane', () => {
    const f = recipeFormatter('anthropic-xml', 'anthropic');
    expect(f).toBeInstanceOf(AnthropicXmlFormatter);
    expect((f as AnthropicXmlFormatter).configuredToolMode).toBe('xml');
  });

  test('native and codex recipes keep their formatters', () => {
    expect(recipeFormatter(undefined, 'anthropic')).toBeInstanceOf(NativeFormatter);
    expect(recipeFormatter('native', 'bedrock')).toBeInstanceOf(NativeFormatter);
    expect(recipeFormatter('anthropic-xml', 'openai-codex')).toBeInstanceOf(OpenAIResponsesFormatter);
  });

  // The regression this pins: with an unconfigured AnthropicXmlFormatter, membrane >= 0.5.87
  // resolves tool mode to native and sends a native chat. Pinned, the request stays a prefill
  // transcript: the history folded into the assistant prefill, ending on the agent's own name.
  test('an anthropic-xml request is built as a prefill transcript', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'Lari', content: [{ type: 'text', text: 'hello' }] },
      { participant: 'Rhys', content: [{ type: 'text', text: 'hi' }] },
      { participant: 'Lari', content: [{ type: 'text', text: 'how are you?' }] },
    ];
    const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
    const build = (formatter: AnthropicXmlFormatter) => formatter.buildMessages(messages, {
      participantMode: 'multiuser', assistantParticipant: 'Rhys', tools,
      toolMode: formatter.configuredToolMode ?? 'native',
      prefillUserMessage: '<cmd>cat untitled.log</cmd>',
    });
    const pinned = build(recipeFormatter('anthropic-xml', 'anthropic') as AnthropicXmlFormatter);
    const last = pinned.messages.at(-1) as { role: string; content: unknown };
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(last.content)).toContain('Rhys:');
    expect(pinned.nativeTools ?? []).toHaveLength(0);
    // The unpinned formatter, as host 0.10.0 built it, is what membrane turns native.
    const unpinned = new AnthropicXmlFormatter();
    expect(unpinned.configuredToolMode).toBeUndefined();
    void Membrane;
  });
});
