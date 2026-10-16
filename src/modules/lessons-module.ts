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

/** A lesson as it's stored. A record an earlier version wrote, or one written
 *  by hand into the shared lessons file, can lack its content, tags or
 *  evidence, or hold a confidence outside 0 to 1, as text, or none that's a
 *  number, so every reader takes it through readable(), and the record stays
 *  as stored. */
type StoredLesson = Omit<Lesson, 'content' | 'tags' | 'evidence' | 'confidence'> &
  { content?: unknown; tags?: unknown; evidence?: unknown; confidence?: unknown };

interface LessonsState {
  lessons: StoredLesson[];
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
    // Each lesson stored with a fault is named once per load for whoever
    // runs the host, with every fault in one line; see readable() for how
    // readers take it.
    for (const l of this.state.lessons) {
      if (l.deprecated) continue;
      const line = loadLine(l);
      if (line) console.warn(line);
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
    return this.readableLessons();
  }

  /** Every lesson as readers see it; see readable(). */
  private readableLessons(): Lesson[] {
    return this.state.lessons.map(readable);
  }

  /** Each lesson as stored, with how readers see it and what the agent's
   *  mark says it needs. A filter or a sort carries each lesson's own
   *  record, so two that share an id don't take each other's. /export
   *  writes the stored records as data and shows the readable ones. */
  getLessonRecords(): Array<{ stored: unknown; lesson: Lesson; needsFix?: string }> {
    return this.state.lessons.map(stored => {
      const fix = stored.deprecated ? undefined : needsFix(stored);
      return { stored, lesson: readable(stored), ...(fix ? { needsFix: fix } : {}) };
    });
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
    const lesson = findLesson(this.state.lessons, input.id);
    const problems = inputProblems(input, false);
    if (!lesson) return notFound('updated', input.id, problems.join('; ') || undefined);
    if (problems.length > 0) {
      return { success: false, isError: true, error: `Nothing was updated: ${problems.join('; ')}.` };
    }

    if (input.content !== undefined) lesson.content = input.content;
    if (input.tags !== undefined) lesson.tags = input.tags;
    if (input.confidence !== undefined) lesson.confidence = input.confidence;
    if (input.evidence !== undefined) {
      // Merge evidence, dedup, keeping every stored value: a lone one is
      // the list's first entry
      const existing = new Set(storedEvidence(lesson.evidence));
      for (const e of input.evidence) existing.add(e);
      lesson.evidence = [...existing];
    }
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, message: 'Lesson updated' } };
  }

  private handleDeprecate(input: DeprecateInput): ToolResult {
    const lesson = findLesson(this.state.lessons, input.id);
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
    let results = this.getLessonRecords().filter(r => !r.lesson.deprecated);

    // Filter by minimum confidence
    if (input.minConfidence !== undefined) {
      results = results.filter(r => r.lesson.confidence >= input.minConfidence!);
    }

    // Filter by tags (any match)
    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(r =>
        r.lesson.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    // Text search (simple keyword matching)
    if (input.text) {
      const keywords = input.text.toLowerCase().split(/\s+/);
      results = results.filter(r => {
        const text = r.lesson.content.toLowerCase();
        return keywords.some(kw => text.includes(kw));
      });
    }

    // Sort by relevance (confidence descending)
    results.sort((a, b) => b.lesson.confidence - a.lesson.confidence);

    return {
      success: true,
      data: {
        count: results.length,
        lessons: results.slice(0, limit).map(({ stored, lesson: l, needsFix: fix }) => ({
          id: l.id,
          content: l.content,
          // As stored, so a confidence outside 0 to 1, or stored as text,
          // shows as it is.
          confidence: (stored as StoredLesson).confidence,
          tags: l.tags,
          evidence: l.evidence,
          ...(fix ? { needsFix: fix } : {}),
        })),
      },
    };
  }

  private handleList(input: ListInput): ToolResult {
    const limit = input.limit ?? 50;
    const all = this.getLessonRecords();
    let results = input.includeDeprecated ? all : all.filter(r => !r.lesson.deprecated);

    // Filter by tags
    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(r =>
        r.lesson.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    // Sort
    const sort = input.sort ?? 'confidence';
    switch (sort) {
      case 'confidence':
        results.sort((a, b) => b.lesson.confidence - a.lesson.confidence);
        break;
      case 'created':
        results.sort((a, b) => b.lesson.created - a.lesson.created);
        break;
      case 'updated':
        results.sort((a, b) => b.lesson.updated - a.lesson.updated);
        break;
    }

    return {
      success: true,
      data: {
        total: results.length,
        // A deprecated lesson has no mark: deprecating it is a fix.
        lessons: results.slice(0, limit).map(({ stored, lesson: l, needsFix: fix }) => ({
          id: l.id,
          content: l.content,
          // As stored, so a confidence outside 0 to 1, or stored as text,
          // shows as it is.
          confidence: (stored as StoredLesson).confidence,
          tags: l.tags,
          deprecated: l.deprecated,
          ...(fix ? { needsFix: fix } : {}),
        })),
      },
    };
  }

  private handleBoost(input: IdInput): ToolResult {
    const lesson = findLesson(this.state.lessons, input.id);
    if (!lesson) return notFound('boosted', input.id);

    const refused = adjustRefusal(lesson, 'boost');
    if (refused) return { success: false, error: refused, isError: true };

    // Diminishing returns boost; one stored as text that holds a number
    // starts from that number.
    const base = confidenceValue(lesson.confidence);
    lesson.confidence = Math.min(1, base + 0.1 * (1 - base));
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, confidence: lesson.confidence } };
  }

  private handleDemote(input: IdInput): ToolResult {
    const lesson = findLesson(this.state.lessons, input.id);
    if (!lesson) return notFound('demoted', input.id);

    const refused = adjustRefusal(lesson, 'demote');
    if (refused) return { success: false, error: refused, isError: true };

    // Diminishing returns demote; one stored as text that holds a number
    // starts from that number.
    const base = confidenceValue(lesson.confidence);
    lesson.confidence = Math.max(0, base - 0.1 * base);
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
    let global: unknown;
    try {
      // A number JSON can't hold, such as 1e999, parses as Infinity, which
      // the module's store refuses to save. It's read as null, a confidence
      // that isn't a number, which a save writes back as it is.
      global = JSON.parse(readFileSync(this.globalPath, 'utf-8'), (_key, value: unknown) =>
        typeof value === 'number' && !Number.isFinite(value) ? null : value);
    } catch {
      return; // File doesn't exist yet — nothing to merge
    }
    if (!isRecord(global) || !Array.isArray(global.lessons)) return;

    const byId = new Map(this.state.lessons.map(l => [l.id, l]));
    let merged = false;
    // An entry that isn't an object isn't a lesson: it's left out of what's
    // merged. The next save writes the file with the lessons the module
    // holds, so without it unless the module's own state holds it too.
    const entries = (global.lessons as unknown[]).filter(isRecord) as StoredLesson[];
    const skipped = global.lessons.length - entries.length;
    if (skipped > 0) {
      console.warn(skipped === 1
        ? `[lessons] the shared lessons file ${this.globalPath} has 1 entry that isn't a lesson (not an object). ` +
          "It's left out, and the next save writes the file with the lessons this host holds."
        : `[lessons] the shared lessons file ${this.globalPath} has ${skipped} entries that aren't lessons (not objects). ` +
          "They're left out, and the next save writes the file with the lessons this host holds.");
    }
    for (const gl of entries) {
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

/** What's wrong with a stored lesson, field by field, or nothing when it's
 *  whole. The agent's mark, the operator's load line and boost and demote's
 *  refusals all say it from this. */
interface Faults {
  /** Content that isn't text, or is blank: queries find no words in it, and
   *  retrieval leaves the lesson out. */
  content: boolean;
  /** Tags that aren't a list ('missing'), read as none, or a list with
   *  entries that aren't text ('mixed'), read by the ones that are. */
  tags?: 'missing' | 'mixed';
  confidence?: ConfidenceFault;
}

interface ConfidenceFault {
  /** What's stored, as a phrase after "with". */
  stored: string;
  /** What queries, lists and retrieval rank and filter it by. */
  ranked: number;
  /** A value from 0 to 1 the stored one most likely meant, if it has one. */
  example?: number;
}

function faultsOf(l: StoredLesson): Faults | undefined {
  const content = typeof l.content !== 'string' || l.content.trim() === '';
  const tags = !Array.isArray(l.tags) ? 'missing' as const : isTextList(l.tags) ? undefined : 'mixed' as const;
  const confidence = confidenceFault(l.confidence);
  return content || tags || confidence ? { content, ...(tags ? { tags } : {}), ...(confidence ? { confidence } : {}) } : undefined;
}

/** A stored confidence as a number: a number as it is, text that holds a
 *  number as that number, and anything else, blank text included, as NaN. */
function confidenceValue(c: unknown): number {
  if (typeof c === 'number') return c;
  if (typeof c === 'string' && c.trim() !== '') return Number(c);
  return NaN;
}

/** A confidence as queries, lists and retrieval rank and filter by it: one
 *  outside 0 to 1 counts as the nearer end, and one that isn't a number as
 *  0. A lesson stored with 85 ranks as 1, the top of the range, with every
 *  lesson stored at 1, rather than as 85. */
function rankedConfidence(c: unknown): number {
  const v = confidenceValue(c);
  return Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v));
}

