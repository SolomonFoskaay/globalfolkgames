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
// Match results (Scope C — on-chain finish order):
//   - `initialize_result`: creates the player's RESULT PDA (base layer, app
//                          pays rent). Seed `gfgresult`, same player_authority.
//   - `delegate_result`  : moves the result PDA into the ER session (base
//                          layer, app pays) so records run gasless.
//   - `record_result`    : commits the FULL 1st..4th finish order of a match
//                          on the ER. FREE for the player (session key signs,
//                          no SOL). This completes the on-chain match story:
//                          dice roll -> reward points -> full finish order.
//
// Competitions (S2 — earn + brand escrow, 30/70 rake):
//   - `initialize_comp`  : creates a Competition escrow PDA (base layer, app
//                          pays rent). Seed `gfgcomp` + comp_id, authority =
//                          the sponsor (brand / the app relay).
//   - `delegate_comp`    : moves the competition PDA into the ER session so
//                          fund/settle/claim run gasless.
//   - `fund_comp`        : the sponsor LOCKS the prize pool on-chain BEFORE
//                          the event (Open -> prize_pool += amount).
//   - `close_comp`       : closes entry after the deadline (Open -> Funded).
//   - `settle_comp`      : program logic splits the pool: 70% to winners
//                          (50/30/20 for 1st/2nd/3rd), 30% platform rake.
//                          Requires the pool funded; sponsor triggers it.
//   - `claim_comp`       : a winner claims their allocation gasless on the ER;
//                          credits their points PDA and marks the allocation
//                          claimed. Signed by the winner's session key.
//   Proven pattern (BracketChain / SkillOS): prize LOCKED in a smart-contract
//   escrow BEFORE the event, payouts by program logic, no third-party custody.
//   On devnet the pool is mirror points (free money) — real-value escrow +
//   legal framing is a mainnet item.
//
// M5 — Premium points + Active Tier (launch engine, IMPLEMENTED):
//   - `initialize_premium_points`: creates the player's PREMIUM points PDA
//                                  (base layer, app pays rent). Seed `gfgprem`,
//                                  same player_authority. Stores the admin
//                                  authority (the sponsor/ecror who initializes
//                                  it), matching the Competition sponsor pattern.
//   - `delegate_premium_points`  : moves the premium PDA into the ER session
//                                  (base layer, app pays) so spends run gasless.
//   - `credit_premium_points`    : the admin (stored authority) credits
//                                  premium_lifetime + premium_spendable together
//                                  after a VERIFIED manual payment. AUTHORITY-
//                                  GATED (only the account's admin_authority
//                                  signer). Idempotent by credit ref.
//   - `spend_premium_points`     : the player spends premium spendable on the ER
//                                  (session key signs, gasless). Insufficient
//                                  guard + idempotent spend_ref.
//   - `activate_subscription`    : deducts 5,000 premium spendable and sets
//                                  subscription_level=2 + active_until=now+30d
//                                  (no auto-renew; expiry is passive). Gasless on
//                                  the ER (session key signs).
//   - `undelegate_premium_points`: returns the premium PDA to this program so it
//                                  can be re-pinned off a flaky ER region
//                                  (RPC/region-agnostic rule, same build).
// Premium points are a buy-only economy: they NEVER merge into global (M4) or
// local (M3) ledgers and never dilute M4a pure.
//
// The PDA seed uses a dedicated `player_authority` key (the player's wallet),
// NOT the payer, so any wallet can sponsor rent/fees without changing the
// account's address.
//
// Follows the MagicBlock quickstart pattern:
// https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart
// https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart

use anchor_lang::prelude::*;
use anchor_lang::accounts::migration::Migration;

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
pub const RESULT: &[u8] = b"gfgresult";
pub const COMP: &[u8] = b"gfgcomp";
pub const GLOBAL_TAG: &[u8] = b"global"; // reserved M4 global points tag, no game may use this
pub const PREMIUM_SEED: &[u8] = b"gfgprem"; // M5 premium points ledger seed (buy-only)
pub const AFFILIATE_SEED: &[u8] = b"gfgref";      // M6 affiliate ledger [gfgref, affiliate]
pub const AFFILIATE_PAIR_SEED: &[u8] = b"gfgrefpair"; // M6 affiliate pair [gfgrefpair, affiliate, referral]
pub const CLAIM_SEED: &[u8] = b"gfgclaim";        // M6 signup-bonus fence [gfgclaim, player] (permanent, on-chain)
pub const SIGNUP_BONUS_POINTS: u64 = 500;         // M6 500P lifetime signup bonus (once per account, ever)
pub const COMP2_SEED: &[u8] = b"gfgcomp2";        // M7 competition instance [gfgcomp2, creator, seq]
pub const GFGWIN_SEED: &[u8] = b"gfgwin";         // M7 winner record [gfgwin, comp, rank]
pub const MAX_GAMES: usize = 4;
pub const MAX_WINNERS: usize = 16;
pub const MATCHBOARD_SEED: &[u8] = b"gfgboard";   // Arc2 M1 D: on-chain match board
pub const MAX_MP: usize = 8;                      // max human seats per earn match
pub const AGM_SEED: &[u8] = b"gfgagm";              // Arc2 M7: standalone AGM order
pub const AGM_SETTLE_SEED: &[u8] = b"gfgagms";        // Arc2 M7F: settlement (pot/fee/payout)
pub const AGM_FEE_BPS: u64 = 1000;                    // flat 10% of the pot (locked)
pub const AFFILIATE_ENTRIES: usize = 24;          // rolling ring of affiliate month-records
pub const PROFILE_HANDLE_SEED: &[u8] = b"gfghandle"; // M6 profile handle [gfghandle, handle_bytes]

pub const RAKE_BPS: u16 = 3000; // 30% platform rake on competition pools
pub const WINNER_SHARES: [u16; 3] = [5000, 3000, 2000]; // 1st/2nd/3rd of the 70% winners bucket

// M5 — Active Tier Level-2 2x launch plan (owner-locked 2026-08-20).
pub const PREMIUM_PLAN_COST: u64 = 5_000; // premium spendable required to activate Level 2
pub const PREMIUM_PLAN_COST_L3: u64 = 10_000; // premium spendable required to activate Level 3 (owner 2026-08-22)
pub const SUBSCRIPTION_DAYS: i64 = 30; // active-sub window (no auto-renew)
pub const BOOSTER_COST: u64 = 500; // $1 / 500P (base rate $0.002 per point, USD - never Naira) for 72h unlimited life
pub const BOOSTER_HOURS: i64 = 72; // unlimited-life booster window
pub const DAY_SECS: i64 = 24 * 60 * 60;

