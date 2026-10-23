/**
 * What the Health view and the Context page say about an agent's context
 * composition and its last inference. The composition is the render stats of
 * the agent's last live compile, the one a turn makes; a preview's dry
 * compile leaves them as they were. context-manager keeps them only for a
 * strategy that keeps render stats, and only from a live compile since the
 * agent's context was loaded, at the host's start or a session or branch
 * switch. So where there are none, these say which of the two it is.
 */

/** What an agent with no composition shows, by whether its strategy keeps
 *  render stats at all. */
export function noComposition(statsKept: boolean): string {
  return statsKept ? 'No live compile since its context was loaded.' : "This agent's strategy keeps no composition.";
}

/** What the Health view shows for an agent's composition, from its entry in
 *  `/healthz`'s `contextComposition`: the entry's stats as a block; else a
 *  line saying why there are none; else nothing, where the section wasn't
 *  read at all or the agent's own read failed, which the view's failure line
 *  names. An entry of `{ statsKept: false }` is an agent whose strategy keeps
 *  no render stats. */
export function healthComposition<C extends { statsKept?: false }>(
  entry: C | undefined,
  opts: { sectionRead: boolean; readFailed: boolean },
): { stats: C } | { line: string } | null {
  if (entry && entry.statsKept !== false) return { stats: entry };
  if (!opts.sectionRead || opts.readFailed) return null;
  return { line: noComposition(entry?.statsKept !== false) };
}

/** An agent's last inference as the framework reports it: when each
 *  inference started and ended, and when one failed. Each is kept until the
 *  next of its kind, so a failure stays after later inferences. */
export interface LastInference {
  startedAt?: number;
  endedAt?: number;
  failedAt?: number;
}

/** What the agent's latest inference did: failed, if a failure came at or
 *  after its start; else started, while it hasn't ended since; else ended. A
 *  failure or end in the latest start's millisecond is read as that
 *  inference's: one that fails before any request can fail in its own start's
 *  millisecond, and read the other way it would show "started" until the
 *  next inference starts, where this way a wrong reading lasts only until
 *  the inference in flight ends. Null when the framework reports none. */
export function lastInferenceState(last: LastInference | null | undefined): { word: 'failed' | 'started' | 'ended'; at: number } | null {
  const { startedAt, endedAt, failedAt } = last ?? {};
  if (failedAt !== undefined && (startedAt === undefined || failedAt >= startedAt)) return { word: 'failed', at: failedAt };
  if (startedAt === undefined) return null;
  if (endedAt === undefined || endedAt < startedAt) return { word: 'started', at: startedAt };
  return { word: 'ended', at: endedAt };
}

/** The Health view's last-inference line, with `ago` saying how long ago a
 *  time was, or null where the framework reports none. */
export function lastInferenceLine(last: LastInference | null | undefined, ago: (at: number) => string): string | null {
  const state = lastInferenceState(last);
  return state ? `last inference: ${state.word} ${ago(state.at)}` : null;
}

/** Why the Context page has no exact count of the next request, from the
 *  makeup endpoint's `countSource`. */
export function notCounted(countSource: string): string {
  if (countSource === 'count_tokens_unsupported_model') return "not counted: count_tokens doesn't take this agent's model";
  const failed = /^count_tokens_failed_(\d+)$/.exec(countSource);
  if (failed) return `not counted: count_tokens answered ${failed[1]}`;
  if (countSource === 'count_tokens_error') return 'not counted: the count_tokens call failed';
  if (countSource === 'count_tokens') return 'not counted: count_tokens answered with no count';
  return `not counted (${countSource})`;
}
