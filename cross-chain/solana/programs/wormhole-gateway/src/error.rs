use anchor_lang::prelude::error_code;

#[error_code]
pub enum WormholeGatewayError {
    #[msg("Cannot mint more than the minting limit.")]
    MintingLimitExceeded = 0x10,

    #[msg("Only custodian authority is permitted for this action.")]
    IsNotAuthority = 0x20,

    #[msg("0x0 recipient not allowed.")]
    ZeroRecipient = 0x30,

    #[msg("Not enough wormhole tBTC in the gateway to bridge.")]
    NotEnoughWrappedTbtc = 0x40,

    #[msg("Amount must not be 0.")]
    ZeroAmount = 0x50,

    #[msg("Amount too low to bridge.")]
    TruncatedZeroAmount = 0x60,

    #[msg("Token Bridge transfer already redeemed.")]
    TransferAlreadyRedeemed = 0x70,

    #[msg("Token chain and address do not match Ethereum's tBTC.")]
    InvalidEthereumTbtc = 0x80,

    #[msg("No tBTC transferred.")]
    NoTbtcTransferred = 0x90,

    #[msg("0x0 receiver not allowed.")]
    RecipientZeroAddress = 0xa0,

    #[msg("Not enough minted by the gateway to satisfy sending tBTC.")]
    MintedAmountUnderflow = 0xb0,
}
