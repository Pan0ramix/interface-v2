import { BigNumber } from 'ethers';
import { useEffect, useState } from 'react';
import { useSingleCallResult } from 'state/multicall/hooks';
import { useMulticallContract } from './useContract';
import { useActiveWeb3React } from 'hooks';

// gets the current timestamp from the blockchain
export default function useCurrentBlockTimestamp(): BigNumber | undefined {
  const { chainId, library } = useActiveWeb3React();
  const multicall = useMulticallContract();
  const isBaseSepolia = chainId !== undefined && Number(chainId) === 84532;

  // For Base Sepolia, get timestamp from provider directly since Multicall3 doesn't have getCurrentBlockTimestamp
  const [baseSepoliaTimestamp, setBaseSepoliaTimestamp] = useState<
    BigNumber | undefined
  >(undefined);

  // Always call the hook unconditionally (React rules)
  const multicallTimestamp = useSingleCallResult(
    isBaseSepolia ? null : multicall,
    'getCurrentBlockTimestamp',
  )?.result?.[0];

  useEffect(() => {
    if (isBaseSepolia && library) {
      library
        .getBlock('latest')
        .then((block) => {
          if (block) {
            setBaseSepoliaTimestamp(BigNumber.from(block.timestamp));
          }
        })
        .catch((error) => {
          console.error('Failed to get block timestamp:', error);
        });
    }
  }, [isBaseSepolia, library]);

  // For Base Sepolia, return the timestamp from provider
  if (isBaseSepolia) {
    return baseSepoliaTimestamp;
  }

  // For other chains, use multicall contract
  return multicallTimestamp;
}