/// Registered M1A game tags for per-game point ledgers. Add a game here when
/// its M1 spec locks. The tag is the seed basis that isolates each game's
/// points PDA ([gfgpoints, game_tag, player]) so games never share ledgers.
pub fn is_valid_game_tag(tag: &str) -> bool {
    matches!(
        tag,
        "ludo" | "ayo_olopon" | "ludo_lab" | "ayo_lab" | "sandbox"
    )
}

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

    /// Idempotent: creates the player's per-game POINTS PDA if it does not
    /// exist yet. Seed [gfgpoints, game_tag, player_authority]. Payer (sponsor)
    /// pays rent; the account belongs to `player_authority`.
    pub fn initialize_points(ctx: Context<InitializePoints>, game_tag: String) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        Ok(())
    }

    /// Delegates the player's per-game POINTS PDA into an ER session (base
    /// layer, sponsor pays) so `record_points`/`spend_local` run gasless.
    pub fn delegate_points(ctx: Context<DelegatePointsInput>, game_tag: String) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_points(
            &ctx.accounts.payer,
            &[POINTS, game_tag.as_bytes(), authority.as_ref()],
            DelegateConfig {
                // Optionally set a specific validator from the first remaining account
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Appends a reward to the player's per-game POINTS PDA (M3 — two-track
    /// local ledger: local_pure_lifetime AND local_spendable_balance are credited together
    /// on a verified win). Runs GASLESS on the ER: the player's session key is
    /// the only signer and no SOL is needed. `game_tag` ('ludo', 'ayo_olopon',
    /// ...) isolates each game's ledger via the PDA seed [gfgpoints, game_tag,
    /// player]. `match_ref` ties the record to the proof-roll transaction that
    /// earned it (first 8 bytes of the roll signature as a u64) and guards
    /// idempotency: a match_ref can only be recorded once.
    pub fn record_points(
        ctx: Context<RecordPointsCtx>,
        game_tag: String,
        points: u64,
        reason: u8,
        match_ref: u64,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let dest = &mut ctx.accounts.points;
        require!(
            dest.award_count == 0 || dest.last_match_ref != match_ref,
            PointsError::DuplicateMatchRef
        );

        dest.local_pure_lifetime = dest
            .local_pure_lifetime
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        dest.local_spendable_balance = dest
            .local_spendable_balance
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        dest.last_points = points;
        dest.last_reason = reason;
        dest.last_match_ref = match_ref;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M3 — local spendable) Draws down the SPENDABLE track of a per-game
    /// points PDA for that game's own in-game purchases (S3 shop). The PURE
    /// track is never touched: local pure is the unspendable bragging-rights
    /// source of truth. Runs GASLESS on the ER (session key signs, 0 SOL);
    /// `spend_ref` is the client/backend-supplied purchase reference that makes
    /// the spend replayable. `reason` uses the client reason tag map.
    pub fn spend_local(
        ctx: Context<SpendLocalCtx>,
        game_tag: String,
        amount: u64,
        reason: u8,
        spend_ref: u64,
    ) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let dest = &mut ctx.accounts.points;
        require!(
            dest.local_spendable_balance >= amount,
            PointsError::InsufficientBalance
        );

        dest.local_spendable_balance = dest
            .local_spendable_balance
            .checked_sub(amount)
            .ok_or(PointsError::InsufficientBalance)?;
        dest.last_spend_reason = reason;
        dest.last_spend_ref = spend_ref;
        dest.last_spend_ts = Clock::get()?.unix_timestamp;
        dest.spend_count = dest.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M3 — data preservation, see .opencode/rules/solana-upgrade-safety.md)
    /// Permissionless one-time migration from the legacy pre-game_tag points
    /// PDA `[gfgpoints, player]` (old `total_points` layout) into the new
    /// per-game ledger `[gfgpoints, game_tag, player]`. Copies the legacy
    /// total into BOTH new tracks (1:1 split) so no lifetime points are lost
    /// across the seed change. Idempotent: skips when the destination already
    /// holds awards. The legacy account is left in place as a tombstone; it is
    /// never closed (closing would reclaim rent and destroy the data).
    pub fn migrate_points(ctx: Context<MigratePointsCtx>, game_tag: String) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let dest = &mut ctx.accounts.points;
        if dest.award_count > 0 {
            return Ok(()); // already migrated
        }
        let legacy = &ctx.accounts.legacy_points;
        if legacy.lamports() == 0 || legacy.try_borrow_data()?.len() <= 8 {
            return Ok(()); // nothing to migrate
        }
        let mut data: &[u8] = &legacy.try_borrow_data()?[8..];
        let old = LegacyPlayerPoints::deserialize(&mut data)?;
        dest.local_pure_lifetime = old.total_points;
        dest.local_spendable_balance = old.total_points;
        dest.last_points = old.last_points;
        dest.last_reason = old.last_reason;
        dest.last_match_ref = old.last_match_ref;
        dest.last_recorded_ts = old.last_recorded_ts;
        dest.award_count = old.award_count;
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

    /// Commits the latest state and returns the per-game POINTS PDA to this
    /// program (runs on ER). Mirrors `undelegate` for the M3 points ledger so
    /// a points PDA can leave a flaky region and be re-pinned to a healthy one
    /// without a program that can drop its data. Additive, 2026-08-18.
    pub fn undelegate_points(ctx: Context<CommitAndUndelegatePointsInput>, game_tag: String) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.points.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commits the latest state and returns the RESULT PDA to this program
    /// (runs on ER). Mirrors `undelegate` for the Scope C result ledger so it
    /// can be re-pinned to a healthy region. Additive, 2026-08-18.
    pub fn undelegate_result(ctx: Context<CommitAndUndelegateResultInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.result.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commits the latest state and returns the GLOBAL POINTS PDA to this
    /// program (runs on ER). Mirrors `undelegate` for the M4 global ledger so
    /// it can be re-pinned to a healthy region. Additive, 2026-08-18.
    pub fn undelegate_global_points(ctx: Context<CommitAndUndelegateGlobalPointsInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.global_points.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Idempotent: creates the player's RESULT PDA if it does not exist yet.
    /// Payer (sponsor) pays rent; the account belongs to `player_authority`.
    pub fn initialize_result(ctx: Context<InitializeResult>) -> Result<()> {
        Ok(())
    }

    /// Delegates the player's RESULT PDA into an ER session (base layer,
    /// sponsor pays) so `record_result` runs gasless on the rollup.
    pub fn delegate_result(ctx: Context<DelegateResultInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_result(
            &ctx.accounts.payer,
            &[RESULT, authority.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Commits the FULL 1st..4th finish order of a match. Runs GASLESS on the
    /// ER: the player's session key is the only signer, no SOL needed.
    /// `finish_order[i]` is the player (color/seat index) that finished in
    /// position i+1 (0 = 1st place). `points`/`multiplier`/`match_ref` mirror
    /// the same values the reward used, so the result ties to the winning roll.
    pub fn record_result(
        ctx: Context<RecordResultCtx>,
        finish_order: [u8; 4],
        points: u64,
        multiplier: u8,
        match_ref: u64,
    ) -> Result<()> {
        let dest = &mut ctx.accounts.result;
        dest.finish_order = finish_order;
        dest.points = points;
        dest.multiplier = multiplier;
        dest.match_ref = match_ref;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.result_count = dest.result_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// Creates a Competition escrow PDA. Base layer; the payer (sponsor) covers
    /// rent. The sponsor authority is the creator; only they can fund/close.
    pub fn initialize_comp(
        ctx: Context<InitializeComp>,
        comp_id: u64,
        entry_fee: u64,
        ends_at: i64,
    ) -> Result<()> {
        let comp = &mut ctx.accounts.comp;
        comp.comp_id = comp_id;
        comp.sponsor = ctx.accounts.sponsor.key();
        comp.entry_fee = entry_fee;
        comp.ends_at = ends_at;
        comp.prize_pool = 0;
        comp.state = CompState::Open as u8;
        comp.winner_count = 0;
        Ok(())
    }

    /// Delegates the Competition PDA into an ER session (base layer, sponsor
    /// pays) so fund/settle/claim run gasless on the rollup.
    pub fn delegate_comp(ctx: Context<DelegateCompInput>) -> Result<()> {
        ctx.accounts.delegate_comp(
            &ctx.accounts.payer,
            &[COMP, ctx.accounts.payer.key().as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Sponsor LOCKS prize pool into the escrow BEFORE the event. Base layer
    /// or ER (sponsor signs either way). Open -> prize_pool += amount.
    pub fn fund_comp(ctx: Context<FundCompCtx>, amount: u64) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        require!(
            ctx.accounts.comp.state == CompState::Open as u8,
            PointsError::NotOpen
        );
        let comp = &mut ctx.accounts.comp;
        comp.prize_pool = comp
            .prize_pool
            .checked_add(amount)
            .ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// Sponsor closes entry once the deadline has passed. Open -> Funded.
    pub fn close_comp(ctx: Context<CloseCompCtx>) -> Result<()> {
        require!(
            ctx.accounts.comp.state == CompState::Open as u8,
            PointsError::NotOpen
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.comp.ends_at,
            PointsError::StillRunning
        );
        ctx.accounts.comp.state = CompState::Funded as u8;
        Ok(())
    }

    /// Program logic splits a funded pool: 70% to the winners bucket (split
    /// 50/30/20 across 1st/2nd/3rd), 30% stays as platform rake. Sponsor
    /// submits the winner table after the on-chain finish orders resolve; the
    /// program validates the total and stores the allocations so claims are
    /// enforceable. Funded -> Settled.
    pub fn settle_comp(
        ctx: Context<SettleCompCtx>,
        winners: [Pubkey; 3],
        amounts: [u64; 3],
    ) -> Result<()> {
        let comp = &mut ctx.accounts.comp;
        require!(
            comp.state == CompState::Funded as u8,
            PointsError::NotFunded
        );
        let winners_bucket = comp
            .prize_pool
            .checked_mul((10_000 - RAKE_BPS) as u64)
            .ok_or(PointsError::Overflow)?
            / 10_000;
        let mut total: u64 = 0;
        for a in amounts.iter() {
            total = total.checked_add(*a).ok_or(PointsError::Overflow)?;
        }
        require!(total <= winners_bucket, PointsError::OverAlloc);
        comp.prize_pool = winners_bucket;
        for i in 0..3 {
            comp.winners[i].winner = winners[i];
            comp.winners[i].amount = amounts[i];
            comp.winners[i].claimed = false;
            if amounts[i] > 0 {
                comp.winner_count = (i + 1) as u8;
            }
        }
        comp.state = CompState::Settled as u8;
        Ok(())
    }

    /// A winner claims their allocation gasless on the ER. Requires the winner
    /// to be a stored allocation. Credits the SPENDABLE track of the player's
    /// per-game points PDA with the allocation (competition winnings are
    /// spendable) and marks it claimed (each allocation claims exactly once).
    /// `game_tag` selects which game's points PDA receives the prize.
    pub fn claim_comp(
        ctx: Context<ClaimCompCtx>,
        game_tag: String,
        winner_index: u8,
    ) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let comp = &mut ctx.accounts.comp;
        require!(
            comp.state == CompState::Settled as u8,
            PointsError::NotSettled
        );
        let idx = winner_index as usize;
        require!(idx < comp.winner_count as usize, PointsError::NoSuchWinner);
        let alloc = &mut comp.winners[idx];
        require!(
            alloc.winner == ctx.accounts.payer.key(),
            PointsError::NotYourAllocation
        );
        require!(!alloc.claimed, PointsError::AlreadyClaimed);
        alloc.claimed = true;

        let dest = &mut ctx.accounts.points;
        dest.local_spendable_balance = dest
            .local_spendable_balance
            .checked_add(alloc.amount)
            .ok_or(PointsError::Overflow)?;
        dest.local_pure_lifetime = dest
            .local_pure_lifetime
            .checked_add(alloc.amount)
            .ok_or(PointsError::Overflow)?;
        dest.last_points = alloc.amount;
        dest.last_reason = 2; // COMP_WIN
        dest.last_match_ref = comp.comp_id;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    // ── M4: Global Points (3-ledger site-wide framework) ──────────────────

    /// Idempotent: creates the player's GLOBAL POINTS PDA if it does not
    /// exist yet. Seed [gfgpoints, 'global', player_authority]. Payer (sponsor)
    /// pays rent; the account belongs to `player_authority`.
    pub fn initialize_global_points(ctx: Context<InitializeGlobalPoints>) -> Result<()> {
        Ok(())
    }

    /// Delegates the player's GLOBAL POINTS PDA into an ER session (base
    /// layer, sponsor pays) so record_global_points / spend_global run gasless.
    pub fn delegate_global_points(ctx: Context<DelegateGlobalPointsInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_global_points(
            &ctx.accounts.payer,
            &[POINTS, GLOBAL_TAG, authority.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Credits the player's GLOBAL POINTS PDA. Runs GASLESS on the ER (session
    /// key signs, 0 SOL). `kind` determines which ledgers are credited:
    ///   - 0 (GAME WIN): M4a pure + M4b lifetime + M4c spendable all credited.
    ///   - 1 (OTHER — signup_bonus/referral/giveaway): M4b lifetime + M4c
    ///     spendable only, M4a pure is untouched (the multiplier-blind flow-up
    ///     contract: tier boosts are kind-1 credits).
    /// `source_code` is a u8 enum identifying the game or event:
    ///   1=ludo, 2=ayo_olopon, 10=signup_bonus, 11=referral, 12=giveaway,
    ///   13=tier_boost. M4 reads gameTag from M3's output (the scorer) and
    ///   maps it to source_code (M4 is the bank, not the scorer).
    /// `match_ref` guards idempotency (first 8 bytes of the triggering tx sig).
    pub fn record_global_points(
        ctx: Context<RecordGlobalPointsCtx>,
        kind: u8,
        source_code: u8,
        points: u64,
        reason: u8,
        match_ref: u64,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);
        require!(kind <= 1, PointsError::InvalidGameTag); // reuse: kind must be 0 or 1
        let dest = &mut ctx.accounts.global_points;
        require!(
            dest.award_count == 0 || dest.last_match_ref != match_ref,
            PointsError::DuplicateMatchRef
        );

        if kind == 0 {
            // Game win: credit all three ledgers (M4a pure + M4b lifetime + M4c spendable)
            dest.global_pure_lifetime = dest
                .global_pure_lifetime
                .checked_add(points)
                .ok_or(PointsError::Overflow)?;
        }
        // kind 0 and 1 both credit lifetime + spendable (never pure for kind 1)
        dest.global_lifetime = dest
            .global_lifetime
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        dest.global_spendable_balance = dest
            .global_spendable_balance
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;

        dest.last_source = source_code;
        dest.last_points = points;
        dest.last_reason = reason;
        dest.last_match_ref = match_ref;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M6 — signup bonus, PERMANENT ON-CHAIN FENCE) Credits the 500P lifetime
    /// signup bonus AND marks the player's `[gfgclaim, player]` account as
    /// claimed, atomically. The claim account is the hard gate: once set it can
    /// NEVER be unset by anyone, so the same wallet can never claim twice even
    /// if the frontend or a server map is bypassed or lost. This single write
    /// replaces the old relay recordGlobalPoints(kind=1, source=10) path.
    /// Runs base-layer (sponsor signs, rare — once per signup), so the claim
    /// account never needs delegating.
    pub fn claim_signup_bonus(ctx: Context<ClaimSignupBonusCtx>, match_ref: u64) -> Result<()> {
        let claim = &mut ctx.accounts.signup_claim;
        require!(claim.claimed == 0, PointsError::SignupAlreadyClaimed); // THE FENCE
        let dest = &mut ctx.accounts.global_points;
        require!(
            dest.award_count == 0 || dest.last_match_ref != match_ref,
            PointsError::DuplicateMatchRef
        );
        // kind=1 semantics: credits M4b lifetime + M4c spendable, NEVER M4a pure.
        dest.global_lifetime = dest
            .global_lifetime
            .checked_add(SIGNUP_BONUS_POINTS)
            .ok_or(PointsError::Overflow)?;
        dest.global_spendable_balance = dest
            .global_spendable_balance
            .checked_add(SIGNUP_BONUS_POINTS)
            .ok_or(PointsError::Overflow)?;
        let now = Clock::get()?.unix_timestamp;
        dest.last_source = 10; // signup_bonus
        dest.last_points = SIGNUP_BONUS_POINTS;
        dest.last_reason = 2; // signup_bonus
        dest.last_match_ref = match_ref;
        dest.last_recorded_ts = now;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        claim.claimed = 1;
        claim.claim_ref = match_ref;
        claim.claimed_ts = now;
        Ok(())
    }

    /// (M6) One-time base-layer init of the player's signup-claim fence account
    /// ([gfgclaim, player], owner = this program). The relay (sponsor) runs it
    /// right before `claim_signup_bonus`; idempotent by the account existing.
    pub fn initialize_signup_claim(ctx: Context<InitializeSignupClaimCtx>) -> Result<()> {
        let claim = &mut ctx.accounts.signup_claim;
        claim.version = 1u8;
        claim.claimed = 0u8;
        claim.claimed_ts = 0;
        claim.claim_ref = 0;
        Ok(())
    }

    /// (M4 — global spendable) Draws down the SPENDABLE track of the global
    /// points PDA. M4a pure and M4b lifetime are never touched. Runs GASLESS
    /// on the ER (session key signs, 0 SOL); `spend_ref` is the
    /// client/backend-supplied purchase reference for replayability.
    pub fn spend_global(
        ctx: Context<SpendGlobalCtx>,
        amount: u64,
        reason: u8,
        spend_ref: u64,
    ) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        let dest = &mut ctx.accounts.global_points;
        require!(
            dest.global_spendable_balance >= amount,
            PointsError::InsufficientBalance
        );

        dest.global_spendable_balance = dest
            .global_spendable_balance
            .checked_sub(amount)
            .ok_or(PointsError::InsufficientBalance)?;
        dest.last_spend_reason = reason;
        dest.last_spend_ref = spend_ref;
        dest.last_spend_ts = Clock::get()?.unix_timestamp;
        dest.spend_count = dest.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    // ── M5: Premium Points + Active Tier (launch engine) ───────────────────

    /// Idempotent: creates the player's PREMIUM points PDA if it does not
    /// exist yet. Seed [gfgprem, player_authority]. Payer (sponsor/ecror) pays
    /// rent; the payer becomes the stored ADMIN AUTHORITY who alone can credit
    /// the account (mirrors the Competition sponsor pattern).
    pub fn initialize_premium_points(ctx: Context<InitializePremiumPoints>) -> Result<()> {
        let prem = &mut ctx.accounts.premium_points;
        prem.version = 3u8; // current v3 layout (v1/v2 migrate via upgrade instructions)
        prem.admin_authority = ctx.accounts.payer.key();
        prem.premium_lifetime = 0;
        prem.premium_spendable = 0;
        prem.subscription_level = 0;
        prem.subscription_active_until = 0;
        prem.last_credit_ts = 0;
        prem.last_credit_points = 0;
        prem.last_credit_ref = 0;
        prem.last_spend_ts = 0;
        prem.last_spend_ref = 0;
        prem.last_spend_reason = 0;
        prem.spend_count = 0;
        prem.last_credit_reason = 0;
        prem.booster_active_until = 0;
        Ok(())
    }

    /// (M5) Permissionless, idempotent migration of a v1 premium account into the
    /// current v2 layout (adds last_credit_reason). Safe for anyone to call for any
    /// account; no-ops when the account is already v2. Runs base-layer or ER; the
    /// payer (any wallet) funds the rent delta for the +1 byte (realloc via Anchor
    /// Migration). Preserves every existing field, defaults last_credit_reason to 1
    /// (subscription_payment) so no data is lost and reads stay valid on v1 too.
    pub fn upgrade_premium_points(ctx: Context<UpgradePremiumPointsCtx>) -> Result<()> {
        let mig = &mut ctx.accounts.premium_points;
        let old = mig.try_as_from()?.clone();
        let next = PremiumPoints {
            version: 3u8,
            booster_active_until: 0,
            admin_authority: old.admin_authority,
            premium_lifetime: old.premium_lifetime,
            premium_spendable: old.premium_spendable,
            subscription_level: old.subscription_level,
            subscription_active_until: old.subscription_active_until,
            last_credit_ts: old.last_credit_ts,
            last_credit_points: old.last_credit_points,
            last_credit_ref: old.last_credit_ref,
            last_spend_ts: old.last_spend_ts,
            last_spend_ref: old.last_spend_ref,
            last_spend_reason: old.last_spend_reason,
            spend_count: old.spend_count,
            last_credit_reason: 1, // subscription_payment
        };
        mig.migrate(next)
    }

    /// Delegates the player's PREMIUM points PDA into an ER session (base
    /// layer, sponsor pays) so spend_premium_points / activate_subscription run
    /// gasless on the rollup.
    pub fn delegate_premium_points(ctx: Context<DelegatePremiumPointsInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_premium_points(
            &ctx.accounts.payer,
            &[PREMIUM_SEED, authority.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// The admin (stored admin_authority, e.g. the sponsor/ecror) credits the
    /// player's PREMIUM points ledger after a VERIFIED manual payment. Writes
    /// premium_lifetime AND premium_spendable together. idempotent by
    /// `credit_ref`, so admin double-clicks can never double-credit.
    /// Runs base-layer or ER signed by the admin key (never by the player).
    pub fn credit_premium_points(
        ctx: Context<CreditPremiumPointsCtx>,
        points: u64,
        credit_ref: u64,
        reason: u8,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);
        let prem = &mut ctx.accounts.premium_points;
        // v2 layout required (run upgrade_premium_points first for legacy accounts).
        require!(prem.version >= 3, PointsError::NeedsUpgrade);
        require!(
            prem.admin_authority == ctx.accounts.admin.key(),
            PointsError::NotAdmin
        );
        require!(
            prem.last_credit_ref != credit_ref,
            PointsError::DuplicateCreditRef
        );
        prem.premium_lifetime = prem
            .premium_lifetime
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        prem.premium_spendable = prem
            .premium_spendable
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        prem.last_credit_points = points;
        prem.last_credit_ref = credit_ref;
        prem.last_credit_ts = Clock::get()?.unix_timestamp;
        prem.version = 3u8;
        prem.last_credit_reason = reason; // 1 = subscription_payment, 2 = in_game_purchase, ...
        Ok(())
    }

    /// (M5) Draws down the SPENDABLE track of the player's PREMIUM points PDA.
    /// Runs GASLESS on the ER (session key signs, 0 SOL, player-consented);
    /// `spend_ref` is the purchase reference for replayability. premium_lifetime
    /// is never touched. (The operator/admin can also spend on the player's
    /// behalf with their authority, e.g. subscription activation.)
    pub fn spend_premium_points(
        ctx: Context<SpendPremiumPointsCtx>,
        amount: u64,
        reason: u8,
        spend_ref: u64,
    ) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        let prem = &mut ctx.accounts.premium_points;
        require!(
            prem.premium_spendable >= amount,
            PointsError::InsufficientPremiumBalance
        );
        prem.premium_spendable = prem
            .premium_spendable
            .checked_sub(amount)
            .ok_or(PointsError::InsufficientPremiumBalance)?;
        prem.last_spend_reason = reason;
        prem.last_spend_ref = spend_ref;
        prem.last_spend_ts = Clock::get()?.unix_timestamp;
        prem.spend_count = prem.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M5) Activates the Level-2 (2x) subscription from PREMIUM spendable.
    /// Deducts PREMIUM_PLAN_COST (5,000), sets subscription_level = 2 and
    /// subscription_active_until = now + 30 days. NO auto-renew: the window is
    /// fixed; expiry is passive until the next manual purchase/credit. Runs
    /// GASLESS on the ER (session key signs).
    pub fn activate_subscription(ctx: Context<ActivateSubscriptionCtx>) -> Result<()> {
        let prem = &mut ctx.accounts.premium_points;
        require!(prem.version >= 3, PointsError::NeedsUpgrade);
        // One active plan at a time: reject a second upgrade while the current
        // 30-day window is still live, so a user can't spend another 5,000P to
        // stack/extend the same plan. They may re-activate only after expiry.
        let now = Clock::get()?.unix_timestamp;
        require!(
            !(prem.subscription_level > 0 && prem.subscription_active_until > now),
            PointsError::AlreadyActive
        );
        require!(
            prem.premium_spendable >= PREMIUM_PLAN_COST,
            PointsError::InsufficientPremiumBalance
        );
        prem.premium_spendable = prem
            .premium_spendable
            .checked_sub(PREMIUM_PLAN_COST)
            .ok_or(PointsError::InsufficientPremiumBalance)?;
        prem.subscription_level = 2u8;
        prem.subscription_active_until =
            Clock::get()?.unix_timestamp.checked_add(SUBSCRIPTION_DAYS * DAY_SECS)
                .ok_or(PointsError::Overflow)?;
        prem.last_spend_reason = 20; // SUB_ACTIVATE
        prem.last_spend_ref = prem.subscription_active_until as u64;
        prem.last_spend_ts = now;
        prem.spend_count = prem.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M5, plan ladder 2026-08-22) Activates a SPECIFIC plan level from PREMIUM
    /// spendable: Level-2 2x costs 5,000P, Level-3 3x costs 10,000P (level is an
    /// arg, so more levels are data/constants, never a new instruction). Sets
    /// subscription_level = level and active_until = now + 30 days (no auto-
    /// renew). One active plan at a time. Gasless on the ER. Additive: the
    /// original activate_subscription (L2 only) stays untouched for existing
    /// callers.
    pub fn activate_subscription_level(ctx: Context<ActivateSubscriptionLevelCtx>, level: u8) -> Result<()> {
        let prem = &mut ctx.accounts.premium_points;
        require!(prem.version >= 3, PointsError::NeedsUpgrade);
        let cost = match level {
            2 => PREMIUM_PLAN_COST,
            3 => PREMIUM_PLAN_COST_L3,
            _ => return Err(PointsError::InvalidLevel.into()),
        };
        let now = Clock::get()?.unix_timestamp;
        require!(
            !(prem.subscription_level > 0 && prem.subscription_active_until > now),
            PointsError::AlreadyActive
        );
        require!(prem.premium_spendable >= cost, PointsError::InsufficientPremiumBalance);
        prem.premium_spendable = prem.premium_spendable
            .checked_sub(cost)
            .ok_or(PointsError::InsufficientPremiumBalance)?;
        prem.subscription_level = level;
        prem.subscription_active_until = now.checked_add(SUBSCRIPTION_DAYS * DAY_SECS).ok_or(PointsError::Overflow)?;
        prem.last_spend_reason = 20; // SUB_ACTIVATE
        prem.last_spend_ref = prem.subscription_active_until as u64;
        prem.last_spend_ts = now;
        prem.spend_count = prem.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M5) Admin cancels a defective/perpetual subscription. Authority-gated
    /// (only stored admin_authority may call), sets level=0 and active_until=0.
    /// Used from the premium tracker to revoke a sub that escaped expiry.
    /// Runs base-layer or ER signed by admin, delegation-aware (undelegate if needed).
    pub fn admin_cancel_subscription(ctx: Context<AdminCancelSubscriptionCtx>) -> Result<()> {
        let prem = &mut ctx.accounts.premium_points;
        require!(
            prem.admin_authority == ctx.accounts.admin.key(),
            PointsError::NotAdmin
        );
        prem.subscription_level = 0;
        prem.subscription_active_until = 0;
        Ok(())
    }

    /// (M5) Authority-gated close of a premium account (returns rent to the
    /// player_authority). Used to reset a corrupted/lost test account for a clean
    /// recreate; never used in normal product flow. Additive, same program id.
    pub fn close_premium_points(ctx: Context<ClosePremiumPointsCtx>) -> Result<()> {
        let prem = &ctx.accounts.premium_points;
        // Stored admin_authority is the normal key. For broken/corrupted devnet
        // accounts whose admin field no longer matches (e.g. a bad migration),
        // the program's upgrade authority (deployer) may close them too — the
        // deployer key already has full control over the program, so this grants
        // no new privilege.
        let is_admin = prem.admin_authority == ctx.accounts.admin.key();
        if !is_admin {
            require!(
                ctx.accounts.programdata.upgrade_authority_address == Some(ctx.accounts.admin.key()),
                PointsError::NotAdmin
            );
        }
        let acct = prem.to_account_info();
        let lamports = acct.lamports();
        **acct.try_borrow_mut_lamports()? = 0;
        **ctx.accounts.destination.to_account_info().try_borrow_mut_lamports()? += lamports;
        Ok(())
    }

    /// Commits the latest state and returns the PREMIUM points PDA to this
    /// program (runs on ER). Mirrors `undelegate_global_points` so a premium
    /// PDA can leave a flaky region and be re-pinned. Additive, 2026-08-20.
    pub fn undelegate_premium_points(ctx: Context<CommitAndUndelegatePremiumPointsInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.premium_points.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    // ================= M6 AFFILIATE (relay-signed immutable audit ledger) ===========
    // The platform (relay, stored as account authority) records each referral-month
    // accrual ON-CHAIN in USD cents (15% of $3 = $0.45), with an eligibility flag so
    // nothing can be accused of being manipulated: 0 = earned (pending), 1 = paid,
    // 2 = forfeited. Totals are permanent; the account keeps a rolling ring of the
    // most recent 68 month-records for detail, and running totals for all history.

    /// Creates/updates the affiliate ledger for one affiliate->referral month.
    /// Authority = stored account authority (relay/sponsor). Idempotent per
    /// (affiliate, referral, period). Run GASLESS on the ER when delegated.
    pub fn record_affiliate_period(
        ctx: Context<RecordAffiliatePeriodCtx>,
        affiliate: Pubkey,
        referral: Pubkey,
        period: u32,
        usd_cents: u64,
        eligibility: u8,
    ) -> Result<()> {
        let acct = &mut ctx.accounts.affiliate_account;
        if acct.authority == Pubkey::default() {
            acct.authority = ctx.accounts.payer.key();
        }
        require!(acct.authority == ctx.accounts.payer.key(), PointsError::NotAdmin);
        require!(av_has_period(&acct, period, referral) == false, PointsError::DuplicateAffiliatePeriod);
        let now = Clock::get()?.unix_timestamp;
        // Update running totals by eligibility.
        if eligibility == 0 {
            acct.lifetime_usd_cents = acct.lifetime_usd_cents.checked_add(usd_cents).ok_or(PointsError::Overflow)?;
            acct.pending_usd_cents = acct.pending_usd_cents.checked_add(usd_cents).ok_or(PointsError::Overflow)?;
        } else if eligibility == 2 {
            acct.forfeited_usd_cents = acct.forfeited_usd_cents.checked_add(usd_cents).ok_or(PointsError::Overflow)?;
        }
        // Rolling ring entry.
        let idx = (acct.entry_count as usize) % AFFILIATE_ENTRIES;
        acct.entries[idx] = AffiliateEntry {
            period,
            referral,
            amount_usd_cents: usd_cents,
            status: eligibility,
            ts: now,
        };
        acct.entry_count = acct.entry_count.checked_add(1).ok_or(PointsError::Overflow)?;

        // Pair bookkeeping (drives the 60-day permanent forfeit + pause/resume).
        let pair = &mut ctx.accounts.affiliate_pair;
        if pair.first_subscribed_ts == 0 {
            pair.first_subscribed_ts = now;
        }
        if eligibility == 0 {
            pair.consecutive_inactive_periods = 0;
            pair.last_earned_period = period;
            pair.forfeited = false;
            pair.paid_period_count = pair.paid_period_count.saturating_add(1);
        } else if eligibility == 2 {
            pair.consecutive_inactive_periods = pair.consecutive_inactive_periods.saturating_add(1);
            if pair.consecutive_inactive_periods >= 2 {
                pair.forfeited = true;
            }
        }
        Ok(())
    }

    /// Marks an affiliate payout (authority-gated, relay/sponsor signs). Moves
    /// pending -> paid, records the payout receipt (ts + ref). Idempotent by
    /// payout_ref: a repeat of the same ref is rejected.
    pub fn upgrade_premium_points_v3(ctx: Context<UpgradePremiumV3Ctx>) -> Result<()> {
        let mig = &mut ctx.accounts.premium_points;
        let old = mig.try_as_from()?.clone();
        let next = PremiumPoints {
            version: 3u8,
            admin_authority: old.admin_authority,
            premium_lifetime: old.premium_lifetime,
            premium_spendable: old.premium_spendable,
            subscription_level: old.subscription_level,
            subscription_active_until: old.subscription_active_until,
            last_credit_ts: old.last_credit_ts,
            last_credit_points: old.last_credit_points,
            last_credit_ref: old.last_credit_ref,
            last_spend_ts: old.last_spend_ts,
            last_spend_ref: old.last_spend_ref,
            last_spend_reason: old.last_spend_reason,
            spend_count: old.spend_count,
            last_credit_reason: old.last_credit_reason,
            booster_active_until: 0,
        };
        mig.migrate(next)
    }

    /// (M5 v3) Activates the 72h unlimited-life booster by spending premium
    /// spendable (BOOSTER_COST = $1 / 500P, base rate $0.002/pt USD). No win
    /// lives unlimited. Extends from now (or the current active booster) by 72h.
    /// Gasless on the ER (session key signs). One plan/booster per account flow.
    pub fn activate_booster(ctx: Context<ActivateBoosterCtx>) -> Result<()> {
        let prem = &mut ctx.accounts.premium_points;
        require!(prem.version >= 3, PointsError::NeedsUpgrade);
        require!(prem.premium_spendable >= BOOSTER_COST, PointsError::InsufficientPremiumBalance);
        let now = Clock::get()?.unix_timestamp;
        let current = if prem.booster_active_until > now { prem.booster_active_until } else { now };
        let until = current.checked_add(BOOSTER_HOURS * 3600).ok_or(PointsError::Overflow)?;
        prem.premium_spendable = prem.premium_spendable.checked_sub(BOOSTER_COST).ok_or(PointsError::InsufficientPremiumBalance)?;
        prem.booster_active_until = until;
        prem.last_spend_reason = 30; // BOOST_ACTIVATE
        prem.last_spend_ref = until as u64;
        prem.last_spend_ts = now;
        prem.spend_count = prem.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    // ================= M7 COMPETITIONS (additive framework, owner 2026-08-22) =========
    // Config-driven on-chain competition instances ([gfgcomp2, creator, seq]) +
    // [gfgwin, comp, rank] winner records. Create/close/settle/cancel/mark are
    // creator-gated (relay/sponsor signs), base-layer (admin frequency). Each
    // winner payoff = pool_value x shares[rank]/sum(shares), computed by the
    // program so the on-chain winner ledger is self-consistent.

    #[allow(clippy::too_many_arguments)]
    pub fn create_competition(
        ctx: Context<CreateCompetitionCtx>,
        seq: u32,
        name: String,
        games: Vec<u8>,
        tier_bits: u8,
        require_all: u8,
        entry_cost: u64,
        entry_families: u8,
        starts_at: i64,
        ends_at: i64,
        pool_usd_cents: u64,
        pool_points: u64,
        winner_count: u8,
        prize_shares: Vec<u32>,
        redemption: u8,
        payout_mode: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ends_at > starts_at && starts_at >= now, PointsError::InvalidCompetition);
        require!(winner_count >= 1 && winner_count as usize <= MAX_WINNERS, PointsError::InvalidCompetition);
        require!(prize_shares.len() == winner_count as usize, PointsError::InvalidCompetition);
        require!(games.len() >= 1 && games.len() <= MAX_GAMES, PointsError::InvalidCompetition);
        require!(tier_bits != 0, PointsError::InvalidCompetition);
        require!(pool_usd_cents > 0 && pool_points > 0 && entry_cost > 0, PointsError::InvalidCompetition);
        for share in &prize_shares { require!(*share > 0, PointsError::InvalidCompetition); }

        let comp = &mut ctx.accounts.competition;
        comp.version = 1u8;
        comp.creator = ctx.accounts.payer.key();
        comp.seq = seq;
        let mut nm = [0u8; 24];
        let name_len = name.as_bytes().len().min(24);
        nm[..name_len].copy_from_slice(&name.as_bytes()[..name_len]);
        comp.name = nm;
        let mut gs = [0u8; MAX_GAMES];
        for (i, g) in games.iter().enumerate() { gs[i] = *g; }
        comp.games = gs;
        comp.game_count = games.len() as u8;
        comp.tier_bits = tier_bits;
        comp.require_all = require_all;
        comp.entry_cost = entry_cost;
        comp.entry_families = entry_families;
        comp.starts_at = starts_at;
        comp.ends_at = ends_at;
        comp.pool_usd_cents = pool_usd_cents;
        comp.pool_points = pool_points;
        comp.winner_count = winner_count;
        let mut sh = [0u32; MAX_WINNERS];
        for (i, v) in prize_shares.iter().enumerate() { sh[i] = *v; }
        comp.prize_shares = sh;
        comp.redemption = redemption;
        comp.payout_mode = payout_mode;
        comp.status = 0u8; // open
        comp.settled_ts = 0;
        Ok(())
    }

    pub fn close_competition(ctx: Context<CompetitionSeqCtx>, seq: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let comp = &mut ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 0, PointsError::NotOpen);
        require!(now >= comp.ends_at, PointsError::StillRunning); // auto-stop (R16)
        comp.status = 1u8; // closed
        Ok(())
    }

    pub fn cancel_competition(ctx: Context<CompetitionSeqCtx>, seq: u32) -> Result<()> {
        let comp = &mut ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 0 || comp.status == 1, PointsError::NotOpen);
        comp.status = 3u8; // cancelled
        Ok(())
    }

    pub fn record_competition_winner(
        ctx: Context<RecordCompetitionWinnerCtx>,
        seq: u32,
        rank: u8,
        player: Pubkey,
    ) -> Result<()> {
        let comp = &ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 1, PointsError::CompetitionNotClosed);
        require!(rank >= 1 && rank as usize <= comp.winner_count as usize, PointsError::RankOutOfRange);
        let idx = (rank - 1) as usize;
        let total: u64 = comp.prize_shares.iter()
            .map(|s| *s as u64)
            .take(comp.winner_count as usize)
            .sum();
        require!(total > 0, PointsError::InvalidCompetition);
        let points = (comp.pool_points * comp.prize_shares[idx] as u64) / total;
        let usd = (comp.pool_usd_cents * comp.prize_shares[idx] as u64) / total;
        let w = &mut ctx.accounts.winner;
        w.version = 1u8;
        w.comp = comp.key();
        w.rank = rank;
        w.player = player;
        w.points = points;
        w.usd_cents = usd;
        w.status = 0u8;
        w.paid_ts = 0;
        Ok(())
    }

    pub fn settle_competition(ctx: Context<CompetitionSeqCtx>, seq: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let comp = &mut ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 1, PointsError::CompetitionNotClosed);
        comp.status = 2u8; // settled
        comp.settled_ts = now;
        Ok(())
    }

    pub fn mark_winner_paid(ctx: Context<MarkWinnerPaidCtx>, seq: u32, rank: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let comp = &ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 2, PointsError::CompetitionNotSettled);
        let w = &mut ctx.accounts.winner;
        require!(w.status == 0, PointsError::AlreadyClaimed);
        w.status = 1u8;
        w.paid_ts = now;
        Ok(())
    }

    // ===== M7 in-window win tally (H, owner 2026-08-23) ===================
    // Every verified win inside a live window increments the player's
    // [gfgwin, comp, player] tally ON-CHAIN (durable on serverless, R13). The
    // board aggregates tallies; the file ledger stays as a local fallback.

    /// One-time init of a player's tally for a competition (rent by the relay/
    /// sponsor; payer is the player session key on first win via the relay).
    pub fn initialize_competition_tally(
        ctx: Context<InitializeCompetitionTallyCtx>,
        seq: u32,
    ) -> Result<()> {
        let t = &mut ctx.accounts.tally;
        t.version = 1u8;
        t.comp = ctx.accounts.competition.key();
        t.player = ctx.accounts.player_authority.key();
        t.wins = 0;
        t.first_ts = 0;
        t.last_ts = 0;
        Ok(())
    }

    /// Gasless ER write (session key): +1 win on the player's own tally, only
    /// while the window is OPEN (auto-stop at ends_at by chain clock) and the
    /// given proof-time sits inside [starts_at, ends_at].
    pub fn record_competition_win(
        ctx: Context<RecordCompetitionWinCtx>,
        seq: u32,
        ts: i64,
        game: u8,
    ) -> Result<()> {
        let comp = &ctx.accounts.competition;
        let now = Clock::get()?.unix_timestamp;
        require!(comp.status == 0, PointsError::NotOpen);
        require!(now <= comp.ends_at, PointsError::StillRunning); // auto-stop (R16)
        require!(ts >= comp.starts_at && ts <= comp.ends_at, PointsError::InvalidCompetition);
        require!(game > 0, PointsError::InvalidCompetition);
        let t = &mut ctx.accounts.tally;
        t.wins = t.wins.checked_add(1).ok_or(PointsError::Overflow)?;
        t.last_ts = ts;
        if t.first_ts == 0 { t.first_ts = ts; }
        Ok(())
    }

    /// Delegate a player's competition tally into an ER session (relay/sponsor
    /// signs base-layer like the other per-player delegates).
    pub fn delegate_competition_tally(ctx: Context<DelegateCompetitionTallyInput>) -> Result<()> {
        ctx.accounts.delegate_tally(
            &ctx.accounts.payer,
            &[
                GFGWIN_SEED,
                ctx.accounts.competition.key().as_ref(),
                ctx.accounts.player_authority.key().as_ref(),
            ],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Return a player's competition tally to this program (region-agnostic).
    pub fn undelegate_competition_tally(ctx: Context<CommitAndUndelegateCompetitionTallyInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.tally.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }


    // ===== arc2m1a: on-chain match board (owner-approved 2026-08-25) =====
    // Additive multiplayer record: start_match locks a board with participants +
    // stake + clocks; commit_move records hashed move checkpoints with turn caps;
    // finish_match writes the winner + time. Solo/free play is untouched.
    #[allow(clippy::too_many_arguments)]
    pub fn start_match(
        ctx: Context<StartMatchCtx>,
        game: u8,
        match_ref: u64,
        players: Vec<Pubkey>,
        seats: u8,
        stake_usd_cents: u64,
        turn_secs: u64,
        max_match_secs: u64,
    ) -> Result<()> {
        require!(players.len() >= 2 && players.len() <= MAX_MP, PointsError::InvalidCompetition);
        require!(seats >= players.len() as u8 && seats as usize <= MAX_MP, PointsError::InvalidCompetition);
        require!(game > 0, PointsError::InvalidCompetition);
        require!(stake_usd_cents > 0, PointsError::InvalidCompetition);
        require!(turn_secs > 0 && max_match_secs > 0, PointsError::InvalidCompetition);
        let b = &mut ctx.accounts.board;
        b.version = 1u8;
        b.game = game;
        b.match_ref = match_ref;
        b.status = 0u8;
        let mut ps = [ctx.accounts.payer.key(); MAX_MP];
        for (i, p) in players.iter().enumerate() { ps[i] = *p; }
        b.players = ps;
        b.player_count = players.len() as u8;
        b.seats = seats;
        b.stake_usd_cents = stake_usd_cents;
        b.seat_pot_usd_cents = stake_usd_cents.checked_mul(seats as u64).ok_or(PointsError::Overflow)?;
        b.turn_secs = turn_secs;
        b.max_match_secs = max_match_secs;
        b.started_at = Clock::get()?.unix_timestamp;
        b.last_turn_ts = [0i64; MAX_MP];
        b.move_count = 0;
        b.last_move_commit = [0u8; 32];
        b.finished_at = 0;
        b.winner_seat = 255;
        Ok(())
    }

    pub fn begin_match(ctx: Context<BeginMatchCtx>, game: u8, match_ref: u64) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        let b = &mut ctx.accounts.board;
        require!(b.status == 0, PointsError::NotOpen);
        b.status = 1;
        b.started_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Commit one hashed move from a seat (gasless on the ER). Caps the turn:
    /// if a seat exceeds its turn_secs, any other seat may take over the next
    /// move (no stalling); max_match_secs is enforced at finish.
    pub fn commit_move(
        ctx: Context<CommitMoveCtx>,
        game: u8,
        match_ref: u64,
        seat: u8,
        move_commit: [u8; 32],
    ) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == 1, PointsError::NotOpen);
        require!(seat < b.player_count, PointsError::RankOutOfRange);
        b.last_move_commit = move_commit;
        b.move_count = b.move_count.checked_add(1).ok_or(PointsError::Overflow)?;
        b.last_turn_ts[seat as usize] = now;
        Ok(())
    }

    pub fn finish_match(ctx: Context<FinishMatchCtx>, game: u8, match_ref: u64, winner_seat: u8) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == 1, PointsError::NotOpen);
        require!(winner_seat < b.player_count, PointsError::RankOutOfRange);
        require!(now - b.started_at <= b.max_match_secs as i64, PointsError::StillRunning); // time cap
        b.status = 2;
        b.winner_seat = winner_seat;
        b.finished_at = now;
        Ok(())
    }

    // ===== arc2m7a: standalone AGM order book (game-agnostic) =====
    pub fn post_agm_order(
        ctx: Context<PostAgmOrderCtx>,
        game: u8,
        order_id: u64,
        stake_usd_cents: u64,
        seats: u8,
    ) -> Result<()> {
        require!(game > 0, PointsError::InvalidCompetition);
        require!(stake_usd_cents > 0, PointsError::InvalidCompetition);
        require!(seats >= 2 && seats as usize <= MAX_MP, PointsError::InvalidCompetition);
        let o = &mut ctx.accounts.order;
        o.version = 1u8;
        o.order_id = order_id;
        o.game = game;
        o.maker = ctx.accounts.payer.key();
        o.stake_usd_cents = stake_usd_cents;
        o.seats = seats;
        o.status = 0u8;
        o.taker = ctx.accounts.payer.key();
        o.created_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn cancel_agm_order(ctx: Context<AgmOrderSeqCtx>, game: u8, order_id: u64) -> Result<()> {
        require!(ctx.accounts.order.game == game, PointsError::InvalidCompetition);
        let o = &mut ctx.accounts.order;
        require!(o.maker == ctx.accounts.signer.key(), PointsError::NotCreator);
        require!(o.status == 0, PointsError::NotOpen);
        o.status = 3;
        Ok(())
    }

    pub fn match_agm_order(ctx: Context<AgmOrderSeqCtx>, game: u8, order_id: u64) -> Result<()> {
        require!(ctx.accounts.order.game == game, PointsError::InvalidCompetition);
        let o = &mut ctx.accounts.order;
        require!(ctx.accounts.signer.key() != o.maker, PointsError::InvalidCompetition);
        require!(o.status == 0, PointsError::NotOpen);
        o.taker = ctx.accounts.signer.key();
        o.status = 2;
        Ok(())
    }

    // ===== Arc2 M7F: lock + settle a matched AGM order =====
    // lock_agm_match: any party may call once the order is MATCHED (status 2);
    // writes the settlement snapshot from the order's stake/seats (fee = 10% pot)
    // and marks the order LOCKED (status 1).
    pub fn lock_agm_match(ctx: Context<LockAgmMatchCtx>, game: u8, order_id: u64, winner_seat: u8) -> Result<()> {
        require!(ctx.accounts.order.game == game, PointsError::InvalidCompetition);
        let o = &ctx.accounts.order;
        require!(o.status == 2, PointsError::NotOpen);
        require!(winner_seat < o.seats, PointsError::RankOutOfRange);
        let pot = o.stake_usd_cents.checked_mul(o.seats as u64).ok_or(PointsError::Overflow)?;
        let fee = (pot * AGM_FEE_BPS) / 10_000;
        let st = &mut ctx.accounts.settlement;
        st.version = 1u8;
        st.order_id = order_id;
        st.game = o.game;
        st.pot_usd_cents = pot;
        st.fee_usd_cents = fee;
        st.seats = o.seats;
        st.winner_seat = winner_seat;
        st.payout_usd_cents = pot.checked_sub(fee).ok_or(PointsError::Overflow)?;
        st.settled_at = Clock::get()?.unix_timestamp;
        ctx.accounts.order.status = 1; // LOCKED (escrow committed after matching)
        Ok(())
    }

    // settle_agm_match: finalizes the order once the board (M1) has finished.
    // finished, so the wallet/escrow rail can pay the 90% winner.
    pub fn settle_agm_match(ctx: Context<AgmOrderSeqCtx>, game: u8, order_id: u64) -> Result<()> {
        require!(ctx.accounts.order.game == game, PointsError::InvalidCompetition);
        let o = &mut ctx.accounts.order;
        require!(o.status == 1, PointsError::NotOpen); // must have been locked (escrow committed)
        o.status = 1; // FILLED (final)
        Ok(())
    }

    pub fn register_profile_handle(
        ctx: Context<RegisterProfileHandleCtx>,
        handle: String,
    ) -> Result<()> {
        let h = handle.trim();
        require!(h.len() >= 5 && h.len() <= 24, PointsError::InvalidHandle);
        let valid = h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        require!(valid, PointsError::InvalidHandle);
        let acct = &mut ctx.accounts.handle_account;
        require!(acct.owner == Pubkey::default(), PointsError::DuplicateHandle);
        acct.owner = ctx.accounts.payer.key();
        acct.created_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn record_affiliate_payout(
        ctx: Context<AffiliatePayoutCtx>,
        affiliate: Pubkey,
        usd_cents: u64,
        payout_ref: u64,
    ) -> Result<()> {
        let acct = &mut ctx.accounts.affiliate_account;
        require!(acct.authority == ctx.accounts.payer.key(), PointsError::NotAdmin);
        require!(acct.last_payout_ref != payout_ref, PointsError::DuplicateCreditRef);
        require!(acct.pending_usd_cents >= usd_cents, PointsError::InsufficientPremiumBalance);
        acct.pending_usd_cents = acct.pending_usd_cents.checked_sub(usd_cents).ok_or(PointsError::InsufficientPremiumBalance)?;
        acct.paid_usd_cents = acct.paid_usd_cents.checked_add(usd_cents).ok_or(PointsError::Overflow)?;
        acct.payout_count = acct.payout_count.saturating_add(1);
        acct.last_payout_ts = Clock::get()?.unix_timestamp;
        acct.last_payout_ref = payout_ref;
        Ok(())
    }
}

fn av_has_period(acct: &AffiliateAccount, period: u32, referral: Pubkey) -> bool {
    acct.entries.iter().any(|e| e.period == period && e.referral == referral)
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
#[instruction(game_tag: String)]
pub struct InitializePoints<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this points account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerPoints::INIT_SPACE,
        seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()],
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

#[derive(Accounts)]
pub struct InitializeResult<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this result account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerResult::INIT_SPACE,
        seeds = [RESULT, player_authority.key().as_ref()],
        bump
    )]
    pub result: Account<'info, PlayerResult>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateResultInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The result pda to delegate.
    #[account(mut, del)]
    pub result: UncheckedAccount<'info>,
}

/// Context for `record_result`. Runs on the ER (gasless): the player's session
/// key is the payer, and the result PDA must already exist + be delegated.
#[derive(Accounts)]
pub struct RecordResultCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [RESULT, player_authority.key().as_ref()], bump)]
    pub result: Account<'info, PlayerResult>,
}

#[derive(Accounts)]
pub struct InitializeComp<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The competition sponsor (brand / the app relay). Pays rent; owns the
    /// escrow lifecycle (fund/close/settle). One active competition per
    /// sponsor: the PDA seed is the sponsor key.
    pub sponsor: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Competition::INIT_SPACE,
        seeds = [COMP, sponsor.key().as_ref()],
        bump
    )]
    pub comp: Account<'info, Competition>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateCompInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The competition escrow PDA (seed: gfgcomp + sponsor key).
    #[account(mut, del)]
    pub comp: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FundCompCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The sponsor who created the competition.
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        seeds = [COMP, sponsor.key().as_ref()],
        bump,
        constraint = comp.sponsor == sponsor.key() @ PointsError::NotSponsor
    )]
    pub comp: Account<'info, Competition>,
}

