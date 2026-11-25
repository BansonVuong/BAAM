// LiteSVM's FailedTransactionMetadata is inherently large; boxing it in test
// helpers would only add noise.
#![allow(clippy::result_large_err)]

mod common;

use {
    accountability::{
        constants::{
            BACK_OUT_CUTOFF_SECS, SPORTS_BET_SEED, SPORTS_VAULT_SEED, STALE_BET_GRACE_SECS,
        },
        error::ErrorCode,
        state::{SportsBet, SportsBetState, SportsVault},
    },
    anchor_lang::{
        prelude::Pubkey, solana_program::instruction::Instruction, AccountDeserialize,
        InstructionData, ToAccountMetas,
    },
    common::*,
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const START: i64 = NOW + 3_600;
const SETTLE_AFTER: i64 = START + 3 * 3_600;
const STALE_AT: i64 = SETTLE_AFTER + STALE_BET_GRACE_SECS;

struct Fx {
    svm: LiteSVM,
    payer: Keypair,
    oracle: Keypair,
    creator: Keypair,
    opponent: Keypair,
    outsider: Keypair,
    game_id: [u8; 32],
    bet: Pubkey,
    vault: Pubkey,
    bet_rent: u64,
    vault_rent: u64,
}

fn setup() -> Fx {
    let mut svm = new_svm();
    let payer = funded(&mut svm);
    let oracle = funded(&mut svm);
    let creator = funded(&mut svm);
    let opponent = funded(&mut svm);
    let outsider = funded(&mut svm);
    let mut game_id = [0u8; 32];
    game_id[..9].copy_from_slice(b"401547439");
    let program_id = accountability::id();
    let (bet, _) = Pubkey::find_program_address(
        &[SPORTS_BET_SEED, creator.pubkey().as_ref(), game_id.as_ref()],
        &program_id,
    );
    let (vault, _) = Pubkey::find_program_address(&[SPORTS_VAULT_SEED, bet.as_ref()], &program_id);
    let bet_rent = svm.minimum_balance_for_rent_exemption(SportsBet::LEN);
    let vault_rent = svm.minimum_balance_for_rent_exemption(SportsVault::LEN);
    Fx {
        svm,
        payer,
        oracle,
        creator,
        opponent,
        outsider,
        game_id,
        bet,
        vault,
        bet_rent,
        vault_rent,
    }
}

// ── instruction builders ───────────────────────────────────────────────────────

fn create_ix(fx: &Fx, settle_after: i64) -> Instruction {
    Instruction::new_with_bytes(
        accountability::id(),
        &accountability::instruction::CreateBet {
            amount: BET_AMOUNT,
            oracle_pubkey: fx.oracle.pubkey(),
            sport: 1,
            game_id: fx.game_id,
            creator_backs_home: true,
            start_time: START,
            settle_after,
        }
        .data(),
        accountability::accounts::CreateBet {
            creator: fx.creator.pubkey(),
            sports_bet: fx.bet,
            vault: fx.vault,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn accept_ix(fx: &Fx, opponent: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        accountability::id(),
        &accountability::instruction::AcceptBet {}.data(),
        accountability::accounts::AcceptBet {
            opponent,
            sports_bet: fx.bet,
            vault: fx.vault,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn cancel_ix(fx: &Fx, creator: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        accountability::id(),
        &accountability::instruction::CancelBet {}.data(),
        accountability::accounts::CancelBet {
            creator,
            sports_bet: fx.bet,
            vault: fx.vault,
        }
        .to_account_metas(None),
    )
}

fn back_out_ix(fx: &Fx, backer: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        accountability::id(),
        &accountability::instruction::BackOut {}.data(),
        accountability::accounts::BackOut {
            backer,
            creator: fx.creator.pubkey(),
            opponent: fx.opponent.pubkey(),
            sports_bet: fx.bet,
            vault: fx.vault,
        }
        .to_account_metas(None),
    )
}

fn settle_ix(fx: &Fx, oracle: Pubkey, home_won: Option<bool>) -> Instruction {
    Instruction::new_with_bytes(
        accountability::id(),
        &accountability::instruction::SettleBet { home_won }.data(),
        accountability::accounts::SettleBet {
            oracle,
            creator: fx.creator.pubkey(),
            opponent: fx.opponent.pubkey(),
            sports_bet: fx.bet,
            vault: fx.vault,
        }
        .to_account_metas(None),
    )
}

fn refund_stale_ix(fx: &Fx, caller: Pubkey, creator: Pubkey, opponent: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        accountability::id(),
        &accountability::instruction::RefundStaleBet {}.data(),
        accountability::accounts::RefundStaleBet {
            caller,
            creator,
            opponent,
            sports_bet: fx.bet,
            vault: fx.vault,
        }
        .to_account_metas(None),
    )
}

// ── flow helpers ───────────────────────────────────────────────────────────────

fn create(fx: &mut Fx) {
    create_with_settle_after(fx, SETTLE_AFTER);
}

fn create_with_settle_after(fx: &mut Fx, settle_after: i64) {
    let ix = create_ix(fx, settle_after);
    send_ix(&mut fx.svm, &fx.payer, &[&fx.creator], ix).unwrap();
}

fn create_and_accept(fx: &mut Fx) {
    create(fx);
    let ix = accept_ix(fx, fx.opponent.pubkey());
    send_ix(&mut fx.svm, &fx.payer, &[&fx.opponent], ix).unwrap();
}

fn settle(fx: &mut Fx, home_won: Option<bool>) -> TxResult {
    let ix = settle_ix(fx, fx.oracle.pubkey(), home_won);
    send_ix(&mut fx.svm, &fx.payer, &[&fx.oracle], ix)
}

fn refund_stale_by_outsider(fx: &mut Fx) -> TxResult {
    let ix = refund_stale_ix(
        fx,
        fx.outsider.pubkey(),
        fx.creator.pubkey(),
        fx.opponent.pubkey(),
    );
    send_ix(&mut fx.svm, &fx.payer, &[&fx.outsider], ix)
}

fn read_bet(fx: &Fx) -> SportsBet {
    let account = fx.svm.get_account(&fx.bet).unwrap();
    SportsBet::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn assert_closed(fx: &Fx) {
    assert!(!exists(&fx.svm, fx.bet), "bet account should be closed");
    assert!(!exists(&fx.svm, fx.vault), "vault account should be closed");
}

fn assert_still_locked(fx: &Fx) {
    assert_eq!(read_bet(fx).state, SportsBetState::Locked);
    assert_eq!(balance(&fx.svm, fx.vault), fx.vault_rent + 2 * BET_AMOUNT);
}

/// Create + accept, oracle settles at `settle_time`; returns
/// (creator_delta, opponent_delta) relative to balances before creation.
fn settled_deltas_at(settle_time: i64, home_won: Option<bool>) -> (i128, i128) {
    let mut fx = setup();
    let creator_before = balance(&fx.svm, fx.creator.pubkey()) as i128;
    let opponent_before = balance(&fx.svm, fx.opponent.pubkey()) as i128;
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, settle_time);
    settle(&mut fx, home_won).unwrap();
    assert_closed(&fx);
    (
        balance(&fx.svm, fx.creator.pubkey()) as i128 - creator_before,
        balance(&fx.svm, fx.opponent.pubkey()) as i128 - opponent_before,
    )
}

fn settled_deltas(home_won: Option<bool>) -> (i128, i128) {
    settled_deltas_at(SETTLE_AFTER, home_won)
}

// ── create / accept ────────────────────────────────────────────────────────────

#[test]
fn create_and_accept_escrow_both_stakes() {
    let mut fx = setup();
    let creator_before = balance(&fx.svm, fx.creator.pubkey());
    let opponent_before = balance(&fx.svm, fx.opponent.pubkey());

    create(&mut fx);
    let bet = read_bet(&fx);
    assert_eq!(bet.state, SportsBetState::Open);
    assert_eq!(bet.opponent, None);
    assert_eq!(
        balance(&fx.svm, fx.creator.pubkey()),
        creator_before - BET_AMOUNT - fx.bet_rent - fx.vault_rent
    );
    assert_eq!(balance(&fx.svm, fx.vault), fx.vault_rent + BET_AMOUNT);

    let ix = accept_ix(&fx, fx.opponent.pubkey());
    send_ix(&mut fx.svm, &fx.payer, &[&fx.opponent], ix).unwrap();
    let bet = read_bet(&fx);
    assert_eq!(bet.state, SportsBetState::Locked);
    assert_eq!(bet.opponent, Some(fx.opponent.pubkey()));
    assert_eq!(
        balance(&fx.svm, fx.opponent.pubkey()),
        opponent_before - BET_AMOUNT
    );
    assert_still_locked(&fx);
}

#[test]
fn accept_after_kickoff_fails() {
    let mut fx = setup();
    create(&mut fx);
    set_time(&mut fx.svm, START);
    let ix = accept_ix(&fx, fx.opponent.pubkey());
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.opponent], ix),
        program_err(ErrorCode::GameStarted),
    );
    assert_eq!(read_bet(&fx).state, SportsBetState::Open);
}

