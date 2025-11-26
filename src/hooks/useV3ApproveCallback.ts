import { TransactionResponse } from '@ethersproject/providers';
import {
  Currency,
  CurrencyAmount,
  MaxUint256,
  Percent,
  TradeType,
} from '@uniswap/sdk-core';
import { Trade as V3Trade } from 'lib/src/trade';
import { useCallback, useMemo, useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  SWAP_ROUTER_ADDRESSES,
  SWAP_ROUTER_V4_ADDRESSES,
  UNI_SWAP_ROUTER,
  ZAP_ADDRESS,
} from '../constants/v3/addresses';
import {
  useHasPendingApproval,
  useTransactionAdder,
} from '../state/transactions/hooks';
import { useTokenContract } from './useContract';
import { useActiveWeb3React } from 'hooks';
import { useV3TokenAllowance } from './useTokenAllowance';
import { calculateGasMargin } from 'utils';
import { MergedZap } from 'state/zap/actions';
import { useIsInfiniteApproval } from 'state/user/hooks';
import { TransactionType } from 'models/enums';
import { ChainId } from '@uniswap/sdk';

export enum ApprovalState {
  UNKNOWN = 'UNKNOWN',
  NOT_APPROVED = 'NOT_APPROVED',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
}

// returns a variable indicating the state of the approval and a function which approves if necessary or early returns
export function useApproveCallback(
  amountToApprove?: CurrencyAmount<Currency>,
  spender?: string,
): [ApprovalState, () => Promise<void>] {
  const [isApproved, setApproved] = useState(false);
  const { account, chainId } = useActiveWeb3React();
  const queryClient = useQueryClient();
  const token = amountToApprove?.currency?.isToken
    ? amountToApprove.currency
    : undefined;
  const currentAllowance = useV3TokenAllowance(
    token,
    account ?? undefined,
    spender,
  );
  const pendingApproval = useHasPendingApproval(token?.address, spender);

  // Reset isApproved flag when allowance changes and becomes insufficient
  // This ensures that after a swap (which reduces allowance), the approval state is recalculated
  useEffect(() => {
    if (
      isApproved &&
      currentAllowance &&
      amountToApprove &&
      currentAllowance.lessThan(amountToApprove)
    ) {
      console.log(
        '🔄 [APPROVAL] Resetting isApproved flag - allowance insufficient',
        {
          timestamp: new Date().toISOString(),
          token: token?.symbol,
          currentAllowance: currentAllowance.toExact(),
          amountToApprove: amountToApprove.toExact(),
        },
      );
      setApproved(false);
    }
  }, [isApproved, currentAllowance, amountToApprove, token?.symbol]);

  // check the current approval status
  const approvalState: ApprovalState = useMemo(() => {
    if (!amountToApprove || !spender) {
      console.debug(
        '🔐 [APPROVAL] UNKNOWN: missing amountToApprove or spender',
        {
          timestamp: new Date().toISOString(),
          hasAmountToApprove: !!amountToApprove,
          hasSpender: !!spender,
          token: token?.symbol,
        },
      );
      return ApprovalState.UNKNOWN;
    }
    if (amountToApprove.currency.isNative) {
      console.debug('🔐 [APPROVAL] APPROVED: currency is native', {
        timestamp: new Date().toISOString(),
        token: token?.symbol,
      });
      return ApprovalState.APPROVED;
    }
    // we might not have enough data to know whether or not we need to approve
    if (!currentAllowance) {
      console.debug('🔐 [APPROVAL] UNKNOWN: no currentAllowance', {
        timestamp: new Date().toISOString(),
        token: token?.symbol,
        spender,
        amountToApprove: amountToApprove.toExact(),
      });
      // If we have isApproved flag but no allowance data, trust the flag temporarily
      // This handles the case where allowance query is still loading after approval
      if (isApproved) {
        return ApprovalState.APPROVED;
      }
      return ApprovalState.UNKNOWN;
    }

    // CRITICAL: Always check actual allowance FIRST - this is the source of truth
    // The isApproved flag is only an optimization and should NOT override actual allowance check
    // After a swap, allowance decreases, so we must check the actual allowance, not the flag
    const needsApproval = currentAllowance.lessThan(amountToApprove);
    const state = needsApproval
      ? pendingApproval
        ? ApprovalState.PENDING
        : ApprovalState.NOT_APPROVED
      : ApprovalState.APPROVED;

    console.log('🔐 [APPROVAL] Approval state calculated', {
      timestamp: new Date().toISOString(),
      token: token?.symbol,
      spender,
      currentAllowance: currentAllowance.toExact(),
      amountToApprove: amountToApprove.toExact(),
      needsApproval,
      pendingApproval,
      state,
    });

    return state;
  }, [
    amountToApprove,
    currentAllowance,
    pendingApproval,
    spender,
    isApproved,
    token,
  ]);

  const tokenContract = useTokenContract(token?.address);
  const addTransaction = useTransactionAdder();
  const [isInfiniteApproval] = useIsInfiniteApproval();

  const approve = useCallback(async (): Promise<void> => {
    if (approvalState !== ApprovalState.NOT_APPROVED) {
      console.error('approve was called unnecessarily');
      return;
    }
    if (!chainId) {
      console.error('no chainId');
      return;
    }

    if (!token) {
      console.error('no token');
      return;
    }

    if (!tokenContract) {
      console.error('tokenContract is null');
      return;
    }

    if (!amountToApprove) {
      console.error('missing amount to approve');
      return;
    }

    if (!spender) {
      console.error('no spender');
      return;
    }

    const approveAmount =
      isInfiniteApproval || chainId === ChainId.SONEIUM
        ? MaxUint256.toString()
        : amountToApprove.quotient.toString();

    let useExact = false;
    const estimatedGas = await tokenContract.estimateGas
      .approve(spender, approveAmount)
      .catch(() => {
        // general fallback for tokens who restrict approval amounts
        useExact = true;
        return tokenContract.estimateGas.approve(
          spender,
          amountToApprove.quotient.toString(),
        );
      });

    return tokenContract
      .approve(
        spender,
        useExact || (!isInfiniteApproval && chainId !== ChainId.SONEIUM)
          ? amountToApprove.quotient.toString()
          : approveAmount,
        {
          gasLimit: calculateGasMargin(estimatedGas),
        },
      )
      .then(async (response: TransactionResponse) => {
        addTransaction(response, {
          summary:
            `Approve ` + (amountToApprove.currency.symbol || `LP-tokens`),
          approval: { tokenAddress: token.address, spender: spender },
          type: TransactionType.APPROVED,
        });

        // Invalidate allowance query immediately when transaction is submitted
        // This triggers a refetch so the UI updates as soon as possible
        if (token?.address && account && spender) {
          console.log(
            '🔄 [APPROVAL] Invalidating allowance query after approval submission',
            {
              timestamp: new Date().toISOString(),
              token: token.symbol,
              tokenAddress: token.address,
              spender,
              account,
            },
          );
          queryClient.invalidateQueries({
            queryKey: ['token-allowance', token.address, account, spender],
          });
          // Also refetch immediately to get the updated allowance right away
          queryClient.refetchQueries({
            queryKey: ['token-allowance', token.address, account, spender],
          });
        }

        try {
          const receipt = await response.wait();
          console.log('✅ [APPROVAL] Approval transaction confirmed', {
            timestamp: new Date().toISOString(),
            token: token?.symbol,
            hash: receipt.transactionHash,
          });

          // Invalidate allowance query again after transaction is confirmed
          // This ensures we have the latest allowance value
          if (token?.address && account && spender) {
            console.log(
              '🔄 [APPROVAL] Invalidating allowance query after approval confirmation',
              {
                timestamp: new Date().toISOString(),
                token: token.symbol,
                tokenAddress: token.address,
                spender,
                account,
              },
            );
            queryClient.invalidateQueries({
              queryKey: ['token-allowance', token.address, account, spender],
            });
            // Also refetch immediately to get the updated allowance right away
            queryClient.refetchQueries({
              queryKey: ['token-allowance', token.address, account, spender],
            });
          }

          setApproved(true);
        } catch (e) {
          setApproved(false);
          console.debug('Failed to approve token', e);
          throw e;
        }
      })
      .catch((error: Error) => {
        console.debug('Failed to approve token', error);
        // throw error
      });
  }, [
    approvalState,
    chainId,
    token,
    tokenContract,
    amountToApprove,
    spender,
    isInfiniteApproval,
    addTransaction,
  ]);

  return [approvalState, approve];
}

