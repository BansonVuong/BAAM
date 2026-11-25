// LiteSVM's FailedTransactionMetadata is inherently large; boxing it in test
// helpers would only add noise.
#![allow(clippy::result_large_err)]

mod common;

use {
    accountability::{
        constants::{SOCIAL_BET_SEED, SOCIAL_VAULT_SEED, STALE_BET_GRACE_SECS},
        error::ErrorCode,
        state::{SocialBet, SocialBetState, SocialVault},
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

const END_DATE: i64 = NOW + 86_400;
const STALE_AT: i64 = END_DATE + STALE_BET_GRACE_SECS;

const FALLBACK_RETURN: u8 = 0;
const FALLBACK_BURN: u8 = 1;
const FALLBACK_CHARITY: u8 = 2;

/// Placeholder for the (ignored) destination when the fallback is "return".
/// Deliberately not `Pubkey::default()`: that is the system program, a reserved
/// key the runtime demotes to read-only, which would trip the `mut` constraint.
const NO_DEST: Pubkey = Pubkey::new_from_array([9u8; 32]);

fn incinerator() -> Pubkey {
    "1nc1nerator11111111111111111111111111111111"
        .parse()
        .unwrap()
}

struct Fx {
    svm: LiteSVM,
    payer: Keypair,
    oracle: Keypair,
    challenger: Keypair,
    opponent: Keypair,
    outsider: Keypair,
    charity: Pubkey,
    bet_id: [u8; 32],
    bet: Pubkey,
    vault: Pubkey,
    bet_rent: u64,
    vault_rent: u64,
}

fn setup() -> Fx {
    let mut svm = new_svm();
    let payer = funded(&mut svm);
    let oracle = funded(&mut svm);
    let challenger = funded(&mut svm);
    let opponent = funded(&mut svm);
    let outsider = funded(&mut svm);
    // Charity starts empty: proves an unfunded destination can receive the pot.
    let charity = Keypair::new().pubkey();
    let bet_id = [7u8; 32];
    let program_id = accountability::id();
    let (bet, _) = Pubkey::find_program_address(
        &[
            SOCIAL_BET_SEED,
            challenger.pubkey().as_ref(),
            bet_id.as_ref(),
        ],
        &program_id,
    );
    let (vault, _) = Pubkey::find_program_address(&[SOCIAL_VAULT_SEED, bet.as_ref()], &program_id);
    let bet_rent = svm.minimum_balance_for_rent_exemption(SocialBet::LEN);
    let vault_rent = svm.minimum_balance_for_rent_exemption(SocialVault::LEN);
    Fx {
        svm,
        payer,
        oracle,
        challenger,
        opponent,
        outsider,
        charity,
        bet_id,
        bet,
        vault,
        bet_rent,
        vault_rent,
    }
}

// ── instruction builders ───────────────────────────────────────────────────────

fn escrow_ix(fx: &Fx, end_date: i64, fallback_kind: u8, fallback_dest: Pubkey) -> Instruction {
    escrow_ix_with(
        fx,
        fx.opponent.pubkey(),
        end_date,
        fallback_kind,
        fallback_dest,
    )
}

fn escrow_ix_with(
    fx: &Fx,
    opponent: Pubkey,
    end_date: i64,
    fallback_kind: u8,
    fallback_dest: Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        accountability::id(),
        &accountability::instruction::EscrowBet {
            amount: BET_AMOUNT,
            oracle_pubkey: fx.oracle.pubkey(),
            bet_id: fx.bet_id,
            end_date,
            fallback_kind,
            fallback_dest,
        }
        .data(),
        accountability::accounts::EscrowBet {
            challenger: fx.challenger.pubkey(),
            opponent,
            social_bet: fx.bet,
            vault: fx.vault,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn settle_ix(fx: &Fx, oracle: Pubkey, destination: Pubkey, outcome: u8) -> Instruction {
    Instruction::new_with_bytes(
        accountability::id(),
        &accountability::instruction::SettleSocial { outcome }.data(),
        accountability::accounts::SettleSocial {
            oracle,
            challenger: fx.challenger.pubkey(),
            opponent: fx.opponent.pubkey(),
            destination,
            social_bet: fx.bet,
            vault: fx.vault,
        }
        .to_account_metas(None),
    )
}

fn stale_ix(fx: &Fx, caller: Pubkey, destination: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        accountability::id(),
        &accountability::instruction::FallbackStaleSocial {}.data(),
        accountability::accounts::FallbackStaleSocial {
            caller,
            challenger: fx.challenger.pubkey(),
            opponent: fx.opponent.pubkey(),
            destination,
            social_bet: fx.bet,
            vault: fx.vault,
        }
        .to_account_metas(None),
    )
}

// ── flow helpers ───────────────────────────────────────────────────────────────

// Methods (not free fns) so call sites can read `fx.charity` etc. as arguments.
impl Fx {
    fn escrow(&mut self, fallback_kind: u8, fallback_dest: Pubkey) {
        self.escrow_until(END_DATE, fallback_kind, fallback_dest);
    }

    fn escrow_until(&mut self, end_date: i64, fallback_kind: u8, fallback_dest: Pubkey) {
        let ix = escrow_ix(self, end_date, fallback_kind, fallback_dest);
        send_ix(
            &mut self.svm,
            &self.payer,
            &[&self.challenger, &self.opponent],
            ix,
        )
        .unwrap();
    }

    fn oracle_settle(&mut self, destination: Pubkey, outcome: u8) -> TxResult {
        let ix = settle_ix(self, self.oracle.pubkey(), destination, outcome);
        send_ix(&mut self.svm, &self.payer, &[&self.oracle], ix)
    }

    fn stale_by_outsider(&mut self, destination: Pubkey) -> TxResult {
        let ix = stale_ix(self, self.outsider.pubkey(), destination);
        send_ix(&mut self.svm, &self.payer, &[&self.outsider], ix)
    }
}

fn read_bet(fx: &Fx) -> SocialBet {
    let account = fx.svm.get_account(&fx.bet).unwrap();
    SocialBet::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn assert_closed(fx: &Fx) {
    assert!(!exists(&fx.svm, fx.bet), "bet account should be closed");
    assert!(!exists(&fx.svm, fx.vault), "vault account should be closed");
}

fn assert_still_locked(fx: &Fx) {
    assert_eq!(read_bet(fx).state, SocialBetState::Locked);
    assert_eq!(balance(&fx.svm, fx.vault), fx.vault_rent + 2 * BET_AMOUNT);
}

struct Balances {
    challenger: u64,
    opponent: u64,
    outsider: u64,
    charity: u64,
    incinerator: u64,
}

fn snapshot(fx: &Fx) -> Balances {
    Balances {
        challenger: balance(&fx.svm, fx.challenger.pubkey()),
        opponent: balance(&fx.svm, fx.opponent.pubkey()),
        outsider: balance(&fx.svm, fx.outsider.pubkey()),
        charity: balance(&fx.svm, fx.charity),
        incinerator: balance(&fx.svm, incinerator()),
    }
}

// ── escrow ─────────────────────────────────────────────────────────────────────

#[test]
fn escrow_locks_both_stakes() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_CHARITY, fx.charity);

    let bet = read_bet(&fx);
    assert_eq!(bet.challenger, fx.challenger.pubkey());
    assert_eq!(bet.opponent, fx.opponent.pubkey());
    assert_eq!(bet.amount, BET_AMOUNT);
    assert_eq!(bet.oracle_pubkey, fx.oracle.pubkey());
    assert_eq!(bet.end_date, END_DATE);
    assert_eq!(bet.fallback_kind, FALLBACK_CHARITY);
    assert_eq!(bet.fallback_dest, fx.charity);
    assert_still_locked(&fx);
    // Challenger pays both accounts' rent.
    assert_eq!(
        balance(&fx.svm, fx.challenger.pubkey()),
        before.challenger - BET_AMOUNT - fx.bet_rent - fx.vault_rent
    );
    assert_eq!(
        balance(&fx.svm, fx.opponent.pubkey()),
        before.opponent - BET_AMOUNT
    );
}

#[test]
fn escrow_requires_opponent_signature() {
    let mut fx = setup();
    let mut ix = escrow_ix(&fx, END_DATE, FALLBACK_RETURN, NO_DEST);
    ix.accounts[1].is_signer = false;
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.challenger], ix),
        anchor_err(anchor_lang::error::ErrorCode::AccountNotSigner),
    );
    assert!(!exists(&fx.svm, fx.bet));
}

