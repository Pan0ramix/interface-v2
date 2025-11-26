import { Token } from '@uniswap/sdk';
import { CurrencyAmount, Token as V3Token } from '@uniswap/sdk-core';
import { useMemo } from 'react';
import { useTokenContract } from './useContract';
import { useLastTransactionHash } from 'state/transactions/hooks';
import { useQuery } from '@tanstack/react-query';
import { TokenAmount } from '@uniswap/sdk';

function useTokenAllowanceData(
  tokenAddress?: string,
  owner?: string,
  spender?: string,
) {
  const contract = useTokenContract(tokenAddress, false);

  return useQuery(
    ['token-allowance', tokenAddress, owner, spender],
    async () => {
      if (!contract || !spender || !owner) return null;

      const startTime = performance.now();
      console.log('🔐 [ALLOWANCE] Fetching allowance', {
        timestamp: new Date().toISOString(),
        tokenAddress,
        owner,
        spender,
      });

      try {
        // Add timeout to prevent hanging
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Allowance fetch timed out after 10s')),
            10000,
          ),
        );

        const allowancePromise = contract.allowance(owner, spender);

        const res = await Promise.race([allowancePromise, timeoutPromise]);
        const duration = performance.now() - startTime;

        console.log('✅ [ALLOWANCE] Allowance fetched', {
          timestamp: new Date().toISOString(),
          tokenAddress,
          owner,
          spender,
          allowance: res.toString(),
          duration: `${duration.toFixed(2)}ms`,
        });

        return res;
      } catch (error) {
        const duration = performance.now() - startTime;
        console.error('❌ [ALLOWANCE] Failed to fetch allowance', {
          timestamp: new Date().toISOString(),
          tokenAddress,
          owner,
          spender,
          error: error?.message || error,
          duration: `${duration.toFixed(2)}ms`,
        });
        throw error;
      }
    },
    {
      enabled: !!(contract && spender && owner), // Only run if we have all required params
      staleTime: 5000, // Consider data fresh for 5 seconds (allows caching)
      cacheTime: 30000, // Keep in cache for 30 seconds (v4 uses cacheTime, not gcTime)
      retry: 1, // Retry only once on failure (faster)
      retryDelay: 500, // Wait 500ms between retries (faster)
    },
  );
}

export function useTokenAllowance(
  token?: Token,
  owner?: string,
  spender?: string,
): TokenAmount | undefined {
  const { data: allowance } = useTokenAllowanceData(
    token?.address,
    owner,
    spender,
  );

  return useMemo(
    () =>
      token && allowance
        ? new TokenAmount(token, allowance.toString())
        : undefined,
    [token, allowance],
  );
}

export function useV3TokenAllowance(
  token?: V3Token,
  owner?: string,
  spender?: string,
): CurrencyAmount<V3Token> | undefined {
  const { data: allowance, isLoading, error } = useTokenAllowanceData(
    token?.address,
    owner,
    spender,
  );

  // Log errors for debugging
  if (error && process.env.NODE_ENV === 'development') {
    console.debug('🔐 [ALLOWANCE] Error fetching allowance', {
      token: token?.symbol,
      tokenAddress: token?.address,
      owner,
      spender,
      error,
    });
  }

  return useMemo(
    () =>
      token && allowance
        ? CurrencyAmount.fromRawAmount(token, allowance.toString())
        : undefined,
    [token, allowance],
  );
}
