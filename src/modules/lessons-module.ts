/**
 * LessonsModule — persistent knowledge store backed by Chronicle.
 *
 * Lessons are units of extracted knowledge with:
 *   - Confidence scores (0–1)
 *   - Tags for categorization
 *   - Evidence links (source message references)
 *
 * The module also implements gatherContext() to auto-inject
 * relevant lessons into the agent's context before inference.
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import type { ContextInjection } from '@animalabs/context-manager';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { unknownToolResult } from './unknown-tool.js';
import { shown } from './shown.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Lesson {
  id: string;
  content: string;
  confidence: number;
  tags: string[];
  evidence: string[];
  created: number;
  updated: number;
  deprecated: boolean;
  deprecationReason?: string;
}

interface LessonsState {
  lessons: Lesson[];
}

interface CreateInput {
  content: string;
  tags: string[];
  evidence?: string[];
  confidence?: number;
}

interface UpdateInput {
  id: string;
  content?: string;
  tags?: string[];
  confidence?: number;
  evidence?: string[];
}

interface DeprecateInput {
  id: string;
  reason: string;
}

interface QueryInput {
  text?: string;
  tags?: string[];
  minConfidence?: number;
  limit?: number;
}

interface ListInput {
  tags?: string[];
  sort?: 'confidence' | 'created' | 'updated';
  limit?: number;
  includeDeprecated?: boolean;
}

interface IdInput {
  id: string;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class LessonsModule implements Module {
  readonly name = 'lessons';

  private ctx: ModuleContext | null = null;
  private state: LessonsState = { lessons: [] };
  private globalPath: string | null;

  constructor(opts?: { globalPath?: string }) {
    this.globalPath = opts?.globalPath ?? null;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const saved = ctx.getState<LessonsState>();
    if (saved) {
      this.state = saved;
    }
    // Merge in lessons from the global shared file
    if (this.globalPath) {
      this.mergeFromGlobal();
    }
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'create',
        description: 'Create a new lesson (unit of extracted knowledge).',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The knowledge content' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Categorization tags (e.g., people, process, decision, technical)',
            },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: 'Source references (e.g., stream:topic:messageId)',
            },
            confidence: { type: 'number', description: 'Initial confidence 0–1 (default: 0.5)' },
          },
          required: ['content', 'tags'],
        },
      },
      {
        name: 'update',
        description: 'Update an existing lesson.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lesson ID' },
            content: { type: 'string', description: 'Updated content' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Updated tags' },
            confidence: { type: 'number', description: 'Updated confidence, from 0 to 1' },
            evidence: { type: 'array', items: { type: 'string' }, description: 'Additional evidence' },
          },
          required: ['id'],
        },
      },
      {
        name: 'deprecate',
        description: 'Mark a lesson as deprecated (no longer considered accurate).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lesson ID' },
            reason: { type: 'string', description: 'Why this lesson is being deprecated' },
          },
          required: ['id', 'reason'],
        },
      },
      {
        name: 'query',
        description: 'Search lessons by text and/or tags.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to search for (keyword matching)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any match)' },
            minConfidence: { type: 'number', description: 'Minimum confidence threshold' },
            limit: { type: 'number', description: 'Max results (default: 20)' },
          },
        },
      },
      {
        name: 'list',
        description: 'List all lessons, optionally filtered and sorted.',
        inputSchema: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
            sort: {
              type: 'string',
              description: 'Sort by: confidence, created, or updated (default: confidence)',
            },
            limit: { type: 'number', description: 'Max results (default: 50)' },
            includeDeprecated: { type: 'boolean', description: 'Include deprecated lessons' },
          },
        },
      },
      {
        name: 'boost',
        description: 'Increase a lesson\'s confidence (it proved useful).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lesson ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'demote',
        description: 'Decrease a lesson\'s confidence (it was wrong or unhelpful).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lesson ID' },
          },
          required: ['id'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input: unknown = call.input ?? {};
    switch (call.name) {
      case 'create': return this.handleCreate(input as CreateInput);
      case 'update': return this.handleUpdate(input as UpdateInput);
      case 'deprecate': return this.handleDeprecate(input as DeprecateInput);
      case 'query': return this.handleQuery(input as QueryInput);
      case 'list': return this.handleList(input as ListInput);
      case 'boost': return this.handleBoost(input as IdInput);
      case 'demote': return this.handleDemote(input as IdInput);
      default:
        return unknownToolResult(this, call.name);
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // Lesson injection is handled solely by RetrievalModule (intelligent retrieval
  // pipeline). LessonsModule provides storage + CRUD tools only.

  // Public accessor for other modules (e.g., RetrievalModule)
  getLessons(): Lesson[] {
    return this.state.lessons;
  }

  // =========================================================================
  // Tool Handlers
  // =========================================================================

  private handleCreate(input: CreateInput): ToolResult {
    // A lesson stored without its content or tags makes every later query by
    // text or by tags fail, and retrieval reads every field as given.
    const problems = inputProblems(input, true);
    if (problems.length > 0) {
      return { success: false, isError: true, error: `Nothing was created: ${problems.join('; ')}.` };
    }

    const lesson: Lesson = {
      id: randomUUID().slice(0, 8),
      content: input.content,
      confidence: input.confidence ?? 0.5,
      tags: input.tags,
      evidence: input.evidence ?? [],
      created: Date.now(),
      updated: Date.now(),
      deprecated: false,
    };

    this.state.lessons.push(lesson);
    this.save();

    return { success: true, data: { id: lesson.id, message: 'Lesson created' } };
  }

  private handleUpdate(input: UpdateInput): ToolResult {
    const lesson = this.state.lessons.find(l => l.id === input.id);
    const problems = inputProblems(input, false);
    if (!lesson) return notFound('updated', input.id, problems.join('; ') || undefined);
    if (problems.length > 0) {
      return { success: false, isError: true, error: `Nothing was updated: ${problems.join('; ')}.` };
    }

    if (input.content !== undefined) lesson.content = input.content;
    if (input.tags !== undefined) lesson.tags = input.tags;
    if (input.confidence !== undefined) lesson.confidence = input.confidence;
    if (input.evidence !== undefined) {
      // Merge evidence, dedup
      const existing = new Set(lesson.evidence);
      for (const e of input.evidence) existing.add(e);
      lesson.evidence = [...existing];
    }
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, message: 'Lesson updated' } };
  }

  private handleDeprecate(input: DeprecateInput): ToolResult {
    const lesson = this.state.lessons.find(l => l.id === input.id);
    const reason: unknown = input.reason;
    const reasonProblem = typeof reason === 'string'
      ? reason.trim() === '' ? 'reason is blank: say why the lesson is no longer accurate' : undefined
      : reason === undefined
        ? 'reason is missing: say why the lesson is no longer accurate'
        : `reason must be text, not ${shown(reason)}`;
    if (!lesson) return notFound('deprecated', input.id, reasonProblem);
    if (reasonProblem) return { success: false, isError: true, error: `Nothing was deprecated: ${reasonProblem}.` };

    lesson.deprecated = true;
    lesson.deprecationReason = input.reason;
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, message: 'Lesson deprecated' } };
  }

  private handleQuery(input: QueryInput): ToolResult {
    const limit = input.limit ?? 20;
    let results = this.state.lessons.filter(l => !l.deprecated);

    // Filter by minimum confidence
    if (input.minConfidence !== undefined) {
      results = results.filter(l => l.confidence >= input.minConfidence!);
    }

    // Filter by tags (any match)
    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(l =>
        l.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    // Text search (simple keyword matching)
    if (input.text) {
      const keywords = input.text.toLowerCase().split(/\s+/);
      results = results.filter(l => {
        const text = l.content.toLowerCase();
        return keywords.some(kw => text.includes(kw));
      });
    }

    // Sort by relevance (confidence descending)
    results.sort((a, b) => b.confidence - a.confidence);

    return {
      success: true,
      data: {
        count: results.length,
        lessons: results.slice(0, limit).map(l => ({
          id: l.id,
          content: l.content,
          confidence: l.confidence,
          tags: l.tags,
          evidence: l.evidence,
        })),
      },
    };
  }

  private handleList(input: ListInput): ToolResult {
    const limit = input.limit ?? 50;
    let results = input.includeDeprecated
      ? [...this.state.lessons]
      : this.state.lessons.filter(l => !l.deprecated);

    // Filter by tags
    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(l =>
        l.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    // Sort
    const sort = input.sort ?? 'confidence';
    switch (sort) {
      case 'confidence':
        results.sort((a, b) => b.confidence - a.confidence);
        break;
      case 'created':
        results.sort((a, b) => b.created - a.created);
        break;
      case 'updated':
        results.sort((a, b) => b.updated - a.updated);
        break;
    }

    return {
      success: true,
      data: {
        total: results.length,
        lessons: results.slice(0, limit).map(l => ({
          id: l.id,
          content: l.content,
          confidence: l.confidence,
          tags: l.tags,
          deprecated: l.deprecated,
        })),
      },
    };
  }

  private handleBoost(input: IdInput): ToolResult {
    const lesson = this.state.lessons.find(l => l.id === input.id);
    if (!lesson) return notFound('boosted', input.id);

    // Diminishing returns boost
    lesson.confidence = Math.min(1, lesson.confidence + 0.1 * (1 - lesson.confidence));
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, confidence: lesson.confidence } };
  }

  private handleDemote(input: IdInput): ToolResult {
    const lesson = this.state.lessons.find(l => l.id === input.id);
    if (!lesson) return notFound('demoted', input.id);

    // Diminishing returns demote
    lesson.confidence = Math.max(0, lesson.confidence - 0.1 * lesson.confidence);
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, confidence: lesson.confidence } };
  }

  private save(): void {
    this.ctx?.setState(this.state);
    if (this.globalPath) {
      this.saveToGlobal();
    }
  }

  /** Merge lessons from the global JSON file. Newer `updated` wins on ID conflicts. */
  private mergeFromGlobal(): void {
    if (!this.globalPath) return;
    let global: LessonsState;
    try {
      global = JSON.parse(readFileSync(this.globalPath, 'utf-8'));
    } catch {
      return; // File doesn't exist yet — nothing to merge
    }
    if (!Array.isArray(global.lessons)) return;

    const byId = new Map(this.state.lessons.map(l => [l.id, l]));
    let merged = false;
    for (const gl of global.lessons) {
      const existing = byId.get(gl.id);
      if (!existing) {
        this.state.lessons.push(gl);
        merged = true;
      } else if (gl.updated > existing.updated) {
        Object.assign(existing, gl);
        merged = true;
      }
    }
    if (merged) {
      this.ctx?.setState(this.state);
    }
  }

  /** Write current lessons to the global JSON file. */
  private saveToGlobal(): void {
    if (!this.globalPath) return;
    try {
      mkdirSync(dirname(this.globalPath), { recursive: true });
      writeFileSync(this.globalPath, JSON.stringify({ lessons: this.state.lessons }, null, 2));
    } catch {
      // Best-effort — don't break the module if the file can't be written
    }
  }
}

