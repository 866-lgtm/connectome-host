import { describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '@animalabs/agent-framework';
import { unknownToolResult } from '../src/modules/unknown-tool.js';

const def = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });

describe('unknownToolResult', () => {
  test('names the tool as the agent called it, says nothing ran, and lists the module tools by their full names', () => {
    const r = unknownToolResult({ name: 'activity', getTools: () => [def('show_in'), def('hide_in')] }, 'show');
    expect(r.success).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.error).toContain('"activity--show"');
    expect(r.error).toContain('nothing ran');
    expect(r.error).toContain('activity--show_in and activity--hide_in');
  });

  test('reads the list from the module each time, so a tool the module adds is offered', () => {
    const tools = [def('a'), def('b')];
    const module = { name: 'm', getTools: () => tools };
    expect(unknownToolResult(module, 'x').error).toContain('m--a and m--b.');
    tools.push(def('c'));
    expect(unknownToolResult(module, 'x').error).toContain('m--a, m--b and m--c.');
  });

  test('utilities are named with how to run them through utils', () => {
    const r = unknownToolResult(
      { name: 'identity', getTools: () => [], getUtilities: () => [def('status'), def('request')] },
      'stat',
    );
    expect(r.error).toContain('identity--status and identity--request');
    expect(r.error).toContain('{"action": "run", "name": "identity--status"}');
    expect(r.error).not.toContain('no tools of its own');
  });

  test('a module with nothing to offer says so, and the module can add where to go instead', () => {
    const r = unknownToolResult(
      { name: 'settings', getTools: () => [] },
      'reasoning_enable',
      'Reasoning is set through agent_settings.',
    );
    expect(r.error).toContain('"settings--reasoning_enable"');
    expect(r.error).toContain('The settings module has no tools of its own; call one of the tools listed for you.');
    expect(r.error!.endsWith('Reasoning is set through agent_settings.')).toBe(true);
  });

  test('one utility reads as one', () => {
    const r = unknownToolResult({ name: 'identity', getTools: () => [], getUtilities: () => [def('status')] }, 'stat');
    expect(r.error).toContain("The identity module's one utility is identity--status, run through the utils tool");
  });

  test('one tool reads as one', () => {
    const r = unknownToolResult({ name: 'time', getTools: () => [def('now')] }, 'today');
    expect(r.error).toContain("The time module's one tool is time--now.");
  });
});
