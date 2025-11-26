import { Currency, CurrencyAmount, TradeType } from '@uniswap/sdk-core';

import { BigNumber } from 'ethers';
import { useMemo, useRef, useEffect } from 'react';
import { useAllV3Routes } from './useAllV3Routes';
import { useSingleContractMultipleData } from 'state/multicall/v3/hooks';
import { useActiveWeb3React } from 'hooks';
import { useUniV3Quoter, useV3Quoter, useV4Quoter } from 'hooks/useContract';
import { Route } from 'v3lib/entities/route';
import { Trade } from 'lib/src/trade';
import { encodeRouteToPath } from 'v3lib/utils/encodeRouteToPath';
import { ChainId } from '@uniswap/sdk';

export enum V3TradeState {
  LOADING,
  INVALID,
  NO_ROUTE_FOUND,
  VALID,
  SYNCING,
}

const QUOTE_GAS_OVERRIDES: { [chainId: number]: number } = {
  [ChainId.ZKEVM]: 20_000_000,
  [ChainId.MANTA]: 20_000_000,
};

const DEFAULT_GAS_QUOTE = 2_000_000;

/**
 * Returns the best v3 trade for a desired exact input swap
 * @param amountIn the amount to swap in
 * @param currencyOut the desired output currency
 */
export function useBestV3TradeExactIn(
  amountIn?: CurrencyAmount<Currency>,
  currencyOut?: Currency,
  isV4?: boolean,
): {
  state: V3TradeState;
  trade: Trade<Currency, Currency, TradeType.EXACT_INPUT> | null;
} {
  const { chainId } = useActiveWeb3React();
  const quoterV3 = useV3Quoter();
  const quoterV4 = useV4Quoter();
  const uniQuoter = useUniV3Quoter();

  const quoter = isV4 ? quoterV4 : quoterV3;
  const {
    routes: algebraRoutes,
    loading: algebraRoutesLoading,
  } = useAllV3Routes(amountIn?.currency, currencyOut, false, isV4);

  const { routes: uniRoutes, loading: uniRoutesLoading } = useAllV3Routes(
    amountIn?.currency,
    currencyOut,
    true,
  );
  const routes = isV4 ? algebraRoutes : algebraRoutes.concat(uniRoutes);

  const algebraQuoteExactInInputs = useMemo(() => {
    return algebraRoutes.map((route) => [
      encodeRouteToPath(route, false, false, isV4),
      amountIn ? `0x${amountIn.quotient.toString(16)}` : undefined,
    ]);
  }, [amountIn, algebraRoutes, isV4]);

  const uniQuoteExactInInputs = useMemo(() => {
    return uniRoutes.map((route) => [
      encodeRouteToPath(route, false, true),
      amountIn ? `0x${amountIn.quotient.toString(16)}` : undefined,
    ]);
  }, [amountIn, uniRoutes]);

  const routesLoading = algebraRoutesLoading || uniRoutesLoading;

  // Skip algebra quoter if contract is not available
  const skipAlgebraQuoter = !quoter;
  const algebraQuotesResults = useSingleContractMultipleData(
    skipAlgebraQuoter ? null : quoter,
    'quoteExactInput',
    skipAlgebraQuoter ? [] : algebraQuoteExactInInputs,
    {
      gasRequired: chainId
        ? QUOTE_GAS_OVERRIDES[chainId] ?? DEFAULT_GAS_QUOTE
        : undefined,
    },
  );

  // Re-enable UniV3 quoter on Base Sepolia now that ABI is fixed
  // QuoterV2 returns 4 values, but we only need amountOut (first value)
  const skipUniQuoter = (chainId as number) === 84532 && !uniQuoter;
  const uniQuotesResults = useSingleContractMultipleData(
    skipUniQuoter ? null : uniQuoter,
    'quoteExactInput',
    skipUniQuoter ? [] : uniQuoteExactInInputs,
    {
      gasRequired: chainId
        ? QUOTE_GAS_OVERRIDES[chainId] ?? DEFAULT_GAS_QUOTE
        : undefined,
    },
  );

  const quotesResults = isV4
    ? algebraQuotesResults
    : algebraQuotesResults.concat(uniQuotesResults);

  const trade = useMemo(() => {
    if (!amountIn || !currencyOut) {
      return {
        state: V3TradeState.INVALID,
        trade: null,
      };
    }

    // Check if routes or quotes are still loading
    const isLoading =
      routesLoading || quotesResults.some(({ loading }) => loading);
    // Check if we have any valid results (even if some are still loading)
    const hasValidResults = quotesResults.some(
      ({ result, valid }) => result && valid,
    );
    // Check if all quotes have failed or are invalid
    const allQuotesFailed =
      quotesResults.length > 0 &&
      quotesResults.every(
        ({ result, valid, error }) => !result && (!valid || !!error),
      );

    // If all quotes failed, mark as no route found
    if (allQuotesFailed) {
      return {
        state: V3TradeState.NO_ROUTE_FOUND,
        trade: null,
      };
    }

    // If loading and no valid results yet, return loading state
    if (isLoading && !hasValidResults) {
      return {
        state: V3TradeState.LOADING,
        trade: null,
      };
    }

    const { bestRoute, amountOut } = quotesResults.reduce(
      (
        currentBest: {
          bestRoute: Route<Currency, Currency> | null;
          amountOut: BigNumber | null;
        },
        { result },
        i,
      ) => {
        if (!result) return currentBest;

        if (currentBest.amountOut === null) {
          return {
            bestRoute: routes[i],
            amountOut: result.amountOut,
          };
        } else if (currentBest.amountOut.lt(result.amountOut)) {
          return {
            bestRoute: routes[i],
            amountOut: result.amountOut,
          };
        }

        return currentBest;
      },
      {
        bestRoute: null,
        amountOut: null,
      },
    );

    if (!bestRoute || !amountOut) {
      return {
        state: V3TradeState.NO_ROUTE_FOUND,
        trade: null,
      };
    }

    const isSyncing = quotesResults.some(({ syncing }) => syncing);

    return {
      state: isSyncing ? V3TradeState.SYNCING : V3TradeState.VALID,
      trade: Trade.createUncheckedTrade({
        route: bestRoute,
        tradeType: TradeType.EXACT_INPUT,
        inputAmount: amountIn,
        outputAmount: CurrencyAmount.fromRawAmount(
          currencyOut,
          amountOut.toString(),
        ),
      }),
    };
  }, [amountIn, currencyOut, quotesResults, routes, routesLoading]);

  return useMemo(() => {
    return trade;
  }, [trade]);
}

