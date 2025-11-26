import { Currency, CurrencyAmount, Price, Token } from '@uniswap/sdk-core';
import { useActiveWeb3React } from 'hooks';
import { useMemo, useRef, useEffect } from 'react';
import { useBestV3TradeExactIn, V3TradeState } from './useBestV3Trade';
import { ChainId } from '@uniswap/sdk';
import { toV3Token, USDC } from 'constants/v3/addresses';

/**
 * Returns the price in USDC of the input currency
 * @param currency currency to compute the USDC price of
 * @param allLiquidity if true, use minimal amount (1 wei) for price calculation
 * @param customAmountIn optional custom amount of currency to use for price calculation.
 *                       If provided, this will be used instead of the default amount.
 *                       This allows using the actual swap amount for more accurate pricing
 *                       and to detect insufficient liquidity for the user's intended swap.
 */
export default function useUSDCPrice(
  currency?: Currency,
  allLiquidity?: boolean,
  customAmountIn?: CurrencyAmount<Currency>,
): Price<Currency, Token> | undefined {
  const { chainId } = useActiveWeb3React();
  const chainIdToUse = chainId ? chainId : ChainId.MATIC;

  const USDC_TOKEN = USDC[chainIdToUse];
  const USDC_V3_TOKEN = useMemo(
    () => (USDC_TOKEN ? toV3Token(USDC_TOKEN) : undefined),
    [USDC_TOKEN],
  );

  const stablecoin = USDC_V3_TOKEN;

  // Use custom amount if provided (actual swap amount), otherwise use default amounts
  // This allows the swap page to use the actual swap amount for price calculation,
  // which is more accurate and will fail if liquidity is insufficient for the user's swap
  // No special handling for USDC - treat it like any other token
  const amountIn = useMemo(() => {
    if (customAmountIn) {
      // Use the actual swap amount - this is the currency amount the user wants to swap
      return customAmountIn;
    }

    // Default: use a reasonable amount for price calculation
    if (!chainId || !currency || !USDC_V3_TOKEN) return undefined;
    const amount = allLiquidity ? 1 : 100_000e1; // Default: 1M for accurate pricing
    return CurrencyAmount.fromRawAmount(currency, amount);
  }, [chainId, allLiquidity, currency, customAmountIn, USDC_V3_TOKEN]);

  const priceCalcStartTimeRef = useRef<number | null>(null);
  const prevCurrencyRef = useRef<Currency | undefined>(currency);
  const prevAmountInRef = useRef<CurrencyAmount<Currency> | undefined>(
    amountIn,
  );

  // Create stable currency identifier for comparison and memoization
  const currencyId = useMemo(() => {
    if (!currency) return undefined;
    return `${currency.chainId}-${currency.wrapped.address}`;
  }, [currency]);

  const stablecoinId = useMemo(() => {
    if (!stablecoin) return undefined;
    return `${stablecoin.chainId}-${stablecoin.address}`;
  }, [stablecoin]);

  // Only calculate trade if we have valid inputs
  // Special case: If currency IS USDC, we don't need to find a route (it's 1:1)
  const shouldCalculateTrade = useMemo(() => {
    if (!currency || !amountIn || !stablecoin || !currencyId || !stablecoinId) {
      return false;
    }
    // If currency equals stablecoin (USDC), skip trade calculation (it's 1:1)
    if (currencyId === stablecoinId || currency.wrapped.equals(stablecoin)) {
      return false;
    }
    return true;
  }, [currency, amountIn, stablecoin, currencyId, stablecoinId]);

  // Track when price calculation starts
  useEffect(() => {
    // Only log when we actually start calculating (not for undefined currency or stablecoin)
    if (
      currency !== prevCurrencyRef.current ||
      amountIn !== prevAmountInRef.current
    ) {
      // Only log when we have a valid currency and should calculate
      if (shouldCalculateTrade && currency && USDC_V3_TOKEN) {
        priceCalcStartTimeRef.current = performance.now();
        console.log('💰 [PRICE] Price calculation started', {
          timestamp: new Date().toISOString(),
          currency: currency?.symbol,
          currencyAddress: currency?.wrapped?.address,
          chainId,
          amountIn: amountIn?.toSignificant(4),
          isCustomAmount: !!customAmountIn,
        });
      } else if (currency && !USDC_V3_TOKEN) {
        // Only warn if we have a currency but no USDC token (actual issue)
        console.warn('⚠️ [PRICE] USDC token not available for chain', {
          chainId,
          currency: currency?.symbol,
        });
      }
      // Removed debug logs for undefined currency and stablecoin (too verbose)
    }
    prevCurrencyRef.current = currency;
    prevAmountInRef.current = amountIn;
  }, [
    currency,
    amountIn,
    USDC_V3_TOKEN,
    chainId,
    customAmountIn,
    shouldCalculateTrade,
    stablecoin,
  ]);

  // Only call trade hooks when we should calculate
  // Use ExactIn: "If I put in X amount of currency, how much USDC do I get out?"
  const v3USDCTrade = useBestV3TradeExactIn(
    shouldCalculateTrade ? amountIn : undefined,
    shouldCalculateTrade ? stablecoin : undefined,
  );
  const v4USDCTrade = useBestV3TradeExactIn(
    shouldCalculateTrade ? amountIn : undefined,
    shouldCalculateTrade ? stablecoin : undefined,
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

    // Special case: If currency IS USDC, return 1:1 price directly
    // No need to find a trade route for USDC/USDC (which doesn't exist)
    if (currency.wrapped.equals(stablecoin)) {
      return new Price(stablecoin, stablecoin, '1', '1');
    }

    // For other currencies, use the trade route to calculate price
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
  customAmountIn?: CurrencyAmount<Currency>,
) {
  const price = useUSDCPrice(
    currencyAmount?.currency,
    allLiquidity,
    customAmountIn,
  );

  return useMemo(() => {
    if (!price || !currencyAmount) return null;
    try {
      return price.quote(currencyAmount);
    } catch (error) {
      return null;
    }
  }, [currencyAmount, price]);
}
