import { parseBytes32String } from '@ethersproject/strings';
import { Currency, ETHER, Token, currencyEquals, ChainId } from '@uniswap/sdk';
import { useMemo, useEffect } from 'react';
import { useSelectedTokenList, useInactiveTokenList } from 'state/lists/hooks';
import {
  NEVER_RELOAD,
  useMultipleContractSingleData,
  useSingleCallResult,
} from 'state/multicall/hooks';
import { useUserAddedTokens } from 'state/user/hooks';
import { isAddress } from 'utils';

import { useActiveWeb3React } from 'hooks';
import { useBytes32TokenContract, useTokenContract } from 'hooks/useContract';
import ERC20_INTERFACE, { ERC20_BYTES32_INTERFACE } from 'constants/abis/erc20';
import { GlobalValue } from 'constants/index';

export function useAllTokens(): { [address: string]: Token } {
  const { chainId } = useActiveWeb3React();
  const userAddedTokens = useUserAddedTokens();
  const allTokens = useSelectedTokenList();

  return useMemo(() => {
    if (!chainId) return {};
    return (
      userAddedTokens
        // reduce into all ALL_TOKENS filtered by the current chain
        .reduce<{ [address: string]: Token }>(
          (tokenMap, token) => {
            tokenMap[token.address] = token;
            return tokenMap;
          },
          // must make a copy because reduce modifies the map, and we do not
          // want to make a copy in every iteration
          { ...allTokens[chainId] },
        )
    );
  }, [chainId, userAddedTokens, allTokens]);
}

export function useInActiveTokens(): { [address: string]: Token } {
  const { chainId } = useActiveWeb3React();
  const userAddedTokens = useUserAddedTokens();
  const allInactiveTokens = useInactiveTokenList(chainId);

  return useMemo(() => {
    if (!chainId) return {};
    return (
      userAddedTokens
        // reduce into all ALL_TOKENS filtered by the current chain
        .reduce<{ [address: string]: Token }>(
          (tokenMap, token) => {
            tokenMap[token.address] = token;
            return tokenMap;
          },
          // must make a copy because reduce modifies the map, and we do not
          // want to make a copy in every iteration
          { ...allInactiveTokens[chainId] },
        )
    );
  }, [chainId, userAddedTokens, allInactiveTokens]);
}

// Check if currency is included in custom list from user storage
export function useIsUserAddedToken(currency: Currency): boolean {
  const userAddedTokens = useUserAddedTokens();
  return !!userAddedTokens.find((token) => currencyEquals(currency, token));
}

export function useIsUserAddedTokens(currencies: Currency[]): boolean[] {
  const userAddedTokens = useUserAddedTokens();
  return currencies.map(
    (currency) =>
      !!userAddedTokens.find((token) => currencyEquals(currency, token)),
  );
}

// parse a name or symbol from a token response
const BYTES32_REGEX = /^0x[a-fA-F0-9]{64}$/;
function parseStringOrBytes32(
  str: string | undefined,
  bytes32: string | undefined,
  defaultValue: string,
): string {
  return str && str.length > 0
    ? str
    : bytes32 && BYTES32_REGEX.test(bytes32)
    ? parseBytes32String(bytes32)
    : defaultValue;
}

