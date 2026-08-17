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
// Active Tier (S1, FUTURE/mainnet design, NOT implemented in this build):
//   - `initialize_tier`   : creates the player's TIER PDA (base layer, app
//                           pays rent). Seed `gfgtier`, same player_authority.
//   - `delegate_tier`     : moves the tier PDA into the ER session (base
//                           layer, app pays) so purchases run gasless.
//   - `purchase_tier`     : buys a monthly Active Tier on the ER. The cost is
//                           the player's SPENDABLE balance, derived on-chain
//                           as points.total_points - tier.total_spent (so a
//                           spend can never exceed what was earned on-chain).
//                           FREE for the player (session key signs, no SOL).
// S1 ships WITHOUT these: the multiplier/cap run client + Supabase and the
// existing `record_points` PDA mirrors the boosted award on-chain. Full
// on-chain tier enforcement is deferred to mainnet (see roadmap "Active Tier
// subscriptions + spendable sink").
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
pub const RESULT: &[u8] = b"gfgresult";
pub const COMP: &[u8] = b"gfgcomp";
pub const GLOBAL_TAG: &[u8] = b"global"; // reserved M4 global points tag, no game may use this

pub const RAKE_BPS: u16 = 3000; // 30% platform rake on competition pools
pub const WINNER_SHARES: [u16; 3] = [5000, 3000, 2000]; // 1st/2nd/3rd of the 70% winners bucket

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
    /// `source_tag` is the game or event name ('Ludo', 'signup_bonus', etc.).
    /// `match_ref` guards idempotency (first 8 bytes of the triggering tx sig).
    pub fn record_global_points(
        ctx: Context<RecordGlobalPointsCtx>,
        kind: u8,
        source_tag: String,
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

        dest.last_source = source_tag.as_bytes().first().copied().unwrap_or(0);
        dest.last_points = points;
        dest.last_reason = reason;
        dest.last_match_ref = match_ref;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
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
    pub last_source: u8,             // first byte of the source_tag string
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
}