#[derive(Accounts)]
pub struct CloseCompCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The sponsor who created the competition.
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        seeds = [COMP, sponsor.key().as_ref()],
        bump,
        constraint = comp.sponsor == sponsor.key() @ PointsError::NotSponsor
    )]
    pub comp: Account<'info, Competition>,
}

#[derive(Accounts)]
pub struct SettleCompCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The sponsor who created the competition.
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        seeds = [COMP, sponsor.key().as_ref()],
        bump,
        constraint = comp.sponsor == sponsor.key() @ PointsError::NotSponsor
    )]
    pub comp: Account<'info, Competition>,
}

/// Context for `claim_comp`. Runs on the ER (gasless): the winner's session
/// key is the payer; the competition PDA must be delegated and the winner's
/// points PDA must exist + be delegated.
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct ClaimCompCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the points PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()], bump)]
    pub points: Account<'info, PlayerPoints>,
    /// The competition sponsor (read-only seed basis; not required to sign).
    /// CHECK: read-only, used only as the PDA seed.
    pub sponsor: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [COMP, sponsor.key().as_ref()],
        bump,
        constraint = comp.sponsor == sponsor.key() @ PointsError::NotSponsor
    )]
    pub comp: Account<'info, Competition>,
}

/// Context for `record_points`. Runs on the ER (gasless): the player's session
/// key is the payer, and the points PDA must already exist + be delegated.
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct RecordPointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()], bump)]
    pub points: Account<'info, PlayerPoints>,
}

