import type { AgentFramework } from '@animalabs/agent-framework';
import { FleetModule } from './modules/fleet-module.js';
import { commitRelease, type ReleaseHere } from './update/host.js';

/**
 * Start a framework's agents, and only then its fleet's autoStart children.
 * A child is a host with residents of its own, so none of them acts before
 * the parent's agents run. Every place the host starts a framework comes
 * through here: the start in main() and a session switch's.
 *
 * For a host an install's entry point started (`here`), this is also the
 * switch's commit point: the framework has opened its stores and tried its
 * servers, and no agent has started, so the host records its release as the
 * one the install's data runs on before starting them. A start on trial
 * commits only once every server it's configured with has connected. If the
 * commit doesn't happen, the framework is stopped, closing what creating it
 * opened, such as its servers' processes, so none outlives the host beside
 * the release that starts next, and this throws (commitRelease says why).
 */
export async function startFramework(
  framework: Pick<AgentFramework, 'start' | 'stop' | 'getModule' | 'listMcplServers'>,
  here: ReleaseHere | null,
): Promise<void> {
  if (here !== null) {
    let moved: { from: string } | undefined;
    try {
      moved = commitRelease(here, {
        unconnectedServers: () => framework.listMcplServers().filter((server) => !server.connected).map((server) => server.id),
      });
    } catch (error) {
      await framework.stop().catch((stopping: unknown) => {
        console.error(`[update] stopping the framework after its start ended failed too: ${stopping instanceof Error ? stopping.message : String(stopping)}`);
      });
      throw error;
    }
    if (moved !== undefined) {
      console.log(`[update] ${here.release} is now the release the install at ${here.root} runs on (it was ${moved.from}).`);
    }
  }
  framework.start();
  const fleet = framework.getModule('fleet');
  if (fleet instanceof FleetModule) fleet.launchAutoStart();
}
