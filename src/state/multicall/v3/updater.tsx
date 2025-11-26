import React, { useEffect, useMemo, useRef } from 'react';
import { useActiveWeb3React } from 'hooks';
import {
  errorFetchingV3MulticallResults,
  fetchingV3MulticallResults,
  updateV3MulticallResults,
} from './actions';
import { useAppDispatch, useAppSelector } from 'state/hooks';
import { Call, parseCallKey, toCallKey } from './utils';
import { chunkArray } from 'utils/chunkArray';
import { AppState } from 'state';
import useDebounce from 'hooks/useDebounce';
import { useBlockNumber } from 'state/application/hooks';
import { retry, RetryableError } from 'utils/retry';
import {
  useMulticall2Contract,
  useMulticall3Contract,
} from 'hooks/useContract';
import { getConfig } from 'config/index';
import { ethers } from 'ethers';

const DEFAULT_CALL_GAS_REQUIRED = 10_000_000;

const CHUNK_SIZE = 100;

/**
 * Fetches a chunk of calls, enforcing a minimum block number constraint
 * @param multicall2 AlgebraInterfaceMulticall contract (for non-Base chains)
 * @param multicall3 Multicall3 contract (for Base Sepolia)
 * @param chunk chunk of calls to make
 * @param blockNumber block number passed as the block tag in the eth_call
 * @param chainId chain ID to determine which multicall to use
 */
