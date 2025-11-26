import { BigNumber } from '@ethersproject/bignumber';
import { Trade as V3Trade } from 'lib/src/trade';
import { TransactionResponse } from '@ethersproject/providers';
import { Currency, Percent, TradeType } from '@uniswap/sdk-core';
import { useMemo } from 'react';
import { SignatureData } from './useERC20Permit';
import { Version } from './useToggledVersion';
import { ethers } from 'ethers';

// import abi from '../abis/swap-router.json'
import { calculateGasMargin, isAddress, isZero, shortenAddress } from 'utils';
import useENS from 'hooks/useENS';
import {
  SWAP_ROUTER_ADDRESSES,
  SWAP_ROUTER_V4_ADDRESSES,
  UNI_SWAP_ROUTER,
} from 'constants/v3/addresses';
import { useActiveWeb3React } from 'hooks';
import { SwapRouter } from 'lib/src/swapRouter';
import useTransactionDeadline from 'hooks/useTransactionDeadline';
import { getTradeVersion } from 'utils/v3/getTradeVersion';
import { useTransactionAdder } from 'state/transactions/hooks';
import { TransactionType } from 'models/enums';
import { ChainId } from '@uniswap/sdk';
import { RPC_PROVIDERS } from 'constants/providers';

enum SwapCallbackState {
  INVALID,
  LOADING,
  VALID,
}

interface SwapCall {
  address: string;
  calldata: string;
  value: string;
}

interface SwapCallEstimate {
  call: SwapCall;
}

interface SuccessfulCall extends SwapCallEstimate {
  call: SwapCall;
  gasEstimate: BigNumber;
}

interface FailedCall extends SwapCallEstimate {
  call: SwapCall;
  error: Error;
}

/**
 * Returns the swap calls that can be used to make the trade
 * @param trade trade to execute
 * @param allowedSlippage user allowed slippage
 * @param recipientAddressOrName the ENS name or address of the recipient of the swap output
 * @param signatureData the signature data of the permit of the input token amount, if available
 */
function useSwapCallArguments(
  trade: V3Trade<Currency, Currency, TradeType> | undefined, // trade to execute, required
  allowedSlippage: Percent, // in bips
  recipientAddressOrName: string | null, // the ENS name or address of the recipient of the trade, or null if swap should be returned to sender
  signatureData: SignatureData | null | undefined,
): SwapCall[] {
  const { account, chainId, library } = useActiveWeb3React();

  const { address: recipientAddress } = useENS(recipientAddressOrName);
  const recipient =
    recipientAddressOrName === null ? account : recipientAddress;
  const deadline = useTransactionDeadline();

  return useMemo(() => {
    if (!trade || !recipient || !library || !account || !chainId || !deadline)
      return [];

    const isUni = trade.swaps[0]?.route?.pools[0]?.isUni;
    const isV4 = trade.swaps[0]?.route?.pools[0]?.isV4;
    const swapRouterAddress = chainId
      ? isUni
        ? UNI_SWAP_ROUTER[chainId]
        : isV4
        ? SWAP_ROUTER_V4_ADDRESSES[chainId]
        : SWAP_ROUTER_ADDRESSES[chainId]
      : undefined;

    if (!swapRouterAddress) return [];

    // if (!routerContract) return []
    const swapMethods: any[] = [];

    swapMethods.push(
      SwapRouter.swapCallParameters(trade, {
        isUni,
        isV4,
        feeOnTransfer: false,
        recipient,
        slippageTolerance: allowedSlippage,
        deadline: deadline.toString(),
        ...(signatureData
          ? {
              inputTokenPermit:
                'allowed' in signatureData
                  ? {
                      expiry: signatureData.deadline,
                      nonce: signatureData.nonce,
                      s: signatureData.s,
                      r: signatureData.r,
                      v: signatureData.v as any,
                    }
                  : {
                      deadline: signatureData.deadline,
                      amount: signatureData.amount,
                      s: signatureData.s,
                      r: signatureData.r,
                      v: signatureData.v as any,
                    },
            }
          : {}),
      }),
    );

    if (trade.tradeType === TradeType.EXACT_INPUT) {
      swapMethods.push(
        SwapRouter.swapCallParameters(trade, {
          isV4,
          feeOnTransfer: true,
          recipient,
          slippageTolerance: allowedSlippage,
          deadline: deadline.toString(),
          ...(signatureData
            ? {
                inputTokenPermit:
                  'allowed' in signatureData
                    ? {
                        expiry: signatureData.deadline,
                        nonce: signatureData.nonce,
                        s: signatureData.s,
                        r: signatureData.r,
                        v: signatureData.v as any,
                      }
                    : {
                        deadline: signatureData.deadline,
                        amount: signatureData.amount,
                        s: signatureData.s,
                        r: signatureData.r,
                        v: signatureData.v as any,
                      },
              }
            : {}),
        }),
      );
    }

    return swapMethods.map(({ calldata, value }) => {
      return {
        address: swapRouterAddress,
        calldata,
        value,
      };
    });
  }, [
    account,
    allowedSlippage,
    chainId,
    deadline,
    library,
    recipient,
    signatureData,
    trade,
  ]);
}