function confidenceFault(c: unknown): ConfidenceFault | undefined {
  const v = confidenceValue(c);
  const inRange = v >= 0 && v <= 1;
  if (typeof c === 'number' && inRange) return undefined;
  const ranked = rankedConfidence(c);
  if (Number.isNaN(v)) return { stored: "a confidence that isn't a number", ranked };
  const asStored = typeof c === 'string' ? `confidence ${JSON.stringify(c)}, stored as text` : `confidence ${v}`;
  if (inRange) return { stored: asStored, ranked, example: v };
  // A whole number from 2 to 100 reads as a percentage, as 85 for 85%.
  // Any other value outside the range gets no guess.
  const percent = Number.isInteger(v) && v >= 2 && v <= 100;
  return { stored: `${asStored}, outside 0 to 1`, ranked, ...(percent ? { example: v / 100 } : {}) };
}

/** What a lesson is stored with, as a phrase after "stored". */
function storedPhrase(f: Faults): string {
  const missing = [...(f.content ? ['content'] : []), ...(f.tags === 'missing' ? ['tags'] : [])];
  return [
    ...(missing.length > 0 ? [`without usable ${missing.join(' or ')}`] : []),
    ...(f.tags === 'mixed' ? ["with tags that aren't all text, read by the ones that are"] : []),
    ...(f.confidence ? [`with ${f.confidence.stored}`] : []),
  ].join(', and ');
}