// ── M4: Global Points contexts ────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeGlobalPoints<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this global points account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + GlobalPoints::INIT_SPACE,
        seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()],
        bump
    )]
    pub global_points: Account<'info, GlobalPoints>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateGlobalPointsInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The global points PDA to delegate.
    #[account(mut, del)]
    pub global_points: UncheckedAccount<'info>,
}

/// Context for `record_global_points`. Runs on the ER (gasless): the player's
/// session key is the payer, and the global points PDA must already exist +
/// be delegated.
#[derive(Accounts)]
pub struct RecordGlobalPointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()], bump)]
    pub global_points: Account<'info, GlobalPoints>,
}

/// Context for `claim_signup_bonus` (M6). Base-layer, sponsor-signed, once per
/// signup. The `signup_claim` account (already initialized) is the permanent
/// on-chain fence: the program rejects any repeat, forever.
#[derive(Accounts)]
pub struct ClaimSignupBonusCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()], bump)]
    pub global_points: Account<'info, GlobalPoints>,
    #[account(mut, seeds = [CLAIM_SEED, player_authority.key().as_ref()], bump)]
    pub signup_claim: Account<'info, SignupClaim>,
}

/// Context for `initialize_signup_claim` (M6). Sponsor (relay) creates the
/// per-wallet claim-fence account once, before the first claim.
#[derive(Accounts)]
pub struct InitializeSignupClaimCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + 1 + 1 + 8 + 8,
        seeds = [CLAIM_SEED, player_authority.key().as_ref()],
        bump
    )]
    pub signup_claim: Account<'info, SignupClaim>,
    pub system_program: Program<'info, System>,
}

