# InterviewsCore (Swift) — NOT COMPILED

> **WARNING: this package was written on Windows, without a Swift toolchain or Xcode. It has
> never been compiled and its tests have never run. Treat it as a reviewed sketch until someone
> runs `swift test` on a Mac and fixes what breaks.**

Pure logic for the planned Identity Atlas Interviews app — no UI, no audio, no networking:

| File | What it does | Server counterpart |
|---|---|---|
| `Resolution.swift` | Candidate classification (homonyms stay ambiguous) and the resolution state machine | `app/api/src/interviews/resolution.js` |
| `MentionDetector.swift` | Deterministic mention detection: team roster, vocabulary, capitalised words; UTF-16 spans | — |
| `LookupDebouncer.swift` | When to look a mention up: debounce, prefix supersede, cache, retry, rate cap | the 120/min limit in `interviews/http/gates.js` |
| `ExcerptHash.swift` | The evidence fingerprint (SHA-256, UTF-8, NFC) | `app/api/src/interviews/evidence.js` (same test vector) |

```bash
cd clients/ios-interviews
swift test        # macOS 14+ / Xcode 15+; CryptoKit is Apple-only
```

The mock Atlas responses for a prototype UI ("William" → one match, "Peter" → two,
"productieomgeving" → not found) are in `app/api/src/interviews/fixtures/`; the API contract is
the **Interviews** tag in `app/api/src/openapi.yaml`. Design and the Phase 0 device spike:
[`docs/architecture/interviews.md`](../../docs/architecture/interviews.md).

This package is not part of any CI job.