/** What an update gives to fix it, and whether deprecating would do too. */
function fixPhrase(f: Faults): { give: string; orDeprecate: boolean } {
  const fields = f.content && f.tags ? ['its content and tags'] : f.content ? ['its content'] : f.tags ? ['its tags'] : [];
  const confidence = f.confidence
    ? [`a confidence from 0 to 1${f.confidence.example !== undefined ? `, such as ${f.confidence.example},` : ''}`]
    : [];
  return { give: [...fields, ...confidence].join(', and '), orDeprecate: fields.length > 0 };
}

/** The lesson a call's id names: only an id that's non-empty text names
 *  one. A call without an id used to find the first lesson stored without
 *  one, since undefined === undefined. */
function findLesson(lessons: StoredLesson[], id: unknown): StoredLesson | undefined {
  return idProblem(id) ? undefined : lessons.find(l => l.id === id);
}

/** Why a call's id can't name a lesson, if it can't. */
function idProblem(id: unknown): string | undefined {
  if (id === undefined || id === '') return 'id is missing: give the lesson\'s id';
  if (typeof id !== 'string') return `id must be text, such as the id lessons--list shows, not ${shown(id)}`;
  return undefined;
}

/** Why no call can name a stored lesson, as a phrase after "and", if none
 *  can: lesson tools find a lesson by an id that's non-empty text. */
function idFault(l: StoredLesson): string | undefined {
  if (l.id === undefined) return 'without an id';
  if (l.id === '') return 'with an empty id';
  if (typeof l.id !== 'string') return `with an id that isn't text (${shown(l.id)})`;
  return undefined;
}

