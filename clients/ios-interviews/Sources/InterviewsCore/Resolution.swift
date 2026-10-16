// Mirror of app/api/src/interviews/resolution.js. The server is authoritative and refuses
// a move it does not allow; this copy exists so the app can grey out actions offline.
// Keep the two in step — the XCTest cases use the same inputs as resolution.test.js.

public enum ResolutionState: String, Codable, CaseIterable, Sendable {
    case unresolved, suggested, confirmed, rejected
    case notFound = "not_found"
    case deferred
}

public enum ResolutionOrigin: String, Codable, Sendable {
    case analyst, detector
}

public struct Candidate: Equatable, Codable, Sendable {
    public let id: String
    public let score: Double
    public let inScope: Bool
    public init(id: String, score: Double, inScope: Bool) {
        self.id = id
        self.score = score
        self.inScope = inScope
    }
}

public struct SearchOutcome: Equatable, Sendable {
    public let state: ResolutionState
    public let entityId: String?
    public let reason: String
}

public enum Resolution {
    /// A lone candidate scoring below this is shown, but not suggested.
    public static let suggestMinScore = 0.6

    public static let automaticStates: Set<ResolutionState> = [.unresolved, .suggested, .notFound]
    static let needsEntity: Set<ResolutionState> = [.suggested, .confirmed, .rejected]

    static let transitions: [ResolutionState?: Set<ResolutionState>] = [
        nil: [.unresolved, .suggested, .notFound, .confirmed, .rejected, .deferred],
        .unresolved: [.suggested, .notFound, .confirmed, .rejected, .deferred],
        .suggested: [.suggested, .confirmed, .rejected, .deferred, .notFound, .unresolved],
        .rejected: [.rejected, .confirmed, .deferred, .notFound, .unresolved, .suggested],
        .notFound: [.confirmed, .deferred, .unresolved, .suggested],
        .deferred: [.confirmed, .rejected, .notFound, .unresolved, .suggested],
        .confirmed: [.rejected, .deferred],
    ]

    /// What the search alone may say. Two homonyms stay `unresolved`; only exactly one
    /// strong candidate inside the team scope may be suggested. Never `confirmed`.
    public static func classify(_ candidates: [Candidate]) -> SearchOutcome {
        if candidates.isEmpty {
            return SearchOutcome(state: .notFound, entityId: nil, reason: "no-candidates")
        }
        if candidates.count == 1 {
            let only = candidates[0]
            return only.score >= suggestMinScore
                ? SearchOutcome(state: .suggested, entityId: only.id, reason: "single-candidate")
                : SearchOutcome(state: .unresolved, entityId: nil, reason: "weak-match")
        }
        let inScope = candidates.filter { $0.inScope }
        if inScope.count == 1, inScope[0].score >= suggestMinScore {
            return SearchOutcome(state: .suggested, entityId: inScope[0].id, reason: "only-candidate-in-scope")
        }
        return SearchOutcome(state: .unresolved, entityId: nil, reason: "ambiguous")
    }

    /// nil when the move is allowed, else the reason it is refused.
    public static func refusal(from current: ResolutionState?, to next: ResolutionState,
                               origin: ResolutionOrigin, entityId: String?) -> String? {
        if origin == .detector && !automaticStates.contains(next) {
            return "Only an analyst can set \"\(next.rawValue)\""
        }
        let hasEntity = !(entityId ?? "").isEmpty
        if needsEntity.contains(next) && !hasEntity { return "\"\(next.rawValue)\" needs the entityId it is about" }
        if !needsEntity.contains(next) && hasEntity { return "\"\(next.rawValue)\" must not name an entity" }
        guard let allowed = transitions[current], allowed.contains(next) else {
            return "A mention that is \"\(current?.rawValue ?? "new")\" cannot become \"\(next.rawValue)\""
        }
        return nil
    }
}
