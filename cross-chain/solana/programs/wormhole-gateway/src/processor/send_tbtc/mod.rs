mod gateway;
pub use gateway::*;

mod wrapped;
pub use wrapped::*;

use crate::error::WormholeGatewayError;
use crate::state::Custodian;
use anchor_lang::prelude::*;
use anchor_spl::token;

pub fn validate_send(
    wrapped_tbtc_token: &Account<'_, token::TokenAccount>,
    recipient: &[u8; 32],
    amount: u64,
) -> Result<()> {
    require!(*recipient != [0; 32], WormholeGatewayError::ZeroRecipient);
    require_gt!(amount, 0, WormholeGatewayError::ZeroAmount);

    // Check that the wrapped tBTC in custody is at least enough to bridge out.
    require_gte!(
        wrapped_tbtc_token.amount,
        amount,
        WormholeGatewayError::NotEnoughWrappedTbtc
    );

    Ok(())
}

pub struct PrepareTransfer<'ctx, 'info> {
    custodian: &'ctx mut Account<'info, Custodian>,
    tbtc_mint: &'ctx Account<'info, token::Mint>,
    sender_token: &'ctx Account<'info, token::TokenAccount>,
    sender: &'ctx Signer<'info>,
    wrapped_tbtc_token: &'ctx Account<'info, token::TokenAccount>,
    token_bridge_transfer_authority: &'ctx AccountInfo<'info>,
    token_program: &'ctx Program<'info, token::Token>,
}

pub fn burn_and_prepare_transfer(
    prepare_transfer: PrepareTransfer,
    amount: u64,
    recipient_chain: u16,
    gateway: Option<[u8; 32]>,
    recipient: [u8; 32],
    arbiter_fee: Option<u64>,
    nonce: u32,
) -> Result<()> {
    let PrepareTransfer {
        custodian,
        tbtc_mint,
        sender_token,
        sender,
        wrapped_tbtc_token,
        token_bridge_transfer_authority,
        token_program,
    } = prepare_transfer;

    // Account for burning tBTC.
    custodian
        .minted_amount
        .checked_sub(amount)
        .ok_or(WormholeGatewayError::MintedAmountUnderflow)?;

    // Burn TBTC mint.
    token::burn(
        CpiContext::new(
            token_program.to_account_info(),
            token::Burn {
                mint: tbtc_mint.to_account_info(),
                from: sender_token.to_account_info(),
                authority: sender.to_account_info(),
            },
        ),
        amount,
    )?;

    emit!(crate::event::WormholeTbtcSent {
        amount,
        recipient_chain,
        gateway: gateway.unwrap_or_default(),
        recipient,
        arbiter_fee: arbiter_fee.unwrap_or_default(),
        nonce
    });

    // Delegate authority to Token Bridge's transfer authority.
    token::approve(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            token::Approve {
                to: wrapped_tbtc_token.to_account_info(),
                delegate: token_bridge_transfer_authority.to_account_info(),
                authority: custodian.to_account_info(),
            },
            &[&[Custodian::SEED_PREFIX, &[custodian.bump]]],
        ),
        amount,
    )
}