#[test]
fn escrow_validates_inputs() {
    let mut fx = setup();

    let ix = escrow_ix(&fx, END_DATE, 3, NO_DEST);
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.challenger, &fx.opponent], ix),
        program_err(ErrorCode::InvalidFallbackKind),
    );

    let ix = escrow_ix(&fx, NOW, FALLBACK_RETURN, NO_DEST);
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.challenger, &fx.opponent], ix),
        program_err(ErrorCode::InvalidEndDate),
    );

    let ix = escrow_ix_with(
        &fx,
        fx.challenger.pubkey(),
        END_DATE,
        FALLBACK_RETURN,
        NO_DEST,
    );
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.challenger], ix),
        program_err(ErrorCode::SelfBet),
    );
}

// ── settle_social: winner outcomes ─────────────────────────────────────────────

#[test]
fn settle_outcome_0_pays_challenger() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_CHARITY, fx.charity);
    fx.oracle_settle(fx.charity, 0).unwrap();

    assert_eq!(
        balance(&fx.svm, fx.challenger.pubkey()),
        before.challenger + BET_AMOUNT
    );
    assert_eq!(
        balance(&fx.svm, fx.opponent.pubkey()),
        before.opponent - BET_AMOUNT
    );
    assert_eq!(balance(&fx.svm, fx.charity), before.charity);
    assert_closed(&fx);
}

