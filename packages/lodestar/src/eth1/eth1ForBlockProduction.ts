import {TreeBacked} from "@chainsafe/ssz";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {BeaconState, Eth1Data, Deposit} from "@chainsafe/lodestar-types";
import {getNewEth1Data} from "@chainsafe/lodestar-beacon-state-transition/lib/fast/block/processEth1Data";
import {ILogger} from "@chainsafe/lodestar-utils";
import {AbortSignal} from "abort-controller";
import {Eth1DepositsCache} from "./eth1DepositsCache";
import {pickEth1Vote, votingPeriodStartTime} from "./utils/eth1Vote";
import {setIntervalAbortableAsync} from "../util/sleep";
import {IBeaconDb} from "../db";
import {Eth1Provider} from "./ethers";
import {fetchBlockRange} from "./httpEth1Client";
import {IEth1ForBlockProduction} from "./interface";
import {IEth1Options} from "./options";

/**
 * Main class handling eth1 data fetching and processing
 * Has:
 * - depositsCache: stores deposit data and an updated deposit roots merkle tree
 * - blocksCache: stores eth1 blocks (hash, number, timestamp)
 *
 * Upon instantiation will fetched deposit logs and blocks up to the follow distance.
 * I will keep updating the cache at regular intervals
 */
export class Eth1ForBlockProduction implements IEth1ForBlockProduction {
  config: IBeaconConfig;
  db: IBeaconDb;
  logger: ILogger;
  opts: IEth1Options;
  signal: AbortSignal;

  // Internal modules, state
  depositsCache: Eth1DepositsCache;
  eth1Provider: Eth1Provider;
  lastProcessedDepositBlockNumber: number | null;
  MAX_BLOCKS_PER_BLOCK_QUERY = 1000;
  MAX_BLOCKS_PER_LOG_QUERY = 1000;

  constructor({
    config,
    db,
    logger,
    opts,
    signal,
  }: {
    config: IBeaconConfig;
    db: IBeaconDb;
    logger: ILogger;
    opts: IEth1Options;
    signal: AbortSignal;
  }) {
    this.config = config;
    this.db = db;
    this.signal = signal;
    this.logger = logger;
    this.opts = opts;
    this.depositsCache = new Eth1DepositsCache(config, db);
    this.eth1Provider = new Eth1Provider(config, opts);
    this.lastProcessedDepositBlockNumber = null;
    const autoUpdateIntervalMs = config.params.SECONDS_PER_ETH1_BLOCK / 2;

    setIntervalAbortableAsync(
      () =>
        this.update().catch((e) => {
          this.logger.error("Error updating eth1 chain cache", e);
        }),
      autoUpdateIntervalMs,
      signal
    ).catch((e) => {
      this.logger.error("Aborted", e);
    });
  }

  /**
   * Return eth1Data and deposits ready for blockProduction for a given state
   */
  async getEth1DataAndDeposits(
    state: TreeBacked<BeaconState>
  ): Promise<{
    eth1Data: Eth1Data;
    deposits: Deposit[];
  }> {
    const eth1Data = await this.getEth1Data(state);
    const deposits = await this.getDeposits(state, eth1Data);
    return {eth1Data, deposits};
  }

  /**
   * Returns an eth1Data vote for a given state
   * Requires `blocksCache` and `depositsCache` to be updated regularly to return good results
   */
  private async getEth1Data(state: TreeBacked<BeaconState>): Promise<Eth1Data> {
    const periodStart = votingPeriodStartTime(this.config, state);
    const {SECONDS_PER_ETH1_BLOCK, ETH1_FOLLOW_DISTANCE} = this.config.params;

    const eth1VotesToConsider = (
      await this.db.eth1Data.values({
        gte: periodStart - SECONDS_PER_ETH1_BLOCK * ETH1_FOLLOW_DISTANCE,
        lte: periodStart - SECONDS_PER_ETH1_BLOCK * ETH1_FOLLOW_DISTANCE * 2,
      })
    ).filter((eth1Data) => eth1Data.depositCount >= state.eth1Data.depositCount);

    return pickEth1Vote(this.config, state, eth1VotesToConsider);
  }