// wraps useApproveCallback in the context of a swap
export function useApproveCallbackFromTrade(
  trade: V3Trade<Currency, Currency, TradeType> | undefined,
  allowedSlippage: Percent,
) {
  const { chainId } = useActiveWeb3React();
  const isUni = trade?.swaps[0]?.route?.pools[0]?.isUni;
  const isV4 = trade?.swaps[0]?.route?.pools[0]?.isV4;

  const v3SwapRouterAddress = chainId
    ? isUni
      ? UNI_SWAP_ROUTER[chainId]
      : isV4
      ? SWAP_ROUTER_V4_ADDRESSES[chainId]
      : SWAP_ROUTER_ADDRESSES[chainId]
    : undefined;
  const amountToApprove = useMemo(
    () =>
      trade && trade.inputAmount.currency.isToken
        ? trade.maximumAmountIn(allowedSlippage)
        : undefined,
    [trade, allowedSlippage],
  );

  const spender = chainId
    ? trade instanceof V3Trade
      ? v3SwapRouterAddress
      : undefined
    : undefined;

  console.log('🔐 [APPROVAL] useApproveCallbackFromTrade', {
    timestamp: new Date().toISOString(),
    hasTrade: !!trade,
    inputCurrency: trade?.inputAmount.currency.symbol,
    inputAmount: trade?.inputAmount.toExact(),
    amountToApprove: amountToApprove?.toExact(),
    spender,
    chainId,
    isUni,
    isV4,
    allowedSlippage: allowedSlippage.toFixed(2),
  });

  return useApproveCallback(amountToApprove, spender);
}

export function useApproveCallbackFromZap(
  zap?: MergedZap,
): [ApprovalState, () => Promise<void>] {
  const { chainId } = useActiveWeb3React();

  const inAmount = zap?.currencyIn?.currency
    ? CurrencyAmount.fromRawAmount(
        zap?.currencyIn?.currency,
        zap.currencyIn?.inputAmount,
      )
    : undefined;

  const spender = chainId ? ZAP_ADDRESS[chainId] : undefined;

  return useApproveCallback(inAmount, spender);
}