async function fetchChunk(
  multicall2: any,
  multicall3: any,
  chunk: Call[],
  blockNumber: number,
  chainId?: number,
  provider?: any,
): Promise<{ success: boolean; returnData: string }[]> {
  const chunkStartTime = performance.now();
  const isQuoteCall = chunk.some(
    (call) =>
      call.callData?.startsWith('0x414bf389') || // quoteExactInput
      call.callData?.startsWith('0xdb3e2198'), // quoteExactOutput
  );

  if (isQuoteCall && chunk.length > 0) {
    console.log('📞 [MULTICALL] Fetching quote chunk', {
      timestamp: new Date().toISOString(),
      chunkSize: chunk.length,
      chainId,
      blockNumber,
    });
  }

  const config = getConfig(chainId);
  const maxChunks = config['maxChunks'] ?? CHUNK_SIZE;
  // Base Sepolia (84532) is not in ChainId enum, so we check the number value
  const isBaseSepolia = chainId === 84532 || Number(chainId) === 84532;

  // Base Sepolia uses Multicall3, all other chains use AlgebraInterfaceMulticall
  // Verify we're not accidentally using Multicall2 for Base Sepolia
  if (isBaseSepolia && multicall2 && !multicall3) {
    console.error(
      'ERROR: Base Sepolia requires Multicall3 but it is not available. Multicall2 will not work.',
    );
  }

  let finalReturnData: any = [];
  try {
    for (let i = 0; i < chunk.length; i = i + maxChunks) {
      const localChunk = chunk.slice(
        i,
        i + maxChunks > chunk.length ? chunk.length : i + maxChunks,
      );

      if (isBaseSepolia && multicall3) {
        // Multicall3 path: use tryAggregate (no per-call gasLimit, handles failures gracefully)
        // Returns: Result[] where Result = {success: bool, returnData: bytes}
        // Note: tryAggregate with requireSuccess=false never reverts, even if individual calls fail

        // Removed verbose logging

        if (!multicall3) {
          const error = new Error(
            'CRITICAL: multicall3 contract is null/undefined for Base Sepolia!',
          );
          console.error(error.message);
          throw error;
        }

        if (typeof multicall3.callStatic?.tryAggregate !== 'function') {
          const error = new Error(
            'CRITICAL: multicall3.callStatic.tryAggregate is not a function!',
          );
          console.error(error.message, {
            multicall3: multicall3,
            callStatic: multicall3?.callStatic,
            methods: Object.keys(multicall3?.callStatic || {}),
          });
          throw error;
        }

        // Add timeout for quote calls on Base Sepolia to prevent hanging
        const isQuoteChunk = localChunk.some(
          (call) =>
            call.callData?.startsWith('0x414bf389') || // quoteExactInput
            call.callData?.startsWith('0xdb3e2198'), // quoteExactOutput
        );
        const QUOTE_TIMEOUT_MS = 15000; // 15 seconds for quote calls
        const timeout = isQuoteChunk ? QUOTE_TIMEOUT_MS : 30000; // 30 seconds for other calls

        try {
          const resultsRawPromise = multicall3.callStatic.tryAggregate(
            false, // requireSuccess = false (allow individual failures)
            localChunk.map((obj) => ({
              target: obj.address,
              callData: obj.callData,
              // Note: Multicall3 tryAggregate doesn't support per-call gasLimit
            })),
            { blockTag: blockNumber },
          );

          // Add timeout wrapper for quote calls to prevent hanging
          const resultsRaw = isQuoteChunk
            ? await Promise.race([
                resultsRawPromise,
                new Promise<never>((_, reject) =>
                  setTimeout(() => {
                    console.warn('⏰ [MULTICALL] Quote chunk timed out', {
                      timestamp: new Date().toISOString(),
                      timeout: `${timeout}ms`,
                      chunkSize: localChunk.length,
                      chainId,
                    });
                    reject(
                      new Error(`Quote multicall timed out after ${timeout}ms`),
                    );
                  }, timeout),
                ),
              ])
            : await resultsRawPromise;

          // Removed verbose logging

          // Adapt Multicall3 tryAggregate results to match AlgebraInterfaceMulticall format
          // Multicall3 tryAggregate returns {success: bool, returnData: bytes}[]
          // We need {success: bool, gasUsed: uint256, returnData: bytes}[]
          const adaptedResults = resultsRaw.map(
            (r: { success: boolean; returnData: string }, idx: number) => {
              const result = {
                success: r.success,
                gasUsed: { toString: () => '0', gte: () => false }, // Multicall3 doesn't provide gasUsed; we don't need it for reads
                returnData: r.returnData || '0x',
              };

              // Debug failed calls - especially pool calls and quote calls for Base Sepolia
              if (!r.success) {
                const selector = localChunk[idx]?.callData?.slice(0, 10);
                const isPoolCall =
                  selector === '0x3850c7bd' || selector === '0x1a686502'; // globalState/slot0 // liquidity
                const isQuoteCall =
                  selector === '0x414bf389' || // quoteExactInput
                  selector === '0xdb3e2198' || // quoteExactOutput (Algebra)
                  selector === '0x2f80bb1d'; // quoteExactOutput (UniV3)

                // Decode error message if available
                let errorMessage = 'Unknown error';
                if (r.returnData && r.returnData.length > 10) {
                  try {
                    // Check if it's a standard Error(string) revert (selector 0x08c379a0)
                    if (r.returnData.startsWith('0x08c379a0')) {
                      const decoded = ethers.utils.defaultAbiCoder.decode(
                        ['string'],
                        '0x' + r.returnData.slice(10),
                      );
                      errorMessage = decoded[0];
                    } else {
                      errorMessage = `Revert (not Error string): ${r.returnData.slice(
                        0,
                        20,
                      )}...`;
                    }
                  } catch (e) {
                    errorMessage = `Failed to decode error: ${e.message}`;
                  }
                }

                if (
                  isPoolCall ||
                  isQuoteCall ||
                  (chainId !== undefined && Number(chainId) === 84532)
                ) {
                  const methodName =
                    selector === '0x3850c7bd'
                      ? 'globalState/slot0'
                      : selector === '0x1a686502'
                      ? 'liquidity'
                      : selector === '0x414bf389'
                      ? 'quoteExactInput'
                      : selector === '0xdb3e2198'
                      ? 'quoteExactOutput (Algebra)'
                      : selector === '0x2f80bb1d'
                      ? 'quoteExactOutput (UniV3)'
                      : 'unknown';

                  console.warn(
                    isQuoteCall
                      ? '❌ [QUOTER] Quote call failed on Base Sepolia'
                      : 'Pool call failed on Base Sepolia',
                    {
                      index: idx,
                      target: localChunk[idx]?.address,
                      selector: selector,
                      methodName,
                      errorMessage,
                      returnData: r.returnData || '0x',
                      callDataLength: localChunk[idx]?.callData?.length,
                      callDataPreview: localChunk[idx]?.callData?.slice(0, 100),
                    },
                  );
                }
              }

              return result;
            },
          );

          // Removed verbose logging

          finalReturnData = finalReturnData.concat(adaptedResults);
        } catch (tryAggregateError) {
          console.error('Multicall3 tryAggregate call failed', {
            chainId,
            error: tryAggregateError?.message || tryAggregateError,
            errorCode: tryAggregateError?.code,
            callCount: localChunk.length,
            multicallAddress: multicall3?.address,
          });
          // Re-throw to let the error handler below catch it
          throw tryAggregateError;
        }
      } else if (multicall2) {
        // AlgebraInterfaceMulticall path: use multicall (with per-call gasLimit)
        // Returns: (blockNumber, returnData[]) where returnData[] is {success: bool, gasUsed: uint256, returnData: bytes}[]
        const { returnData } = await multicall2.callStatic.multicall(
          localChunk.map((obj) => ({
            target: obj.address,
            callData: obj.callData,
            gasLimit: obj.gasRequired ?? DEFAULT_CALL_GAS_REQUIRED,
          })),
          { blockTag: blockNumber },
        );
        finalReturnData = finalReturnData.concat(returnData);
      } else {
        // No multicall contract available, return failed results
        finalReturnData = finalReturnData.concat(
          localChunk.map(() => ({
            success: false,
            returnData: '0x',
          })),
        );
        continue;
      }
      // Log gas usage warnings (only for AlgebraInterfaceMulticall as it provides gasUsed)
      if (
        process.env.NODE_ENV === 'development' &&
        !isBaseSepolia &&
        finalReturnData.length > 0
      ) {
        const lastChunkResults = finalReturnData.slice(-localChunk.length);
        lastChunkResults.forEach((r: any, i: number) => {
          if (
            !r.success &&
            r.returnData &&
            r.returnData.length === 2 &&
            r.gasUsed &&
            typeof r.gasUsed.gte === 'function' &&
            r.gasUsed.gte(
              Math.floor(
                (localChunk[i].gasRequired ?? DEFAULT_CALL_GAS_REQUIRED) * 0.95,
              ),
            )
          ) {
            console.warn(
              `A call failed due to requiring ${r.gasUsed.toString()} vs. allowed ${localChunk[
                i
              ].gasRequired ?? DEFAULT_CALL_GAS_REQUIRED}`,
              localChunk[i],
            );
          }
        });
      }
    }

    const chunkDuration = performance.now() - chunkStartTime;
    if (isQuoteCall && chunkDuration > 1000) {
      // Log if quote chunk took more than 1 second
      console.log('⏳ [MULTICALL] Quote chunk fetch completed', {
        timestamp: new Date().toISOString(),
        duration: `${chunkDuration.toFixed(2)}ms`,
        chunkSize: chunk.length,
        chainId,
        successCount: finalReturnData.filter((r) => r.success).length,
        failCount: finalReturnData.filter((r) => !r.success).length,
      });
    }

    return finalReturnData;
  } catch (error) {
    const chunkDuration = performance.now() - chunkStartTime;
    if (isQuoteCall) {
      console.error('❌ [MULTICALL] Quote chunk fetch failed', {
        timestamp: new Date().toISOString(),
        duration: `${chunkDuration.toFixed(2)}ms`,
        chunkSize: chunk.length,
        chainId,
        error: error?.message || error,
      });
    }
    if (
      error.error?.code === -32000 ||
      error.error?.message?.indexOf('header not found') !== -1
    ) {
      throw new RetryableError(
        `header not found for block number ${blockNumber}`,
      );
    } else if (
      error.error?.code === -32603 ||
      error.error?.message?.indexOf('execution ran out of gas') !== -1 ||
      error.error?.code === 3 ||
      error.message?.indexOf('execution reverted') !== -1
    ) {
      if (chunk.length > 1) {
        if (process.env.NODE_ENV === 'development') {
          console.debug('Splitting a chunk in 2', chunk);
        }
        const half = Math.floor(chunk.length / 2);
        const [c0, c1] = await Promise.all([
          fetchChunk(
            multicall2,
            multicall3,
            chunk.slice(0, half),
            blockNumber,
            chainId,
            provider,
          ),
          fetchChunk(
            multicall2,
            multicall3,
            chunk.slice(half, chunk.length),
            blockNumber,
            chainId,
            provider,
          ),
        ]);
        return c0.concat(c1);
      }
      // If single call fails and it's a revert error, return failed results instead of throwing
      // This prevents the entire multicall from failing and blocking the UI
      const isTimeoutError =
        error?.message?.includes('timed out') ||
        error?.message?.includes('timeout');

      if (isTimeoutError || process.env.NODE_ENV === 'development') {
        console.warn(
          `Multicall failed for chunk, returning failed results to prevent blocking:`,
          {
            chunkSize: chunk.length,
            error: error?.message || error,
            isTimeout: isTimeoutError,
            chainId,
          },
        );

        // Debug fallback: For Base Sepolia, try individual calls to isolate the failing one
        if (isBaseSepolia && provider) {
          console.warn(
            'Attempting to isolate failing calls on Base Sepolia by testing individually...',
          );
          for (const obj of chunk) {
            try {
              const ret = await provider.call(
                {
                  to: obj.address,
                  data: obj.callData,
                },
                blockNumber,
              );
              console.debug('Single call success', {
                target: obj.address,
                selector: obj.callData.slice(0, 10),
                returnDataLength: ret?.length || 0,
              });
            } catch (singleError) {
              console.error('Single call FAILED', {
                target: obj.address,
                selector: obj.callData.slice(0, 10),
                error:
                  singleError?.message || singleError?.reason || singleError,
                callDataLength: obj.callData.length,
              });
            }
          }
        }
      }
      // Return failed results for all calls in the chunk so the app doesn't hang
      return chunk.map(() => ({
        success: false,
        returnData: '0x',
      }));
    }
    // For any other error, log it but still return failed results instead of throwing
    // This ensures the app continues to function even when multicall completely fails
    console.error(
      'Failed to fetch chunk, returning failed results to prevent blocking:',
      error?.message || error,
    );
    return chunk.map(() => ({
      success: false,
      returnData: '0x',
    }));
  }
}