/// Context for `create_competition` (M7). Seeds use [COMP2_SEED, creator, seq].
#[derive(Accounts)]
#[instruction(seq: u32, name: String, games: Vec<u8>, tier_bits: u8, require_all: u8, entry_cost: u64, entry_families: u8, starts_at: i64, ends_at: i64, pool_usd_cents: u64, pool_points: u64, winner_count: u8, prize_shares: Vec<u32>, redemption: u8, payout_mode: u8)]
pub struct CreateCompetitionCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<CompetitionInstance>(),
        seeds = [COMP2_SEED, payer.key().as_ref(), &seq.to_le_bytes()],
        bump
    )]
    pub competition: Account<'info, CompetitionInstance>,
    pub system_program: Program<'info, System>,
}

/// Reusable creator-gated context for close/settle/cancel (COMP2 seed).
#[derive(Accounts)]
#[instruction(seq: u32)]
pub struct CompetitionSeqCtx<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [COMP2_SEED, authority.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
}

/// Context for `record_competition_winner` (per rank; creates its gfgwin record).
#[derive(Accounts)]
#[instruction(seq: u32, rank: u8, player: Pubkey)]
pub struct RecordCompetitionWinnerCtx<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [COMP2_SEED, authority.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<WinnerRecord>(),
        seeds = [GFGWIN_SEED, competition.key().as_ref(), &[rank]],
        bump
    )]
    pub winner: Account<'info, WinnerRecord>,
    pub system_program: Program<'info, System>,
}