/** What's wrong with the fields a create or update gives, each named with the
 *  value given. create needs content and tags; update takes any of them. */
function inputProblems(
  input: { content?: unknown; tags?: unknown; confidence?: unknown; evidence?: unknown },
  isCreate: boolean,
): string[] {
  const problems: string[] = [];
  const textList = (value: unknown) => Array.isArray(value) && value.every(t => typeof t === 'string');
  // A field left out keeps its value on update; null is a value, and not
  // one any field takes.
  const orKeep = (what: string) => (isCreate ? '' : `, or leave it out to keep the current ${what}`);
  if (input.content === undefined) {
    if (isCreate) problems.push('content is missing: give the lesson as text');
  } else if (typeof input.content !== 'string') {
    problems.push(`content must be the lesson as text${orKeep('text')}, not ${shown(input.content)}`);
  } else if (input.content.trim() === '') {
    problems.push(`content is blank: give the lesson as text${orKeep('text')}`);
  }
  if (input.tags === undefined) {
    if (isCreate) problems.push('tags is missing: give a list of tags, such as ["process"]');
  } else if (!textList(input.tags)) {
    problems.push(`tags must be a list of text, such as ["process"]${orKeep('tags')}, not ${shown(input.tags)}`);
  }
  if (input.confidence !== undefined
    && !(typeof input.confidence === 'number' && input.confidence >= 0 && input.confidence <= 1)) {
    problems.push(`confidence must be a number from 0 to 1, such as 0.8, not ${shown(input.confidence)}`);
  }
  if (input.evidence !== undefined && !textList(input.evidence)) {
    problems.push(`evidence must be a list of text, such as ["stream:topic:messageId"], not ${shown(input.evidence)}`);
  }
  return problems;
}

/** An update, deprecate, boost or demote whose id matches no lesson, with
 *  any other problem in the call named beside it. */
function notFound(verb: 'updated' | 'deprecated' | 'boosted' | 'demoted', id: unknown, also?: string): ToolResult {
  const which = id === undefined || id === ''
    ? 'id is missing: give the lesson\'s id'
    : `no lesson has the id ${shown(id)}`;
  return {
    success: false,
    isError: true,
    error:
      `Nothing was ${verb}: ${which}${also ? `; ${also}` : ''}. ` +
      'lessons--list shows lessons with their ids, the first 50 unless you give a larger limit (deprecated ' +
      'ones too, with includeDeprecated: true), and lessons--query finds lessons by text or tags.',
  };
}