/**
 * From the current all listeners state, return each call key mapped to the
 * minimum number of blocks per fetch. This is how often each key must be fetched.
 * @param allListeners the all listeners state
 * @param chainId the current chain id
 */
export function activeListeningKeys(
  allListeners: AppState['multicallV3']['callListeners'],
  chainId?: number,
): { [callKey: string]: number } {
  if (!allListeners || !chainId) return {};
  const listeners = allListeners[chainId];
  if (!listeners) return {};

  return Object.keys(listeners).reduce<{ [callKey: string]: number }>(
    (memo, callKey) => {
      const keyListeners = listeners[callKey];

      memo[callKey] = Object.keys(keyListeners)
        .filter((key) => {
          const blocksPerFetch = parseInt(key);
          if (blocksPerFetch <= 0) return false;
          return keyListeners[blocksPerFetch] > 0;
        })
        .reduce((previousMin, current) => {
          return Math.min(previousMin, parseInt(current));
        }, Infinity);
      return memo;
    },
    {},
  );
}

/**
 * Return the keys that need to be refetched
 * @param callResults current call result state
 * @param listeningKeys each call key mapped to how old the data can be in blocks
 * @param chainId the current chain id
 * @param latestBlockNumber the latest block number
 */
export function outdatedListeningKeys(
  callResults: AppState['multicallV3']['callResults'],
  listeningKeys: { [callKey: string]: number },
  chainId: number | undefined,
  latestBlockNumber: number | undefined,
): string[] {
  if (!chainId || !latestBlockNumber) return [];
  const results = callResults[chainId];
  // no results at all, load everything
  if (!results) return Object.keys(listeningKeys);

  return Object.keys(listeningKeys).filter((callKey) => {
    const blocksPerFetch = listeningKeys[callKey];

    const data = callResults[chainId][callKey];
    // no data, must fetch
    if (!data) return true;

    const minDataBlockNumber = latestBlockNumber - (blocksPerFetch - 1);

    // already fetching it for a recent enough block, don't refetch it
    if (
      data.fetchingBlockNumber &&
      data.fetchingBlockNumber >= minDataBlockNumber
    )
      return false;

    // if data is older than minDataBlockNumber, fetch it
    return !data.blockNumber || data.blockNumber < minDataBlockNumber;
  });
}

