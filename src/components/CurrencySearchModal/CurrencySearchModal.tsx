import { ChainId, Currency, ETHER } from '@uniswap/sdk';
import React, { useCallback, useEffect, useState } from 'react';
import ReactGA from 'react-ga';
import { CustomModal } from 'components';
import useLast from 'hooks/useLast';
import CurrencySearch from './CurrencySearch';
import 'components/styles/CurrencySearchModal.scss';
import { WrappedTokenInfo } from 'state/lists/v3/wrappedTokenInfo';
import { TokenInfo } from '@uniswap/token-lists';
import { NativeCurrency, Currency as CurrencyV3 } from '@uniswap/sdk-core';
import { useIsV2 } from 'state/application/hooks';
import { useActiveWeb3React } from 'hooks';

interface CurrencySearchModalProps {
  isOpen: boolean;
  onDismiss: () => void;
  selectedCurrency?: Currency | null;
  //TODO: Ignore typing to support new currency sdk
  onCurrencySelect: (currency: any) => void;
  otherSelectedCurrency?: Currency | null;
  showCommonBases?: boolean;
}

const CurrencySearchModal: React.FC<CurrencySearchModalProps> = ({
  isOpen,
  onDismiss,
  onCurrencySelect,
  selectedCurrency,
  otherSelectedCurrency,
  showCommonBases = false,
}) => {
  const { isV2 } = useIsV2();
  const [listView, setListView] = useState<boolean>(false);
  const lastOpen = useLast(isOpen);
  const { chainId } = useActiveWeb3React();
  const chainIdToUse = chainId ? chainId : ChainId.MATIC;
  const nativeCurrency = ETHER[chainIdToUse];
  useEffect(() => {
    if (isOpen && !lastOpen) {
      setListView(false);
    }
  }, [isOpen, lastOpen]);

  const handleCurrencySelect = useCallback(
    (currency: Currency) => {
      console.log('🔍 handleCurrencySelect called with:', currency);
      if (!isV2) {
        if ((currency as CurrencyV3).isNative) {
          onCurrencySelect({
            ...nativeCurrency,
            isNative: true,
            isToken: false,
          } as NativeCurrency);
        } else {
          const currencyAny = currency as any;

          // Check if currency is already a WrappedTokenInfo (has tokenInfo property)
          if (
            currency &&
            'tokenInfo' in currency &&
            currency.tokenInfo &&
            currency instanceof WrappedTokenInfo
          ) {
            // Already a WrappedTokenInfo, use it directly
            console.log('✅ Using WrappedTokenInfo directly');
            onCurrencySelect(currency);
          } else if (
            currency &&
            'chainId' in currency &&
            'decimals' in currency &&
            'symbol' in currency &&
            'name' in currency
          ) {
            // For Token instances (manually added tokens), create a TokenInfo-like object
            // Try multiple ways to get the address
            const tokenAddress =
              currencyAny.address ||
              currencyAny.wrapped?.address ||
              (currencyAny.tokenInfo?.address
                ? currencyAny.tokenInfo.address
                : undefined);

            console.log('🔍 Token address extraction:', {
              direct: currencyAny.address,
              wrapped: currencyAny.wrapped?.address,
              tokenInfo: currencyAny.tokenInfo?.address,
              final: tokenAddress,
            });

            if (!tokenAddress) {
              console.error('❌ Token address not found for currency:', {
                currency,
                keys: Object.keys(currencyAny),
                chainId: currency.chainId,
                symbol: currency.symbol,
                name: currency.name,
              });
              // Try to get address using getter methods
              const addressViaGetter =
                typeof currencyAny.address === 'function'
                  ? currencyAny.address()
                  : undefined;

              if (addressViaGetter) {
                console.log('✅ Found address via getter:', addressViaGetter);
                const tokenInfo: TokenInfo = {
                  chainId: currency.chainId as number,
                  address: addressViaGetter,
                  decimals: currency.decimals as number,
                  symbol: (currency.symbol as string) || '',
                  name: (currency.name as string) || '',
                };
                onCurrencySelect(new WrappedTokenInfo(tokenInfo));
                onDismiss();
                return;
              }

              // Last resort: try using the currency as-is, maybe it's already wrapped
              console.warn('⚠️ Falling back to using currency as-is');
              onCurrencySelect(currency);
              onDismiss();
              return;
            }

            const tokenInfo: TokenInfo = {
              chainId: currency.chainId as number,
              address: tokenAddress,
              decimals: currency.decimals as number,
              symbol: (currency.symbol as string) || '',
              name: (currency.name as string) || '',
            };
            console.log(
              '✅ Creating WrappedTokenInfo from TokenInfo:',
              tokenInfo,
            );
            const wrappedToken = new WrappedTokenInfo(tokenInfo);
            console.log('📤 Calling onCurrencySelect with:', {
              wrappedToken,
              address: wrappedToken.address,
              symbol: wrappedToken.symbol,
            });
            onCurrencySelect(wrappedToken);
          } else {
            // For TokenInfo instances (from token lists), wrap directly
            console.log('✅ Wrapping TokenInfo directly');
            onCurrencySelect(new WrappedTokenInfo(currency as TokenInfo));
          }
        }
      } else {
        onCurrencySelect(currency);
      }
      onDismiss();
    },
    [isV2, onDismiss, onCurrencySelect, nativeCurrency],
  );

  const handleClickChangeList = useCallback(() => {
    ReactGA.event({
      category: 'Lists',
      action: 'Change Lists',
    });
    setListView(true);
  }, []);

  return (
    <CustomModal
      open={isOpen}
      onClose={onDismiss}
      modalWrapper={'searchModalWrapper'}
      hideBackdrop={true}
    >
      <CurrencySearch
        isOpen={isOpen}
        onDismiss={onDismiss}
        onCurrencySelect={handleCurrencySelect}
        onChangeList={handleClickChangeList}
        selectedCurrency={selectedCurrency}
        otherSelectedCurrency={otherSelectedCurrency}
        showCommonBases={showCommonBases}
      />
    </CustomModal>
  );
};

export default CurrencySearchModal;
