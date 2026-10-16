import Foundation

/// Decides WHEN a mention is looked up in Atlas, so a live transcript does not turn into
/// a request per partial word. Pure: time is passed in, nothing is scheduled here.
///
///   • a mention is due once it has been stable for `delay` seconds
///   • a longer mention that extends a pending one supersedes it ("Pet" → "Peter")
///   • a literal is looked up once per interview (cache); `retry` re-queues after a failure
///   • at most `maxPerMinute` lookups are released per rolling minute (the server allows 120)
public struct LookupDebouncer: Sendable {
    public let delay: TimeInterval
    public let maxPerMinute: Int

    private var pending: [String: Date] = [:]
    private var looked: Set<String> = []
    private var released: [Date] = []

    public init(delay: TimeInterval = 0.8, maxPerMinute: Int = 60) {
        self.delay = delay
        self.maxPerMinute = maxPerMinute
    }

    /// The cache key: trimmed, lowercased, diacritics folded.
    public static func key(_ literal: String) -> String {
        literal.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    public mutating func observe(_ literal: String, at now: Date) {
        let k = Self.key(literal)
        guard k.count >= 2, !looked.contains(k) else { return }
        for other in pending.keys where other != k && k.hasPrefix(other) {
            pending.removeValue(forKey: other)
        }
        pending[k] = now
    }

    /// The keys to look up now. Each is moved from pending to looked-up.
    public mutating func due(at now: Date) -> [String] {
        released.removeAll { now.timeIntervalSince($0) >= 60 }
        let ready = pending.filter { now.timeIntervalSince($0.value) >= delay }
            .sorted { $0.value < $1.value }
            .map(\.key)
        var out: [String] = []
        for k in ready {
            if released.count >= maxPerMinute { break }
            pending.removeValue(forKey: k)
            looked.insert(k)
            released.append(now)
            out.append(k)
        }
        return out
    }

    /// A lookup failed (offline, 429, 5xx): queue it again; recording is unaffected.
    public mutating func retry(_ key: String, at now: Date) {
        looked.remove(key)
        pending[key] = now
    }

    public var pendingCount: Int { pending.count }
}
