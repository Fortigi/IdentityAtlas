import AVFoundation
import Foundation
import InterviewsCore
import Observation
import UIKit

/// Runs one interview: audio capture, on-device transcription and the diagnostics the
/// one-hour feasibility test needs. Recording never depends on transcription succeeding.
@MainActor
@Observable
final class RecordingController {
    enum Phase: Equatable {
        case idle
        case preparing(String)
        case recording
        case stopping
        case finished(UUID)
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var record: SessionRecord?
    private(set) var volatileText = ""
    private(set) var elapsed: Double = 0
    private(set) var interrupted = false
    private(set) var batteryLevel: Double?
    private(set) var thermalState = ProcessInfo.processInfo.thermalState.rawValue

    private let store: SessionStore
    private var recorder: AudioRecorder?
    private var transcriber: Transcriber?
    private var ticker: Task<Void, Never>?
    private var lastSampleAt: Double = -1
    static let sampleEvery: Double = 30

    init(store: SessionStore) {
        self.store = store
    }

    var isActive: Bool {
        switch phase {
        case .preparing, .recording, .stopping: return true
        default: return false
        }
    }

    func start(title: String) async {
        guard !isActive else { return }
        phase = .preparing("Toestemming microfoon…")
        guard await AVAudioApplication.requestRecordPermission() else {
            phase = .failed("Geen toegang tot de microfoon. Zet dit aan in Instellingen.")
            return
        }

        var session = SessionRecord(title: title.isEmpty ? "Gesprek" : title, startedAt: Date())
        trace("Nieuwe sessie \(session.id.uuidString.prefix(8)): \(session.title)")

        // Transcription is best effort: on failure we record audio only and say why.
        phase = .preparing("Transcriptie voorbereiden…")
        let speech = Transcriber()
        do {
            try await speech.prepare(preferred: Locale(identifier: "nl-NL")) { [weak self] message in
                Task { @MainActor in self?.phase = .preparing(message) }
            }
            session.localeIdentifier = speech.locale?.identifier(.bcp47)
            transcriber = speech
        } catch {
            trace("Transcriptie niet beschikbaar: \(error.localizedDescription)")
            session.transcriptionNote = "Geen transcriptie: \(error.localizedDescription)"
            transcriber = nil
        }

        let audio = AudioRecorder()
        audio.onInterruption = { [weak self] began in
            Task { @MainActor in self?.interrupted = began }
        }
        if let transcriber {
            audio.onBuffer = { buffer in transcriber.feed(buffer) }
        }
        do {
            try FileManager.default.createDirectory(at: store.directory(for: session.id), withIntermediateDirectories: true)
            try audio.start(fileURL: store.audioURL(for: session.id), transcriberFormat: transcriber?.audioFormat)
        } catch {
            trace("Opname starten mislukt: \(error.localizedDescription)")
            phase = .failed("Opname kon niet starten: \(error.localizedDescription)")
            return
        }
        recorder = audio
        session.startedAt = Date()
        record = session
        store.save(session)

        if let transcriber {
            do {
                try await transcriber.start(
                    onUpdate: { [weak self] update in Task { @MainActor in self?.apply(update) } },
                    onError: { [weak self] error in Task { @MainActor in self?.transcriptionFailed(error) } })
            } catch {
                transcriptionFailed(error)
            }
        }

        UIDevice.current.isBatteryMonitoringEnabled = true
        phase = .recording
        trace("Opname loopt")
        startTicker()
    }

    func stop() async {
        guard phase == .recording, var session = record else { return }
        phase = .stopping
        ticker?.cancel()
        recorder?.stop()
        recorder = nil
        await transcriber?.finish()
        transcriber = nil
        sample()
        session = record ?? session
        session.endedAt = Date()
        session.status = .completed
        if !volatileText.isEmpty {
            trace("Laatste voorlopige tekst niet afgerond: \(volatileText.count) tekens")
        }
        volatileText = ""
        record = session
        store.save(session)
        UIDevice.current.isBatteryMonitoringEnabled = false
        trace("Opname gestopt na \(Transcript.timestamp(session.duration ?? 0)), \(session.segments.count) zinnen")
        phase = .finished(session.id)
    }

    func reset() {
        guard !isActive else { return }
        phase = .idle
        record = nil
        elapsed = 0
        volatileText = ""
        lastSampleAt = -1
    }

    private func apply(_ update: TranscriptionUpdate) {
        guard var session = record else { return }
        if update.isFinal {
            session.segments = Transcript.appendingFinal(
                session.segments, TranscriptSegment(start: update.start, end: update.end, text: update.text))
            volatileText = ""
            record = session
            store.save(session) // a final sentence is never lost to a crash
        } else {
            volatileText = update.text
        }
    }

    private func transcriptionFailed(_ error: Error) {
        trace("Transcriptie gestopt: \(error.localizedDescription)")
        guard var session = record else { return }
        session.transcriptionNote = "Transcriptie gestopt na \(Transcript.timestamp(elapsed)): \(error.localizedDescription)"
        record = session
        store.save(session)
    }

    private func startTicker() {
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, let start = self.record?.startedAt else { return }
                self.elapsed = Date().timeIntervalSince(start)
                if self.elapsed - self.lastSampleAt >= Self.sampleEvery { self.sample() }
            }
        }
    }

    private func sample() {
        guard var session = record else { return }
        let level = UIDevice.current.batteryLevel
        batteryLevel = level >= 0 ? Double(level) : nil
        thermalState = ProcessInfo.processInfo.thermalState.rawValue
        lastSampleAt = elapsed
        session.diagnostics.append(DiagnosticsSample(elapsed: elapsed, batteryLevel: batteryLevel, thermalState: thermalState))
        record = session
        store.save(session)
        trace("Meting: batterij \(batteryLevel.map { "\(Int($0 * 100))%" } ?? "?"), temperatuur \(Diagnostics.thermalLabel(thermalState))")
    }
}
