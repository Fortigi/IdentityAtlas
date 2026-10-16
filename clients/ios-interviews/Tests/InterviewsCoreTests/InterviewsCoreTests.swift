// NOT COMPILED OR RUN: written on Windows. Run with `swift test` on a Mac.
import XCTest
@testable import InterviewsCore

final class ResolutionTests: XCTestCase {
    let peterA = Candidate(id: "p1", score: 1, inScope: false)
    let peterB = Candidate(id: "p2", score: 1, inScope: false)

    func testMissingNameIsNotFound() {
        XCTAssertEqual(Resolution.classify([]), SearchOutcome(state: .notFound, entityId: nil, reason: "no-candidates"))
    }

    func testOneStrongCandidateIsOnlySuggested() {
        XCTAssertEqual(Resolution.classify([Candidate(id: "w1", score: 0.71, inScope: true)]).state, .suggested)
    }

    func testThresholdBoundary() {
        XCTAssertEqual(Resolution.classify([Candidate(id: "x", score: 0.6, inScope: false)]).state, .suggested)
        XCTAssertEqual(Resolution.classify([Candidate(id: "x", score: 0.59, inScope: false)]).reason, "weak-match")
    }

    func testTwoPetersStayAmbiguous() {
        XCTAssertEqual(Resolution.classify([peterA, peterB]), SearchOutcome(state: .unresolved, entityId: nil, reason: "ambiguous"))
    }

    func testOnlyPeterInScopeIsSuggestedNotTheFirst() {
        let out = Resolution.classify([peterA, Candidate(id: "p2", score: 1, inScope: true)])
        XCTAssertEqual(out, SearchOutcome(state: .suggested, entityId: "p2", reason: "only-candidate-in-scope"))
    }

    func testDetectorNeverConfirms() {
        XCTAssertNotNil(Resolution.refusal(from: .suggested, to: .confirmed, origin: .detector, entityId: "w1"))
        XCTAssertNil(Resolution.refusal(from: .suggested, to: .confirmed, origin: .analyst, entityId: "w1"))
    }

    func testConfirmedCannotGoBackToSuggested() {
        XCTAssertNotNil(Resolution.refusal(from: .confirmed, to: .suggested, origin: .detector, entityId: "w1"))
        XCTAssertNil(Resolution.refusal(from: .confirmed, to: .rejected, origin: .analyst, entityId: "w1"))
    }

    func testEntityRules() {
        XCTAssertNotNil(Resolution.refusal(from: nil, to: .confirmed, origin: .analyst, entityId: nil))
        XCTAssertNotNil(Resolution.refusal(from: nil, to: .notFound, origin: .analyst, entityId: "x"))
    }
}

final class MentionDetectorTests: XCTestCase {
    let sentence = "William beheert de productieomgeving, maar Peter is verantwoordelijk voor de databases."

    func testRosterVocabularyAndCapitalisedWords() {
        let d = MentionDetector(roster: ["William de Boer", "William", "Peter"], vocabulary: ["productieomgeving", "databases"])
        let found = d.detect(in: sentence)
        XCTAssertEqual(found.map(\.literal), ["William", "productieomgeving", "Peter", "databases"])
        XCTAssertEqual(found.map(\.source), [.roster, .vocabulary, .roster, .vocabulary])
    }

    func testSpansAreUTF16Offsets() {
        let d = MentionDetector(roster: ["René"])
        let text = "🙂 René is eigenaar"   // the emoji is 2 UTF-16 units
        let m = d.detect(in: text).first
        XCTAssertEqual(m?.spanStart, 3)
        XCTAssertEqual(m?.spanEnd, 7)
    }

    func testWordBoundariesAndFirstWordOfSentence() {
        let d = MentionDetector(roster: ["Piet"])
        // "Pieter" is not "Piet"; "Daarom" starts the sentence and is not a mention.
        XCTAssertEqual(d.detect(in: "Daarom belde Pieter.").map(\.literal), ["Pieter"])
        XCTAssertEqual(d.detect(in: "Daarom belde Pieter.").map(\.source), [.capitalised])
    }
}

final class LookupDebouncerTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_000)

    func testWaitsForTheDelayAndSupersedesPrefixes() {
        var d = LookupDebouncer(delay: 0.8)
        d.observe("Pet", at: t0)
        d.observe("Peter", at: t0.addingTimeInterval(0.3))
        XCTAssertEqual(d.due(at: t0.addingTimeInterval(1.0)), [])
        XCTAssertEqual(d.due(at: t0.addingTimeInterval(1.2)), ["peter"])
    }

    func testLooksUpEachLiteralOnceUntilRetried() {
        var d = LookupDebouncer(delay: 0)
        d.observe("Peter", at: t0)
        XCTAssertEqual(d.due(at: t0), ["peter"])
        d.observe("peter", at: t0)
        XCTAssertEqual(d.due(at: t0), [])
        d.retry("peter", at: t0)
        XCTAssertEqual(d.due(at: t0), ["peter"])
    }

    func testRateCap() {
        var d = LookupDebouncer(delay: 0, maxPerMinute: 2)
        for name in ["Anna", "Bram", "Cees"] { d.observe(name, at: t0) }
        XCTAssertEqual(d.due(at: t0).count, 2)
        XCTAssertEqual(d.pendingCount, 1)
        XCTAssertEqual(d.due(at: t0.addingTimeInterval(60)).count, 1)
    }
}

final class ExcerptHashTests: XCTestCase {
    func testSameVectorAsTheServer() {
        // app/api/src/interviews/evidence.test.js pins the same value.
        XCTAssertEqual(ExcerptHash.of("William beheert de productieomgeving"),
                       "a77fccf295976f0170d89e4526fae5491eb0b4e7a6eaeeeee0b5e0526bb37e44")
    }

    func testComposedAndDecomposedAccentsMatch() {
        XCTAssertEqual(ExcerptHash.of("Ren\u{00E9}"), ExcerptHash.of("Rene\u{0301}"))
    }
}
