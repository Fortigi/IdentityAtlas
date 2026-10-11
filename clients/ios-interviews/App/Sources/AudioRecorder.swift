import AVFoundation

/// Captures the microphone with AVAudioEngine. Every buffer is written to the audio file
/// FIRST; only then is a converted copy handed to the transcriber. If transcription fails,
/// the recording carries on.
final class AudioRecorder {
    private let engine = AVAudioEngine()
    private var file: AVAudioFile?
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var writeErrors = 0
    private var observers: [NSObjectProtocol] = []

    /// Receives buffers in the transcriber's format (called on the audio thread).
    var onBuffer: ((AVAudioPCMBuffer) -> Void)?
    /// Called on the main thread when an interruption (phone call, Siri) starts or ends.
    var onInterruption: ((Bool) -> Void)?

    func start(fileURL: URL, transcriberFormat: AVAudioFormat?) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: [])
        try session.setActive(true)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        trace("Microfoon: \(Int(inputFormat.sampleRate)) Hz, \(inputFormat.channelCount) kanaal")

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: inputFormat.sampleRate,
            AVNumberOfChannelsKey: inputFormat.channelCount,
            AVEncoderBitRateKey: 64_000,
        ]
        file = try AVAudioFile(forWriting: fileURL, settings: settings,
                               commonFormat: .pcmFormatFloat32, interleaved: false)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                               ofItemAtPath: fileURL.path)

        if let target = transcriberFormat, target != inputFormat {
            converter = AVAudioConverter(from: inputFormat, to: target)
            converter?.primeMethod = .none
            targetFormat = target
            trace("Omzetten naar \(Int(target.sampleRate)) Hz voor de transcriptie")
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.handle(buffer)
        }
        observe(session)
        engine.prepare()
        try engine.start()
    }

    private func handle(_ buffer: AVAudioPCMBuffer) {
        do {
            try file?.write(from: buffer)
        } catch {
            writeErrors += 1
            if writeErrors <= 3 { trace("Schrijven naar audiobestand mislukt: \(error.localizedDescription)") }
        }
        guard let onBuffer else { return }
        if let converted = convert(buffer) { onBuffer(converted) }
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter, let targetFormat else { return buffer }
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error {
            trace("Omzetten mislukt: \(error?.localizedDescription ?? "onbekend")")
            return nil
        }
        return output
    }

    private func observe(_ session: AVAudioSession) {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            guard let self,
                  let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            switch type {
            case .began:
                trace("Onderbreking gestart (bijv. telefoongesprek)")
                self.onInterruption?(true)
            case .ended:
                trace("Onderbreking voorbij, opname hervatten")
                do {
                    try AVAudioSession.sharedInstance().setActive(true)
                    try self.engine.start()
                } catch {
                    trace("Hervatten mislukt: \(error.localizedDescription)")
                }
                self.onInterruption?(false)
            @unknown default:
                break
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).map(String.init) ?? "?"
            trace("Audioroute gewijzigd (reden \(reason))")
        })
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        file = nil // closes and finalises the m4a
        converter = nil
        onBuffer = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if writeErrors > 0 { trace("Totaal \(writeErrors) schrijffouten in deze opname") }
    }
}
