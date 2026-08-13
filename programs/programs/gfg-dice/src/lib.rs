// gfg-dice
// GlobalFolkGames provably-fair dice, gasless for end users.
//
// A player requests VRF randomness through the MagicBlock VRF program.
// A verified oracle fulfills the request and the VRF program calls back into
// callback_roll_dice, which stores two dice values (1..=6) on the player's PDA.
//
// Ephemeral Rollup (ER) integration:
//   - `initialize`  : creates the player's dice PDA (base layer, app pays).
//   - `delegate`    : moves the PDA into a MagicBlock ER session (base layer,
//                     app pays) so rolls run gasless on the rollup.
//   - `roll_dice`   : requests VRF randomness. On the ER it is free and the
//                     player's session key is the only signer (no SOL needed).
//   - `commit`/`undelegate`: optional manual state pushes back to base layer.
//
// Points / rewards (Scope B — on-chain points):
//   - `initialize_points`: creates the player's POINTS PDA (base layer, app
//                          pays rent). Seed `gfgpoints`, same player_authority.
//   - `delegate_points`  : moves the points PDA into the ER session (base
//                          layer, app pays) so records run gasless.
//   - `record_points`    : appends an award to the points PDA on the ER. FREE
//                          for the player (session key signs, no SOL needed).
//                          The transaction signature is the authoritative
//                          on-chain receipt of the reward.
//
// The PDA seed uses a dedicated `player_authority` key (the player's wallet),
// NOT the payer, so any wallet can sponsor rent/fees without changing the
// account's address.
//
// Follows the MagicBlock quickstart pattern:
// https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart
// https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart

use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

declare_id!("CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ");

pub const PLAYER: &[u8] = b"gfgplayerd";
pub const POINTS: &[u8] = b"gfgpoints";

#[ephemeral]
#[program]
pub mod gfg_dice {
    use super::*;

    /// Idempotent: creates the player's dice PDA if it does not exist yet.
    /// The payer (sponsor) pays rent; the account belongs to `player_authority`.
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
        // Derive two INDEPENDENT dice from the 32 VRF bytes.
        // `random_u8_with_range` scans the array from the END (bytes[31] first),
        // so a zero-padded tail would always resolve to 1. Fill the full 32 bytes
        // of each die's seed from its half of the randomness instead.
        let mut seed1 = [0u8; 32];
        seed1[..16].copy_from_slice(&randomness[..16]);
        seed1[16..].copy_from_slice(&randomness[..16]);
        let mut seed2 = [0u8; 32];
        seed2[..16].copy_from_slice(&randomness[16..]);
        seed2[16..].copy_from_slice(&randomness[16..]);

        let roll1 = vrf::rnd::random_u8_with_range(&seed1, 1, 6);
        let roll2 = vrf::rnd::random_u8_with_range(&seed2, 1, 6);

        msg!("gfg-dice randomness: {:?}", randomness);
        msg!("gfg-dice rolls: {} + {}", roll1, roll2);

        ctx.accounts.player.last_roll1 = roll1;
        ctx.accounts.player.last_roll2 = roll2;
        ctx.accounts.player.last_client_seed = client_seed;
        ctx.accounts.player.last_request_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Delegates the player's dice PDA into an Ephemeral Rollup session.
    /// Pins the ER validator via the first remaining account. Base layer; the
    /// payer (sponsor) covers the one-time session + account costs.
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_player(
            &ctx.accounts.payer,
            &[PLAYER, authority.as_ref()],
            DelegateConfig {
                // Optionally set a specific validator from the first remaining account
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Manually pushes the delegated state back to the base layer (runs on ER).
    pub fn commit(ctx: Context<CommitAndUndelegateInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.player.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Idempotent: creates the player's POINTS PDA if it does not exist yet.
    /// Payer (sponsor) pays rent; the account belongs to `player_authority`.
    pub fn initialize_points(ctx: Context<InitializePoints>) -> Result<()> {
        Ok(())
    }

    /// Delegates the player's POINTS PDA into an ER session (base layer,
    /// sponsor pays) so `record_points` runs gasless on the rollup.
    pub fn delegate_points(ctx: Context<DelegatePointsInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_points(
            &ctx.accounts.payer,
            &[POINTS, authority.as_ref()],
            DelegateConfig {
                // Optionally set a specific validator from the first remaining account
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Appends a reward to the player's POINTS PDA. Runs GASLESS on the ER:
    /// the player's session key is the only signer and no SOL is needed. The
    /// transaction signature is the authoritative on-chain receipt of the award.
    /// `match_ref` ties the record to the proof-roll transaction that earned it
    /// (first 8 bytes of the roll signature as a u64).
    pub fn record_points(
        ctx: Context<RecordPointsCtx>,
        points: u64,
        reason: u8,
        match_ref: u64,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);

        let dest = &mut ctx.accounts.points;
        dest.total_points = dest
            .total_points
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        dest.last_points = points;
        dest.last_reason = reason;
        dest.last_match_ref = match_ref;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// Commits the latest state and returns the PDA to this program (runs on ER).
    pub fn undelegate(ctx: Context<CommitAndUndelegateInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.player.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this dice account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerDice::INIT_SPACE,
        seeds = [PLAYER, player_authority.key().as_ref()],
        bump
    )]
    pub player: Account<'info, PlayerDice>,
    pub system_program: Program<'info, System>,
}

/// Add delegate function to the context.
#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The pda to delegate.
    #[account(mut, del)]
    pub player: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializePoints<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this points account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerPoints::INIT_SPACE,
        seeds = [POINTS, player_authority.key().as_ref()],
        bump
    )]
    pub points: Account<'info, PlayerPoints>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePointsInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The points pda to delegate.
    #[account(mut, del)]
    pub points: UncheckedAccount<'info>,
}

/// Context for `record_points`. Runs on the ER (gasless): the player's session
/// key is the payer, and the points PDA must already exist + be delegated.
#[derive(Accounts)]
pub struct RecordPointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, player_authority.key().as_ref()], bump)]
    pub points: Account<'info, PlayerPoints>,
}

#[vrf]
#[derive(Accounts)]
pub struct DoRollDiceCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(seeds = [PLAYER, player_authority.key().as_ref()], bump)]
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

/// Context for manual commit / undelegate (runs on the ER).
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PLAYER, player_authority.key().as_ref()], bump)]
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

/// On-chain points ledger for one player (Scope B — record_points).
///
/// Fields:
///   - total_points     : cumulative lifetime points recorded on-chain.
///   - last_points      : the most recent award amount.
///   - last_reason      : award reason tag (see client mapping: 1=ludo-win).
///   - last_match_ref   : first 8 bytes (as u64) of the proof-roll tx signature
///                        that earned the last award.
///   - last_recorded_ts : unix ts of the most recent record.
///   - award_count      : number of records written.
#[account]
#[derive(InitSpace)]
pub struct PlayerPoints {
    pub total_points: u64,
    pub last_points: u64,
    pub last_reason: u8,
    pub last_match_ref: u64,
    pub last_recorded_ts: i64,
    pub award_count: u64,
}

#[error_code]
pub enum PointsError {
    #[msg("points must be greater than zero")]
    ZeroPoints,
    #[msg("points overflow")]
    Overflow,
}