  /**
   * Returns deposits to be included for a given state and eth1Data vote
   * Requires `blocksCache` and `depositsCache` to be updated regularly to return good results
   */
  private async getDeposits(state: TreeBacked<BeaconState>, eth1DataVote: Eth1Data): Promise<Deposit[]> {
    const depositIndex = state.eth1DepositIndex;
    // Eth1 data may change due to the vote included in this block
    const {depositCount} = getNewEth1Data(this.config, state, eth1DataVote) || state.eth1Data;

    if (depositIndex > depositCount) {
      throw Error("DepositIndexTooHigh");
    } else if (depositIndex === depositCount) {
      return [];
    } else {
      return this.depositsCache.getDeposits({
        indexRange: {gt: depositIndex, lt: Math.min(depositCount, depositIndex + this.config.params.MAX_DEPOSITS)},
        depositCount,
      });
    }
  }

  /**
   * Update the deposit and block cache, returning an error if either fail.
   */
  private async update(): Promise<void> {
    const remoteHighestBlock = await this.eth1Provider.getBlockNumber();
    const remoteFollowBlock = Math.max(0, remoteHighestBlock - this.config.params.ETH1_FOLLOW_DISTANCE);
    await this.updateDepositCache(remoteFollowBlock);
    await this.updateBlockCache(remoteFollowBlock);
  }

  /**
   * Fetch deposit events from remote eth1 node up to follow-distance block
   */
  private async updateDepositCache(remoteFollowBlock: number): Promise<void> {
    const lastProcessedDepositBlockNumber = await this.getLastProcessedDepositBlockNumber();
    const fromBlock = this.getFromBlockToFetch(lastProcessedDepositBlockNumber);
    const toBlock = Math.min(remoteFollowBlock, fromBlock + this.MAX_BLOCKS_PER_LOG_QUERY);

    const depositEvents = await this.eth1Provider.getDepositEvents(fromBlock, toBlock);
    await this.depositsCache.insertBatch(depositEvents);
    // Store the `toBlock` since that block may not contain
    this.lastProcessedDepositBlockNumber = toBlock;
  }

  /**
   * Fetch block headers from a remote eth1 node up to follow-distance block
   *
   * depositRoot and depositCount is inferred from already fetched deposits.
   * Calling get_deposit_root() and the smart contract for a non-latest block requires an
   * archive node, something most users don't have access too.
   */
  private async updateBlockCache(remoteFollowBlock: number): Promise<void> {
    const highestEth1Data = await this.db.eth1Data.lastValue();
    const lastCachedBlock = highestEth1Data && highestEth1Data.blockNumber;
    const fromBlock = this.getFromBlockToFetch(lastCachedBlock);
    const lastProcessedDepositBlockNumber = await this.getLastProcessedDepositBlockNumber();
    const toBlock = Math.min(
      remoteFollowBlock,
      fromBlock + this.MAX_BLOCKS_PER_BLOCK_QUERY,
      lastProcessedDepositBlockNumber || 0 // Do not fetch any blocks if no deposits have been fetched yet
    );

    const eth1Blocks = await fetchBlockRange(this.opts.providerUrl, fromBlock, toBlock, this.signal);
    const eth1Datas = await this.depositsCache.appendEth1DataDeposit(eth1Blocks, this.lastProcessedDepositBlockNumber);
    await this.db.eth1Data.batchPutValues(eth1Datas);
  }

  private getFromBlockToFetch(lastCachedBlock: number | null): number {
    return Math.max(lastCachedBlock ? lastCachedBlock + 1 : 0, this.opts.depositContractDeployBlock || 0);
  }

  private async getLastProcessedDepositBlockNumber(): Promise<number | null> {
    if (!this.lastProcessedDepositBlockNumber) {
      this.lastProcessedDepositBlockNumber = await this.depositsCache.geHighestDepositEventBlockNumber();
    }
    return this.lastProcessedDepositBlockNumber;
  }
}
