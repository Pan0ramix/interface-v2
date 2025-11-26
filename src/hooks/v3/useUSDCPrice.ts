import { Currency, CurrencyAmount, Price, Token } from '@uniswap/sdk-core';
import { useActiveWeb3React } from 'hooks';
import { useMemo, useRef, useEffect } from 'react';
import { useBestV3TradeExactOut, V3TradeState } from './useBestV3Trade';
import { ChainId } from '@uniswap/sdk';
import { toV3Token, USDC } from 'constants/v3/addresses';

/**
 * Returns the price in USDC of the input currency
 * @param currency currency to compute the USDC price of
 */
export default function useUSDCPrice(
  currency?: Currency,
  allLiquidity?: boolean,
): Price<Currency, Token> | undefined {
  const { chainId } = useActiveWeb3React();
  const chainIdToUse = chainId ? chainId : ChainId.MATIC;

  const USDC_TOKEN = USDC[chainIdToUse];
  const USDC_V3_TOKEN = useMemo(
    () => (USDC_TOKEN ? toV3Token(USDC_TOKEN) : undefined),
    [USDC_TOKEN],
  );

  // On Base Sepolia, use smaller amount for price calculation (faster, less likely to fail)
  // For other chains, use the standard large amount
  const isBaseSepolia = chainId !== undefined && Number(chainId) === 84532;

  const amountOut = useMemo(() => {
    if (!chainId || !USDC_V3_TOKEN) return undefined;
    const amount = allLiquidity
      ? 1
      : isBaseSepolia
      ? 1000e6 // 1000 USDC for Base Sepolia
      : 100_000e1; // 1M for others
    return CurrencyAmount.fromRawAmount(USDC_V3_TOKEN, amount);
  }, [chainId, allLiquidity, isBaseSepolia, USDC_V3_TOKEN]);

  const stablecoin = amountOut?.currency;

  const priceCalcStartTimeRef = useRef<number | null>(null);
  const prevCurrencyRef = useRef<Currency | undefined>(currency);
  const prevAmountOutRef = useRef<CurrencyAmount<Token> | undefined>(amountOut);

  // Create stable currency identifier for comparison and memoization
  const currencyId = useMemo(() => {
    if (!currency) return undefined;
    return `${currency.chainId}-${currency.wrapped.address}`;
  }, [currency]);

  const stablecoinId = useMemo(() => {
    if (!stablecoin) return undefined;
    return `${stablecoin.chainId}-${stablecoin.address}`;
  }, [stablecoin]);

  // Only calculate trade if we have valid inputs and currency is not the stablecoin
  // Use stable IDs to prevent unnecessary recalculations
  const shouldCalculateTrade = useMemo(() => {
    if (
      !currency ||
      !amountOut ||
      !stablecoin ||
      !currencyId ||
      !stablecoinId
    ) {
      return false;
    }
    // Early return if currency equals stablecoin (using ID comparison for speed)
    if (currencyId === stablecoinId) {
      return false;
    }
    // Double-check with equals for safety
    return !currency.wrapped.equals(stablecoin);
  }, [currency, amountOut, stablecoin, currencyId, stablecoinId]);

  // Track when price calculation starts
  useEffect(() => {
    // Log when currency or amountOut changes
    if (
      currency !== prevCurrencyRef.current ||
      amountOut !== prevAmountOutRef.current
    ) {
      if (!currency) {
        console.debug('💰 [PRICE] Currency is undefined', {
          timestamp: new Date().toISOString(),
          chainId,
          hasUSDC: !!USDC_V3_TOKEN,
        });
      } else if (!shouldCalculateTrade && currency && stablecoin) {
        console.debug(
          '💰 [PRICE] Currency equals stablecoin, skipping price calc',
          {
            timestamp: new Date().toISOString(),
            currency: currency?.symbol,
            stablecoin: stablecoin?.symbol,
          },
        );
      } else if (currency && !USDC_V3_TOKEN) {
        console.warn('⚠️ [PRICE] USDC token not available for chain', {
          chainId,
          currency: currency?.symbol,
        });
      } else if (shouldCalculateTrade) {
        priceCalcStartTimeRef.current = performance.now();
        console.log('💰 [PRICE] Price calculation started', {
          timestamp: new Date().toISOString(),
          currency: currency?.symbol,
          currencyAddress: currency?.wrapped?.address,
          chainId,
          amountOut: amountOut?.toSignificant(4),
          isBaseSepolia,
          hasUSDC: !!USDC_V3_TOKEN,
        });
      }
    }
    prevCurrencyRef.current = currency;
    prevAmountOutRef.current = amountOut;
  }, [
    currency,
    amountOut,
    USDC_V3_TOKEN,
    chainId,
    isBaseSepolia,
    shouldCalculateTrade,
    stablecoin,
  ]);

  // Only call trade hooks when we should calculate
  const v3USDCTrade = useBestV3TradeExactOut(
    shouldCalculateTrade ? currency : undefined,
    shouldCalculateTrade ? amountOut : undefined,
  );
  const v4USDCTrade = useBestV3TradeExactOut(
    shouldCalculateTrade ? currency : undefined,
    shouldCalculateTrade ? amountOut : undefined,
    true,
  );

  // Log when price calculation completes
  useEffect(() => {
    if (
      priceCalcStartTimeRef.current &&
      v3USDCTrade.state !== V3TradeState.LOADING &&
      v4USDCTrade.state !== V3TradeState.LOADING
    ) {
      const priceCalcDuration =
        performance.now() - priceCalcStartTimeRef.current;
      const hasPrice = !!v3USDCTrade.trade || !!v4USDCTrade.trade;
      console.log('💰 [PRICE] Price calculation completed', {
        timestamp: new Date().toISOString(),
        duration: `${priceCalcDuration.toFixed(2)}ms`,
        currency: currency?.symbol,
        v3TradeState: v3USDCTrade.state,
        v4TradeState: v4USDCTrade.state,
        hasV3Trade: !!v3USDCTrade.trade,
        hasV4Trade: !!v4USDCTrade.trade,
        hasPrice,
        chainId,
      });
      if (!hasPrice && priceCalcDuration > 5000) {
        console.warn(
          '⚠️ [PRICE] Price calculation took long and returned no price',
          {
            duration: `${priceCalcDuration.toFixed(2)}ms`,
            currency: currency?.symbol,
          },
        );
      }
      priceCalcStartTimeRef.current = null; // Reset after logging
    }
  }, [
    currency,
    v3USDCTrade.state,
    v4USDCTrade.state,
    v3USDCTrade.trade,
    v4USDCTrade.trade,
    chainId,
  ]);

  return useMemo(() => {
    if (!currency || !stablecoin) {
      return undefined;
    }

    // handle usdc
    if (currency?.wrapped.equals(stablecoin)) {
      return new Price(stablecoin, stablecoin, '1', '1');
    }

    if (v3USDCTrade.trade) {
      const { numerator, denominator } = v3USDCTrade.trade.route.midPrice;
      return new Price(currency, stablecoin, denominator, numerator);
    }

    if (v4USDCTrade.trade) {
      const { numerator, denominator } = v4USDCTrade.trade.route.midPrice;
      return new Price(currency, stablecoin, denominator, numerator);
    }

    return undefined;
  }, [currency, stablecoin, v3USDCTrade.trade, v4USDCTrade.trade]);
}

export function useUSDCValue(
  currencyAmount: CurrencyAmount<Currency> | undefined | null,
  allLiquidity = false,
) {
  const price = useUSDCPrice(currencyAmount?.currency, allLiquidity);

  return useMemo(() => {
    if (!price || !currencyAmount) return null;
    try {
      return price.quote(currencyAmount);
    } catch (error) {
      return null;
    }
  }, [currencyAmount, price]);
}
