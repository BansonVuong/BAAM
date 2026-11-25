import Foundation

enum MessageBetType: String, Codable, CaseIterable, Identifiable {
    case PERSONAL
    case DEV

    var id: String { rawValue }

    var label: String {
        switch self {
        case .PERSONAL: return "PERSONAL"
        case .DEV: return "Sports"
        }
    }
}

enum MessageBetVoteChoice: String, Codable, CaseIterable, Identifiable {
    case challenger
    case acceptor

    var id: String { rawValue }
}

/// Stake currencies the relayer understands. `PTS` = play-money points (off-chain,
/// whole numbers); `SOL` = devnet escrow. The server's `BET_CURRENCIES` decides
/// which are allowed (`GET /profile` → `betCurrencies`).
enum MessageBetCurrency: String, Codable, CaseIterable, Identifiable {
    case PTS
    case SOL

    var id: String { rawValue }

    var label: String {
        switch self {
        case .PTS: return "Points"
        case .SOL: return "SOL"
        }
    }

    /// Parses a server currency string; unknown/missing values are treated as SOL
    /// because every pre-points bet was SOL.
    static func from(_ raw: String?) -> MessageBetCurrency {
        raw?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "PTS" ? .PTS : .SOL
    }
}

enum MessageStakeFormatter {
    private static let pointsFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        formatter.usesGroupingSeparator = true
        return formatter
    }()

    /// "1,000 pts" / "1 pt".
    static func points(_ value: Double) -> String {
        let rounded = value.rounded()
        let text = pointsFormatter.string(from: NSNumber(value: rounded)) ?? String(Int(rounded))
        return "\(text) \(rounded == 1 ? "pt" : "pts")"
    }

    /// "500 pts" for points stakes, "0.25 SOL" for SOL stakes.
    static func stake(amount: String, currency: MessageBetCurrency) -> String {
        let trimmed = amount.trimmingCharacters(in: .whitespacesAndNewlines)
        switch currency {
        case .PTS:
            if let value = Double(trimmed) { return points(value) }
            return "\(trimmed) pts"
        case .SOL:
            return "\(trimmed) SOL"
        }
    }
}

enum MessageStakeValidator {
    /// Mirrors the relayer's POINTS_MAX_STAKE (relayer/points-logic.ts).
    static let maxPointsStake = 1_000_000_000

    /// Validates a typed stake for `currency` and returns the string to send as
    /// `stake`, or a user-facing error. Points must be whole numbers ≥ 1 (and, when
    /// the balance is known, no more than it); SOL must be a positive decimal.
    static func validate(
        _ raw: String,
        currency: MessageBetCurrency,
        pointsBalance: Double? = nil
    ) -> Result<String, MessageStakeError> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        switch currency {
        case .PTS:
            let digits = trimmed.replacingOccurrences(of: ",", with: "")
            guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let value = Int(digits), value >= 1 else {
                return .failure(MessageStakeError("Points stake must be a whole number of at least 1."))
            }
            guard value <= maxPointsStake else {
                return .failure(MessageStakeError(
                    "Points stake must be at most \(MessageStakeFormatter.points(Double(maxPointsStake)))."
                ))
            }
            if let pointsBalance, Double(value) > pointsBalance {
                return .failure(MessageStakeError(
                    "You need \(MessageStakeFormatter.points(Double(value))) but have \(MessageStakeFormatter.points(pointsBalance))."
                ))
            }
            return .success(String(value))
        case .SOL:
            guard let value = Double(trimmed), value.isFinite, value > 0 else {
                return .failure(MessageStakeError("Stake must be a positive SOL amount."))
            }
            return .success(trimmed)
        }
    }
}

struct MessageStakeError: Error, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
}

/// Leagues offered by the sports board, mirroring the web dashboard's SportsView.
enum MessageSportKind: String, Codable, CaseIterable, Identifiable {
    case nba
    case nfl
    case nhl
    case soccer

    var id: String { rawValue }

    var label: String {
        switch self {
        case .nba: return "NBA"
        case .nfl: return "NFL"
        case .nhl: return "NHL"
        case .soccer: return "Soccer"
        }
    }
}