/**
 * This is hacking out the revert reason from the ethers provider thrown error however it can.
 * This object seems to be undocumented by ethers.
 * @param error an error from the ethers provider
 */
function swapErrorToUserReadableMessage(error: any): string {
  let reason: string | undefined;
  while (Boolean(error)) {
    reason = error.reason ?? error.message ?? reason;
    error = error.error ?? error.data?.originalError;
  }

  if (reason?.indexOf('execution reverted: ') === 0)
    reason = reason.substr('execution reverted: '.length);

  switch (reason) {
    case 'UniswapV2Router: EXPIRED':
      return `The transaction could not be sent because the deadline has passed. Please check that your transaction deadline is not too low.`;
    case 'UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT':
    case 'UniswapV2Router: EXCESSIVE_INPUT_AMOUNT':
      return `This transaction will not succeed either due to price movement or fee on transfer. Try increasing your slippage tolerance.`;
    case 'TransferHelper: TRANSFER_FROM_FAILED':
      return `The input token cannot be transferred. There may be an issue with the input token.`;
    case 'UniswapV2: TRANSFER_FAILED':
      return `The output token cannot be transferred. There may be an issue with the output token.`;
    case 'UniswapV2: K':
      return `The Quickswap invariant x*y=k was not satisfied by the swap. This usually means one of the tokens you are swapping incorporates custom behavior on transfer.`;
    case 'Too little received':
    case 'Too much requested':
    case 'STF':
      return `This transaction will not succeed due to price movement. Try increasing your slippage tolerance. Note: rebase tokens are incompatible with Quickswap`;
    case 'TF':
      return `The output token cannot be transferred. There may be an issue with the output token. Note: rebase tokens are incompatible with Quickswap.`;
    default:
      // Check for ERC20 allowance errors
      if (
        reason?.includes('transfer amount exceeds allowance') ||
        reason?.includes('ERC20: transfer amount exceeds allowance') ||
        reason?.includes('insufficient allowance')
      ) {
        return `Insufficient token approval. Please approve the token before swapping. The approval amount must be at least the swap amount plus slippage.`;
      }
      if (reason?.indexOf('undefined is not an object') !== -1) {
        console.error(error, reason);
        return `An error occurred when trying to execute this swap. You may need to increase your slippage tolerance. If that does not work, there may be an incompatibility with the token you are trading. Note: rebase tokens are incompatible with Algebra.`;
      }
      return `Unknown error${
        reason ? `: "${reason}"` : ''
      }. Try increasing your slippage tolerance. Note: rebase tokens are incompatible with Quickswap.`;
  }
}