/**
 * Returns the best v3 trade for a desired exact output swap
 * @param currencyIn the desired input currency
 * @param amountOut the amount to swap out
 */
export function useBestV3TradeExactOut(
  currencyIn?: Currency,
  amountOut?: CurrencyAmount<Currency>,
  isV4?: boolean,
): {
  state: V3TradeState;
  trade: Trade<Currency, Currency, TradeType.EXACT_OUTPUT> | null;
} {
  const { chainId } = useActiveWeb3React();
  const quoterV3 = useV3Quoter();
  const quoterV4 = useV4Quoter();
  const quoter = isV4 ? quoterV4 : quoterV3;
  const univ3Quoter = useUniV3Quoter();

  // Early return if inputs are invalid - prevents unnecessary hook calls
  const hasValidInputs = useMemo(() => {
    return !!(currencyIn && amountOut && amountOut.currency);
  }, [currencyIn, amountOut]);

  // Create stable identifiers to prevent unnecessary recalculations
  const currencyInId = useMemo(() => {
    if (!currencyIn) return undefined;
    return `${currencyIn.chainId}-${currencyIn.wrapped.address}`;
  }, [currencyIn]);

  const currencyOutId = useMemo(() => {
    if (!amountOut?.currency) return undefined;
    return `${amountOut.currency.chainId}-${amountOut.currency.wrapped.address}`;
  }, [amountOut?.currency]);

  const amountOutValue = useMemo(() => {
    return amountOut?.quotient.toString();
  }, [amountOut?.quotient]);

  const tradeStartTimeRef = useRef<number | null>(null);
  const quotesStartTimeRef = useRef<number | null>(null);
  const prevCurrencyInIdRef = useRef<string | undefined>(currencyInId);
  const prevCurrencyOutIdRef = useRef<string | undefined>(currencyOutId);
  const prevAmountOutValueRef = useRef<string | undefined>(amountOutValue);

  // Track when trade calculation starts - only when inputs actually change
  useEffect(() => {
    if (
      hasValidInputs &&
      (currencyInId !== prevCurrencyInIdRef.current ||
        currencyOutId !== prevCurrencyOutIdRef.current ||
        amountOutValue !== prevAmountOutValueRef.current)
    ) {
      // Reset quote start time when trade calculation restarts
      quotesStartTimeRef.current = null;
      tradeStartTimeRef.current = performance.now();
      console.log('🔍 [PRICE] Trade calculation started (ExactOut)', {
        timestamp: new Date().toISOString(),
        currencyIn: currencyIn?.symbol,
        currencyOut: amountOut?.currency?.symbol,
        amountOut: amountOut?.toSignificant(4),
        isV4,
        chainId,
      });
    }
    prevCurrencyInIdRef.current = currencyInId;
    prevCurrencyOutIdRef.current = currencyOutId;
    prevAmountOutValueRef.current = amountOutValue;
  }, [
    hasValidInputs,
    currencyInId,
    currencyOutId,
    amountOutValue,
    isV4,
    chainId,
    currencyIn,
    amountOut,
  ]);

  // Only fetch routes if we have valid inputs
  const routeFindingStartTime = useRef<number | null>(null);
  const {
    routes: algebraRoutes,
    loading: algebraRoutesLoading,
  } = useAllV3Routes(
    hasValidInputs ? currencyIn : undefined,
    hasValidInputs ? amountOut?.currency : undefined,
    false,
    isV4,
  );

  const { routes: uniRoutes, loading: uniRoutesLoading } = useAllV3Routes(
    hasValidInputs ? currencyIn : undefined,
    hasValidInputs ? amountOut?.currency : undefined,
    true,
  );

  // Log route finding completion
  useEffect(() => {
    // Only log if we have valid currencies
    if (!hasValidInputs) return;

    if (
      routeFindingStartTime.current === null &&
      (algebraRoutesLoading || uniRoutesLoading)
    ) {
      routeFindingStartTime.current = performance.now();
      console.log('🛣️ [PRICE] Route finding started (ExactOut)', {
        timestamp: new Date().toISOString(),
        currencyIn: currencyIn?.symbol,
        currencyOut: amountOut?.currency?.symbol,
        isV4,
      });
    } else if (
      routeFindingStartTime.current !== null &&
      !algebraRoutesLoading &&
      !uniRoutesLoading
    ) {
      const routeFindingDuration =
        performance.now() - routeFindingStartTime.current;
      console.log('🛣️ [PRICE] Route finding completed (ExactOut)', {
        timestamp: new Date().toISOString(),
        duration: `${routeFindingDuration.toFixed(2)}ms`,
        algebraRoutesCount: algebraRoutes.length,
        uniRoutesCount: uniRoutes.length,
        totalRoutes: algebraRoutes.length + uniRoutes.length,
        isV4,
      });
      routeFindingStartTime.current = null;
    }
  }, [
    algebraRoutesLoading,
    uniRoutesLoading,
    algebraRoutes.length,
    uniRoutes.length,
    currencyInId,
    currencyOutId,
    isV4,
    hasValidInputs,
  ]);

  const routesLoading = algebraRoutesLoading || uniRoutesLoading;
  const routes = isV4 ? algebraRoutes : algebraRoutes.concat(uniRoutes);

  // Only prepare quote inputs if we have valid inputs and routes
  const algebraQuoteExactOutInputs = useMemo(() => {
    if (!hasValidInputs || !amountOut) return [];
    return algebraRoutes.map((route) => [
      encodeRouteToPath(route, true, false, isV4),
      `0x${amountOut.quotient.toString(16)}`,
    ]);
  }, [hasValidInputs, amountOut, algebraRoutes, isV4]);

  const uniQuoteExactOutInputs = useMemo(() => {
    if (!hasValidInputs || !amountOut) return [];
    return uniRoutes.map((route) => [
      encodeRouteToPath(route, true, true),
      `0x${amountOut.quotient.toString(16)}`,
    ]);
  }, [hasValidInputs, amountOut, uniRoutes]);

  // Skip algebra quoter if contract is not available
  const skipAlgebraQuoter = !quoter;

  useEffect(() => {
    if (
      hasValidInputs &&
      !skipAlgebraQuoter &&
      algebraQuoteExactOutInputs.length > 0 &&
      quotesStartTimeRef.current === null
    ) {
      quotesStartTimeRef.current = performance.now();
      console.log('⏳ [PRICE] Starting quote calls (ExactOut)', {
        timestamp: new Date().toISOString(),
        algebraQuotesCount: algebraQuoteExactOutInputs.length,
        uniQuotesCount: uniQuoteExactOutInputs.length,
        isV4,
        currencyIn: currencyIn?.symbol,
        currencyOut: amountOut?.currency?.symbol,
      });
    }
  }, [
    hasValidInputs,
    skipAlgebraQuoter,
    algebraQuoteExactOutInputs.length,
    uniQuoteExactOutInputs.length,
    isV4,
    currencyIn,
    amountOut,
  ]);

  const algebraQuotesResults = useSingleContractMultipleData(
    skipAlgebraQuoter ? null : quoter,
    'quoteExactOutput',
    skipAlgebraQuoter ? [] : algebraQuoteExactOutInputs,
    {
      gasRequired: chainId
        ? QUOTE_GAS_OVERRIDES[chainId] ?? DEFAULT_GAS_QUOTE
        : undefined,
    },
  );

  // Re-enable UniV3 quoter on Base Sepolia now that ABI is fixed
  // QuoterV2 returns 4 values, but we only need amountIn (first value)
  const skipUniQuoter = (chainId as number) === 84532 && !univ3Quoter;
  const uniQuotesResults = useSingleContractMultipleData(
    skipUniQuoter ? null : univ3Quoter,
    'quoteExactOutput',
    skipUniQuoter ? [] : uniQuoteExactOutInputs,
    {
      gasRequired: chainId
        ? QUOTE_GAS_OVERRIDES[chainId] ?? DEFAULT_GAS_QUOTE
        : undefined,
    },
  );

  const quotesResults = isV4
    ? algebraQuotesResults
    : algebraQuotesResults.concat(uniQuotesResults);

  // Log quote results status and detect timeouts
  useEffect(() => {
    if (quotesStartTimeRef.current !== null) {
      const loadingCount = quotesResults.filter((r) => r.loading).length;
      const validCount = quotesResults.filter((r) => r.valid && r.result)
        .length;
      const errorCount = quotesResults.filter((r) => r.error).length;
      const invalidCount = quotesResults.filter((r) => !r.valid).length;
      const elapsed = performance.now() - quotesStartTimeRef.current;

      // Timeout after 15 seconds - quotes should not take this long
      const QUOTE_TIMEOUT_MS = 15000;
      const hasTimedOut = elapsed > QUOTE_TIMEOUT_MS;

      if (loadingCount === 0 && quotesResults.length > 0) {
        const quotesDuration = performance.now() - quotesStartTimeRef.current;
        console.log('✅ [PRICE] Quote calls completed (ExactOut)', {
          timestamp: new Date().toISOString(),
          duration: `${quotesDuration.toFixed(2)}ms`,
          totalQuotes: quotesResults.length,
          validQuotes: validCount,
          errorQuotes: errorCount,
          invalidQuotes: invalidCount,
          isV4,
        });
        quotesStartTimeRef.current = null;
      } else if (hasTimedOut && loadingCount > 0) {
        // Quote calls have timed out - log warning
        console.warn('⏰ [PRICE] Quote calls timed out (ExactOut)', {
          timestamp: new Date().toISOString(),
          elapsed: `${elapsed.toFixed(2)}ms`,
          timeout: `${QUOTE_TIMEOUT_MS}ms`,
          loadingCount,
          validCount,
          errorCount,
          invalidCount,
          totalQuotes: quotesResults.length,
          isV4,
        });
        quotesStartTimeRef.current = null; // Reset to prevent repeated warnings
      } else if (quotesResults.length > 0 && loadingCount > 0) {
        // Log progress if taking longer than expected
        if (elapsed > 3000) {
          // Log every 3 seconds if still loading
          console.warn(
            '⏳ [PRICE] Quote calls taking longer than expected (ExactOut)',
            {
              timestamp: new Date().toISOString(),
              elapsed: `${elapsed.toFixed(2)}ms`,
              loadingCount,
              validCount,
              errorCount,
              invalidCount,
              totalQuotes: quotesResults.length,
              isV4,
            },
          );
        }
      }
    }
  }, [quotesResults, isV4]);

  const trade = useMemo(() => {
    if (
      !amountOut ||
      !currencyIn ||
      quotesResults.some(({ valid }) => !valid)
    ) {
      return {
        state: V3TradeState.INVALID,
        trade: null,
      };
    }

    // Check if routes or quotes are still loading
    const isLoading =
      routesLoading || quotesResults.some(({ loading }) => loading);
    // Check if we have any valid results (even if some are still loading)
    const hasValidResults = quotesResults.some(
      ({ result, valid }) => result && valid,
    );
    // Check if all quotes have failed or are invalid
    const allQuotesFailed =
      quotesResults.length > 0 &&
      quotesResults.every(
        ({ result, valid, error }) => !result && (!valid || !!error),
      );

    // Check for timeout - if quotes have been loading for too long, consider them failed
    const quotesTimedOut =
      quotesStartTimeRef.current !== null &&
      performance.now() - quotesStartTimeRef.current > 15000; // 15 second timeout

    // If all quotes failed or timed out, mark as no route found
    if (allQuotesFailed || (quotesTimedOut && !hasValidResults)) {
      if (quotesTimedOut && !hasValidResults) {
        console.warn(
          '⏰ [PRICE] Quotes timed out, marking as no route found (ExactOut)',
          {
            timestamp: new Date().toISOString(),
            totalQuotes: quotesResults.length,
            isV4,
          },
        );
      }
      return {
        state: V3TradeState.NO_ROUTE_FOUND,
        trade: null,
      };
    }

    // If loading and no valid results yet, return loading state (but not indefinitely)
    if (isLoading && !hasValidResults && !quotesTimedOut) {
      return {
        state: V3TradeState.LOADING,
        trade: null,
      };
    }

    const { bestRoute, amountIn } = quotesResults.reduce(
      (
        currentBest: {
          bestRoute: Route<Currency, Currency> | null;
          amountIn: BigNumber | null;
        },
        { result },
        i,
      ) => {
        if (!result) return currentBest;

        if (currentBest.amountIn === null) {
          return {
            bestRoute: routes[i],
            amountIn: result.amountIn,
          };
        } else if (currentBest.amountIn.gt(result.amountIn)) {
          return {
            bestRoute: routes[i],
            amountIn: result.amountIn,
          };
        }

        return currentBest;
      },
      {
        bestRoute: null,
        amountIn: null,
      },
    );

    if (!bestRoute || !amountIn) {
      return {
        state: V3TradeState.NO_ROUTE_FOUND,
        trade: null,
      };
    }

    const isSyncing = quotesResults.some(({ syncing }) => syncing);

    const result = {
      state: isSyncing ? V3TradeState.SYNCING : V3TradeState.VALID,
      trade: Trade.createUncheckedTrade({
        route: bestRoute,
        tradeType: TradeType.EXACT_OUTPUT,
        inputAmount: CurrencyAmount.fromRawAmount(
          currencyIn,
          amountIn.toString(),
        ),
        outputAmount: amountOut,
      }),
    };

    // Log trade calculation completion
    if (tradeStartTimeRef.current !== null && result.trade) {
      const tradeDuration = performance.now() - tradeStartTimeRef.current;
      console.log('✅ [PRICE] Trade calculation completed (ExactOut)', {
        timestamp: new Date().toISOString(),
        duration: `${tradeDuration.toFixed(2)}ms`,
        state: result.state,
        inputAmount: result.trade.inputAmount.toSignificant(4),
        outputAmount: result.trade.outputAmount.toSignificant(4),
        isV4,
      });
      tradeStartTimeRef.current = null;
    }

    return result;
  }, [
    amountOut,
    currencyIn,
    quotesResults,
    routes,
    routesLoading,
    isV4,
    hasValidInputs,
  ]);

  return useMemo(() => {
    return trade;
  }, [trade]);
}
