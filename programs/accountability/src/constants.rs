pub const COMMITMENT_SEED: &[u8] = b"commitment";
pub const VAULT_SEED: &[u8] = b"vault";

// Sports bets (1v1 / group-chat result wagers settled by the ESPN oracle crank).
pub const SPORTS_BET_SEED: &[u8] = b"sports_bet";
pub const SPORTS_VAULT_SEED: &[u8] = b"sports_vault";

// Social/witness bets (peer-judged wagers; both stakes escrowed at acceptance,
// settled by the oracle from a witness-vote quorum, or routed to a precommitted
// fallback once the resolve-by date passes without a quorum).
pub const SOCIAL_BET_SEED: &[u8] = b"social_bet";
pub const SOCIAL_VAULT_SEED: &[u8] = b"social_vault";

/// You can back out of a locked bet up until 5 minutes before kickoff.
pub const BACK_OUT_CUTOFF_SECS: i64 = 5 * 60;

/// Grace period after a locked bet's settle-by time (`SportsBet::settle_after` /
/// `SocialBet::end_date`) before ANYONE may run the permissionless escape hatch
/// (`refund_stale_bet` / `fallback_stale_social`). Until then only the oracle can
/// settle; the oracle may still settle after the grace period too, until somebody
/// runs the escape hatch.
///
/// 7 days: the oracle normally settles within minutes-to-hours of the result, so
/// a week leaves ample headroom for relayer outages, late or corrected sports
/// data, short postponements, and manual operator intervention, while still
/// bounding how long user funds can be stranded if the oracle disappears (e.g.
/// key loss). It must stay comfortably longer than any realistic oracle delay:
/// once it elapses, the side that is losing has an incentive to race a late
/// settlement with a refund.
pub const STALE_BET_GRACE_SECS: i64 = 7 * 24 * 60 * 60;