// returns a function that will execute a swap, if the parameters are all valid
// and the user has approved the slippage adjusted input amount for the trade
export function useSwapCallback(
  trade: V3Trade<Currency, Currency, TradeType> | undefined, // trade to execute, required
  allowedSlippage: Percent, // in bips
  recipientAddressOrName: string | null, // the ENS name or address of the recipient of the trade, or null if swap should be returned to sender
  signatureData: SignatureData | undefined | null,
): {
  state: SwapCallbackState;
  callback:
    | null
    | (() => Promise<{
        response: TransactionResponse;
        summary: string;
      }>);
  error: string | null;
} {
  const { account, chainId, library } = useActiveWeb3React();

  const swapCalls = useSwapCallArguments(
    trade,
    allowedSlippage,
    recipientAddressOrName,
    signatureData,
  );

  const addTransaction = useTransactionAdder();

  const { address: recipientAddress } = useENS(recipientAddressOrName);
  const recipient =
    recipientAddressOrName === null ? account : recipientAddress;

  return useMemo(() => {
    if (!trade || !library || !account || !chainId) {
      return {
        state: SwapCallbackState.INVALID,
        callback: null,
        error: 'Missing dependencies',
      };
    }
    if (!recipient) {
      if (recipientAddressOrName !== null) {
        return {
          state: SwapCallbackState.INVALID,
          callback: null,
          error: 'Invalid recipient',
        };
      } else {
        return {
          state: SwapCallbackState.LOADING,
          callback: null,
          error: null,
        };
      }
    }

    return {
      state: SwapCallbackState.VALID,
      callback: async function onSwap(): Promise<{
        response: TransactionResponse;
        summary: string;
      }> {
        const swapStartTime = performance.now();
        console.log('🔄 [SWAP] Swap callback started', {
          timestamp: new Date().toISOString(),
          swapCallsCount: swapCalls.length,
          chainId,
          trade: trade
            ? {
                input: `${trade.inputAmount.toSignificant(4)} ${
                  trade.inputAmount.currency.symbol
                }`,
                output: `${trade.outputAmount.toSignificant(4)} ${
                  trade.outputAmount.currency.symbol
                }`,
              }
            : null,
        });

        // On Base Sepolia, use RPC provider for gas estimation (Alchemy is faster than MetaMask's provider)
        // For other chains, use MetaMask's provider
        const isBaseSepolia =
          chainId !== undefined && Number(chainId) === 84532;

        // Use RPC provider (Alchemy) for gas estimation on Base Sepolia (faster/more reliable)
        // Use MetaMask provider for other chains
        const gasEstimationProvider =
          isBaseSepolia && chainId ? RPC_PROVIDERS[chainId] : library;

        const gasEstimationStartTime = performance.now();
        console.log('⛽ [SWAP] Starting gas estimation', {
          timestamp: new Date().toISOString(),
          provider: isBaseSepolia ? 'ALCHEMY_RPC' : 'METAMASK',
          swapCallsCount: swapCalls.length,
          chainId,
        });

        // Add timeout wrapper for gas estimation
        const withTimeout = <T>(
          promise: Promise<T>,
          timeoutMs: number,
          errorMessage: string,
        ): Promise<T> => {
          return Promise.race([
            promise,
            new Promise<T>((_, reject) =>
              setTimeout(() => reject(new Error(errorMessage)), timeoutMs),
            ),
          ]);
        };

        // Try gas estimation with appropriate provider
        // On Base Sepolia, use Alchemy RPC provider (faster); on other chains, use MetaMask provider
        const estimatedCalls: SwapCallEstimate[] = await Promise.all(
          swapCalls.map((call, index) => {
            const callStartTime = performance.now();
            const { address, calldata, value } = call;

            const tx =
              !value || isZero(value)
                ? { from: account, to: address, data: calldata }
                : {
                    from: account,
                    to: address,
                    data: calldata,
                    value,
                  };

            console.log(
              `⛽ [SWAP] Estimating gas for call ${index + 1}/${
                swapCalls.length
              }`,
              {
                timestamp: new Date().toISOString(),
                callIndex: index + 1,
                to: address,
                dataLength: calldata?.length,
                hasValue: !!value,
              },
            );

            // Use Alchemy RPC provider for Base Sepolia, MetaMask provider for others
            const provider = gasEstimationProvider || library;

            // On Base Sepolia with Alchemy, use longer timeout since it should work
            // For other chains, use standard timeout
            const timeout = isBaseSepolia ? 10000 : 10000; // 10s for both (Alchemy should be fast)

            return withTimeout(
              provider.estimateGas(tx),
              timeout,
              'Gas estimation timed out',
            )
              .then((gasEstimate) => {
                const callDuration = performance.now() - callStartTime;
                console.log(
                  `✅ [SWAP] Gas estimate successful for call ${index + 1}`,
                  {
                    timestamp: new Date().toISOString(),
                    duration: `${callDuration.toFixed(2)}ms`,
                    gasEstimate: gasEstimate.toString(),
                  },
                );
                return {
                  call,
                  gasEstimate,
                };
              })
              .catch((gasError) => {
                const callDuration = performance.now() - callStartTime;
                console.error(
                  `❌ [SWAP] Gas estimate failed for call ${index + 1}`,
                  {
                    timestamp: new Date().toISOString(),
                    duration: `${callDuration.toFixed(2)}ms`,
                    error: gasError?.message || gasError,
                    errorCode: gasError?.code,
                    errorData: gasError?.data,
                    tx: {
                      to: tx.to,
                      from: tx.from,
                      dataLength: tx.data?.length,
                      hasValue: !!tx.value,
                    },
                    chainId,
                  },
                );
                const ethCallStartTime = performance.now();
                console.warn(
                  `⚠️ [SWAP] Trying eth_call as fallback for call ${index + 1}`,
                  { timestamp: new Date().toISOString() },
                );

                return withTimeout(
                  provider.call(tx),
                  timeout, // Use same timeout for eth_call
                  'eth_call timed out',
                )
                  .then((result) => {
                    const ethCallDuration =
                      performance.now() - ethCallStartTime;

                    // Check if result is a revert (starts with Error selector 0x08c379a0)
                    if (
                      result &&
                      typeof result === 'string' &&
                      result.startsWith('0x08c379a0')
                    ) {
                      // Decode the error message
                      let errorMessage = 'execution reverted';
                      try {
                        const decoded = ethers.utils.defaultAbiCoder.decode(
                          ['string'],
                          '0x' + result.slice(10),
                        );
                        errorMessage = decoded[0];
                      } catch (e) {
                        // If decoding fails, use generic message
                      }

                      console.error(
                        `❌ [SWAP] eth_call returned revert for call ${index +
                          1}`,
                        {
                          timestamp: new Date().toISOString(),
                          duration: `${ethCallDuration.toFixed(2)}ms`,
                          errorMessage,
                          result: result.slice(0, 100) + '...',
                          call,
                        },
                      );
                      return {
                        call,
                        error: new Error(
                          swapErrorToUserReadableMessage({
                            message: `execution reverted: ${errorMessage}`,
                          }),
                        ),
                      };
                    }

                    // If we get here, the call actually succeeded (unexpected)
                    console.debug(
                      '⚠️ [SWAP] Unexpected successful call after failed estimate gas',
                      {
                        timestamp: new Date().toISOString(),
                        duration: `${ethCallDuration.toFixed(2)}ms`,
                        call,
                        gasError,
                        result,
                      },
                    );
                    return {
                      call,
                      error: new Error(
                        'Unexpected issue with estimating the gas. Please try again.',
                      ),
                    };
                  })
                  .catch((callError) => {
                    const ethCallDuration =
                      performance.now() - ethCallStartTime;

                    // Extract error message from callError
                    let errorMessage =
                      callError?.message ||
                      callError?.toString() ||
                      'Unknown error';
                    const errorData = callError?.data;

                    // Check if errorData contains revert reason
                    if (
                      errorData &&
                      typeof errorData === 'string' &&
                      errorData.startsWith('0x08c379a0')
                    ) {
                      try {
                        const decoded = ethers.utils.defaultAbiCoder.decode(
                          ['string'],
                          '0x' + errorData.slice(10),
                        );
                        errorMessage = decoded[0];
                      } catch (e) {
                        // If decoding fails, use original message
                      }
                    }

                    // Check for allowance errors
                    const isAllowanceError =
                      errorMessage.includes(
                        'transfer amount exceeds allowance',
                      ) ||
                      errorMessage.includes(
                        'ERC20: transfer amount exceeds allowance',
                      ) ||
                      errorMessage.includes('insufficient allowance');

                    console.error(
                      `❌ [SWAP] eth_call also failed for call ${index + 1}`,
                      {
                        timestamp: new Date().toISOString(),
                        duration: `${ethCallDuration.toFixed(2)}ms`,
                        error: errorMessage,
                        errorCode: callError?.code,
                        errorData: errorData,
                        isAllowanceError,
                        tx: {
                          to: tx.to,
                          from: tx.from,
                          dataLength: tx.data?.length,
                          hasValue: !!tx.value,
                        },
                        chainId,
                      },
                    );

                    if (isAllowanceError) {
                      console.warn(
                        `⚠️ [SWAP] Token approval insufficient. User needs to approve more tokens.`,
                        { timestamp: new Date().toISOString() },
                      );
                    } else {
                      console.warn(
                        `⚠️ [SWAP] Will use fallback gas for call ${index + 1}`,
                        { timestamp: new Date().toISOString() },
                      );
                    }

                    return {
                      call,
                      error: new Error(
                        swapErrorToUserReadableMessage({
                          message: errorMessage,
                          reason: errorMessage,
                          data: { originalError: { message: errorMessage } },
                        }),
                      ),
                    };
                  });
              });
          }),
        );

        const gasEstimationDuration =
          performance.now() - gasEstimationStartTime;
        console.log('✅ [SWAP] Gas estimation completed', {
          timestamp: new Date().toISOString(),
          duration: `${gasEstimationDuration.toFixed(2)}ms`,
          successfulEstimates: estimatedCalls.filter(
            (el): el is SuccessfulCall => 'gasEstimate' in el,
          ).length,
          failedEstimates: estimatedCalls.filter(
            (el): el is FailedCall => 'error' in el,
          ).length,
        });

        // a successful estimation is a bignumber gas estimate and the next call is also a bignumber gas estimate
        const bestCallOption = estimatedCalls.find(
          (el): el is SuccessfulCall => 'gasEstimate' in el,
        );

        // Gas estimation completed

        // If no successful gas estimate, use the first call with a fallback gas limit
        // This allows the wallet to estimate gas itself
        let callToUse: SwapCall;
        let gasLimit: BigNumber | undefined;

        if (bestCallOption) {
          callToUse = bestCallOption.call;
          gasLimit = calculateGasMargin(bestCallOption.gasEstimate);
          // Using successful gas estimate
        } else {
          // All gas estimations failed - use first call with fallback gas limit
          // Calculate fallback based on trade complexity
          const errorCalls = estimatedCalls.filter(
            (call): call is FailedCall => 'error' in call,
          );

          // Log the error for debugging but don't throw - let wallet try
          if (errorCalls.length > 0) {
            console.warn(
              'Gas estimation failed, using fallback gas limit. Error:',
              errorCalls[errorCalls.length - 1].error,
            );
          }

          // Use first call with fallback gas estimate
          // Base: 200k, +100k per hop in route (increased for Base Sepolia)
          if (swapCalls.length === 0) {
            throw new Error('No swap calls available');
          }

          const baseGas = 200_000;
          const hopGas = 100_000;
          let estimatedGas = baseGas;

          // Estimate gas based on route complexity
          for (const { route } of trade.swaps) {
            estimatedGas += route.pools.length * hopGas;
          }

          callToUse = swapCalls[0];
          gasLimit = calculateGasMargin(BigNumber.from(estimatedGas));

          // Using fallback gas limit - wallet will estimate if needed
        }

        const { address, calldata, value } = callToUse;

        const txSendStartTime = performance.now();
        console.log('📤 [SWAP] Sending transaction to wallet', {
          timestamp: new Date().toISOString(),
          address,
          hasGasLimit: !!gasLimit,
          gasLimit: gasLimit?.toString(),
          hasValue: !!(value && !isZero(value)),
          value: value?.toString(),
        });

        try {
          // If gas estimation failed, let MetaMask estimate it
          // Only provide gasLimit if we have a successful estimate
          const txParams: any = {
            from: account,
            to: address,
            data: calldata,
            ...(value && !isZero(value) ? { value } : {}),
          };

          // Always provide gasLimit to avoid MetaMask estimation delays
          // Use successful estimate if available, otherwise use calculated fallback
          if (gasLimit) {
            txParams.gasLimit = gasLimit;
          }

          const txResponse = await library
            .getSigner()
            .sendTransaction(txParams);

          const txSendDuration = performance.now() - txSendStartTime;
          const totalSwapDuration = performance.now() - swapStartTime;
          console.log('✅ [SWAP] Transaction sent successfully', {
            timestamp: new Date().toISOString(),
            txSendDuration: `${txSendDuration.toFixed(2)}ms`,
            totalSwapDuration: `${totalSwapDuration.toFixed(2)}ms`,
            hash: txResponse.hash,
          });

          const response = txResponse;
          const inputSymbol = trade.inputAmount.currency.symbol;
          const outputSymbol = trade.outputAmount.currency.symbol;
          const inputAmount = trade.inputAmount.toSignificant(4);
          const outputAmount = trade.outputAmount.toSignificant(4);

          const base = `Swap ${inputAmount} ${inputSymbol} for ${outputAmount} ${outputSymbol}`;
          const withRecipient =
            recipient === account
              ? base
              : `${base} to ${
                  recipientAddressOrName && isAddress(recipientAddressOrName)
                    ? shortenAddress(recipientAddressOrName)
                    : recipientAddressOrName
                }`;

          const tradeVersion = getTradeVersion(trade);

          const withVersion =
            tradeVersion === Version.v3
              ? withRecipient
              : `${withRecipient} on ${tradeVersion}`;

          addTransaction(response, {
            summary: withVersion,
            type: TransactionType.SWAPPED,
          });

          return { response, summary: withVersion };
        } catch (error) {
          console.error('❌ [SWAP] Error sending transaction:', error);
          // if the user rejected the tx, pass this along
          if (error?.code === 'ACTION_REJECTED') {
            throw new Error('Transaction rejected.');
          } else {
            // otherwise, the error was unexpected and we need to convey that
            console.error(`Swap failed`, error, address, calldata, value);

            throw new Error(
              `Swap failed: ${swapErrorToUserReadableMessage(error)}`,
            );
          }
        }
      },
      error: null,
    };
  }, [
    trade,
    library,
    account,
    chainId,
    recipient,
    recipientAddressOrName,
    swapCalls,
    addTransaction,
  ]);
}