/// Context for `mark_winner_paid`.
#[derive(Accounts)]
#[instruction(seq: u32, rank: u8)]
pub struct MarkWinnerPaidCtx<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [COMP2_SEED, authority.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
    #[account(mut, seeds = [GFGWIN_SEED, competition.key().as_ref(), &[rank]], bump)]
    pub winner: Account<'info, WinnerRecord>,
}

/// Context for `start_match` (Arc2 M1 D). Board seed [gfgboard, game, match_ref].
/// game + match_ref are instruction args; the creator (lobby/payer) is the gate.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64, players: Vec<Pubkey>, seats: u8, stake_usd_cents: u64, turn_secs: u64, max_match_secs: u64)]
pub struct StartMatchCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<MatchBoard>(),
        seeds = [MATCHBOARD_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()],
        bump
    )]
    pub board: Account<'info, MatchBoard>,
    pub system_program: Program<'info, System>,
}

/// Context for `begin_match`.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64)]
pub struct BeginMatchCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
}

/// Context for `commit_move`.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64, seat: u8, move_commit: [u8; 32])]
pub struct CommitMoveCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
}

/// Context for `finish_match`.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64, winner_seat: u8)]
pub struct FinishMatchCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
}

/// Context for `post_agm_order`.
#[derive(Accounts)]
#[instruction(game: u8, order_id: u64, stake_usd_cents: u64, seats: u8)]
pub struct PostAgmOrderCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<AgmOrder>(),
        seeds = [AGM_SEED, &game.to_le_bytes(), &order_id.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, AgmOrder>,
    pub system_program: Program<'info, System>,
}

/// Reusable context for cancel/match (seeds [gfgagm, game, order_id]).
#[derive(Accounts)]
#[instruction(game: u8, order_id: u64)]
pub struct AgmOrderSeqCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [AGM_SEED, &game.to_le_bytes(), &order_id.to_le_bytes()], bump)]
    pub order: Account<'info, AgmOrder>,
}

/// Context for `lock_agm_match` (creates the settlement snapshot).
#[derive(Accounts)]
#[instruction(game: u8, order_id: u64, winner_seat: u8)]
pub struct LockAgmMatchCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [AGM_SEED, &game.to_le_bytes(), &order_id.to_le_bytes()], bump)]
    pub order: Account<'info, AgmOrder>,
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<AgmSettlement>(),
        seeds = [AGM_SETTLE_SEED, &order_id.to_le_bytes()],
        bump
    )]
    pub settlement: Account<'info, AgmSettlement>,
    pub system_program: Program<'info, System>,
}

/// Context for `spend_global`. Runs on the ER (gasless): the player's session
/// key is the payer, and the global points PDA must already exist + be
/// delegated.
#[derive(Accounts)]
pub struct SpendGlobalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()], bump)]
    pub global_points: Account<'info, GlobalPoints>,
}

// ── M5: Premium Points contexts ────────────────────────────────────────────

/// Context for `initialize_premium_points`. Base layer: the payer
/// (sponsor/ecror) pays rent and becomes the stored admin authority.
#[derive(Accounts)]
pub struct InitializePremiumPoints<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PremiumPoints::INIT_SPACE,
        seeds = [PREMIUM_SEED, player_authority.key().as_ref()],
        bump
    )]
    pub premium_points: Account<'info, PremiumPoints>,
    pub system_program: Program<'info, System>,
}

/// Context for `delegate_premium_points`. Base layer, sponsor pays.
#[delegate]
#[derive(Accounts)]
pub struct DelegatePremiumPointsInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The premium points PDA to delegate.
    #[account(mut, del)]
    pub premium_points: UncheckedAccount<'info>,
}

/// Context for `credit_premium_points`. The admin authority (sponsor/ecror,
/// stored at init) signs. Runs base-layer or ER signed by the admin; the
/// player does NOT sign.
#[derive(Accounts)]
pub struct CreditPremiumPointsCtx<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `spend_premium_points`. Runs on the ER (gasless): the player's
/// session key is the payer, and the premium PDA must exist + be delegated.
#[derive(Accounts)]
pub struct SpendPremiumPointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `activate_subscription`. Runs on the ER (gasless): the player's
/// session key signs; the premium PDA must exist + be delegated.
#[derive(Accounts)]
pub struct ActivateSubscriptionCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `activate_subscription_level` (M5 plan ladder). Same shape as
/// ActivateSubscriptionCtx plus the level argument (instruction-bound).
#[derive(Accounts)]
#[instruction(level: u8)]
pub struct ActivateSubscriptionLevelCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `upgrade_premium_points`: migrates a v1 premium account to v2
/// (adds last_credit_reason). Permissionless (any payer may run it for any
/// account); idempotent; reallocs the account +1 byte via Anchor Migration.
#[derive(Accounts)]
pub struct UpgradePremiumPointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        realloc = 8 + PremiumPoints::INIT_SPACE,
        realloc::payer = payer,
        realloc::zero = false
    )]
    pub premium_points: Migration<'info, PremiumPointsV1, PremiumPoints>,
    pub system_program: Program<'info, System>,
}

/// Context for `record_affiliate_period` (M6). Creates the affiliate ledger and
/// pair account if missing (payer, the relay/sponsor, pays rent and becomes the
/// stored authority). Runs base-layer for first creation, ER gasless when delegated.
#[derive(Accounts)]
#[instruction(affiliate: Pubkey, referral: Pubkey, period: u32, usd_cents: u64, eligibility: u8)]
pub struct RecordAffiliatePeriodCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AffiliateAccount::INIT_SPACE,
        seeds = [AFFILIATE_SEED, affiliate.as_ref()],
        bump
    )]
    pub affiliate_account: Account<'info, AffiliateAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AffiliatePair::INIT_SPACE,
        seeds = [AFFILIATE_PAIR_SEED, affiliate.as_ref(), referral.as_ref()],
        bump
    )]
    pub affiliate_pair: Account<'info, AffiliatePair>,
    pub system_program: Program<'info, System>,
}

/// Context for `upgrade_premium_points_v3` (M5 v3): migrates a v2 premium account
/// (124 bytes) to v3 (adds booster_active_until). Permissionless; reallocs +8 bytes.
#[derive(Accounts)]
pub struct UpgradePremiumV3Ctx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        realloc = 8 + PremiumPoints::INIT_SPACE,
        realloc::payer = payer,
        realloc::zero = false
    )]
    pub premium_points: Migration<'info, PremiumPointsV2, PremiumPoints>,
    pub system_program: Program<'info, System>,
}

/// Context for `activate_booster` (M5 v3). Gasless on the ER (session key signs).
#[derive(Accounts)]
pub struct ActivateBoosterCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `initialize_competition_tally` (H): sponsor/relay creates the
/// player's per-competition win tally once.
#[derive(Accounts)]
#[instruction(seq: u32)]
pub struct InitializeCompetitionTallyCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The competition creator (comp PDA seed part).
    pub creator: AccountInfo<'info>,
    #[account(seeds = [COMP2_SEED, creator.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<CompetitionTally>(),
        seeds = [GFGWIN_SEED, competition.key().as_ref(), player_authority.key().as_ref()],
        bump
    )]
    pub tally: Account<'info, CompetitionTally>,
    pub system_program: Program<'info, System>,
}

/// Context for `record_competition_win` (H): gasless ER write by the player's
/// session key; auto-stop + window-fresh enforced inside.
#[derive(Accounts)]
#[instruction(seq: u32, ts: i64, game: u8)]
pub struct RecordCompetitionWinCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The competition creator (comp PDA seed part).
    pub creator: AccountInfo<'info>,
    #[account(seeds = [COMP2_SEED, creator.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
    #[account(mut, seeds = [GFGWIN_SEED, competition.key().as_ref(), player_authority.key().as_ref()], bump)]
    pub tally: Account<'info, CompetitionTally>,
}

/// Context for `delegate_competition_tally` (H). Mirrors the other delegates.
#[delegate]
#[derive(Accounts)]
pub struct DelegateCompetitionTallyInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The competition instance pubkey (part of the tally seed).
    pub competition: AccountInfo<'info>,
    /// CHECK: The tally PDA to delegate.
    #[account(mut, del)]
    pub tally: UncheckedAccount<'info>,
}

/// Context for `undelegate_competition_tally` (H).
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateCompetitionTallyInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The tally PDA to undelegate.
    #[account(mut)]
    pub tally: UncheckedAccount<'info>,
}

/// Context for `register_profile_handle` (M6). Self-service: the player's wallet
/// (session key) signs to claim a handle, gasless on the ER.
#[derive(Accounts)]
#[instruction(handle: String)]
pub struct RegisterProfileHandleCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ProfileHandle::INIT_SPACE,
        seeds = [PROFILE_HANDLE_SEED, handle.as_bytes()],
        bump
    )]
    pub handle_account: Account<'info, ProfileHandle>,
    pub system_program: Program<'info, System>,
}

