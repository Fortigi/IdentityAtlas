import Foundation

/// A candidate mention in one transcript segment.
///
/// `spanStart` / `spanEnd` are UTF-16 code-unit offsets (end exclusive) — the same unit a
/// JavaScript string index uses, so the server's span checks and any web reviewer agree
/// with the device about where a mention is.
public struct DetectedMention: Equatable, Sendable {
    public let literal: String
    public let spanStart: Int
    public let spanEnd: Int
    public let source: Source

    public enum Source: String, Sendable {
        case roster      // a name from the interview's team (GET /v1/interviews/context)
        case vocabulary  // an organisation term the consultant loaded ("productieomgeving")
        case capitalised // a capitalised word that is not the first word of a sentence
    }
}

/// Deterministic, rules-only mention detection (decision-principles B3: nothing
/// probabilistic decides; an optional on-device model may add proposals elsewhere).
/// Detector id for the API: `detectorVersion`.
public struct MentionDetector: Sendable {
    public static let detectorVersion = "lexicon@1"

    let roster: [String]
    let vocabulary: [String]
    let stopwords: Set<String>

    public init(roster: [String], vocabulary: [String] = [], stopwords: Set<String> = MentionDetector.defaultStopwords) {
        // Longest first, so "Peter Jansen" wins over "Peter" at the same position.
        self.roster = roster.filter { !$0.isEmpty }.sorted { $0.count > $1.count }
        self.vocabulary = vocabulary.filter { !$0.isEmpty }.sorted { $0.count > $1.count }
        self.stopwords = stopwords
    }

    public static let defaultStopwords: Set<String> = [
        "ik", "jij", "hij", "zij", "wij", "we", "ze", "de", "het", "een", "en", "maar", "dus", "ja", "nee",
        "i", "you", "he", "she", "we", "they", "the", "a", "and", "but", "so", "yes", "no", "ok", "oké",
    ]

    public func detect(in text: String) -> [DetectedMention] {
        var found: [DetectedMention] = []
        var taken = IndexSet()
        for (terms, source) in [(roster, DetectedMention.Source.roster), (vocabulary, .vocabulary)] {
            for term in terms {
                for range in wordRanges(of: term, in: text) {
                    let span = utf16Span(range, in: text)
                    if taken.intersects(integersIn: span.lowerBound..<span.upperBound) { continue }
                    taken.insert(integersIn: span.lowerBound..<span.upperBound)
                    found.append(DetectedMention(literal: String(text[range]), spanStart: span.lowerBound, spanEnd: span.upperBound, source: source))
                }
            }
        }
        for (range, word) in capitalisedWords(in: text) {
            let span = utf16Span(range, in: text)
            if taken.intersects(integersIn: span.lowerBound..<span.upperBound) { continue }
            if stopwords.contains(word.lowercased()) { continue }
            found.append(DetectedMention(literal: word, spanStart: span.lowerBound, spanEnd: span.upperBound, source: .capitalised))
        }
        return found.sorted { $0.spanStart < $1.spanStart }
    }

    /// Case- and diacritic-insensitive occurrences of `term` that start and end on a word boundary.
    func wordRanges(of term: String, in text: String) -> [Range<String.Index>] {
        var out: [Range<String.Index>] = []
        var from = text.startIndex
        while let r = text.range(of: term, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex) {
            let startOK = r.lowerBound == text.startIndex || !text[text.index(before: r.lowerBound)].isLetter
            let endOK = r.upperBound == text.endIndex || !text[r.upperBound].isLetter
            if startOK && endOK { out.append(r) }
            from = r.upperBound
        }
        return out
    }

    /// Capitalised words, skipping the first word of each sentence (capitalised anyway).
    func capitalisedWords(in text: String) -> [(Range<String.Index>, String)] {
        var out: [(Range<String.Index>, String)] = []
        var sentenceStart = true
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byWords) { word, range, enclosing, _ in
            guard let word else { return }
            if !sentenceStart, let first = word.first, first.isUppercase {
                out.append((range, word))
            }
            // A sentence ends when the text between this word and the next holds . ! or ?
            let trailing = text[range.upperBound..<enclosing.upperBound]
            sentenceStart = trailing.contains { ".!?".contains($0) }
        }
        return out
    }

    func utf16Span(_ range: Range<String.Index>, in text: String) -> Range<Int> {
        let start = text.utf16.distance(from: text.utf16.startIndex, to: range.lowerBound)
        let end = text.utf16.distance(from: text.utf16.startIndex, to: range.upperBound)
        return start..<end
    }
}
