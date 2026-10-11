# Identity Atlas Interviews — iPhone/iPad client

Two parts:

| Folder | What | Built by |
|---|---|---|
| `Sources/InterviewsCore`, `Tests/` | Pure Swift logic: mention resolution, lookup debouncing, evidence hash, and the recorded-session model (`Recording.swift`) | `swift test` in the **iOS Interviews app** workflow |
| `App/` | **IA Interviews**, the recorder app (SwiftUI, iOS 26+) | the same workflow: simulator build on every PR, signed TestFlight build on pushes to `feature/interviews-ios*` |

Nobody needs a Mac: [`.github/workflows/ios-interviews.yml`](../../.github/workflows/ios-interviews.yml)
runs on a GitHub-hosted macOS runner, generates the Xcode project from `App/project.yml` with
[XcodeGen](https://github.com/yonaskolb/XcodeGen) and builds it. The `.xcodeproj` is never committed.

| File | What it does | Server counterpart |
|---|---|---|
| `Resolution.swift` | Candidate classification (homonyms stay ambiguous) and the resolution state machine | `app/api/src/interviews/resolution.js` |
| `MentionDetector.swift` | Deterministic mention detection: team roster, vocabulary, capitalised words; UTF-16 spans | — |
| `LookupDebouncer.swift` | When to look a mention up: debounce, prefix supersede, cache, retry, rate cap | the 120/min limit in `interviews/http/gates.js` |
| `ExcerptHash.swift` | The evidence fingerprint (SHA-256, UTF-8, NFC) | `app/api/src/interviews/evidence.js` (same test vector) |
| `Recording.swift` | The session kept on the phone: segments, crash recovery, diagnostics, export text | — |

The mock Atlas responses for a prototype UI ("William" → one match, "Peter" → two,
"productieomgeving" → not found) are in `app/api/src/interviews/fixtures/`; the API contract is
the **Interviews** tag in `app/api/src/openapi.yaml`. Design:
[`docs/architecture/interviews.md`](../../docs/architecture/interviews.md).

## What the recorder does (step 1 of the proof of concept)

- Records the conversation to `audio.m4a` on the phone and keeps recording with the screen locked.
- Transcribes live **on the device** with Apple's `SpeechAnalyzer` / `SpeechTranscriber` (iOS 26),
  Dutch (`nl-NL`) by default, with a timestamp per sentence. Nothing is sent anywhere.
- Recording never depends on transcription: if Dutch is unavailable or the recogniser stops, the
  audio carries on and the session says why the text is missing.
- Saves the session after every finished sentence; a session cut off by a crash or reboot shows
  up as *Onderbroken* with everything up to that moment.
- Logs battery and temperature every 30 s, for the one-hour feasibility test.
- In-app log (*Logboek*) and share buttons for text, audio and log — the substitute for a Mac console.

Not yet: entity lookup against Identity Atlas (step 2), report and relation proposals (step 3),
question suggestions (step 4), speaking (step 5).

## TestFlight setup (one-time, by the Apple account holder)

1. Join the Apple Developer Program (individual is fastest).
2. App Store Connect → Apps → **+** → New App: platform iOS, name *Identity Atlas Interviews*,
   bundle ID `io.identityatlas.interviews` (register it under Certificates, IDs & Profiles →
   Identifiers first if the form does not offer it), any SKU.
3. App Store Connect → Users and Access → Integrations → App Store Connect API → **Generate API key**
   with access **Admin** (cloud-managed signing needs it). Download the `.p8` — it can be downloaded once.
4. GitHub → repository Settings → Secrets and variables → Actions → add `ASC_KEY_ID` (the key ID),
   `ASC_ISSUER_ID` (shown above the key list), `ASC_KEY_P8` (the full contents of the `.p8`,
   BEGIN/END lines included) and `APPLE_TEAM_ID` (developer.apple.com → Membership details).
5. Actions → **iOS Interviews app** → Run workflow on the `feature/interviews-ios-recorder` branch.
6. App Store Connect → the app → TestFlight → Internal Testing → add yourself, then install through
   the TestFlight app on the iPhone.

On the iPhone: Settings → Apple Intelligence & Siri on, with Dutch as the device **and** Siri language.

## Core tests on a Mac

```bash
cd clients/ios-interviews
swift test
```