#[test]
fn settle_outcome_1_pays_opponent_and_rent_returns_to_challenger() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_CHARITY, fx.charity);
    // Oracle may settle a winner at any time — including before end_date.
    fx.oracle_settle(fx.charity, 1).unwrap();

    assert_eq!(
        balance(&fx.svm, fx.challenger.pubkey()),
        before.challenger - BET_AMOUNT
    );
    assert_eq!(
        balance(&fx.svm, fx.opponent.pubkey()),
        before.opponent + BET_AMOUNT
    );
    assert_closed(&fx);
}

#[test]
fn settle_rejects_unknown_outcome() {
    let mut fx = setup();
    fx.escrow(FALLBACK_RETURN, NO_DEST);
    assert_custom_err(
        fx.oracle_settle(NO_DEST, 3),
        program_err(ErrorCode::InvalidOutcome),
    );
    assert_still_locked(&fx);
}

#[test]
fn non_oracle_cannot_settle_social() {
    let mut fx = setup();
    fx.escrow(FALLBACK_RETURN, NO_DEST);
    for impostor in [&fx.outsider, &fx.challenger, &fx.opponent] {
        let ix = settle_ix(&fx, impostor.pubkey(), NO_DEST, 0);
        let result = send_ix(&mut fx.svm, &fx.payer, &[impostor], ix);
        assert_custom_err(result, program_err(ErrorCode::UnauthorizedOracle));
    }
    assert_still_locked(&fx);
}

#[test]
fn double_settle_social_rejected() {
    let mut fx = setup();
    fx.escrow(FALLBACK_RETURN, NO_DEST);
    fx.oracle_settle(NO_DEST, 0).unwrap();
    assert_custom_err(
        fx.oracle_settle(NO_DEST, 1),
        anchor_err(anchor_lang::error::ErrorCode::AccountNotInitialized),
    );
}

// ── settle_social: oracle fallback (outcome 2) ─────────────────────────────────