/// Context for `record_affiliate_payout` (M6).
#[derive(Accounts)]
#[instruction(affiliate: Pubkey, usd_cents: u64, payout_ref: u64)]
pub struct AffiliatePayoutCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [AFFILIATE_SEED, affiliate.as_ref()], bump)]
    pub affiliate_account: Account<'info, AffiliateAccount>,
}

/// Context for `close_premium_points`. Authority-gated (stored admin_authority);
/// closes the account and returns rent to `destination` so a broken account can be
/// reset and recreated cleanly (devnet maintenance only).
#[derive(Accounts)]
pub struct ClosePremiumPointsCtx<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: rent recipient.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// Bpf-upgradeable ProgramData account (only read to authorize the deployer close).
    pub programdata: Account<'info, ProgramData>,
}

/// Context for `admin_cancel_subscription`. Authority-gated: only the stored
/// admin_authority (sponsor/ecror) may cancel a defective perpetual sub.
/// Player does NOT sign; admin does. Runs base-layer (undelegate if delegated).
#[derive(Accounts)]
pub struct AdminCancelSubscriptionCtx<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `undelegate_premium_points`: returns the PREMIUM PDA to this
/// program (runs on the ER). Mirrors CommitAndUndelegateGlobalPointsInput.
/// premium_points is UNTYPED so a legacy v1/v2 premium account (115/124 bytes)
/// can be undelegated even though the current PremiumPoints layout is 132 bytes
/// (a typed Account<PremiumPoints> deserialize would reject the shorter bytes,
/// Custom 3003 = AccountDidNotDeserialize). The Magic commit intent only reads
/// the account key, never its data.
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegatePremiumPointsInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The premium points PDA to undelegate (untyped).
    #[account(mut)]
    pub premium_points: UncheckedAccount<'info>,
}

/// Context for `spend_local`. Runs on the ER (gasless): the player's session
/// key is the payer, and the points PDA must already exist + be delegated.
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct SpendLocalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()], bump)]
    pub points: Account<'info, PlayerPoints>,
}

/// Context for `migrate_points`. Runs on the base layer (one-time, sponsor or
/// anyone pays): reads the legacy pre-game_tag PDA and seeds the new per-game
/// ledger with the same data.
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct MigratePointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for both PDAs).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: Legacy (pre-game_tag) points PDA [gfgpoints, player]. Read-only
    /// tombstone; never closed after migration.
    #[account(seeds = [POINTS, player_authority.key().as_ref()], bump)]
    pub legacy_points: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerPoints::INIT_SPACE,
        seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()],
        bump
    )]
    pub points: Account<'info, PlayerPoints>,
    pub system_program: Program<'info, System>,
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

/// Context for `undelegate_points`: returns the per-game POINTS PDA to this
/// program (runs on the ER). Mirrors CommitAndUndelegateInput for the M3
/// points ledger. Additive, 2026-08-18.
#[commit]
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct CommitAndUndelegatePointsInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()], bump)]
    pub points: Account<'info, PlayerPoints>,
}

/// Context for `undelegate_result`: returns the RESULT PDA to this program
/// (runs on the ER). Mirrors CommitAndUndelegateInput for the Scope C result
/// ledger. Additive, 2026-08-18.
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateResultInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [RESULT, player_authority.key().as_ref()], bump)]
    pub result: Account<'info, PlayerResult>,
}

/// Context for `undelegate_global_points`: returns the GLOBAL POINTS PDA to
/// this program (runs on the ER). Mirrors CommitAndUndelegateInput for the M4
/// global ledger. Additive, 2026-08-18.
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateGlobalPointsInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()], bump)]
    pub global_points: Account<'info, GlobalPoints>,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerDice {
    pub last_roll1: u8,
    pub last_roll2: u8,
    pub last_client_seed: u8,
    pub last_request_ts: i64,
}

/// On-chain LOCAL points ledger for one player per game (M3 — two-track local
/// points). One account per [game_tag, player]. Runs gasless on the ER.
///
/// Field naming: `local_` prefixed so the future M4 GLOBAL ledgers can live on
/// the same program as `global_*` fields/accounts without ambiguity.
///
/// Fields:
///   - local_pure_lifetime    : PURE (unspendable) lifetime points. Source of truth
///                        for the player's on-chain bragging rights. Credits
///                        on every verified win; never drawn down.
///   - local_spendable_balance: SPENDABLE track credited alongside pure on every win
///                        (1:1 for now). Can be spent via `spend_local` (local
///                        in-game purchases) or `claim_comp` (competition
///                        winnings credit this track).
///   - last_points      : the most recent award amount.
///   - last_reason      : award reason tag (client mapping; see
///                        `src/magicblock-vrf.js` POINT_REASONS).
///   - last_match_ref   : first 8 bytes (as u64) of the proof-roll tx signature
///                        that earned the last award. Duplicate guard for the
///                        idempotent 1x-per-match rule.
///   - last_recorded_ts : unix ts of the most recent award.
///   - award_count      : number of awards recorded.
///   - last_spend_ts    : unix ts of the most recent local spend.
///   - last_spend_ref   : client/backend purchase reference of the last spend.
///   - last_spend_reason: spend reason tag of the last spend.
///   - spend_count      : number of local spends recorded.
#[account]
#[derive(InitSpace)]
pub struct PlayerPoints {
    pub local_pure_lifetime: u64,
    pub local_spendable_balance: u64,
    pub last_points: u64,
    pub last_reason: u8,
    pub last_match_ref: u64,
    pub last_recorded_ts: i64,
    pub award_count: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
}

/// On-chain GLOBAL points ledger for one player (M4 — site-wide three-ledger
/// framework). One account per player, seed [gfgpoints, 'global', player].
/// Runs gasless on the ER.
///
/// Three tracks:
///   - global_pure_lifetime    : sum of M3 local wins across ALL games, no
///                               multiplier, no purchases, no bonus — the honest
///                               cross-game skill total (M4a).
///   - global_lifetime         : every point earned from ANY source (M3 game
///                               wins + M5 multiplier credits + M6 signup/
///                               referral/giveaway). Unspendable, permanent
///                               reputation number (M4b).
///   - global_spendable_balance: the spendable split of lifetime. Purchases,
///                               Active Tier buys, comp entries, cosmetics
///                               all flow here. Goes up and down (M4c).
///
/// `kind` field on credits:
///   - 0 = GAME WIN: credits all three tracks (M4a + M4b + M4c).
///   - 1 = OTHER (signup_bonus/referral/giveaway/tier_boost): credits M4b
///         + M4c only. M4a pure is never multiplied or bonus-inflated.
#[account]
#[derive(InitSpace)]
pub struct GlobalPoints {
    pub global_pure_lifetime: u64,   // M4a: sum of verified game wins only
    pub global_lifetime: u64,        // M4b: everything earned, unspendable
    pub global_spendable_balance: u64, // M4c: spendable track
    pub last_source: u8,             // source_code enum: 1=ludo, 2=ayo_olopon, 10=signup_bonus, 11=referral, 12=giveaway, 13=tier_boost, 14=daily_reward
    pub last_points: u64,
    pub last_reason: u8,
    pub last_match_ref: u64,
    pub last_recorded_ts: i64,
    pub award_count: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
}

/// M6 signup-bonus fence account ([gfgclaim, player]), ONE per wallet. Holds
/// an immutable "claimed" flag so the 500P signup bonus can only ever be
/// granted once in the program's lifetime, even if a client or server map is
/// forged or lost. Never changes seed; additive-only account type.
#[account]
#[derive(Default)]
pub struct SignupClaim {
    pub version: u8,      // 1 = current
    pub claimed: u8,      // 0 = not claimed, 1 = claimed (permanent)
    pub claimed_ts: i64,  // unix ts when claimed
    pub claim_ref: u64,   // the credit match_ref used
}

/// M7 competition instance ([gfgcomp2, creator, seq]) - the competition itself,
/// fully config-driven (games, tiers, entry, window, pool, shares, redemption).
#[account]
pub struct CompetitionInstance {
    pub version: u8,          // 1 = current
    pub creator: Pubkey,      // instance authority (admin now, sponsors later)
    pub seq: u32,
    pub name: [u8; 24],
    pub games: [u8; MAX_GAMES],   // source_codes of selected games (0 = empty)
    pub game_count: u8,
    pub tier_bits: u8,        // bit k set => level k qualifies (bit2=L2, bit3=L3, ...)
    pub require_all: u8,      // 0 = any-of tiers, 1 = all-of (future, reserved)
    pub entry_cost: u64,
    pub entry_families: u8,   // bit0 global, bit1 local, bit2 premium
    pub starts_at: i64,
    pub ends_at: i64,         // auto-stop (R16)
    pub pool_usd_cents: u64,
    pub pool_points: u64,     // pool in points ($0.002/pt base, set by creator)
    pub winner_count: u8,
    pub prize_shares: [u32; MAX_WINNERS], // redemption units per rank (1..winner_count)
    pub redemption: u8,       // 0 naira, 1 points, 2 crypto, 3 merch (presentational)
    pub payout_mode: u8,      // 0 manual, 1 escrow (later)
    pub status: u8,           // 0 open, 1 closed, 2 settled, 3 cancelled
    pub settled_ts: i64,
}

/// M7 winner record ([gfgwin, comp, rank]) - one per prize slot, on-chain proof
/// of who won which rank and whether they were paid (R15).
#[account]
pub struct WinnerRecord {
    pub version: u8,
    pub comp: Pubkey,
    pub rank: u8,
    pub player: Pubkey,
    pub points: u64,
    pub usd_cents: u64,
    pub status: u8,           // 0 won (pending), 1 paid
    pub paid_ts: i64,
}

/// M7 per-player in-window win tally ([gfgwin, comp, player]) - the durable,
/// on-chain record of verified wins inside a competition window (R13/R16).
/// Written gaslessly by the player's session key (ER); read by the board.
#[account]
pub struct CompetitionTally {
    pub version: u8,
    pub comp: Pubkey,
    pub player: Pubkey,
    pub wins: u64,
    pub first_ts: i64,
    pub last_ts: i64,
}

/// Arc2 M1 (item D): on-chain match board for MULTIPLAYER (earn) matches.
/// Commit-hashed move checkpoints + turn/max clocks + finish winner, so any
/// earn game's match is provable and replayable. Additive; no effect on any
/// existing account layout.
#[account]
pub struct MatchBoard {
    pub version: u8,             // 1 = current
    pub game: u8,                // M1 source_code (1 = ludo, ...)
    pub match_ref: u64,          // lobby-generated unique id
    pub status: u8,              // 0 locked (awaiting players), 1 in_progress, 2 finished
    pub players: [Pubkey; MAX_MP],
    pub player_count: u8,        // how many HUMAN wallets are in
    pub seats: u8,               // total seats (humans + computer fill)
    pub stake_usd_cents: u64,    // each side's stake
    pub seat_pot_usd_cents: u64, // pot = stake * seats  (flat 10% fee at finish)
    pub turn_secs: u64,
    pub max_match_secs: u64,
    pub started_at: i64,
    pub last_turn_ts: [i64; MAX_MP],
    pub move_count: u64,
    pub last_move_commit: [u8; 32],
    pub finished_at: i64,
    pub winner_seat: u8,         // 0..player_count-1, 255 = none yet
}

/// Arc2 M1 (item E): game-AGNOSTIC AGM order (maker/taker). Money only - the
/// game is chosen by the maker (one game per order) and the game's rules
/// profile lives in the games registry (config), not here. All games plug in.
#[account]
pub struct AgmOrder {
    pub version: u8,             // 1 = current
    pub order_id: u64,
    pub game: u8,                // M1 source_code the maker picked
    pub maker: Pubkey,           // payer who posted
    pub stake_usd_cents: u64,    // each side's stake (1 $ .. up to the game cap)
    pub seats: u8,               // total seats wanted (min 2; computers fill rest)
    pub status: u8,              // 0 open, 1 filled(locked by escrow later), 2 matched, 3 cancelled
    pub taker: Pubkey,           // zero until matched
    pub created_at: i64,
}

