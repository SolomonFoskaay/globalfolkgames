// core.rs - PLAYER CORE ACCOUNT (arcv2m3, the law).
//
// ONE on-chain account per player instead of one PDA per feature per game.
// Seed [gfgcore, player]. It holds lives, the global ledgers, premium, the last
// result digest, and a bounded table of per-game point BUCKETS (24 bytes each,
// keyed by the 8-byte game tag). Adding a platform game NEVER adds an account
// and never needs a program change.
//
// Build law: layout is fixed and versioned (version u8 FIRST). Any future change
// ships a permissionless, idempotent migrate_* in the SAME build. Do not
// reorder, rename, or remove fields.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

pub const CORE_SEED: &[u8] = b"gfgcore";
pub const CORE_BUCKETS: usize = 24;
pub const CORE_DEFAULT_POOL: u16 = 5;

/// One per-game bucket: 24 bytes. Keyed by the 8-byte game tag so no numeric
/// registry exists and a new game needs no program change. A runtime vector of
/// protocol metadata needs large stack space; this anchor's small fixed array
/// alone generates a tiny frame, so keep it in the account data (not on stack).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct GameBucket {
    pub game_tag: [u8; 8],
    pub local_pure: u64,
    pub local_spendable: u64,
}

#[account]
pub struct PlayerCore {
    pub version: u8,
    pub player: Pubkey,
    pub created_at: i64,
    // lives (charged AT GAME START)
    pub lives_day: i64,
    pub lives_used: u16,
    pub lives_pool: u16,
    pub unlimited_until: i64,
    pub last_life_ref: u64,
    pub last_life_ts: i64,
    pub lives_award_count: u64,
    // global ledgers
    pub global_pure: u64,
    pub global_lifetime: u64,
    pub global_spendable: u64,
    // premium (subscription + booster), direct-activate
    pub premium_lifetime: u64,
    pub premium_spendable: u64,
    pub subscription_level: u8,
    pub subscription_active_until: i64,
    pub booster_active_until: i64,
    pub last_credit_ref: u64,
    // last result (for the seam / profile) + idempotency refs
    pub last_match_ref: u64,
    pub last_global_ref: u64,
    pub last_finish_digest: [u8; 8],
    // per-game point buckets
    pub bucket_count: u8,
    pub buckets: [GameBucket; CORE_BUCKETS],
    pub bump: u8,
    /// The admin/operator authority (set to the initializer = sponsor relay).
    /// Gates premium credit and plan/booster activation (direct, after a
    /// verified payment). Kept LAST so earlier offsets never shift.
    pub admin_authority: Pubkey,
}

impl PlayerCore {
    // Fixed Borsh length (no padding). Must equal the serialized size.
    pub const LEN: usize = 1 + 32 + 8            // version, player, created_at
        + 8 + 2 + 2 + 8 + 8 + 8 + 8              // lives
        + 8 + 8 + 8                              // global
        + 8 + 8 + 1 + 8 + 8 + 8                  // premium
        + 8 + 8 + 8                              // last result (match_ref, global_ref, digest)
        + 1 + (8 + 8 + 8) * CORE_BUCKETS         // bucket_count + buckets
        + 1                                       // bump
        + 32; // admin_authority (last; keeps earlier offsets stable)

    /// Find the bucket index for a game tag, or None.
    pub fn find_bucket(&self, tag: &[u8; 8]) -> Option<usize> {
        for i in 0..self.bucket_count as usize {
            if &self.buckets[i].game_tag == tag { return Some(i); }
        }
        None
    }

    /// Find or append the bucket for a game tag, returning its index.
    pub fn ensure_bucket(&mut self, tag: &[u8; 8]) -> Result<usize> {
        if let Some(i) = self.find_bucket(tag) { return Ok(i); }
        let n = self.bucket_count as usize;
        require!(n < CORE_BUCKETS, crate::PointsError::CoreBucketsFull);
        self.buckets[n].game_tag = *tag;
        self.buckets[n].local_pure = 0;
        self.buckets[n].local_spendable = 0;
        self.bucket_count = (n + 1) as u8;
        Ok(n)
    }