#[test]
fn oracle_fallback_before_end_date_fails() {
    let mut fx = setup();
    fx.escrow(FALLBACK_RETURN, NO_DEST);
    set_time(&mut fx.svm, END_DATE - 1);
    assert_custom_err(
        fx.oracle_settle(NO_DEST, 2),
        program_err(ErrorCode::FallbackTooEarly),
    );
    assert_still_locked(&fx);
}

#[test]
fn oracle_fallback_return_refunds_both() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_RETURN, NO_DEST);
    set_time(&mut fx.svm, END_DATE);
    // Destination is ignored for "return"; pass an unrelated account.
    fx.oracle_settle(fx.outsider.pubkey(), 2).unwrap();

    assert_eq!(balance(&fx.svm, fx.challenger.pubkey()), before.challenger);
    assert_eq!(balance(&fx.svm, fx.opponent.pubkey()), before.opponent);
    assert_eq!(balance(&fx.svm, fx.outsider.pubkey()), before.outsider);
    assert_closed(&fx);
}

#[test]
fn oracle_fallback_burn_sends_pot_to_incinerator() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_BURN, incinerator());
    set_time(&mut fx.svm, END_DATE);
    fx.oracle_settle(incinerator(), 2).unwrap();

    assert_eq!(
        balance(&fx.svm, incinerator()),
        before.incinerator + 2 * BET_AMOUNT
    );
    assert_eq!(
        balance(&fx.svm, fx.challenger.pubkey()),
        before.challenger - BET_AMOUNT
    );
    assert_eq!(
        balance(&fx.svm, fx.opponent.pubkey()),
        before.opponent - BET_AMOUNT
    );
    assert_closed(&fx);
}

#[test]
fn oracle_fallback_charity_sends_pot_to_charity() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_CHARITY, fx.charity);
    set_time(&mut fx.svm, END_DATE + 5);
    fx.oracle_settle(fx.charity, 2).unwrap();

    assert_eq!(
        balance(&fx.svm, fx.charity),
        before.charity + 2 * BET_AMOUNT
    );
    assert_eq!(
        balance(&fx.svm, fx.challenger.pubkey()),
        before.challenger - BET_AMOUNT
    );
    assert_eq!(
        balance(&fx.svm, fx.opponent.pubkey()),
        before.opponent - BET_AMOUNT
    );
    assert_closed(&fx);
}

#[test]
fn oracle_fallback_rejects_wrong_destination() {
    for kind in [FALLBACK_BURN, FALLBACK_CHARITY] {
        let mut fx = setup();
        fx.escrow(kind, fx.charity);
        set_time(&mut fx.svm, END_DATE);
        assert_custom_err(
            fx.oracle_settle(fx.outsider.pubkey(), 2),
            program_err(ErrorCode::InvalidDestination),
        );
        assert_still_locked(&fx);
    }
}

// ── fallback_stale_social (permissionless escape hatch) ────────────────────────

#[test]
fn stale_fallback_before_grace_fails() {
    let mut fx = setup();
    fx.escrow(FALLBACK_RETURN, NO_DEST);
    // Even after end_date (when the oracle could run it), strangers must wait.
    for t in [END_DATE - 1, END_DATE, STALE_AT - 1] {
        set_time(&mut fx.svm, t);
        assert_custom_err(
            fx.stale_by_outsider(NO_DEST),
            program_err(ErrorCode::StaleGraceNotElapsed),
        );
    }
    assert_still_locked(&fx);
}

#[test]
fn stale_fallback_return_by_random_third_party() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_RETURN, NO_DEST);
    set_time(&mut fx.svm, STALE_AT);
    fx.stale_by_outsider(fx.outsider.pubkey()).unwrap();

    assert_eq!(balance(&fx.svm, fx.challenger.pubkey()), before.challenger);
    assert_eq!(balance(&fx.svm, fx.opponent.pubkey()), before.opponent);
    assert_eq!(balance(&fx.svm, fx.outsider.pubkey()), before.outsider);
    assert_closed(&fx);

    // Late oracle cannot pay a winner afterwards; second fallback also fails.
    assert_custom_err(
        fx.oracle_settle(NO_DEST, 0),
        anchor_err(anchor_lang::error::ErrorCode::AccountNotInitialized),
    );
    assert_custom_err(
        fx.stale_by_outsider(NO_DEST),
        anchor_err(anchor_lang::error::ErrorCode::AccountNotInitialized),
    );
}

