import AVFoundation
import Speech

/// One result from the on-device recogniser. Volatile results are quick guesses that a
/// later final result for the same stretch of audio replaces.
struct TranscriptionUpdate {
    var text: String
    var start: Double
    var end: Double
    var isFinal: Bool
}

enum TranscriberError: LocalizedError {
    case localeUnavailable(String, supported: [String])
    case notPrepared

    var errorDescription: String? {
        switch self {
        case let .localeUnavailable(wanted, supported):
            return "Taal \(wanted) wordt op dit toestel niet ondersteund. Beschikbaar: \(supported.joined(separator: ", "))"
        case .notPrepared:
            return "Transcriptie is niet voorbereid"
        }
    }
}

/// Wraps SpeechAnalyzer + SpeechTranscriber (iOS 26): fully on-device, long-form,
/// with audio time ranges on every result.
final class Transcriber {
    private var transcriber: SpeechTranscriber?
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private(set) var audioFormat: AVAudioFormat?
    private(set) var locale: Locale?

    static func supportedLocaleIdentifiers() async -> [String] {
        await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }.sorted()
    }

    /// Resolves the locale, downloads the language model if needed, and picks the audio format.
    func prepare(preferred: Locale, progress: @escaping (String) -> Void) async throws {
        guard let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: preferred) else {
            throw TranscriberError.localeUnavailable(preferred.identifier(.bcp47),
                                                     supported: await Self.supportedLocaleIdentifiers())
        }
        let module = SpeechTranscriber(locale: resolved,
                                       transcriptionOptions: [],
                                       reportingOptions: [.volatileResults],
                                       attributeOptions: [.audioTimeRange])
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            progress("Taalmodel \(resolved.identifier(.bcp47)) downloaden…")
            trace("Taalmodel \(resolved.identifier(.bcp47)) wordt gedownload")
            try await request.downloadAndInstall()
            trace("Taalmodel geïnstalleerd")
        }
        audioFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module])
        analyzer = SpeechAnalyzer(modules: [module])
        transcriber = module
        locale = resolved
        trace("Transcriptie klaar: \(resolved.identifier(.bcp47)), formaat \(audioFormat.map { "\(Int($0.sampleRate)) Hz" } ?? "?")")
    }

    func start(onUpdate: @escaping (TranscriptionUpdate) -> Void, onError: @escaping (Error) -> Void) async throws {
        guard let analyzer, let transcriber else { throw TranscriberError.notPrepared }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        input = continuation
        resultsTask = Task {
            do {
                for try await result in transcriber.results {
                    onUpdate(TranscriptionUpdate(text: String(result.text.characters),
                                                 start: result.range.start.seconds,
                                                 end: result.range.end.seconds,
                                                 isFinal: result.isFinal))
                }
            } catch {
                onError(error)
            }
        }
        try await analyzer.start(inputSequence: stream)
    }

    /// Called from the audio thread.
    func feed(_ buffer: AVAudioPCMBuffer) {
        input?.yield(AnalyzerInput(buffer: buffer))
    }

    /// Flushes the remaining audio so the last sentence is finalised too.
    func finish() async {
        input?.finish()
        input = nil
        do {
            try await analyzer?.finalizeAndFinishThroughEndOfInput()
        } catch {
            trace("Afronden transcriptie: \(error.localizedDescription)")
        }
        await resultsTask?.value
        resultsTask = nil
    }
}