#[test]
fn self_accept_fails() {
    let mut fx = setup();
    create(&mut fx);
    let ix = accept_ix(&fx, fx.creator.pubkey());
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.creator], ix),
        program_err(ErrorCode::SelfBet),
    );
}

#[test]
fn accept_locked_bet_fails() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    let ix = accept_ix(&fx, fx.outsider.pubkey());
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.outsider], ix),
        program_err(ErrorCode::BetNotOpen),
    );
}

// ── settle ─────────────────────────────────────────────────────────────────────

#[test]
fn settle_home_win_pays_creator_who_backed_home() {
    let (creator_delta, opponent_delta) = settled_deltas(Some(true));
    // Creator: staked 1x, got the 2x pot back, plus both accounts' rent refunded.
    assert_eq!(creator_delta, BET_AMOUNT as i128);
    assert_eq!(opponent_delta, -(BET_AMOUNT as i128));
}

#[test]
fn settle_away_win_pays_opponent() {
    let (creator_delta, opponent_delta) = settled_deltas(Some(false));
    assert_eq!(creator_delta, -(BET_AMOUNT as i128));
    assert_eq!(opponent_delta, BET_AMOUNT as i128);
}

#[test]
fn settle_draw_refunds_both() {
    let (creator_delta, opponent_delta) = settled_deltas(None);
    assert_eq!(creator_delta, 0);
    assert_eq!(opponent_delta, 0);
}

