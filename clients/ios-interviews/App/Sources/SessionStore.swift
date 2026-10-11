import Foundation
import InterviewsCore
import Observation

/// Sessions live in Documents/Interviews/<id>/ as session.json + audio.m4a.
/// Nothing leaves the phone unless the user shares it.
@Observable
final class SessionStore {
    private(set) var sessions: [SessionRecord] = []
    let root: URL

    init(root: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Interviews", isDirectory: true)) {
        self.root = root
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func directory(for id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }
    func audioURL(for id: UUID) -> URL { directory(for: id).appendingPathComponent(SessionRecord.audioFileName) }

    /// Loads all sessions; any still marked `recording` was cut off and is marked interrupted.
    func loadAll() {
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        var loaded: [SessionRecord] = []
        for dir in dirs {
            let url = dir.appendingPathComponent(SessionRecord.recordFileName)
            guard let data = try? Data(contentsOf: url) else { continue }
            do {
                let record = try SessionCoding.decoder().decode(SessionRecord.self, from: data)
                let recovered = SessionRecovery.recovered(record)
                if recovered != record {
                    trace("Sessie \(record.id.uuidString.prefix(8)) was onderbroken; gemarkeerd als onderbroken")
                    save(recovered)
                }
                loaded.append(recovered)
            } catch {
                trace("Kan sessie niet lezen (\(dir.lastPathComponent)): \(error.localizedDescription)")
            }
        }
        sessions = loaded.sorted { $0.startedAt > $1.startedAt }
    }

    func save(_ record: SessionRecord) {
        let dir = directory(for: record.id)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let data = try SessionCoding.encoder().encode(record)
            try data.write(to: dir.appendingPathComponent(SessionRecord.recordFileName),
                           options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            trace("Opslaan mislukt: \(error.localizedDescription)")
        }
        if let i = sessions.firstIndex(where: { $0.id == record.id }) {
            sessions[i] = record
        } else {
            sessions.insert(record, at: 0)
        }
    }

    func delete(_ id: UUID) {
        try? FileManager.default.removeItem(at: directory(for: id))
        sessions.removeAll { $0.id == id }
        trace("Sessie \(id.uuidString.prefix(8)) verwijderd")
    }
}
