import XCTest
@testable import InterviewsCore

final class TimestampTests: XCTestCase {
    func testCutsFractionsInsteadOfRoundingUp() {
        XCTAssertEqual(Transcript.timestamp(59.9), "00:59")
        XCTAssertEqual(Transcript.timestamp(60), "01:00")
    }

    func testSwitchesToHoursAtExactlyOneHour() {
        XCTAssertEqual(Transcript.timestamp(3599), "59:59")
        XCTAssertEqual(Transcript.timestamp(3600), "1:00:00")
        XCTAssertEqual(Transcript.timestamp(3725), "1:02:05")
    }

    func testNegativeAndNonFiniteBecomeZero() {
        XCTAssertEqual(Transcript.timestamp(-3), "00:00")
        XCTAssertEqual(Transcript.timestamp(.nan), "00:00")
        XCTAssertEqual(Transcript.timestamp(.infinity), "00:00")
    }
}

final class AppendingFinalTests: XCTestCase {
    func testBlankResultIsDropped() {
        let base = [TranscriptSegment(start: 0, end: 2, text: "Goedemorgen")]
        XCTAssertEqual(Transcript.appendingFinal(base, TranscriptSegment(start: 2, end: 3, text: "  \n")), base)
    }

    func testTextIsTrimmed() {
        let out = Transcript.appendingFinal([], TranscriptSegment(start: 0, end: 1, text: " Rob beheert de klant. "))
        XCTAssertEqual(out.map(\.text), ["Rob beheert de klant."])
    }

    func testLateFinalOfEarlierRangeIsInsertedInOrder() {
        let a = TranscriptSegment(start: 0, end: 4, text: "eerste")
        let c = TranscriptSegment(start: 10, end: 12, text: "derde")
        let b = TranscriptSegment(start: 5, end: 9, text: "tweede")
        XCTAssertEqual(Transcript.appendingFinal([a, c], b).map(\.text), ["eerste", "tweede", "derde"])
    }

    func testEqualStartKeepsArrivalOrder() {
        let a = TranscriptSegment(start: 5, end: 6, text: "a")
        let b = TranscriptSegment(start: 5, end: 7, text: "b")
        XCTAssertEqual(Transcript.appendingFinal([a], b).map(\.text), ["a", "b"])
    }
}

final class PlainTextTests: XCTestCase {
    func testHeaderAndLines() {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "nl_NL")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        let start = Date(timeIntervalSince1970: 1_760_000_000) // 2025-10-09 08:53 UTC
        let record = SessionRecord(
            title: "Gesprek met Rob", startedAt: start, endedAt: start.addingTimeInterval(65),
            status: .completed, localeIdentifier: "nl-NL",
            segments: [TranscriptSegment(start: 3.2, end: 5, text: "Wij werken per klant."),
                       TranscriptSegment(start: 61, end: 64, text: "RDW is een klant.")])
        XCTAssertEqual(Transcript.plainText(record, dateFormatter: formatter), """
            Gesprek met Rob
            Gestart: 2025-10-09 08:53
            Duur: 01:05
            Taal: nl-NL (lokaal getranscribeerd)

            [00:03] Wij werken per klant.
            [01:01] RDW is een klant.
            """)
    }

    func testNoteIsShownAndUnknownDurationOmitted() {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy"
        formatter.timeZone = TimeZone(identifier: "UTC")
        let record = SessionRecord(title: "T", startedAt: Date(timeIntervalSince1970: 0),
                                   transcriptionNote: "Nederlands niet beschikbaar")
        let text = Transcript.plainText(record, dateFormatter: formatter)
        XCTAssertTrue(text.contains("Let op: Nederlands niet beschikbaar"))
        XCTAssertFalse(text.contains("Duur:"))
        XCTAssertFalse(text.contains("Taal:"))
    }
}

final class RecoveryTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_000)

    func testCompletedSessionIsUntouched() {
        let done = SessionRecord(title: "T", startedAt: start, endedAt: start.addingTimeInterval(10), status: .completed)
        XCTAssertEqual(SessionRecovery.recovered(done), done)
    }

    func testRecordingBecomesInterruptedEndingAtLastEvidence() {
        let cut = SessionRecord(title: "T", startedAt: start,
                                segments: [TranscriptSegment(start: 0, end: 42, text: "x")],
                                diagnostics: [DiagnosticsSample(elapsed: 30, batteryLevel: 0.9, thermalState: 0)])
        let out = SessionRecovery.recovered(cut)
        XCTAssertEqual(out.status, .interrupted)
        XCTAssertEqual(out.endedAt, start.addingTimeInterval(42))
    }

    func testDiagnosticsCanBeTheLastEvidence() {
        let cut = SessionRecord(title: "T", startedAt: start,
                                segments: [TranscriptSegment(start: 0, end: 5, text: "x")],
                                diagnostics: [DiagnosticsSample(elapsed: 90, batteryLevel: nil, thermalState: 1)])
        XCTAssertEqual(SessionRecovery.recovered(cut).endedAt, start.addingTimeInterval(90))
    }

    func testWithoutEvidenceEndEqualsStart() {
        XCTAssertEqual(SessionRecovery.recovered(SessionRecord(title: "T", startedAt: start)).endedAt, start)
    }

    func testExistingEndIsKept() {
        let cut = SessionRecord(title: "T", startedAt: start, endedAt: start.addingTimeInterval(7))
        XCTAssertEqual(SessionRecovery.recovered(cut).endedAt, start.addingTimeInterval(7))
    }
}

final class DiagnosticsTests: XCTestCase {
    func testBatteryUsedSkipsMissingReadings() {
        let samples = [DiagnosticsSample(elapsed: 0, batteryLevel: nil, thermalState: 0),
                       DiagnosticsSample(elapsed: 30, batteryLevel: 0.80, thermalState: 0),
                       DiagnosticsSample(elapsed: 60, batteryLevel: 0.73, thermalState: 2)]
        XCTAssertEqual(Diagnostics.batteryUsed(samples), 7)
        XCTAssertEqual(Diagnostics.hottest(samples), 2)
    }

    func testBatteryUsedNeedsTwoReadings() {
        XCTAssertNil(Diagnostics.batteryUsed([DiagnosticsSample(elapsed: 0, batteryLevel: 0.5, thermalState: 0)]))
        XCTAssertNil(Diagnostics.hottest([]))
    }

    func testThermalLabels() {
        XCTAssertEqual((0...4).map(Diagnostics.thermalLabel), ["normaal", "licht warm", "warm", "kritiek", "onbekend"])
    }
}

final class CodingTests: XCTestCase {
    func testRoundTripKeepsDatesAndSegments() throws {
        let record = SessionRecord(title: "T", startedAt: Date(timeIntervalSince1970: 1_760_000_000),
                                   endedAt: Date(timeIntervalSince1970: 1_760_000_100), status: .completed,
                                   localeIdentifier: "nl-NL",
                                   segments: [TranscriptSegment(start: 1, end: 2, text: "a")],
                                   diagnostics: [DiagnosticsSample(elapsed: 30, batteryLevel: 0.5, thermalState: 1)])
        let data = try SessionCoding.encoder().encode(record)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("\"2025-10-09T08:53:20Z\""))
        XCTAssertEqual(try SessionCoding.decoder().decode(SessionRecord.self, from: data), record)
    }
}
