import {routes} from "@lodestar/api";
import {fromHexString} from "@chainsafe/ssz";
import {ProofType, Tree} from "@chainsafe/persistent-merkle-tree";
import {SyncPeriod} from "@lodestar/types";
import {ApiModules} from "../types.js";
import {resolveStateId} from "../beacon/state/utils.js";
import {IApiOptions} from "../../options.js";

// TODO: Import from lightclient/server package

export function getLightclientApi(
  opts: IApiOptions,
  {chain, config, db}: Pick<ApiModules, "chain" | "config" | "db">
): routes.lightclient.Api {
  // It's currently possible to request gigantic proofs (eg: a proof of the entire beacon state)
  // We want some some sort of resistance against this DoS vector.
  const maxGindicesInProof = opts.maxGindicesInProof ?? 512;

  return {
    async getStateProof(stateId, jsonPaths) {
      const state = await resolveStateId(config, chain, db, stateId);

      // Commit any changes before computing the state root. In normal cases the state should have no changes here
      state.commit();
      const stateNode = state.node;
      const tree = new Tree(stateNode);

      const gindexes = state.type.tree_createProofGindexes(stateNode, jsonPaths);
      // TODO: Is it necessary to de-duplicate?
      //       It's not a problem if we overcount gindexes
      const gindicesSet = new Set(gindexes);

      if (gindicesSet.size > maxGindicesInProof) {
        throw new Error("Requested proof is too large.");
      }

      return {
        data: tree.getProof({
          type: ProofType.treeOffset,
          gindices: Array.from(gindicesSet),
        }),
      };
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    async getUpdates(startPeriod: SyncPeriod, count: number) {
      const updates = await chain.lightClientServer.getUpdates(startPeriod, count);
      return {data: updates};
    },

    async getOptimisticUpdate() {
      const optimisticUpdate = chain.lightClientServer.getOptimisticUpdate();
      if (optimisticUpdate === null) {
        throw new Error("No latest header update available");
      } else {
        return {data: optimisticUpdate};
      }
    },

    async getFinalityUpdate() {
      const finalityUpdate = chain.lightClientServer.getFinalityUpdate();
      if (finalityUpdate === null) {
        throw new Error("No latest finality update available");
      }
      return {data: finalityUpdate};
    },

    async getBootstrap(blockRoot) {
      const bootstrapProof = await chain.lightClientServer.getBootstrap(fromHexString(blockRoot));
      return {data: bootstrapProof};
    },
  };
}
