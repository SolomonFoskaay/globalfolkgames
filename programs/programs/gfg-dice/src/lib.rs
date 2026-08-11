// gfg-dice
// GlobalFolkGames provably-fair dice.
//
// A player requests VRF randomness through the MagicBlock VRF program.
// A verified oracle fulfills the request and the VRF program calls back into
// callback_roll_dice, which stores two dice values (1..=6) on the player's PDA.
// The game client reads those values and uses them for the roll.
//
// Follows the MagicBlock quickstart pattern:
// https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart

use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

declare_id!("CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ");

pub const PLAYER: &[u8] = b"gfgplayerd";

#[program]
pub mod gfg_dice {
    use super::*;

    /// Idempotent: creates the payer's dice PDA if it does not exist yet.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    /// Requests verifiable randomness from the MagicBlock VRF program.
    /// The result is delivered asynchronously via `callback_roll_dice`.
    pub fn roll_dice(ctx: Context<DoRollDiceCtx>, client_seed: u8) -> Result<()> {
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackRollDice::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            // Account the callback needs to write the result into.
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.player.key(),
                is_signer: false,
                is_writable: true,
            }]),
            callback_args: Some(vec![client_seed]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Called by the VRF program (oracle-verified) with the randomness.
    pub fn callback_roll_dice(
        ctx: Context<CallbackRollDiceCtx>,
        randomness: [u8; 32],
        client_seed: u8,
    ) -> Result<()> {
        // Derive two INDEPENDENT dice from the 32 VRF bytes. `random_u8_with_range`
        // requires a full [u8; 32] and scans it uniformly, so passing the same
        // array twice would yield correlated rolls. Split the halves instead.
        let mut seed1 = [0u8; 32];
        seed1[..16].copy_from_slice(&randomness[..16]);
        let mut seed2 = [0u8; 32];
        seed2[..16].copy_from_slice(&randomness[16..]);

        let roll1 = vrf::rnd::random_u8_with_range(&seed1, 1, 6);
        let roll2 = vrf::rnd::random_u8_with_range(&seed2, 1, 6);

        ctx.accounts.player.last_roll1 = roll1;
        ctx.accounts.player.last_roll2 = roll2;
        ctx.accounts.player.last_client_seed = client_seed;
        ctx.accounts.player.last_request_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerDice::INIT_SPACE,
        seeds = [PLAYER, payer.key().as_ref()],
        bump
    )]
    pub player: Account<'info, PlayerDice>,
    pub system_program: Program<'info, System>,
}

#[vrf]
#[derive(Accounts)]
pub struct DoRollDiceCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [PLAYER, payer.key().as_ref()], bump)]
    pub player: Account<'info, PlayerDice>,
    /// CHECK: The oracle queue.
    #[account(
        mut,
        constraint =
            oracle_queue.key() == vrf::consts::DEFAULT_QUEUE ||            // base-layer (devnet/mainnet)
            oracle_queue.key() == vrf::consts::DEFAULT_EPHEMERAL_QUEUE     // ephemeral rollup
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackRollDiceCtx<'info> {
    #[account(mut)]
    pub player: Account<'info, PlayerDice>,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerDice {
    pub last_roll1: u8,
    pub last_roll2: u8,
    pub last_client_seed: u8,
    pub last_request_ts: i64,
}