#[test]
fn stale_fallback_burn_routes_to_incinerator() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_BURN, incinerator());
    set_time(&mut fx.svm, STALE_AT);
    fx.stale_by_outsider(incinerator()).unwrap();

    assert_eq!(
        balance(&fx.svm, incinerator()),
        before.incinerator + 2 * BET_AMOUNT
    );
    // Challenger gets back only the rent they fronted.
    assert_eq!(
        balance(&fx.svm, fx.challenger.pubkey()),
        before.challenger - BET_AMOUNT
    );
    assert_eq!(balance(&fx.svm, fx.outsider.pubkey()), before.outsider);
    assert_closed(&fx);
}

#[test]
fn stale_fallback_charity_routes_to_charity() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_CHARITY, fx.charity);
    set_time(&mut fx.svm, STALE_AT + 100);
    fx.stale_by_outsider(fx.charity).unwrap();

    assert_eq!(
        balance(&fx.svm, fx.charity),
        before.charity + 2 * BET_AMOUNT
    );
    assert_eq!(
        balance(&fx.svm, fx.opponent.pubkey()),
        before.opponent - BET_AMOUNT
    );
    assert_closed(&fx);
}

#[test]
fn stale_fallback_rejects_wrong_destination() {
    let mut fx = setup();
    fx.escrow(FALLBACK_CHARITY, fx.charity);
    set_time(&mut fx.svm, STALE_AT);
    assert_custom_err(
        fx.stale_by_outsider(fx.outsider.pubkey()),
        program_err(ErrorCode::InvalidDestination),
    );
    assert_still_locked(&fx);
}

#[test]
fn stale_fallback_rejects_wrong_participants() {
    let mut fx = setup();
    fx.escrow(FALLBACK_RETURN, NO_DEST);
    set_time(&mut fx.svm, STALE_AT);

    let mut ix = stale_ix(&fx, fx.outsider.pubkey(), NO_DEST);
    ix.accounts[2].pubkey = fx.outsider.pubkey(); // opponent slot
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.outsider], ix),
        anchor_err(anchor_lang::error::ErrorCode::ConstraintHasOne),
    );

    let mut ix = stale_ix(&fx, fx.outsider.pubkey(), NO_DEST);
    ix.accounts[1].pubkey = fx.outsider.pubkey(); // challenger slot
    assert_custom_err(
        send_ix(&mut fx.svm, &fx.payer, &[&fx.outsider], ix),
        anchor_err(anchor_lang::error::ErrorCode::ConstraintHasOne),
    );
    assert_still_locked(&fx);
}

#[test]
fn oracle_can_still_settle_winner_after_grace() {
    let mut fx = setup();
    let before = snapshot(&fx);
    fx.escrow(FALLBACK_CHARITY, fx.charity);
    set_time(&mut fx.svm, STALE_AT + 1);
    fx.oracle_settle(fx.charity, 1).unwrap();
    assert_eq!(
        balance(&fx.svm, fx.opponent.pubkey()),
        before.opponent + BET_AMOUNT
    );
    assert_eq!(balance(&fx.svm, fx.charity), before.charity);
    assert_closed(&fx);
}

#[test]
fn stale_fallback_with_huge_end_date_does_not_overflow() {
    let mut fx = setup();
    fx.escrow_until(i64::MAX, FALLBACK_RETURN, NO_DEST);
    set_time(&mut fx.svm, i64::MAX - 1);
    assert_custom_err(
        fx.stale_by_outsider(NO_DEST),
        program_err(ErrorCode::StaleGraceNotElapsed),
    );
    assert_still_locked(&fx);
}