/// One upcoming game returned by the relayer's `/scoreboard` feed.
struct MessageScoreboardGame: Codable, Identifiable, Equatable {
    let gameId: String
    let homeTeam: String
    let awayTeam: String
    let status: String
    let isFinal: Bool
    let startTime: String?
    let startTimeMs: Double?

    var id: String { gameId }

    /// Human-readable kickoff for the picker row; falls back to the raw status.
    var kickoffLabel: String {
        if let startTimeMs {
            let date = Date(timeIntervalSince1970: startTimeMs / 1000)
            return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        }
        return status.isEmpty ? "Scheduled" : status
    }
}

struct MessageScoreboardResponse: Codable {
    let sport: String
    let league: String?
    let games: [MessageScoreboardGame]
}

struct MessageCreateBetRequest: Codable {
    let source: String
    let imessageConversationId: String
    let type: MessageBetType
    let acceptor: String
    let terms: String
    let stake: String
    let currency: MessageBetCurrency
    let sport: String?
    let gameId: String?
    let backsHome: Bool?
    let homeTeam: String?
    let awayTeam: String?
}

struct MessageConversation: Codable, Identifiable {
    let id: String
    let ownerUsername: String
    let members: [String]
    let joined: Bool
    let isOwner: Bool
    let createdAt: Double
}

struct MessageConversationResponse: Codable {
    let conversation: MessageConversation
}

struct MessageConversationCreateResponse: Codable {
    let conversation: MessageConversation
    let inviteUrl: String
}

struct MessageCreateBetResponse: Codable {
    let bet: MessageCreatedBet
}

struct MessageCreatedBet: Codable {
    let id: String
}

struct MessageDeepLinkResponse: Codable {
    let betId: String?
    let url: String?
}

struct MessageBetCardEnvelope: Codable {
    let card: MessageBetCard
}

struct MessageBetCard: Codable, Identifiable {
    struct GroupInfo: Codable {
        let id: String
        let name: String
    }

    struct StakeInfo: Codable {
        let amount: String
        let currency: String

        var kind: MessageBetCurrency { MessageBetCurrency.from(currency) }
        /// "500 pts" / "0.25 SOL".
        var display: String { MessageStakeFormatter.stake(amount: amount, currency: kind) }
    }

    /// Points escrow status (`null` for SOL bets).
    struct PointsInfo: Codable {
        let state: String?
        let label: String?
    }

    struct ProofInfo: Codable, Identifiable {
        struct Image: Codable {
            let url: String
            let contentType: String?
        }

        let id: String
        let uploader: String?
        let createdAt: Double?
        let checkinId: String?
        let caption: String?
        let link: String?
        let image: Image?
    }

    /// Progress of a recurring (scheduled check-in) bet; `null` for one-off bets.
    struct CheckinProgressInfo: Codable {
        struct Window: Codable {
            let key: String
            let start: Double
            let end: Double
        }

        struct Decision: Codable {
            let winner: String?
            let reason: String?
        }

        let doerUsername: String?
        let required: Int
        let total: Int
        let approved: Int
        let possible: Int?
        let submitted: Int?
        let pendingReview: Int?
        let verdictDeadline: Double?
        let currentWindow: Window?
        let nextWindow: Window?
        let decision: Decision?
    }

    struct VotesInfo: Codable {
        let challenger: Int
        let acceptor: Int
        let total: Int
        let byVoter: [String: MessageBetVoteChoice]
        let myVote: MessageBetVoteChoice?
    }

    struct SportsInfo: Codable {
        let sport: String?
        let gameId: String?
        let homeTeam: String?
        let awayTeam: String?
        let challengerBacksHome: Bool?
    }

    struct OnChainInfo: Codable {
        struct Signatures: Codable {
            let create: String?
            let accept: String?
            let settle: String?
        }

        struct ExplorerLinks: Codable {
            let create: String?
            let accept: String?
            let settle: String?
        }

        let enabled: Bool
        let state: String?
        let label: String
        let signatures: Signatures
        let explorer: ExplorerLinks
    }

