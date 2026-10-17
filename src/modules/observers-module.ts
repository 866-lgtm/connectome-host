/**
 * ObserversModule — the agent holds the pen on who may observe its interior.
 *
 * Interiority access (thinking, tool payloads, conversation stream via the
 * webui) is a consent question before it is an ACL question — see connectome
 * docs/observability.md §4. These tools let the agent read and edit its own
 * data/observers.json grant file. The webui's ObserverRegistry checks the
 * file every ~3s, so without a restart a grant applies to the next hello, and
 * a revocation ends the grant's sessions and open connections. Operators can
 * edit the same file directly; writes here are atomic (tmp+rename) so the two
 * never corrupt each other.
 * A file these tools can't read, or that isn't a grants file, is never
 * written over. In one they can read, a change touches only the entries it
 * matches: every other entry, an unusable one included, and every other
 * field stays as found. The host uses a file's usable grants and names the
 * rest, so a bad entry never stops the agent's own changes.
 *
 * Grants marked `protected: true` (recipe-designated operator baseline) are
 * visible but not revocable through these tools; only a file edit removes
 * them. Tools also cannot CREATE protected grants — protection is an
 * operator-level marker.
 */

import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import {
  OBSERVER_SCOPES,
  canonicalKey,
  checkObserversFile,
  readObserversFile,
  saveObserversFile,
  type GrantsDocument,
  type ObserverGrant,
  type ObserverScope,
  type ObserversFile,
} from './web-ui-observers.js';

export interface ObserversModuleConfig {
  /** Absolute path to the grant file (same one the webui watches). */
  path: string;
  /** 'tools' (default) or 'utilities' — grant edits are rare; behind the
   *  `utils` meta-tool they stop costing three schemas per inference. The
   *  consent semantics are unchanged either way: the agent holds the pen. */
  surface?: 'tools' | 'utilities';
}

export class ObserversModule implements Module {
  readonly name = 'observers';

