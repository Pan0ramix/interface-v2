import React from 'react';
import { createReducer } from '@reduxjs/toolkit';
import {
  addV3MulticallListeners,
  errorFetchingV3MulticallResults,
  fetchingV3MulticallResults,
  removeV3MulticallListeners,
  updateV3MulticallResults,
} from './actions';
import { toCallKey } from './utils';

export interface MulticallV3State {
  callListeners?: {
    // on a per-chain basis
    [chainId: number]: {
      // stores for each call key the listeners' preferences
      [callKey: string]: {
        // stores how many listeners there are per each blocks per fetch preference
        [blocksPerFetch: number]: number;
      };
    };
  };

  callResults: {
    [chainId: number]: {
      [callKey: string]: {
        data?: string | null;
        blockNumber?: number;
        fetchingBlockNumber?: number;
      };
    };
  };
}

const initialState: MulticallV3State = {
  callResults: {},
};

export default createReducer(initialState, (builder) =>
  builder
    .addCase(
      addV3MulticallListeners,
      (state, { payload: { calls, chainId, options } }) => {
        const blocksPerFetch = options?.blocksPerFetch ?? 1;
        const listeners: MulticallV3State['callListeners'] = state.callListeners
          ? state.callListeners
          : (state.callListeners = {});
        listeners[chainId] = listeners[chainId] ?? {};
        calls.forEach((call) => {
          const callKey = toCallKey(call);
          listeners[chainId][callKey] = listeners[chainId][callKey] ?? {};
          listeners[chainId][callKey][blocksPerFetch] =
            (listeners[chainId][callKey][blocksPerFetch] ?? 0) + 1;
        });
      },
    )
    .addCase(
      removeV3MulticallListeners,
      (state, { payload: { chainId, calls, options } }) => {
        const blocksPerFetch = options?.blocksPerFetch ?? 1;
        const listeners: MulticallV3State['callListeners'] = state.callListeners
          ? state.callListeners
          : (state.callListeners = {});

        if (!listeners[chainId]) return;
        calls.forEach((call) => {
          const callKey = toCallKey(call);
          if (!listeners[chainId][callKey]) return;
          if (!listeners[chainId][callKey][blocksPerFetch]) return;

          if (listeners[chainId][callKey][blocksPerFetch] === 1) {
            delete listeners[chainId][callKey][blocksPerFetch];
          } else {
            listeners[chainId][callKey][blocksPerFetch]--;
          }
        });
      },
    )
    .addCase(
      fetchingV3MulticallResults,
      (state, { payload: { chainId, fetchingBlockNumber, calls } }) => {
        state.callResults[chainId] = state.callResults[chainId] ?? {};
        calls.forEach((call) => {
          const callKey = toCallKey(call);
          const current = state.callResults[chainId][callKey];
          if ((current?.fetchingBlockNumber ?? 0) >= fetchingBlockNumber)
            return;

          // CRITICAL: Always preserve existing data and blockNumber when updating fetchingBlockNumber
          // This prevents fetchingBlockNumber updates from overwriting actual result data
          if (current) {
            // Entry exists - preserve ALL existing fields, only update fetchingBlockNumber
            // Use spread operator to ensure all fields are preserved
            state.callResults[chainId][callKey] = {
              ...current,
              fetchingBlockNumber,
            };
          } else {
            // No existing entry - create new one with just fetchingBlockNumber
            state.callResults[chainId][callKey] = {
              fetchingBlockNumber,
            };
          }

          // Debug logging removed - multicall working correctly
        });
      },
    )
    .addCase(
      errorFetchingV3MulticallResults,
      (state, { payload: { fetchingBlockNumber, chainId, calls } }) => {
        state.callResults[chainId] = state.callResults[chainId] ?? {};
        calls.forEach((call) => {
          const callKey = toCallKey(call);
          const current = state.callResults[chainId][callKey];
          if (!current || typeof current.fetchingBlockNumber !== 'number')
            return; // only should be dispatched if we are already fetching
          if (current.fetchingBlockNumber <= fetchingBlockNumber) {
            delete current.fetchingBlockNumber;
            current.data = null;
            current.blockNumber = fetchingBlockNumber;
          }
        });
      },
    )
    .addCase(
      updateV3MulticallResults,
      (state, { payload: { chainId, results, blockNumber } }) => {
        state.callResults[chainId] = state.callResults[chainId] ?? {};
        Object.keys(results).forEach((callKey) => {
          const current = state.callResults[chainId][callKey];
          if ((current?.blockNumber ?? 0) > blockNumber) return;
          // Preserve fetchingBlockNumber when storing actual data
          // Explicitly construct the object to ensure all fields are preserved
          const newResult: {
            data?: string | null;
            blockNumber?: number;
            fetchingBlockNumber?: number;
          } = {
            data: results[callKey],
            blockNumber,
          };

          // Preserve existing fetchingBlockNumber if it exists
          if (current?.fetchingBlockNumber !== undefined) {
            newResult.fetchingBlockNumber = current.fetchingBlockNumber;
          }

          state.callResults[chainId][callKey] = newResult;
        });
      },
    ),
);