    struct ActionsInfo: Codable {
        let canAccept: Bool
        let canVote: Bool
        let acceptEndpoint: String
        let voteEndpoint: String
        // Added with proofs / recurring check-ins; absent on older relayers.
        let canAddProof: Bool?
        let canCheckin: Bool?
        let canReview: Bool?
        let proofEndpoint: String?
        let checkinEndpoint: String?
    }

    struct LinksInfo: Codable {
        let deepLink: String
    }

    let betId: String
    let group: GroupInfo
    let type: MessageBetType
    let status: String
    let statusLabel: String
    let terms: String
    let stake: StakeInfo
    let challenger: String
    let acceptor: String
    let witnessesRequired: Int
    let votes: VotesInfo
    let winner: MessageBetVoteChoice?
    let winnerName: String?
    let validation: String
    let sports: SportsInfo?
    let onChain: OnChainInfo
    let actions: ActionsInfo
    let links: LinksInfo
    // Points / proof / check-in fields (all optional so older relayers still decode).
    let outcomeLabel: String?
    let points: PointsInfo?
    let proofCount: Int?
    let proofs: [ProofInfo]?
    let firstProofImageUrl: String?
    let checkins: CheckinProgressInfo?

    var id: String { betId }

    var isPoints: Bool { stake.kind == .PTS }
    var isRecurring: Bool { checkins != nil }

    /// Escrow status line: the points label for PTS bets, the on-chain label for SOL.
    var escrowLabel: String {
        if isPoints {
            return points?.label ?? onChain.label
        }
        return onChain.label
    }

    /// "1 proof" / "3 proofs"; nil when there are none (or the server predates proofs).
    var proofSummary: String? {
        guard let count = proofCount ?? proofs?.count, count > 0 else { return nil }
        return "\(count) proof\(count == 1 ? "" : "s")"
    }

    /// "2 of 6 days done · needs 4" for recurring bets.
    var checkinSummary: String? {
        guard let checkins else { return nil }
        var text = "\(checkins.approved) of \(checkins.total) day\(checkins.total == 1 ? "" : "s") done"
        if checkins.required > 0 && checkins.required != checkins.total {
            text += " · needs \(checkins.required)"
        }
        return text
    }
}

struct MessageErrorResponse: Codable {
    let error: String
}

struct MessageAuthUser: Codable {
    let id: String
    let email: String
    let username: String
    let initials: String
    let createdAt: Double
}

struct MessageAuthResponse: Codable {
    let token: String
    let user: MessageAuthUser
}

struct MessageCurrentUserResponse: Codable {
    let user: MessageAuthUser
    let pointsBalance: Double?
}

struct MessageBetCurrencies: Codable, Equatable {
    let allowed: [String]
    let `default`: String?

    /// Older relayers had no points and no `betCurrencies`: SOL only.
    static let legacy = MessageBetCurrencies(allowed: ["SOL"], default: "SOL")

    /// Allowed currencies this client understands, in server order (never empty).
    var allowedCurrencies: [MessageBetCurrency] {
        var unique: [MessageBetCurrency] = []
        for raw in allowed {
            if let currency = MessageBetCurrency(rawValue: raw.uppercased()), !unique.contains(currency) {
                unique.append(currency)
            }
        }
        return unique.isEmpty ? [.SOL] : unique
    }

    var defaultCurrency: MessageBetCurrency {
        let options = allowedCurrencies
        if let raw = self.default,
           let parsed = MessageBetCurrency(rawValue: raw.uppercased()),
           options.contains(parsed) {
            return parsed
        }
        return options[0]
    }
}

struct MessageProfile: Codable {
    let name: String
    let initials: String
    let github: String
    let wallet: String
    let solBalance: Double
    /// Play-money balance; nil on older relayers (or when the server couldn't read it).
    let pointsBalance: Double?
    /// Which stake currencies POST /bets accepts; nil on older relayers (SOL only).
    let betCurrencies: MessageBetCurrencies?

    var currencies: MessageBetCurrencies { betCurrencies ?? .legacy }
}

struct MessageParticipantLinkResponse: Codable {
    let linked: Bool
    let username: String
}

struct MessageResolvedParticipant: Codable {
    let participantId: String
    let username: String
}

struct MessageParticipantsResponse: Codable {
    let participants: [MessageResolvedParticipant]
}
