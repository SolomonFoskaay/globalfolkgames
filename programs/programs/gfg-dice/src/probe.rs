// probe.rs - TEMPORARY benchmark module.
//
// Purpose: prove that a delegated, program-owned PDA can be RESIZED (Anchor
// `realloc`) on the MagicBlock ER. This decides whether the Player Core account
// can grow its per-game point buckets dynamically (cheapest for casual players)
// instead of pre-allocating a fixed table.
//
// This module is additive and harmless; it will be removed once the Player Core
// account lands. It touches no live account and no Ludo/Chess state.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

pub const PROBE_SEED: &[u8] = b"gfgprobe";

#[account]
pub struct ProbeAccount {
    pub version: u8,
    pub marker: u8,
    pub len_marker: u32,
}

impl ProbeAccount {
    pub const LEN: usize = 1 + 1 + 4;
}

#[derive(Accounts)]
pub struct ProbeInitCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + ProbeAccount::LEN,
        seeds = [PROBE_SEED, payer.key().as_ref()],
        bump
    )]
    pub probe: Account<'info, ProbeAccount>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct ProbeDelegateCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the probe PDA to delegate.
    #[account(mut, del)]
    pub probe: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(new_len: u32)]
pub struct ProbeResizeCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [PROBE_SEED, payer.key().as_ref()],
        bump,
        realloc = new_len as usize,
        realloc::payer = payer,
        realloc::zero = false,
    )]
    pub probe: Account<'info, ProbeAccount>,
    pub system_program: Program<'info, System>,
}
