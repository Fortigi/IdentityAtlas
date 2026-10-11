import InterviewsCore
import SwiftUI

@main
struct InterviewRecorderApp: App {
    @State private var store = SessionStore()

    var body: some Scene {
        WindowGroup {
            SessionListView()
                .environment(store)
                .task {
                    trace("App gestart, versie \(AppInfo.version)")
                    store.loadAll()
                }
        }
    }
}

enum AppInfo {
    static var version: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "nl_NL")
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()
}

struct SessionListView: View {
    @Environment(SessionStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        RecordingView(store: store)
                    } label: {
                        Label("Nieuw gesprek", systemImage: "mic.circle.fill")
                            .font(.headline)
                    }
                }
                Section("Gesprekken") {
                    if store.sessions.isEmpty {
                        Text("Nog geen gesprekken opgenomen.").foregroundStyle(.secondary)
                    }
                    ForEach(store.sessions) { session in
                        NavigationLink {
                            SessionDetailView(sessionId: session.id)
                        } label: {
                            SessionRow(session: session)
                        }
                    }
                }
            }
            .navigationTitle("IA Interviews")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        LogView()
                    } label: {
                        Image(systemName: "doc.text.magnifyingglass")
                    }
                    .accessibilityLabel("Logboek")
                }
            }
            .safeAreaInset(edge: .bottom) {
                Text("Versie \(AppInfo.version) · alles blijft op dit toestel")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 4)
            }
        }
    }
}

struct SessionRow: View {
    let session: SessionRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(session.title).font(.body.weight(.medium))
            HStack(spacing: 6) {
                Text(AppInfo.dateFormatter.string(from: session.startedAt))
                if let d = session.duration { Text("· \(Transcript.timestamp(d))") }
                Text("· \(session.segments.count) zinnen")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if session.status == .interrupted {
                Text("Onderbroken").font(.caption).foregroundStyle(.orange)
            }
        }
    }
}

struct RecordingView: View {
    @State private var controller: RecordingController
    @State private var title = ""
    @State private var informed = false
    @Environment(\.dismiss) private var dismiss

    init(store: SessionStore) {
        _controller = State(initialValue: RecordingController(store: store))
    }

    var body: some View {
        VStack(spacing: 0) {
            switch controller.phase {
            case .idle, .failed:
                setup
            default:
                live
            }
        }
        .navigationTitle(controller.isActive ? "Opname" : "Nieuw gesprek")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(controller.isActive)
        .onChange(of: controller.phase) { _, phase in
            UIApplication.shared.isIdleTimerDisabled = (phase == .recording)
        }
    }

    private var setup: some View {
        Form {
            Section("Gesprek") {
                TextField("Titel, bijv. ‘Hoe Fortigi werkt – met Rob’", text: $title)
            }
            Section {
                Toggle("Iedereen in het gesprek weet dat het wordt opgenomen en lokaal getranscribeerd", isOn: $informed)
            } footer: {
                Text("De opname en de tekst blijven op deze iPhone. Er wordt niets verstuurd.")
            }
            if case let .failed(message) = controller.phase {
                Section { Text(message).foregroundStyle(.red) }
            }
            Section {
                Button {
                    Task { await controller.start(title: title) }
                } label: {
                    Label("Start opname", systemImage: "record.circle")
                        .frame(maxWidth: .infinity)
                }
                .disabled(!informed)
            }
        }
    }

    private var live: some View {
        VStack(spacing: 12) {
            statusBar
            transcript
            controls
        }
        .padding(.top, 8)
    }

