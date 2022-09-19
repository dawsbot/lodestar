import EventEmitter from "node:events";
import {routes} from "@lodestar/api/beacon";
import {altair, Epoch, Slot} from "@lodestar/types";
import {EpochClock} from "./EpochClock.js";
import {BeaconNodeProcess, SimulationParams} from "./types.js";
import {computeAttestation, computeAttestationParticipation, computeInclusionDelay, getForkName} from "./utils.js";

const participationHeading = (id: string): string => `${id}-P-H/S/T`;
const missedBlocksHeading = (id: string): string => `${id}-M`;

export class SimulationTracker {
  readonly producedBlocks: Map<string, Map<Slot, boolean>>;
  readonly attestationsPerBlock: Map<string, Map<Slot, number>>;
  readonly inclusionDelayPerBlock: Map<string, Map<Slot, number>>;
  readonly attestationParticipation: Map<string, Map<Epoch, {head: number; source: number; target: number}>>;
  private lastSeenSlot: Map<string, Slot>;

  readonly emitter = new EventEmitter();

  private signal: AbortSignal;
  private nodes: BeaconNodeProcess[];
  private clock: EpochClock;
  private params: SimulationParams;

  constructor(nodes: BeaconNodeProcess[], clock: EpochClock, params: SimulationParams, signal: AbortSignal) {
    this.signal = signal;
    this.nodes = nodes;
    this.clock = clock;
    this.params = params;

    this.producedBlocks = new Map();
    this.attestationsPerBlock = new Map();
    this.inclusionDelayPerBlock = new Map();
    this.attestationParticipation = new Map();
    this.lastSeenSlot = new Map();

    for (let i = 0; i < nodes.length; i += 1) {
      this.producedBlocks.set(nodes[i].id, new Map());
      this.attestationsPerBlock.set(nodes[i].id, new Map());
      this.inclusionDelayPerBlock.set(nodes[i].id, new Map());
      this.attestationParticipation.set(nodes[i].id, new Map());
      this.lastSeenSlot.set(nodes[i].id, 0);
    }
  }

  get missedBlocks(): Map<string, Slot[]> {
    const missedBlocks: Map<string, Slot[]> = new Map();
    const minSlot = Math.min(...this.lastSeenSlot.values());

    for (let i = 0; i < this.nodes.length; i++) {
      const missedBlocksForNode: Slot[] = [];

      for (let s = 0; s < minSlot; s++) {
        if (!this.producedBlocks.get(this.nodes[i].id)?.get(s)) {
          missedBlocksForNode.push(s);
        }
      }

      missedBlocks.set(this.nodes[i].id, missedBlocksForNode);
    }

    return missedBlocks;
  }

  async start(): Promise<void> {
    for (let i = 0; i < this.nodes.length; i += 1) {
      this.nodes[i].api.events.eventstream(
        [routes.events.EventType.block, routes.events.EventType.head, routes.events.EventType.finalizedCheckpoint],
        this.signal,
        async (event) => {
          this.emitter.emit(event.type, event, this.nodes[i]);

          switch (event.type) {
            case routes.events.EventType.block:
              await this.onBlock(event.message, this.nodes[i]);
              return;
            case routes.events.EventType.finalizedCheckpoint:
              this.onFinalizedCheckpoint(event.message, this.nodes[i]);
              return;
          }
        }
      );
    }
  }

  async stop(): Promise<void> {
    // Do nothing;
  }

  private async onBlock(
    event: routes.events.EventData[routes.events.EventType.block],
    node: BeaconNodeProcess
  ): Promise<void> {
    const slot = event.slot;
    const lastSeenSlot = this.lastSeenSlot.get(node.id);
    const blockAttestations = await node.api.beacon.getBlockAttestations(slot);

    if (lastSeenSlot !== undefined && slot > lastSeenSlot) {
      this.lastSeenSlot.set(node.id, slot);
    }

    this.producedBlocks.get(node.id)?.set(slot, true);
    this.attestationsPerBlock.get(node.id)?.set(slot, computeAttestation(blockAttestations.data));
    this.inclusionDelayPerBlock.get(node.id)?.set(slot, computeInclusionDelay(blockAttestations.data, slot));

    if (this.clock.isFirstSlotOfEpoch(slot)) {
      const state = await node.api.debug.getStateV2("head");
      const participation = computeAttestationParticipation(state.data as altair.BeaconState);

      this.attestationParticipation
        .get(node.id)
        // As the `computeAttestationParticipation` using previousEpochParticipation for calculations
        ?.set(participation.epoch, {
          head: participation.head,
          source: participation.source,
          target: participation.target,
        });
    }
  }

  private onHead(_event: routes.events.EventData[routes.events.EventType.head], _node: BeaconNodeProcess): void {
    // TODO: Add head tracking
  }

  private onFinalizedCheckpoint(
    _event: routes.events.EventData[routes.events.EventType.finalizedCheckpoint],
    _node: BeaconNodeProcess
  ): void {
    // TODO: Add checkpoint tracking
  }

  printNoesInfo(): void {
    /* eslint-disable @typescript-eslint/naming-convention */
    const maxSlot = Math.max(...this.lastSeenSlot.values());
    const records: Record<string, unknown>[] = [];

    for (let slot = 0; slot <= maxSlot; slot++) {
      const epoch = this.clock.getEpochForSlot(slot);

      const record: Record<string, unknown> = {
        F: getForkName(epoch, this.params),
        Eph: `${this.clock.getEpochForSlot(slot)}/${this.clock.getSlotIndexInEpoch(slot)}`,
        slot,
      };

      for (const node of this.nodes) {
        record[missedBlocksHeading(node.id)] = this.producedBlocks.get(node.id)?.get(slot) ? "" : "x";
      }

      for (const node of this.nodes) {
        record[participationHeading(node.id)] = "";
      }

      records.push(record);

      if (this.clock.isLastSlotOfEpoch(slot)) {
        const epoch = this.clock.getEpochForSlot(slot);
        const record: Record<string, unknown> = {
          F: getForkName(epoch, this.params),
          Eph: epoch,
          slot: "---",
        };

        for (const node of this.nodes) {
          record[missedBlocksHeading(node.id)] = this.missedBlocks.get(node.id)?.filter((s) => s <= slot).length;
        }

        for (const node of this.nodes) {
          const participation = this.attestationParticipation.get(node.id)?.get(epoch);
          const participationStr =
            participation?.head != null
              ? `${participation?.head.toFixed(2)}/${participation?.source.toFixed(2)}/${participation?.target.toFixed(
                  2
                )}`
              : "";
          record[participationHeading(node.id)] = participationStr;
        }
        records.push(record);
      }
    }

    console.table(records);
    console.log(
      ["M - Missed Blocks", "P - Attestation Participation", "H - Head", "S - Source", "T - Target"].join(" | ")
    );
    /* eslint-enable @typescript-eslint/naming-convention */
  }
}