import Foundation
import Observation

/// In-app log. There is no Mac attached to read the device console, so everything the
/// recorder does is written here and to Documents/app.log, which the user can share.
@Observable
final class AppLog {
    static let shared = AppLog()

    private(set) var lines: [String] = []
    let fileURL: URL
    private let queue = DispatchQueue(label: "io.identityatlas.interviews.log")
    private let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    init(directory: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]) {
        fileURL = directory.appendingPathComponent("app.log")
    }

    /// Safe to call from any thread, including the audio render thread.
    func log(_ message: String) {
        let line = "\(stamp.string(from: Date())) \(message)"
        queue.async { [fileURL] in
            let data = Data((line + "\n").utf8)
            if let handle = try? FileHandle(forWritingTo: fileURL) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
        DispatchQueue.main.async {
            self.lines.append(line)
            if self.lines.count > 2000 { self.lines.removeFirst(self.lines.count - 2000) }
        }
    }
}

func trace(_ message: String) { AppLog.shared.log(message) }