#[test]
fn non_oracle_cannot_settle() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, SETTLE_AFTER);
    for impostor in [&fx.outsider, &fx.creator, &fx.opponent] {
        let ix = settle_ix(&fx, impostor.pubkey(), Some(true));
        let result = send_ix(&mut fx.svm, &fx.payer, &[impostor], ix);
        assert_custom_err(result, program_err(ErrorCode::UnauthorizedOracle));
    }
    assert_still_locked(&fx);
}

#[test]
fn settle_before_settle_after_fails() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, SETTLE_AFTER - 1);
    assert_custom_err(
        settle(&mut fx, Some(true)),
        program_err(ErrorCode::SettleTooEarly),
    );
    assert_still_locked(&fx);
}

#[test]
fn settle_open_bet_fails() {
    let mut fx = setup();
    create(&mut fx);
    set_time(&mut fx.svm, SETTLE_AFTER);
    // No opponent yet; pass an arbitrary account in the opponent slot.
    let mut ix = settle_ix(&fx, fx.oracle.pubkey(), Some(true));
    ix.accounts[2].pubkey = fx.outsider.pubkey();
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.oracle], ix),
        program_err(ErrorCode::BetNotLocked),
    );
}

#[test]
fn settle_with_wrong_opponent_fails() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, SETTLE_AFTER);
    let mut ix = settle_ix(&fx, fx.oracle.pubkey(), Some(false));
    ix.accounts[2].pubkey = fx.outsider.pubkey();
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.oracle], ix),
        program_err(ErrorCode::InvalidOpponent),
    );
    assert_still_locked(&fx);
}