    private var statusBar: some View {
        VStack(spacing: 4) {
            Text(Transcript.timestamp(controller.elapsed))
                .font(.system(size: 44, weight: .semibold, design: .monospaced))
            HStack(spacing: 12) {
                if case let .preparing(message) = controller.phase {
                    ProgressView()
                    Text(message)
                } else {
                    Label(controller.record?.localeIdentifier.map { "Transcriptie \($0), lokaal" } ?? "Alleen audio",
                          systemImage: controller.record?.localeIdentifier == nil ? "waveform" : "text.bubble")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Label(controller.batteryLevel.map { "\(Int($0 * 100))%" } ?? "–", systemImage: "battery.75")
                Label(Diagnostics.thermalLabel(controller.thermalState), systemImage: "thermometer.medium")
                if controller.interrupted {
                    Label("Onderbroken", systemImage: "phone.arrow.down.left").foregroundStyle(.orange)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(controller.record?.segments ?? []) { segment in
                        SegmentLine(segment: segment)
                    }
                    if !controller.volatileText.isEmpty {
                        Text(controller.volatileText).foregroundStyle(.secondary).italic()
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal)
            }
            .onChange(of: controller.record?.segments.count) { _, _ in
                withAnimation { proxy.scrollTo("end") }
            }
            .onChange(of: controller.volatileText) { _, _ in
                proxy.scrollTo("end")
            }
        }
        .frame(maxHeight: .infinity)
    }

    @ViewBuilder
    private var controls: some View {
        switch controller.phase {
        case .recording:
            Button {
                Task { await controller.stop() }
            } label: {
                Label("Stop", systemImage: "stop.circle.fill")
                    .font(.title2.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 56)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .padding()
        case .stopping:
            ProgressView("Afronden…").padding()
        case .finished:
            VStack(spacing: 8) {
                Label("Opgeslagen", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                Button("Terug naar overzicht") { dismiss() }
                    .buttonStyle(.borderedProminent)
            }
            .padding()
        default:
            EmptyView()
        }
    }
}

struct SegmentLine: View {
    let segment: TranscriptSegment

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(Transcript.timestamp(segment.start))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            Text(segment.text)
        }
    }
}

struct SessionDetailView: View {
    let sessionId: UUID
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDelete = false

    var body: some View {
        if let session = store.sessions.first(where: { $0.id == sessionId }) {
            List {
                Section("Gesprek") {
                    LabeledContent("Gestart", value: AppInfo.dateFormatter.string(from: session.startedAt))
                    LabeledContent("Duur", value: session.duration.map(Transcript.timestamp) ?? "–")
                    LabeledContent("Taal", value: session.localeIdentifier ?? "geen transcriptie")
                    LabeledContent("Zinnen", value: "\(session.segments.count)")
                    if let used = Diagnostics.batteryUsed(session.diagnostics) {
                        LabeledContent("Batterij gebruikt", value: "\(Int(used))%")
                    }
                    if let hot = Diagnostics.hottest(session.diagnostics) {
                        LabeledContent("Warmste moment", value: Diagnostics.thermalLabel(hot))
                    }
                    if let note = session.transcriptionNote {
                        Text(note).font(.caption).foregroundStyle(.orange)
                    }
                }
                Section {
                    ShareLink(item: Transcript.plainText(session, dateFormatter: AppInfo.dateFormatter)) {
                        Label("Deel tekst", systemImage: "square.and.arrow.up")
                    }
                    ShareLink(item: store.audioURL(for: session.id)) {
                        Label("Deel audio", systemImage: "waveform")
                    }
                    Button("Verwijder gesprek", role: .destructive) { confirmDelete = true }
                }
                Section("Transcript") {
                    if session.segments.isEmpty {
                        Text("Geen tekst.").foregroundStyle(.secondary)
                    }
                    ForEach(session.segments) { SegmentLine(segment: $0) }
                }
            }
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog("Gesprek en opname definitief verwijderen?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Verwijderen", role: .destructive) {
                    store.delete(sessionId)
                    dismiss()
                }
            }
        } else {
            Text("Gesprek niet gevonden.").foregroundStyle(.secondary)
        }
    }
}

struct LogView: View {
    @State private var logStore = AppLog.shared

    var body: some View {
        List(Array(logStore.lines.enumerated().reversed()), id: \.offset) { entry in
            Text(entry.element).font(.caption.monospaced())
        }
        .navigationTitle("Logboek")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: logStore.fileURL) { Image(systemName: "square.and.arrow.up") }
            }
        }
    }
}