export default function Updater(): null {
  const dispatch = useAppDispatch();
  const state = useAppSelector((state) => state.multicallV3);
  // wait for listeners to settle before triggering updates
  const debouncedListeners = useDebounce(state.callListeners, 1000);
  const latestBlockNumber = useBlockNumber();
  const { chainId, provider } = useActiveWeb3React();
  const multicall2Contract = useMulticall2Contract();
  const multicall3Contract = useMulticall3Contract();
  const cancellations = useRef<{
    blockNumber: number;
    cancellations: (() => void)[];
  }>();

  const listeningKeys: { [callKey: string]: number } = useMemo(() => {
    return activeListeningKeys(debouncedListeners, chainId);
  }, [debouncedListeners, chainId]);

  const unserializedOutdatedCallKeys = useMemo(() => {
    return outdatedListeningKeys(
      state.callResults,
      listeningKeys,
      chainId,
      latestBlockNumber,
    );
  }, [chainId, state.callResults, listeningKeys, latestBlockNumber]);

  const serializedOutdatedCallKeys = useMemo(
    () => JSON.stringify(unserializedOutdatedCallKeys.sort()),
    [unserializedOutdatedCallKeys],
  );

  const chunkGasLimit = 100_000_000;

  useEffect(() => {
    // For Base Sepolia, use Multicall3; for other chains, use AlgebraInterfaceMulticall
    // Base Sepolia (84532) is not in ChainId enum, so we check the number value
    // Cast to number since Base Sepolia isn't part of the ChainId enum
    const isBaseSepolia =
      chainId !== undefined && (chainId as number) === 84532;
    const activeMulticall = isBaseSepolia
      ? multicall3Contract
      : multicall2Contract;

    // Ensure we have a valid multicall contract for the current chain
    if (!latestBlockNumber || !chainId || !activeMulticall) return;

    const outdatedCallKeys: string[] = JSON.parse(serializedOutdatedCallKeys);
    if (outdatedCallKeys.length === 0) return;
    const calls = outdatedCallKeys.map((key) => parseCallKey(key));

    const chunkedCalls = chunkArray(calls, chunkGasLimit);

    if (
      cancellations.current &&
      cancellations.current.blockNumber !== latestBlockNumber
    ) {
      cancellations.current.cancellations.forEach((c) => c());
    }

    dispatch(
      fetchingV3MulticallResults({
        calls,
        chainId,
        fetchingBlockNumber: latestBlockNumber,
      }),
    );

    cancellations.current = {
      blockNumber: latestBlockNumber,
      cancellations: chunkedCalls.map((chunk, index) => {
        const { cancel, promise } = retry(
          () =>
            fetchChunk(
              multicall2Contract,
              multicall3Contract,
              chunk,
              latestBlockNumber,
              chainId,
              provider,
            ),
          {
            n: Infinity,
            minWait: 1000,
            maxWait: 2500,
          },
        );
        promise
          .then((returnData) => {
            // accumulates the length of all previous indices
            /**const firstCallKeyIndex = chunkedCalls
              .slice(0, index)
              .reduce<number>((memo, curr) => memo + curr.length, 0);
            const lastCallKeyIndex = firstCallKeyIndex + returnData.length;

            const slice = outdatedCallKeys.slice(
              firstCallKeyIndex,
              lastCallKeyIndex,
            );*/

            // split the returned slice into errors and success
            const { erroredCalls, results } = chunk.reduce<{
              erroredCalls: Call[];
              results: { [callKey: string]: string | null };
            }>(
              (memo, call, i) => {
                const callKey = toCallKey(call);
                if (returnData[i].success) {
                  const returnDataValue = returnData[i].returnData ?? null;
                  memo.results[callKey] = returnDataValue;

                  // Minimal logging - only log failures
                  if (
                    process.env.NODE_ENV === 'development' &&
                    chainId !== undefined &&
                    Number(chainId) === 84532 &&
                    !returnDataValue
                  ) {
                    console.warn('Multicall: Storing null returnData', {
                      callKey: callKey.substring(0, 80) + '...',
                      callAddress: call.address,
                    });
                  }
                } else {
                  memo.erroredCalls.push(call);
                  if (
                    process.env.NODE_ENV === 'development' &&
                    chainId !== undefined &&
                    Number(chainId) === 84532
                  ) {
                    console.warn('Multicall call failed, not storing result', {
                      chainId,
                      callKey,
                      callAddress: call.address,
                      callSelector: call.callData?.slice(0, 10),
                    });
                  }
                }
                return memo;
              },
              { erroredCalls: [], results: {} },
            );

            // dispatch any new results
            if (Object.keys(results).length > 0) {
              dispatch(
                updateV3MulticallResults({
                  chainId,
                  results,
                  blockNumber: latestBlockNumber,
                }),
              );
            }

            // dispatch any errored calls
            if (erroredCalls.length > 0) {
              if (process.env.NODE_ENV === 'development') {
                returnData.forEach((returnData, ix) => {
                  if (!returnData.success) {
                    console.debug('Call failed', chunk[ix], returnData);
                  }
                });
              } else {
                console.debug('Calls errored in fetch', erroredCalls);
              }
              dispatch(
                errorFetchingV3MulticallResults({
                  calls: erroredCalls,
                  chainId,
                  fetchingBlockNumber: latestBlockNumber,
                }),
              );
            }
          })
          .catch((error: any) => {
            if (error.isCancelledError) {
              console.debug(
                'Cancelled fetch for blockNumber',
                latestBlockNumber,
                chunk,
                chainId,
              );
              return;
            }
            // When multicall fails completely (e.g., contract not deployed),
            // mark all calls as errored so the app doesn't hang waiting
            console.warn(
              'Multicall chunk failed completely, marking all calls as errored to prevent blocking:',
              error.message || error,
            );
            dispatch(
              errorFetchingV3MulticallResults({
                calls: chunk,
                chainId,
                fetchingBlockNumber: latestBlockNumber,
              }),
            );
          });
        return cancel;
      }),
    };
  }, [
    chainId,
    multicall2Contract,
    multicall3Contract,
    dispatch,
    serializedOutdatedCallKeys,
    latestBlockNumber,
    provider,
  ]);

  return null;
}