#[test]
fn double_settle_rejected() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, SETTLE_AFTER);
    settle(&mut fx, Some(true)).unwrap();
    let creator_after = balance(&fx.svm, fx.creator.pubkey());

    // Second settle in a later transaction: the bet account is gone.
    assert_custom_err(
        settle(&mut fx, Some(true)),
        anchor_err(anchor_lang::error::ErrorCode::AccountNotInitialized),
    );
    assert_eq!(balance(&fx.svm, fx.creator.pubkey()), creator_after);
}

#[test]
fn double_settle_in_one_transaction_rejected() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, SETTLE_AFTER);
    let ixs = [
        settle_ix(&fx, fx.oracle.pubkey(), Some(true)),
        settle_ix(&fx, fx.oracle.pubkey(), Some(true)),
    ];
    assert!(send_ixs(&mut fx.svm, &fx.payer, &[&fx.oracle], &ixs).is_err());
    // Atomic: nothing moved.
    assert_still_locked(&fx);
}

// ── cancel ─────────────────────────────────────────────────────────────────────

#[test]
fn creator_can_cancel_open_bet() {
    let mut fx = setup();
    let creator_before = balance(&fx.svm, fx.creator.pubkey());
    create(&mut fx);
    let ix = cancel_ix(&fx, fx.creator.pubkey());
    send_ix(&mut fx.svm, &fx.payer, &[&fx.creator], ix).unwrap();
    assert_eq!(balance(&fx.svm, fx.creator.pubkey()), creator_before);
    assert_closed(&fx);
}

#[test]
fn non_creator_cannot_cancel() {
    let mut fx = setup();
    create(&mut fx);
    let ix = cancel_ix(&fx, fx.outsider.pubkey());
    // Seeds are derived from the signer, so a stranger fails the PDA check.
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.outsider], ix),
        anchor_err(anchor_lang::error::ErrorCode::ConstraintSeeds),
    );
    assert_eq!(read_bet(&fx).state, SportsBetState::Open);
}

#[test]
fn cannot_cancel_locked_bet() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    let ix = cancel_ix(&fx, fx.creator.pubkey());
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.creator], ix),
        program_err(ErrorCode::BetNotOpen),
    );
    assert_still_locked(&fx);
}

// ── back out ───────────────────────────────────────────────────────────────────
//
// NOTE: back_out is currently UNILATERAL — either participant alone can unwind a
// locked bet (no co-signature from the other side). These tests pin down that
// current behaviour; it is flagged for product review.

fn back_out_refunds(backer_is_creator: bool) {
    let mut fx = setup();
    let creator_before = balance(&fx.svm, fx.creator.pubkey());
    let opponent_before = balance(&fx.svm, fx.opponent.pubkey());
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, START - BACK_OUT_CUTOFF_SECS - 1);

    let backer = if backer_is_creator {
        &fx.creator
    } else {
        &fx.opponent
    };
    let ix = back_out_ix(&fx, backer.pubkey());
    send_ix(&mut fx.svm, &fx.payer, &[backer], ix).unwrap();

    assert_eq!(balance(&fx.svm, fx.creator.pubkey()), creator_before);
    assert_eq!(balance(&fx.svm, fx.opponent.pubkey()), opponent_before);
    assert_closed(&fx);
}

#[test]
fn creator_alone_can_back_out_inside_window() {
    back_out_refunds(true);
}

#[test]
fn opponent_alone_can_back_out_inside_window() {
    back_out_refunds(false);
}

#[test]
fn back_out_at_cutoff_fails() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, START - BACK_OUT_CUTOFF_SECS);
    let ix = back_out_ix(&fx, fx.opponent.pubkey());
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.opponent], ix),
        program_err(ErrorCode::BackOutWindowClosed),
    );
    assert_still_locked(&fx);
}

#[test]
fn outsider_cannot_back_out() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    let ix = back_out_ix(&fx, fx.outsider.pubkey());
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.outsider], ix),
        program_err(ErrorCode::NotAParticipant),
    );
    assert_still_locked(&fx);
}

// ── refund_stale_bet (permissionless escape hatch) ─────────────────────────────

#[test]
fn stale_refund_before_grace_fails() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    for t in [SETTLE_AFTER, STALE_AT - 1] {
        set_time(&mut fx.svm, t);
        assert_custom_err(
            refund_stale_by_outsider(&mut fx),
            program_err(ErrorCode::StaleGraceNotElapsed),
        );
    }
    assert_still_locked(&fx);
}

