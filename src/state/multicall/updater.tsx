import { Contract } from '@ethersproject/contracts';
import { useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useActiveWeb3React } from 'hooks';
import { useMulticallContract } from 'hooks/useContract';
import useDebounce from 'hooks/useDebounce';
import { chunkArray } from 'utils/chunkArray';
import { retry } from 'utils/retry';
import { useBlockNumber } from 'state/application/hooks';
import { AppDispatch, AppState } from 'state';
import {
  Call,
  addListenerOptions,
  errorFetchingMulticallResults,
  fetchingMulticallResults,
  parseCallKey,
  updateMulticallResults,
} from './actions';

import { getConfig } from '../../config/index';

// chunk calls so we do not exceed the gas limit
const CALL_CHUNK_SIZE = 500;
const DEFAULT_GAS_REQUIRED = 1_000_000;

/**
 * Fetches a chunk of calls, enforcing a minimum block number constraint
 * @param multicallContract multicall contract to fetch against
 * @param chunk chunk of calls to make
 * @param minBlockNumber minimum block number of the result set
 * @param chainId chain ID to determine which multicall function to use
 */
async function fetchChunk(
  multicall: Contract,
  chunk: Call[],
  blockNumber: number,
  chainId?: number,
): Promise<{ success: boolean; returnData: string }[]> {
  //console.debug('Fetching chunk', chunk, blockNumber);
  try {
    // Base Sepolia (84532) uses Multicall3 which has tryAggregate, not tryBlockAndAggregate
    const isBaseSepolia = chainId === 84532;
    // Check if functions exist by trying to get them
    let hasTryAggregate = false;
    let hasTryBlockAndAggregate = false;
    if (multicall.interface) {
      try {
        multicall.interface.getFunction('tryAggregate');
        hasTryAggregate = true;
      } catch {
        hasTryAggregate = false;
      }
      try {
        multicall.interface.getFunction('tryBlockAndAggregate');
        hasTryBlockAndAggregate = true;
      } catch {
        hasTryBlockAndAggregate = false;
      }
    }

    let returnData: { success: boolean; returnData: string; gasUsed?: any }[];

    if (isBaseSepolia || (hasTryAggregate && !hasTryBlockAndAggregate)) {
      // Use Multicall3's tryAggregate (no per-call gasLimit, no blockTag)
      const calls = chunk.map((obj) => ({
        target: obj.address,
        callData: obj.callData,
      }));

      if (process.env.NODE_ENV === 'development') {
        console.log(
          '🔍 [Multicall] Using Multicall3 tryAggregate for Base Sepolia:',
          {
            chainId,
            multicallAddress: multicall.address,
            callsCount: calls.length,
          },
        );
      }

      const results = await multicall.callStatic.tryAggregate(false, calls);
      // Adapt Multicall3 format to match Multicall2 format
      returnData = results.map((result: any) => ({
        success: result.success,
        returnData: result.returnData,
        gasUsed: undefined, // Multicall3 doesn't provide gasUsed per call
      }));

      if (process.env.NODE_ENV === 'development') {
        const successCount = returnData.filter((r) => r.success).length;
        console.log('✅ [Multicall] Multicall3 results:', {
          total: returnData.length,
          successful: successCount,
          failed: returnData.length - successCount,
        });
      }
    } else {
      // Use Multicall2's tryBlockAndAggregate (supports per-call gasLimit and blockTag)
      const {
        returnData: result,
      } = await multicall.callStatic.tryBlockAndAggregate(
        false,
        chunk.map((obj) => ({
          target: obj.address,
          callData: obj.callData,
          gasLimit: obj.gasRequired ?? 1_000_000,
        })),
        { blockTag: blockNumber },
      );
      returnData = result;
    }

    if (process.env.NODE_ENV === 'development') {
      returnData.forEach(({ gasUsed, returnData, success }: any, i: number) => {
        if (
          !success &&
          gasUsed &&
          returnData.length === 2 &&
          gasUsed &&
          gasUsed.gte &&
          gasUsed.gte(
            Math.floor((chunk[i].gasRequired ?? DEFAULT_GAS_REQUIRED) * 0.95),
          )
        ) {
          console.warn(
            `A call failed due to requiring ${gasUsed.toString()} vs. allowed ${chunk[
              i
            ].gasRequired ?? DEFAULT_GAS_REQUIRED}`,
            chunk[i],
          );
        }
      });
    }

    return returnData;
  } catch (error) {
    console.error('Failed to fetch chunk', error);
    throw error;
  }
}

