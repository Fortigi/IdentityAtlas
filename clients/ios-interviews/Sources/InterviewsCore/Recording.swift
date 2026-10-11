// Identity Atlas Interviews — the recorded session as it is kept on the phone.
//
// Pure model and rules only (no audio, no Speech framework), so `swift test` on any Mac
// covers them. The app in ../App feeds these types from AVAudioEngine and SpeechAnalyzer.
// Principle: the audio file is the evidence; the transcript is derived from it and may be
// missing (transcription unavailable) without the session being lost.
import Foundation

public struct TranscriptSegment: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    /// Seconds from the start of the recording.
    public var start: Double
    public var end: Double
    public var text: String

    public init(id: UUID = UUID(), start: Double, end: Double, text: String) {
        self.id = id
        self.start = start
        self.end = end
        self.text = text
    }
}

public enum SessionStatus: String, Codable, Sendable {
    case recording
    case completed
    /// The app stopped (crash, kill, reboot) while the session was still recording.
    case interrupted
}

/// One battery/temperature reading, taken while recording, for the one-hour feasibility test.
public struct DiagnosticsSample: Codable, Equatable, Sendable {
    public var elapsed: Double
    /// 0…1, nil when the device does not report it (simulator).
    public var batteryLevel: Double?
    /// `ProcessInfo.ThermalState.rawValue`: 0 nominal … 3 critical.
    public var thermalState: Int

    public init(elapsed: Double, batteryLevel: Double?, thermalState: Int) {
        self.elapsed = elapsed
        self.batteryLevel = batteryLevel
        self.thermalState = thermalState
    }
}

public struct SessionRecord: Codable, Equatable, Identifiable, Sendable {
    public static let audioFileName = "audio.m4a"
    public static let recordFileName = "session.json"

    public var id: UUID
    public var title: String
    public var startedAt: Date
    public var endedAt: Date?
    public var status: SessionStatus
    /// The transcription locale actually used, e.g. "nl-NL"; nil when nothing was transcribed.
    public var localeIdentifier: String?
    /// Why there is no (complete) transcript, in words for the user.
    public var transcriptionNote: String?
    public var segments: [TranscriptSegment]
    public var diagnostics: [DiagnosticsSample]

    public init(id: UUID = UUID(), title: String, startedAt: Date, endedAt: Date? = nil,
                status: SessionStatus = .recording, localeIdentifier: String? = nil,
                transcriptionNote: String? = nil, segments: [TranscriptSegment] = [],
                diagnostics: [DiagnosticsSample] = []) {
        self.id = id
        self.title = title
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.status = status
        self.localeIdentifier = localeIdentifier
        self.transcriptionNote = transcriptionNote
        self.segments = segments
        self.diagnostics = diagnostics
    }

    /// Seconds between start and end; nil while still recording.
    public var duration: Double? { endedAt.map { $0.timeIntervalSince(startedAt) } }
}

public enum Transcript {
    /// "mm:ss" below an hour, "h:mm:ss" from an hour on. Fractions are cut, never rounded up,
    /// so a segment that starts at 59.9 s is listed under the minute it started in.
    public static func timestamp(_ seconds: Double) -> String {
        let total = seconds.isFinite ? max(0, Int(seconds.rounded(.down))) : 0
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }

    /// Adds a finalised result. Blank text is dropped; the list stays ordered by start time
    /// because the recogniser may finalise a later range before an earlier one.
    public static func appendingFinal(_ segments: [TranscriptSegment], _ new: TranscriptSegment) -> [TranscriptSegment] {
        let text = new.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return segments }
        var next = new
        next.text = text
        var out = segments
        let index = out.firstIndex(where: { $0.start > next.start }) ?? out.endIndex
        out.insert(next, at: index)
        return out
    }

    /// The shareable text: a header, then one line per segment.
    public static func plainText(_ record: SessionRecord, dateFormatter: DateFormatter) -> String {
        var lines = [record.title, "Gestart: \(dateFormatter.string(from: record.startedAt))"]
        if let duration = record.duration { lines.append("Duur: \(timestamp(duration))") }
        if let locale = record.localeIdentifier { lines.append("Taal: \(locale) (lokaal getranscribeerd)") }
        if let note = record.transcriptionNote { lines.append("Let op: \(note)") }
        lines.append("")
        lines.append(contentsOf: record.segments.map { "[\(timestamp($0.start))] \($0.text)" })
        return lines.joined(separator: "\n")
    }
}

public enum SessionRecovery {
    /// A session found in state `recording` at app start was cut off. It becomes `interrupted`
    /// with its end set to the last moment we have evidence for — not to "now", which could be
    /// days later.
    public static func recovered(_ record: SessionRecord) -> SessionRecord {
        guard record.status == .recording else { return record }
        var out = record
        out.status = .interrupted
        if out.endedAt == nil {
            let lastSegment = record.segments.map(\.end).max() ?? 0
            let lastSample = record.diagnostics.map(\.elapsed).max() ?? 0
            out.endedAt = record.startedAt.addingTimeInterval(max(lastSegment, lastSample))
        }
        return out
    }
}

public enum Diagnostics {
    /// Battery percentage points used between the first and last reading that report a level.
    public static func batteryUsed(_ samples: [DiagnosticsSample]) -> Double? {
        let levels = samples.compactMap(\.batteryLevel)
        guard let first = levels.first, let last = levels.last, levels.count > 1 else { return nil }
        return ((first - last) * 100).rounded()
    }

    public static func hottest(_ samples: [DiagnosticsSample]) -> Int? {
        samples.map(\.thermalState).max()
    }

    public static func thermalLabel(_ raw: Int) -> String {
        switch raw {
        case 0: return "normaal"
        case 1: return "licht warm"
        case 2: return "warm"
        case 3: return "kritiek"
        default: return "onbekend"
        }
    }
}

public enum SessionCoding {
    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }

    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