#[test]
fn stale_refund_after_grace_by_random_third_party() {
    let mut fx = setup();
    let creator_before = balance(&fx.svm, fx.creator.pubkey());
    let opponent_before = balance(&fx.svm, fx.opponent.pubkey());
    let outsider_before = balance(&fx.svm, fx.outsider.pubkey());
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, STALE_AT);

    refund_stale_by_outsider(&mut fx).unwrap();

    // Both sides whole again; creator also recovers both accounts' rent.
    assert_eq!(balance(&fx.svm, fx.creator.pubkey()), creator_before);
    assert_eq!(balance(&fx.svm, fx.opponent.pubkey()), opponent_before);
    assert_eq!(balance(&fx.svm, fx.outsider.pubkey()), outsider_before);
    assert_closed(&fx);

    // Oracle arriving late cannot settle the refunded bet; nor can a second refund.
    assert_custom_err(
        settle(&mut fx, Some(true)),
        anchor_err(anchor_lang::error::ErrorCode::AccountNotInitialized),
    );
    assert_custom_err(
        refund_stale_by_outsider(&mut fx),
        anchor_err(anchor_lang::error::ErrorCode::AccountNotInitialized),
    );
}

#[test]
fn participant_can_also_trigger_stale_refund() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, STALE_AT + 1);
    let ix = refund_stale_ix(
        &fx,
        fx.opponent.pubkey(),
        fx.creator.pubkey(),
        fx.opponent.pubkey(),
    );
    send_ix(&mut fx.svm, &fx.payer, &[&fx.opponent], ix).unwrap();
    assert_closed(&fx);
}

#[test]
fn oracle_can_still_settle_after_grace_if_nobody_refunded() {
    let (creator_delta, opponent_delta) = settled_deltas_at(STALE_AT + 10, Some(false));
    assert_eq!(creator_delta, -(BET_AMOUNT as i128));
    assert_eq!(opponent_delta, BET_AMOUNT as i128);
}

#[test]
fn stale_refund_on_open_bet_fails() {
    let mut fx = setup();
    create(&mut fx);
    set_time(&mut fx.svm, STALE_AT);
    let ix = refund_stale_ix(
        &fx,
        fx.outsider.pubkey(),
        fx.creator.pubkey(),
        fx.opponent.pubkey(),
    );
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.outsider], ix),
        program_err(ErrorCode::BetNotLocked),
    );
    assert_eq!(read_bet(&fx).state, SportsBetState::Open);
}

#[test]
fn stale_refund_rejects_wrong_opponent() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, STALE_AT);
    let ix = refund_stale_ix(
        &fx,
        fx.outsider.pubkey(),
        fx.creator.pubkey(),
        fx.outsider.pubkey(),
    );
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.outsider], ix),
        program_err(ErrorCode::InvalidOpponent),
    );
    assert_still_locked(&fx);
}

#[test]
fn stale_refund_rejects_wrong_creator() {
    let mut fx = setup();
    create_and_accept(&mut fx);
    set_time(&mut fx.svm, STALE_AT);
    let ix = refund_stale_ix(
        &fx,
        fx.outsider.pubkey(),
        fx.outsider.pubkey(),
        fx.opponent.pubkey(),
    );
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.outsider], ix),
        anchor_err(anchor_lang::error::ErrorCode::ConstraintHasOne),
    );
    assert_still_locked(&fx);
}

#[test]
fn stale_refund_with_huge_settle_after_does_not_overflow() {
    let mut fx = setup();
    create_with_settle_after(&mut fx, i64::MAX);
    let ix = accept_ix(&fx, fx.opponent.pubkey());
    send_ix(&mut fx.svm, &fx.payer, &[&fx.opponent], ix).unwrap();
    set_time(&mut fx.svm, i64::MAX - 1);
    assert_custom_err(
        refund_stale_by_outsider(&mut fx),
        program_err(ErrorCode::StaleGraceNotElapsed),
    );
    assert_still_locked(&fx);
}