/** What the agent's list and query say a stored lesson needs, if anything. */
function needsFix(l: StoredLesson): string | undefined {
  const f = faultsOf(l);
  if (!f) return undefined;
  const unnamed = idFault(l);
  if (unnamed) {
    return `Stored ${storedPhrase(f)}, and ${unnamed}. ${readsPhrase(f)}. Lesson tools find a lesson by an id ` +
      "that's non-empty text, so none can reach this one, and there's nothing to do about it.";
  }
  const { give, orDeprecate } = fixPhrase(f);
  return `Stored ${storedPhrase(f)}: give ${give} with lessons--update${orDeprecate ? ', or deprecate this lesson' : ''}.`;
}

/** The line that names a stored lesson's faults for whoever runs the host,
 *  once per load, with what readers make of them and what fixes them. */
function loadLine(l: StoredLesson): string | undefined {
  const f = faultsOf(l);
  if (!f) return undefined;
  const unnamed = idFault(l);
  if (unnamed) {
    return `[lessons] a lesson ${unnamed} is stored ${storedPhrase(f)}. ${readsPhrase(f)}. Lesson tools find a ` +
      "lesson by an id that's non-empty text, so none can reach it, and there's nothing to do about it.";
  }
  const { give, orDeprecate } = fixPhrase(f);
  return `[lessons] lesson ${JSON.stringify(l.id)} is stored ${storedPhrase(f)}. ` +
    `${readsPhrase(f)}${f.content ? ',' : ''} until the lesson is updated with ` +
    `${orDeprecate ? `${give} or deprecated` : give.replace(/,$/, '')}.`;
}

/** What queries and retrieval make of a stored lesson's faults. */
function readsPhrase(f: Faults): string {
  const reads = [
    ...(f.tags === 'missing' && !f.content ? ['read its tags as empty'] : []),
    ...(f.tags === 'mixed' ? ['read only its text tags'] : []),
    ...(f.confidence ? [`rank it as ${f.confidence.ranked}`] : []),
  ];
  return f.content
    ? `Queries find no words in its content${f.tags === 'missing' ? ' and read its tags as empty' : ''}` +
      `${reads.length > 0 ? ` and ${reads.join(' and ')}` : ''}, and retrieval leaves it out`
    : `Queries and retrieval ${reads.join(' and ')}`;
}

/** Why boost or demote leaves a lesson as it is: one whose stored confidence
 *  is outside 0 to 1 or isn't a number has no value to start from, and one
 *  taken from its rank would quietly decide it. */
function adjustRefusal(l: StoredLesson, verb: 'boost' | 'demote'): string | undefined {
  const fault = confidenceFault(l.confidence);
  const v = confidenceValue(l.confidence);
  if (!fault || (v >= 0 && v <= 1)) return undefined;
  const example = fault.example !== undefined ? `, such as ${fault.example},` : '';
  const done = verb === 'boost' ? 'boosted' : 'demoted';
  return `Nothing was ${done}: lesson ${JSON.stringify(l.id)} is stored with ${fault.stored}, so it has no ` +
    `confidence to ${verb} from. Give it one from 0 to 1${example} with lessons--update, then ${verb} it.`;
}

/** A stored lesson as every reader sees it: content it lacks reads as empty,
 *  of its tags and its evidence only the text entries count (evidence stored
 *  as one value counts as a list of that one), and its confidence is the one
 *  it's ranked by. The stored record isn't changed, so it stays as stored
 *  until someone updates it. */
function readable(l: StoredLesson): Lesson {
  if (typeof l.content === 'string' && isTextList(l.tags) && isTextList(l.evidence) && !confidenceFault(l.confidence)) {
    return l as Lesson;
  }
  return {
    ...l,
    content: typeof l.content === 'string' ? l.content : '',
    tags: textEntries(l.tags),
    evidence: textEntries(storedEvidence(l.evidence)),
    confidence: rankedConfidence(l.confidence),
  };
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(t => typeof t === 'string');
}

/** Stored evidence as a list: a list as it is, a lone value as a list of
 *  that one, and none when nothing is stored. */
function storedEvidence(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

/** The text entries of a list, or none when it isn't one. */
function textEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const which = idProblem(id) ?? `no lesson has the id ${shown(id)}`;
  return {
    success: false,
    isError: true,
    error:
      `Nothing was ${verb}: ${which}${also ? `; ${also}` : ''}. ` +
      'lessons--list shows lessons with their ids, the first 50 unless you give a larger limit (deprecated ' +
      'ones too, with includeDeprecated: true), and lessons--query finds lessons by text or tags.',
  };
}