    /// Charge ONE life AT GAME START (never on completion). Unlimited (booster
    /// or premium active) draws nothing but stamps the ref. Callers charge only
    /// on a real transition so a retry can never double-charge.
    pub fn charge_life(&mut self, now: i64, match_ref: u64) -> Result<()> {
        if self.unlimited_until > 0 && self.unlimited_until > now {
            self.last_life_ref = match_ref;
            self.last_life_ts = now;
            return Ok(());
        }
        let day = now / 86400;
        if self.lives_day != day { self.lives_day = day; self.lives_used = 0; } // GMT+00 refill
        require!(self.lives_used < self.lives_pool, crate::PointsError::NoLives);
        self.lives_used = self.lives_used.checked_add(1).ok_or(crate::PointsError::Overflow)?;
        self.last_life_ref = match_ref;
        self.last_life_ts = now;
        self.lives_award_count = self.lives_award_count.checked_add(1).ok_or(crate::PointsError::Overflow)?;
        Ok(())
    }

    /// Credit the global ledgers. kind 0 = game win (pure + lifetime +
    /// spendable); kind 1 = other sources (lifetime + spendable only, never
    /// pure). Idempotent by `last_global_ref`.
    pub fn record_global(&mut self, kind: u8, points: u64, match_ref: u64) -> Result<()> {
        if kind == 0 {
            self.global_pure = self.global_pure.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        }
        self.global_lifetime = self.global_lifetime.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        self.global_spendable = self.global_spendable.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        self.last_global_ref = match_ref;
        Ok(())
    }

    /// Spend from the global spendable balance.
    pub fn spend_global(&mut self, amount: u64) -> Result<()> {
        require!(self.global_spendable >= amount, crate::PointsError::InsufficientBalance);
        self.global_spendable = self.global_spendable.checked_sub(amount).ok_or(crate::PointsError::InsufficientBalance)?;
        Ok(())
    }

    /// Credit premium points (admin/operated). The direct-activation flow keeps
    /// this for promos; a purchase activates the plan directly (no middleman).
    pub fn credit_premium(&mut self, points: u64, credit_ref: u64) -> Result<()> {
        require!(self.last_credit_ref != credit_ref, crate::PointsError::DuplicateCreditRef);
        self.premium_lifetime = self.premium_lifetime.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        self.premium_spendable = self.premium_spendable.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        self.last_credit_ref = credit_ref;
        Ok(())
    }

    /// DIRECT activation: set the plan level + expiry in ONE step (pay -> active,
    /// no premium-points middleman, no second click). Lives pool follows the
    /// tier (free/other 5, L2 10, L3 15).
    pub fn activate_plan(&mut self, level: u8, until: i64) -> Result<()> {
        self.subscription_level = level;
        self.subscription_active_until = until;
        self.lives_pool = if level >= 3 { 15 } else if level == 2 { 10 } else { 5 };
        Ok(())
    }

    /// DIRECT booster activation (unlimited lives until `until`).
    pub fn activate_booster(&mut self, until: i64) -> Result<()> {
        if until > self.booster_active_until { self.booster_active_until = until; }
        Ok(())
    }
}

/// Pad a game tag string into the fixed 8-byte slot (idempotent).
pub fn game_tag8(tag: &str) -> [u8; 8] {
    let mut out = [0u8; 8];
    let b = tag.as_bytes();
    let n = if b.len() < 8 { b.len() } else { 8 };
    out[..n].copy_from_slice(&b[..n]);
    out
}

#[derive(Accounts)]
pub struct InitializeCoreCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + PlayerCore::LEN,
        seeds = [CORE_SEED, player_authority.key().as_ref()],
        bump
    )]
    pub core: Account<'info, PlayerCore>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateCoreCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: the core PDA to delegate.
    #[account(mut, del)]
    pub core: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateCoreCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Account<'info, PlayerCore>,
}

/// Record a per-game local award into the player's core bucket (gasless ER).
/// Payer is the sponsor/payer (relay); the credit lands on `player_authority`'s
/// bucket. Idempotent by match_ref (global last-match guard).
#[derive(Accounts)]
pub struct RecordCorePointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

/// Credit the global ledgers into the player's core (gasless ER). kind 0 = win.
#[derive(Accounts)]
pub struct RecordCoreGlobalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

/// Spend from the core's global spendable balance (gasless ER).
#[derive(Accounts)]
pub struct SpendCoreGlobalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

/// Admin-gated premium credit + DIRECT plan/booster activation on the core. The
/// payer must equal the core's stored `admin_authority` (the sponsor relay),
/// which signs only after a verified payment.
#[derive(Accounts)]
pub struct CoreAdminCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}