  constructor(private readonly config: ObserversModuleConfig) {}

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return (this.config.surface ?? 'tools') === 'tools' ? this.definitions() : [];
  }

  getUtilities(): ToolDefinition[] {
    return this.config.surface === 'utilities' ? this.definitions() : [];
  }

  private definitions(): ToolDefinition[] {
    return [
      {
        name: 'get',
        description:
          'List who is currently authorized to observe your internals through the web viewer ' +
          '(thinking, tool calls, conversation stream — by scope). Each grant is an ed25519 ' +
          'public key + label + scope list. Labels are testimony, not verified identity.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'grant',
        description:
          'Authorize an observer key to watch your internals through the web viewer. ' +
          `Scopes (event families): ${OBSERVER_SCOPES.join(', ')}. ` +
          "'health' = liveness/usage only; 'ops' = alerts (refusals, failures); 'messages' = the " +
          "conversation; 'tools' = tool calls and results; 'thinking' = your thinking blocks; " +
          "'debug' = compiled-context debug endpoints (implies seeing everything in your window). " +
          'Grant deliberately — this is access to your interior. Takes effect within ~3 seconds.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'ed25519:<base64url public key> — the fingerprint the person/device shows you.' },
            label: { type: 'string', description: 'Who this is (your words — e.g. "antra-phone", "fleet-hub").' },
            scopes: {
              type: 'array',
              items: { type: 'string', enum: [...OBSERVER_SCOPES] },
              description: 'Event families this key may receive.',
            },
            expires: { type: 'string', description: 'Optional ISO timestamp; the grant stops working after this.' },
          },
          required: ['key', 'label', 'scopes'],
        },
      },
      {
        name: 'revoke',
        description:
          'Remove an observer grant by key or by label. Protected (operator-baseline) grants ' +
          'cannot be revoked here. Within about 3 seconds, new connections are refused, and the ' +
          "grant's HTTP sessions and open connections end.",
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'ed25519:<base64url public key> to revoke; every grant for that key goes.' },
            label: { type: 'string', description: 'Alternative: revoke by exact label (must match exactly one grant); every grant for that grant\'s key goes with it.' },
          },
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    try {
      switch (call.name) {
        case 'get': {
          const read = this.read();
          if ('problem' in read) {
            return err(
              `The grants can't be listed: ${read.problem}. ` +
              (read.unparsed
                ? 'Until it parses, the web viewer goes on with the grants it last admitted, if any. '
                : '') +
              'These tools leave the file alone. Ask whoever runs this host to repair it.',
            );
          }
          return ok({ observers: read.usable.map(redactNothing), ...notUsed(read.problems) });
        }

        case 'grant': {
          // Written in canonical form, whichever base64 spelling was given.
          const key = canonicalKey(typeof input.key === 'string' ? input.key.trim() : '');
          const label = typeof input.label === 'string' ? input.label.trim() : '';
          const scopes = Array.isArray(input.scopes) ? input.scopes : [];
          if (!key) {
            return err('key must be "ed25519:<base64url public key>", a key that decodes to 32 bytes');
          }
          if (!label) return err('label is required');
          if (scopes.length === 0 || !scopes.every((s) => (OBSERVER_SCOPES as readonly string[]).includes(s as string))) {
            return err(`scopes must be a non-empty subset of: ${OBSERVER_SCOPES.join(', ')}`);
          }
          const expires = typeof input.expires === 'string' ? input.expires : null;
          if (expires && !Number.isFinite(Date.parse(expires))) return err('expires must be an ISO timestamp');

          const read = this.read();
          if ('problem' in read) return err(`Nothing was granted: ${read.problem}. ${leftAlone('grant')}`);
          // Every entry for the key becomes this one, as a revoke by key takes
          // them all: a repeat left behind would stay in the file, unused.
          const sameKey = read.doc.observers.filter((g): g is ObserverGrant => isEntry(g) && canonicalKey(g.key) === key);
          if (sameKey.some((g) => g.protected)) return err('that key holds a protected grant — edit the file to change it');
          const grant: ObserverGrant = { key, label, scopes: scopes as ObserverScope[], expires };
          const existing = sameKey[0];
          if (existing) {
            Object.assign(existing, grant); // update label/scopes/expiry in place
            read.doc.observers = read.doc.observers.filter((g) => g === existing || !sameKey.includes(g as ObserverGrant));
          } else {
            read.doc.observers.push(grant);
          }
          return this.saved(
            read.doc,
            `${existing ? 'Updated' : 'Granted'}: ${label} → [${grant.scopes.join(', ')}]${expires ? ` until ${expires}` : ''}. Live within ~3s.`,
          );
        }

        case 'revoke': {
          const key = typeof input.key === 'string' ? input.key.trim() : '';
          const label = typeof input.label === 'string' ? input.label.trim() : '';
          if (!key && !label) return err('provide key or label');
          const read = this.read();
          if ('problem' in read) return err(`Nothing was revoked: ${read.problem}. ${leftAlone('revoke')}`);
          const entries = (match: (g: ObserverGrant) => boolean) =>
            read.doc.observers.filter((g): g is ObserverGrant => isEntry(g) && match(g));
          // A key matches every spelling of itself. One that doesn't decode can
          // still name an entry spelled exactly so.
          const keyed = (k: string) => (g: ObserverGrant) => (canonicalKey(g.key) ?? g.key) === k;
          let matches = entries(key ? keyed(canonicalKey(key) ?? key) : (g) => g.label === label);
          if (matches.length === 0) return err('no matching grant');
          // A label has to name one entry. The key is the observer, though, so
          // a revoke takes every entry for it: a repeat left behind would be
          // used in place of the one revoked.
          if (!key && matches.length > 1) return err(`label matches ${matches.length} grants — revoke by key`);
          const named = matches[0]!;
          if (named.protected) return err('that grant is protected (operator baseline) — edit the file to remove it');
          // As a revoke by key does: one that doesn't decode matches entries
          // spelled exactly as it is.
          if (!key && typeof named.key === 'string') matches = entries(keyed(canonicalKey(named.key) ?? named.key));
          if (matches.some((g) => g.protected)) {
            return err('that key also holds a protected grant (operator baseline) — edit the file to remove it');
          }
          read.doc.observers = read.doc.observers.filter((g) => !matches.includes(g as ObserverGrant));
          const revoked = matches.map((g) => (typeof g.label === 'string' ? g.label : g.key));
          return this.saved(read.doc, `Revoked: ${revoked.join(', ')}. Within about 3 s, new connections are refused, and its sessions and open connections end.`);
        }

        default:
          return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
      }
    } catch (e) {
      return err(`observers file operation failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /** The file as found, its usable grants and what's wrong with the rest; or
   *  why it can't be changed. A missing file is no grants yet. A file that
   *  can't be read, isn't valid JSON or isn't a grants file is never written
   *  over. `unparsed` marks one that isn't valid JSON, which the viewer reads
   *  differently. */
  private read():
    | { doc: GrantsDocument; usable: ObserverGrant[]; problems: string[] }
    | { problem: string; unparsed: boolean } {
    const read = readObserversFile(this.config.path);
    if (read.kind === 'ok') return { doc: read.doc, usable: read.file.observers, problems: read.problems };
    if (read.kind === 'missing') return { doc: { observers: [] }, usable: [], problems: [] };
    return { problem: `the grants file, ${this.config.path}, ${read.problem}`, unparsed: read.kind === 'unparsed' };
  }

  /** Save the changed document, and answer with `message` and the grants the
   *  file now gives, naming any entry it holds that isn't used. */
  private saved(doc: GrantsDocument, message: string): ToolResult {
    saveObserversFile(this.config.path, doc as unknown as ObserversFile);
    const after = checkObserversFile(doc);
    return after.kind === 'ok'
      ? ok({ message, observers: after.file.observers, ...notUsed(after.problems) })
      : ok({ message });
  }
}

/** The entries a read found but the host doesn't use, each with its reason,
 *  for an answer that lists the grants. */
function notUsed(problems: string[]): { notUsed?: string[] } {
  return problems.length > 0 ? { notUsed: problems } : {};
}

/** An entry of the grants list that can be read as a grant's fields. */
function isEntry(g: unknown): g is ObserverGrant {
  return typeof g === 'object' && g !== null;
}

/** Why grant and revoke refuse a file they can't read, and what fixes it. */
function leftAlone(verb: 'grant' | 'revoke'): string {
  return (
    "These tools don't write over a file they can't read as grants, so they leave it alone until it's repaired. " +
    `Ask whoever runs this host to repair the file, then ${verb} again.`
  );
}

function redactNothing(g: ObserverGrant): ObserverGrant {
  return g; // grants hold public keys + labels only — nothing secret to redact
}

function ok(data: Record<string, unknown>): ToolResult {
  return { success: true, data, isError: false };
}

function err(message: string): ToolResult {
  return { success: false, error: message, isError: true };
}