/// arc2m7b: settlement of a filled order. Reads the stake/seats at lock and
/// computes the flat-10% fee + 90% winner payout (recorded on-chain; actual
/// token move happens in the payout rail or embedded-wallet credit).
#[account]
pub struct AgmSettlement {
    pub version: u8,
    pub order_id: u64,
    pub game: u8,
    pub pot_usd_cents: u64,
    pub fee_usd_cents: u64,     // pot * 10%
    pub seats: u8,
    pub winner_seat: u8,
    pub payout_usd_cents: u64,  // pot * 90% (single winner takes all)
    pub settled_at: i64,
}

/// On-chain PREMIUM points ledger for one player (M5 — subscription + premium
/// points, the launch engine). One account per player, seed [gfgprem, player].
/// Runs gasless on the ER.
///
/// Two tracks, buy-only (never earned from gameplay):
///   - premium_lifetime    : the player's permanent premium-point credential
///                           (never spendable).
///   - premium_spendable   : the spendable premium balance (buys the Active
///                           Tier subscription, lives, and anything else premium
///                           spendable is accepted for - places global spendable
///                           can NEVER go). Acquired ONLY via admin
///                           `credit_premium_points` after a verified purchase.
///
/// Subscription state lives here (never Supabase):
///   - subscription_level     : 0 = free, 2 = Level-2 (2x) at launch.
///   - subscription_active_until : unix ts; a fixed 30-day window, NO auto-renew
///                           (expiry is passive until the next manual purchase).
///
/// `version: u8` is FIRST per upgrade-safety R2 (live layouts are versioned).
/// The MEDIA never merges into global (M4) or local (M3) ledgers.
#[account]
#[derive(InitSpace)]
pub struct PremiumPoints {
    pub version: u8,               // layout version: 1 (original), 2 (adds last_credit_reason)
    pub admin_authority: Pubkey,   // the sponsor/ecror who may credit the ledger
    pub premium_lifetime: u64,     // permanent, never spendable
    pub premium_spendable: u64,    // spendable premium balance (buys the sub)
    pub subscription_level: u8,    // 0=free, 2=Level 2
    pub subscription_active_until: i64, // unix ts expiry; never auto-renewed
    pub last_credit_ts: i64,
    pub last_credit_points: u64,
    pub last_credit_ref: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
    /// On-chain WHY of the most recent credit (M3/M4-style reason tag so modules can
    /// read source without extra metadata). 1 = subscription_payment (Level 2).
    /// Only present on version >= 2 accounts; v1 accounts default to 1 on read.
    pub last_credit_reason: u8,
    /// M5 v3: unlimited-life booster window (unix ts, 72h from activation). while
    /// active, M10 lives are unlimited. version must be >= 3 to have this field.
    pub booster_active_until: i64,
}

/// Exact byte layout of the v2 PremiumPoints account (version 2, includes
/// last_credit_reason). Used ONLY by the permissionless `upgrade_premium_points_v3`
/// migration so v2 accounts upgrade cleanly to v3 (R2).
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct PremiumPointsV2 {
    pub version: u8,
    pub admin_authority: Pubkey,
    pub premium_lifetime: u64,
    pub premium_spendable: u64,
    pub subscription_level: u8,
    pub subscription_active_until: i64,
    pub last_credit_ts: i64,
    pub last_credit_points: u64,
    pub last_credit_ref: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
    pub last_credit_reason: u8,
}

impl Owner for PremiumPointsV2 {
    fn owner() -> Pubkey { crate::ID }
}

impl anchor_lang::AccountDeserialize for PremiumPointsV2 {
    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        Self::skip_disc_read(buf).map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
    }
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        Self::skip_disc_read(buf).map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
    }
}

impl PremiumPointsV2 {
    fn skip_disc_read(buf: &mut &[u8]) -> std::result::Result<Self, anchor_lang::solana_program::program_error::ProgramError> {
        if buf.len() < 8 {
            return Err(anchor_lang::solana_program::program_error::ProgramError::AccountDataTooSmall);
        }
        *buf = &buf[8..];
        <Self as anchor_lang::AnchorDeserialize>::deserialize(buf)
            .map_err(|_| anchor_lang::solana_program::program_error::ProgramError::InvalidAccountData)
    }
}

/// Exact byte layout of the original (v1) PremiumPoints account (115 bytes incl
/// discriminator). Used ONLY by the permissionless `upgrade_premium_points`
/// migration so old bytes keep deserializing and upgrade cleanly (upgrade-safety R2).
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct PremiumPointsV1 {
    pub version: u8,
    pub admin_authority: Pubkey,
    pub premium_lifetime: u64,
    pub premium_spendable: u64,
    pub subscription_level: u8,
    pub subscription_active_until: i64,
    pub last_credit_ts: i64,
    pub last_credit_points: u64,
    pub last_credit_ref: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct AffiliateEntry {
    pub period: u32,
    pub referral: Pubkey,
    pub amount_usd_cents: u64,
    /// 0 = earned (pending), 1 = paid, 2 = forfeited
    pub status: u8,
    pub ts: i64,
}

/// M6 — per-affiliate immutable audit ledger. Authority = relay/sponsor.
/// Running totals are permanent; `entries` keeps the most recent 68 months.
#[account]
pub struct AffiliateAccount {
    pub version: u8,
    pub authority: Pubkey,
    pub affiliate: Pubkey,
    pub lifetime_usd_cents: u64,
    pub pending_usd_cents: u64,
    pub paid_usd_cents: u64,
    pub forfeited_usd_cents: u64,
    pub entry_count: u32,
    pub payout_count: u32,
    pub last_payout_ts: i64,
    pub last_payout_ref: u64,
    pub entries: Box<[AffiliateEntry; AFFILIATE_ENTRIES]>,
}

/// M6 — public identity handle. A player claims a handle once (gasless self-
/// register); the account binds handle -> wallet so referral links and public
/// leaderboards can show a handle and never an email or wallet.
#[account]
#[derive(InitSpace)]
pub struct ProfileHandle {
    pub owner: Pubkey,
    pub created_ts: i64,
}

impl anchor_lang::Space for AffiliateAccount {
    const INIT_SPACE: usize =
        1 + 32 + 32 + 8 + 8 + 8 + 8 + 4 + 4 + 8 + 8 + AFFILIATE_ENTRIES * 53;
}

/// M6 — per (affiliate, referral) state that drives the 60-day permanent
/// forfeit and pause/resume rules.
#[account]
#[derive(InitSpace)]
pub struct AffiliatePair {
    pub version: u8,
    pub affiliate: Pubkey,
    pub referral: Pubkey,
    pub first_subscribed_ts: i64,
    pub last_earned_period: u32,
    pub consecutive_inactive_periods: u16,
    pub forfeited: bool,
    pub paid_period_count: u16,
}

impl Owner for PremiumPointsV1 {
    fn owner() -> Pubkey { crate::ID }
}

impl anchor_lang::AccountDeserialize for PremiumPointsV1 {
    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        Self::skip_disc_read(buf).map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
    }
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        Self::skip_disc_read(buf).map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
    }
}

impl PremiumPointsV1 {
    fn skip_disc_read(buf: &mut &[u8]) -> std::result::Result<Self, anchor_lang::solana_program::program_error::ProgramError> {
        // Skip the 8-byte account discriminator, then read the 13 borsh fields.
        if buf.len() < 8 {
            return Err(anchor_lang::solana_program::program_error::ProgramError::AccountDataTooSmall);
        }
        *buf = &buf[8..];
        <Self as anchor_lang::AnchorDeserialize>::deserialize(buf)
            .map_err(|_| anchor_lang::solana_program::program_error::ProgramError::InvalidAccountData)
    }
}

/// Exact byte layout of the LEGACY (pre-game_tag) PlayerPoints account created
/// by Scope B. Used only by `migrate_points` to read old accounts that predate
/// the per-game seed change. Never ship this layout as a new account; it exists
/// so old bytes keep deserializing and migrate cleanly (upgrade-safety R2).
#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub struct LegacyPlayerPoints {
    pub total_points: u64,
    pub last_points: u64,
    pub last_reason: u8,
    pub last_match_ref: u64,
    pub last_recorded_ts: i64,
    pub award_count: u64,
}

/// On-chain match-result ledger for one player (Scope C — finish order).
///
/// Fields:
///   - finish_order     : finish positions for the match, index i = seat/color
///                        that finished in position i+1 (0 = 1st place).
///   - points           : the reward points recorded for that result.
///   - multiplier       : the Active Tier multiplier that applied.
///   - match_ref        : first 8 bytes (as u64) of the proof-roll tx signature.
///   - last_recorded_ts : unix ts of the most recent result.
///   - result_count     : number of results recorded.
#[account]
#[derive(InitSpace)]
pub struct PlayerResult {
    pub finish_order: [u8; 4],
    pub points: u64,
    pub multiplier: u8,
    pub match_ref: u64,
    pub last_recorded_ts: i64,
    pub result_count: u64,
}

/// Competition lifecycle states.
#[repr(u8)]
pub enum CompState {
    Open = 0,    // entries open, sponsor can fund the pool
    Funded = 1,  // entry closed, pool locked, sponsor can settle
    Settled = 2, // winners allocated, claims open
}

/// One winner's allocation inside a Competition escrow.
#[derive(InitSpace, Default, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct WinnerAlloc {
    pub winner: Pubkey,
    pub amount: u64,
    pub claimed: bool,
}

/// Competition escrow (S2 — earn + brand rake). Seed `gfgcomp` + comp_id.
///
/// The sponsor locks the prize pool on-chain BEFORE the event; on settle the
/// program enforces a 70/30 rake and stores the winner table; winners claim
/// their allocations gasless on the ER.
#[account]
#[derive(InitSpace)]
pub struct Competition {
    pub comp_id: u64,
    pub sponsor: Pubkey,
    pub entry_fee: u64,
    pub ends_at: i64,
    pub prize_pool: u64,
    pub state: u8,
    pub winner_count: u8,
    pub winners: [WinnerAlloc; 3],
}

#[error_code]
pub enum PointsError {
    #[msg("points must be greater than zero")]
    ZeroPoints,
    #[msg("points overflow")]
    Overflow,
    #[msg("unknown or unregistered game tag")]
    InvalidGameTag,
    #[msg("match_ref already recorded (duplicate award guard)")]
    DuplicateMatchRef,
    #[msg("insufficient spendable balance for this local spend")]
    InsufficientBalance,
    #[msg("only the competition sponsor can do this")]
    NotSponsor,
    #[msg("fund amount must be greater than zero")]
    ZeroAmount,
    #[msg("competition is not open")]
    NotOpen,
    #[msg("competition is not funded")]
    NotFunded,
    #[msg("competition is not settled")]
    NotSettled,
    #[msg("competition still running (ends_at not reached)")]
    StillRunning,
    #[msg("winner allocations exceed the 70% winners bucket")]
    OverAlloc,
    #[msg("no such winner index")]
    NoSuchWinner,
    #[msg("allocation belongs to a different player")]
    NotYourAllocation,
    #[msg("allocation already claimed")]
    AlreadyClaimed,
    #[msg("signup bonus already claimed (once per account, forever)")]
    SignupAlreadyClaimed,
    #[msg("unsupported subscription level (2 or 3 at launch)")]
    InvalidLevel,
    #[msg("invalid competition configuration")]
    InvalidCompetition,
    #[msg("only the competition creator can do this")]
    NotCreator,
    #[msg("competition must be closed before winners are recorded")]
    CompetitionNotClosed,
    #[msg("competition must be settled before paying winners")]
    CompetitionNotSettled,
    #[msg("prize rank is out of range for this competition")]
    RankOutOfRange,
    #[msg("premium points credit requires the admin authority signer")]
    NotAdmin,
    #[msg("premium points credit_ref already used (duplicate credit guard)")]
    DuplicateCreditRef,
    #[msg("insufficient premium spendable balance")]
    InsufficientPremiumBalance,
    #[msg("subscription already active — one plan at a time, re-upgrade only after expiry")]
    AlreadyActive,
    #[msg("premium account needs upgrade_premium_points (v2 layout) first")]
    NeedsUpgrade,
    #[msg("affiliate period for this referral already recorded")]
    DuplicateAffiliatePeriod,
    #[msg("profile handle already taken")]
    DuplicateHandle,
    #[msg("profile handle is invalid (5-24 chars, letters/numbers only)")]
    InvalidHandle,
}