// undefined if invalid or does not exist
// null if loading
// otherwise returns the token
export function useToken(tokenAddress?: string): Token | undefined | null {
  const { chainId, library } = useActiveWeb3React();
  const tokens = useAllTokens();

  const address = isAddress(tokenAddress);

  const tokenContract = useTokenContract(address ? address : undefined, false);
  const tokenContractBytes32 = useBytes32TokenContract(
    address ? address : undefined,
    false,
  );

  // Debug logging for contract creation
  useEffect(() => {
    if (address && !tokenContract) {
      console.warn('⚠️ [v2] Token contract not created:', {
        address,
        chainId,
        hasLibrary: !!library,
        libraryType: library?.constructor?.name,
      });
    }
  }, [address, tokenContract, chainId, library]);
  const token: Token | undefined = address
    ? Object.values(tokens).find(
        (token) => token.address.toLowerCase() === address.toLowerCase(),
      )
    : undefined;

  const tokenName = useSingleCallResult(
    token ? undefined : tokenContract,
    'name',
    undefined,
    NEVER_RELOAD,
  );
  const tokenNameBytes32 = useSingleCallResult(
    token ? undefined : tokenContractBytes32,
    'name',
    undefined,
    NEVER_RELOAD,
  );
  const symbol = useSingleCallResult(
    token ? undefined : tokenContract,
    'symbol',
    undefined,
    NEVER_RELOAD,
  );
  const symbolBytes32 = useSingleCallResult(
    token ? undefined : tokenContractBytes32,
    'symbol',
    undefined,
    NEVER_RELOAD,
  );
  const decimals = useSingleCallResult(
    token ? undefined : tokenContract,
    'decimals',
    undefined,
    NEVER_RELOAD,
  );

  return useMemo(() => {
    if (token) {
      return token;
    }
    if (!chainId || !address) {
      return undefined;
    }

    // If token contract doesn't exist, return null to keep trying
    // The contract might be created on the next render
    if (!tokenContract) {
      console.log(
        '⏳ [v2] Token contract not created yet for address:',
        address,
        {
          chainId,
          hasLibrary: !!library,
        },
      );
      return null; // Return null instead of undefined to keep trying
    }

    // Check if any calls are still loading
    const isLoading = decimals.loading || symbol.loading || tokenName.loading;

    // Check if any calls have errors
    const hasError = decimals.error || symbol.error || tokenName.error;

    // Check if any calls are invalid (contract might not exist or call failed)
    const hasInvalid = !decimals.valid || !symbol.valid || !tokenName.valid;

    // If we have decimals result, we can create a token (even if name/symbol failed)
    if (decimals.result) {
      const newToken = new Token(
        chainId,
        address,
        decimals.result[0],
        parseStringOrBytes32(
          symbol.result?.[0],
          symbolBytes32.result?.[0],
          'UNKNOWN',
        ),
        parseStringOrBytes32(
          tokenName.result?.[0],
          tokenNameBytes32.result?.[0],
          'Unknown Token',
        ),
      );
      return newToken;
    }

    // If we're still loading, return null to indicate loading state
    if (isLoading) {
      return null;
    }

    // If we have an error but no result, and we're not loading, the token might not exist
    // But we should still return null to show loading state for a bit longer
    // This handles cases where multicall is slow or retrying
    if (hasError && !decimals.result) {
      // Log for debugging
      console.warn('⚠️ [v2] Token fetch error for address:', address, {
        decimals: {
          valid: decimals.valid,
          loading: decimals.loading,
          error: decimals.error,
          result: decimals.result,
        },
        symbol: {
          valid: symbol.valid,
          loading: symbol.loading,
          error: symbol.error,
          result: symbol.result,
        },
        tokenName: {
          valid: tokenName.valid,
          loading: tokenName.loading,
          error: tokenName.error,
          result: tokenName.result,
        },
      });
      // Return null to keep showing loading state, in case it's a transient error
      return null;
    }

    // If calls are invalid (contract might not exist or calls failed), return null to keep trying
    if (hasInvalid && !decimals.result && !isLoading) {
      console.warn('⚠️ [v2] Token calls invalid for address:', address, {
        decimalsValid: decimals.valid,
        symbolValid: symbol.valid,
        tokenNameValid: tokenName.valid,
      });
      // Return null to keep showing loading state, in case multicall is retrying
      return null;
    }

    return undefined;
  }, [
    tokenAddress,
    address,
    chainId,
    library,
    tokenContract,
    tokenContractBytes32,
    decimals.valid,
    decimals.loading,
    decimals.result,
    decimals.error,
    decimals.syncing,
    symbol.valid,
    symbol.loading,
    symbol.result,
    symbol.error,
    symbol.syncing,
    symbolBytes32.result,
    token,
    tokenName.valid,
    tokenName.loading,
    tokenName.result,
    tokenName.error,
    tokenName.syncing,
    tokenNameBytes32.result,
  ]);
}

