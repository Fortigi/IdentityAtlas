import CryptoKit
import Foundation

/// The evidence fingerprint the server expects (app/api/src/interviews/evidence.js):
/// lowercase hex SHA-256 over the UTF-8 bytes of the excerpt in Unicode NFC.
public enum ExcerptHash {
    public static func of(_ excerpt: String) -> String {
        let nfc = excerpt.precomposedStringWithCanonicalMapping
        return SHA256.hash(data: Data(nfc.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
