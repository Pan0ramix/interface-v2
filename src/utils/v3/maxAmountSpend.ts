import { ChainId } from '@uniswap/sdk';
import { Currency, CurrencyAmount } from '@uniswap/sdk-core';
import { MIN_NATIVE_CURRENCY_FOR_GAS } from 'constants/index';
import JSBI from 'jsbi';

/**
 * Given some token amount, return the max that can be spent of it
 * @param currencyAmount to return max of
 */
export function maxAmountSpend(
  currencyAmount?: CurrencyAmount<Currency>,
): CurrencyAmount<Currency> | undefined {
  if (!currencyAmount) return undefined;
  if (currencyAmount.currency.isNative) {
    const minGas = MIN_NATIVE_CURRENCY_FOR_GAS[currencyAmount.currency.chainId];
    if (!minGas) {
      // If MIN_NATIVE_CURRENCY_FOR_GAS is not defined for this chain, return the full amount
      return currencyAmount;
    }
    if (JSBI.greaterThan(currencyAmount.quotient, minGas)) {
      return CurrencyAmount.fromRawAmount(
        currencyAmount.currency,
        JSBI.subtract(currencyAmount.quotient, minGas),
      );
    } else {
      return CurrencyAmount.fromRawAmount(
        currencyAmount.currency,
        JSBI.BigInt(0),
      );
    }
  }
  return currencyAmount;
}

export function halfAmountSpend(
  currencyAmount?: CurrencyAmount<Currency>,
): CurrencyAmount<Currency> | undefined {
  if (!currencyAmount) return undefined;
  const halfAmount = currencyAmount.divide('2');
  if (currencyAmount.currency.isNative) {
    const minGas = MIN_NATIVE_CURRENCY_FOR_GAS[currencyAmount.currency.chainId];
    if (!minGas) {
      // If MIN_NATIVE_CURRENCY_FOR_GAS is not defined for this chain, return the half amount
      return halfAmount;
    }
    if (JSBI.greaterThan(halfAmount.quotient, minGas)) {
      return halfAmount;
    } else {
      return CurrencyAmount.fromRawAmount(
        currencyAmount.currency,
        JSBI.BigInt(0),
      );
    }
  }
  return halfAmount;
}
