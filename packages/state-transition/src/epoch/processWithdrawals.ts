import {MAX_EFFECTIVE_BALANCE, MAX_PARTIAL_WITHDRAWALS_PER_EPOCH} from "@lodestar/params";
import {ValidatorIndex, ssz} from "@lodestar/types";

import {CachedBeaconStateCapella} from "../types.js";
import {decreaseBalance} from "../util/index.js";

function withdrawBalance(state: CachedBeaconStateCapella, validatorIndex: ValidatorIndex, amount: number): void {
  const validator = state.validators.get(validatorIndex);
  decreaseBalance(state, validatorIndex, amount);
  const withdrawal = ssz.capella.Withdrawal.toViewDU({
    index: state.nextWithdrawalIndex,
    validatorIndex,
    address: validator.withdrawalCredentials.slice(12, 32),
    amount: BigInt(amount),
  });
  state.withdrawalQueue.push(withdrawal);
  state.nextWithdrawalIndex++;
}

export function processFullWithdrawals(state: CachedBeaconStateCapella): void {
  const currentEpoch = state.epochCtx.epoch + 1;
  const {validators} = state;
  for (let index = 0; index < validators.length; index++) {
    const validator = validators.get(index);
    const balance = state.balances.get(index);
    // withdrawalCredentials first byte is 0x01
    if (validator.withdrawalCredentials[0] === 1 && validator.withdrawableEpoch <= currentEpoch && balance > 0) {
      //withdraw_balance
      withdrawBalance(state, index, balance);
    }
  }
}

export function processPartialWithdrawals(state: CachedBeaconStateCapella): void {
  const {validators} = state;
  let partialWithdrawalsCount = 0;
  let validatorIndex = state.nextPartialWithdrawalValidatorIndex;
  for (let i = 0; i < validators.length; i++) {
    const balance = state.balances.get(validatorIndex);
    const validator = state.validators.get(validatorIndex);
    const effectiveBalance = validator.effectiveBalance;
    const excessBalance = balance - MAX_EFFECTIVE_BALANCE;
    if (validator.withdrawalCredentials[0] === 1 && effectiveBalance === MAX_EFFECTIVE_BALANCE && excessBalance > 0) {
      withdrawBalance(state, validatorIndex, excessBalance);
      partialWithdrawalsCount++;
    }
    validatorIndex = (validatorIndex + 1) % validators.length;
    if (partialWithdrawalsCount >= MAX_PARTIAL_WITHDRAWALS_PER_EPOCH) {
      break;
    }
  }
  state.nextPartialWithdrawalValidatorIndex = validatorIndex;
}
