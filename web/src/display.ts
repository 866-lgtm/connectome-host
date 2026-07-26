/**
 * Cosmetic display-name overrides for the web UI.
 *
 * The framework identifies agents by their recipe `agent.name`, and that
 * name is baked into every stored message's `participant` — renaming it
 * for real requires a session-store migration (see membrane's
 * assistantParticipant role matching). Until that migration happens, this
 * map renames agents at render time only. Never feed the mapped value back
 * into wire commands or cost lookups: those key on the raw name.
 */
const DISPLAY_NAMES: Record<string, string> = {
  connectome: 'Polaris',
};

export function displayName(name: string): string {
  return DISPLAY_NAMES[name] ?? name;
}