/**
 * From the current all listeners state, return each call key mapped to the
 * minimum number of blocks per fetch. This is how often each key must be fetched.
 * @param allListeners the all listeners state
 * @param chainId the current chain id
 */
export function activeListeningKeys(
  allListeners: AppState['multicall']['callListeners'],
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
  callResults: AppState['multicall']['callResults'],
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
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector<AppState, AppState['multicall']>(
    (state) => state.multicall,
  );
  // wait for listeners to settle before triggering updates
  const debouncedListeners = useDebounce(state.callListeners, 1000);
  const latestBlockNumber = useBlockNumber();
  const { chainId } = useActiveWeb3React();
  const multicallContract = useMulticallContract();
  const cancellations = useRef<{
    blockNumber: number;
    cancellations: (() => void)[];
  }>();

  const config = getConfig(chainId);

  useMemo(() => {
    const blocksPerFetch = config['blocksPerFetch'] ?? 20;
    dispatch(
      addListenerOptions({
        chainId,
        blocksPerFetch: blocksPerFetch,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);
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

  useEffect(() => {
    if (!latestBlockNumber || !chainId || !multicallContract) return;

    const outdatedCallKeys: string[] = JSON.parse(serializedOutdatedCallKeys);
    if (outdatedCallKeys.length === 0) return;
    const calls = outdatedCallKeys.map((key) => parseCallKey(key));

    const chunkedCalls: Call[][] = chunkArray(calls);

    if (cancellations.current?.blockNumber !== latestBlockNumber) {
      cancellations.current?.cancellations?.forEach((c) => c());
    }

    dispatch(
      fetchingMulticallResults({
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
            fetchChunk(multicallContract, chunk, latestBlockNumber, chainId),
          {
            n: Infinity,
            minWait: 1000,
            maxWait: 2500,
          },
        );
        promise
          .then((returnData) => {
            // accumulates the length of all previous indices
            const firstCallKeyIndex = chunkedCalls
              .slice(0, index)
              .reduce<number>((memo, curr) => memo + curr.length, 0);
            const lastCallKeyIndex = firstCallKeyIndex + returnData.length;

            const slice = outdatedCallKeys.slice(
              firstCallKeyIndex,
              lastCallKeyIndex,
            );

            // split the returned slice into errors and success
            const { erroredCalls, results } = slice.reduce<{
              erroredCalls: Call[];
              results: { [callKey: string]: string | null };
            }>(
              (memo, callKey, i) => {
                if (returnData[i].success) {
                  memo.results[callKey] = returnData[i].returnData ?? null;
                } else {
                  memo.erroredCalls.push(parseCallKey(callKey));
                }
                return memo;
              },
              { erroredCalls: [], results: {} },
            );

            // dispatch any new results
            if (Object.keys(results).length > 0)
              dispatch(
                updateMulticallResults({
                  chainId,
                  results,
                  blockNumber: latestBlockNumber,
                }),
              );

            // dispatch any errored calls
            if (erroredCalls.length > 0) {
              console.debug('Calls errored in fetch', erroredCalls);
              dispatch(
                errorFetchingMulticallResults({
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
            console.error(
              'Failed to fetch multicall chunk',
              chunk,
              chainId,
              error,
            );
            dispatch(
              errorFetchingMulticallResults({
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
    multicallContract,
    dispatch,
    serializedOutdatedCallKeys,
    latestBlockNumber,
  ]);

  return null;
}
