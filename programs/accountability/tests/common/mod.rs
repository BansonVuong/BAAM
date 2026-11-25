//! Shared LiteSVM helpers for the bet tests.
#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::instruction::Instruction,
    },
    litesvm::{types::FailedTransactionMetadata, LiteSVM},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const STARTING_BALANCE: u64 = 10_000_000_000;
pub const BET_AMOUNT: u64 = 1_000_000_000;
/// Arbitrary "now" the tests start from.
pub const NOW: i64 = 1_700_000_000;

pub type TxResult = Result<(), FailedTransactionMetadata>;

pub fn new_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(
        accountability::id(),
        include_bytes!("../../../../target/deploy/accountability.so"),
    )
    .unwrap();
    set_time(&mut svm, NOW);
    svm
}

pub fn funded(svm: &mut LiteSVM) -> Keypair {
    let keypair = Keypair::new();
    svm.airdrop(&keypair.pubkey(), STARTING_BALANCE).unwrap();
    keypair
}

pub fn set_time(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

/// Send `instructions` with a dedicated fee payer, so participant balances
/// move only by what the program does (no fee noise in lamport assertions).
pub fn send_ixs(
    svm: &mut LiteSVM,
    fee_payer: &Keypair,
    signers: &[&Keypair],
    instructions: &[Instruction],
) -> TxResult {
    let message = Message::new_with_blockhash(
        instructions,
        Some(&fee_payer.pubkey()),
        &svm.latest_blockhash(),
    );
    let mut all: Vec<&Keypair> = vec![fee_payer];
    for signer in signers {
        if signer.pubkey() != fee_payer.pubkey() {
            all.push(signer);
        }
    }
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &all).unwrap();
    let result = svm.send_transaction(transaction).map(|_| ());
    // Fresh blockhash every time so a retried identical tx is never deduped.
    svm.expire_blockhash();
    result
}

pub fn send_ix(
    svm: &mut LiteSVM,
    fee_payer: &Keypair,
    signers: &[&Keypair],
    instruction: Instruction,
) -> TxResult {
    send_ixs(svm, fee_payer, signers, &[instruction])
}

pub fn balance(svm: &LiteSVM, address: Pubkey) -> u64 {
    svm.get_account(&address)
        .map_or(0, |account| account.lamports)
}

pub fn exists(svm: &LiteSVM, address: Pubkey) -> bool {
    svm.get_account(&address)
        .is_some_and(|account| account.lamports > 0)
}

pub fn program_err(code: accountability::error::ErrorCode) -> u32 {
    code.into()
}

pub fn anchor_err(code: anchor_lang::error::ErrorCode) -> u32 {
    code.into()
}

/// Assert the transaction failed with `Custom(code)` from our program.
#[track_caller]
pub fn assert_custom_err(result: TxResult, code: u32) {
    let failure = result.expect_err("transaction unexpectedly succeeded");
    let rendered = format!("{:?}", failure.err);
    assert!(
        rendered.contains(&format!("Custom({code})")),
        "expected Custom({code}), got {rendered}\nlogs: {:#?}",
        failure.meta.logs
    );
}