// Use tokens should be used to simplify getting token data in the future.
// Currently our token lists are dependent on json data.
// 1. We need to fix the lists so the store the raw data and not the tokens
// 2. Once the list is retrieved we should call the use token hooks to obtain the missing tokens
// 3. We then should convert the raw lists to their wrapped forms which store the tokens
// 4. Then we should store the wrapped list in the state.
// 5. Before this all can occur we need to update our lists to operate on addresses instead of Symbols (There already is a PR waiting missing the new farms)
export function useTokens(
  tokenAddresses: string[],
): Token[] | undefined | null {
  const { chainId } = useActiveWeb3React();
  const tokens = useAllTokens();

  const tokenSet = [...new Set(tokenAddresses)];
  const validatedUnknownTokenAddresses = tokenSet
    .filter((x) => isAddress(x))
    .filter((x) => !tokens[x]);

  const tokenNames = useMultipleContractSingleData(
    validatedUnknownTokenAddresses,
    ERC20_INTERFACE,
    'name',
    undefined,
    NEVER_RELOAD,
  );

  const tokenNamesBytes32 = useMultipleContractSingleData(
    validatedUnknownTokenAddresses,
    ERC20_BYTES32_INTERFACE,
    'name',
    undefined,
    NEVER_RELOAD,
  );

  const symbols = useMultipleContractSingleData(
    validatedUnknownTokenAddresses,
    ERC20_INTERFACE,
    'symbol',
    undefined,
    NEVER_RELOAD,
  );

  const symbolsBytes32 = useMultipleContractSingleData(
    validatedUnknownTokenAddresses,
    ERC20_BYTES32_INTERFACE,
    'symbol',
    undefined,
    NEVER_RELOAD,
  );

  const tokenDecimals = useMultipleContractSingleData(
    validatedUnknownTokenAddresses,
    ERC20_INTERFACE,
    'decimals',
    undefined,
    NEVER_RELOAD,
  );

  const anyLoading: boolean = useMemo(
    () =>
      tokenNames.some((callState) => callState.loading) ||
      tokenNamesBytes32.some((callState) => callState.loading) ||
      symbols.some((callState) => callState.loading) ||
      symbolsBytes32.some((callState) => callState.loading) ||
      tokenDecimals.some((callState) => callState.loading),
    [tokenNames, tokenNamesBytes32, symbols, symbolsBytes32, tokenDecimals],
  );

  return useMemo(() => {
    const existingTokens = [...new Set(tokenAddresses)]
      .filter((x) => isAddress(x))
      .map((x) => tokens[x])
      .filter((x) => !!x);
    return validatedUnknownTokenAddresses.reduce<Token[]>(
      (memo, tokenAddress, index) => {
        if (anyLoading || !chainId) {
          return [];
        }

        const decimals = tokenDecimals[index];
        const symbol = symbols[index];
        const symbolBytes32 = symbolsBytes32[index];
        const tokenName = tokenNames[index];
        const tokenNameBytes32 = tokenNamesBytes32[index];

        if (decimals.result) {
          memo.push(
            new Token(
              chainId,
              tokenAddress,
              decimals.result[0],
              parseStringOrBytes32(
                symbol.result?.[0],
                symbolBytes32.result?.[0],
                'UNKNOWN',
              ),
              parseStringOrBytes32(
                tokenName.result?.[0],
                tokenNameBytes32.result?.[0],
                'Unknown Token',
              ),
            ),
          );
        }
        return memo;
      },
      existingTokens,
    );
  }, [
    tokenAddresses,
    validatedUnknownTokenAddresses,
    tokens,
    anyLoading,
    chainId,
    tokenDecimals,
    symbols,
    symbolsBytes32,
    tokenNames,
    tokenNamesBytes32,
  ]);
}

export function useCurrency(
  currencyId: string | undefined,
): Currency | null | undefined {
  const { chainId } = useActiveWeb3React();
  const chainIdToUse = chainId ? chainId : ChainId.MATIC;
  const nativeCurrency = ETHER[chainIdToUse];
  const isETH = currencyId?.toUpperCase() === 'ETH';
  const token = useToken(isETH ? undefined : currencyId);
  return isETH ? nativeCurrency : token;
}

export function useCurrencyFromSymbol(symbol?: string): Currency | undefined {
  const { chainId } = useActiveWeb3React();
  const allTokens = useAllTokens();
  const commonTokens = GlobalValue.tokens.COMMON[chainId];
  if (!symbol) return;
  if (symbol.toLowerCase() === ETHER[chainId].symbol?.toLowerCase())
    return ETHER[chainId];
  const token = Object.values(allTokens).find(
    (token) => token.symbol?.toLowerCase() === symbol.toLowerCase(),
  );
  if (token) return token;
  const tokenInCommon = commonTokens.find(
    (token) => token.symbol?.toLowerCase() === symbol.toLowerCase(),
  );
  return tokenInCommon;
}
