import Foundation
import Security
import LocalAuthentication
import Darwin

// Runtime-only helper. Secret bytes travel exclusively through Node's fd 3
// pipe, never stdout/stderr, command arguments, files, or a diagnostics API.
// A direct terminal invocation has no valid fd 3 and exits before Keychain IO.
func readCredential() -> Int32 {
    let args = CommandLine.arguments
    guard args.count == 6, args[1] == "--service", args[3] == "--account", args[5] == "--no-ui" else { return 2 }
    let valid = "^[A-Za-z0-9_.-]{1,128}$"
    guard args[2].range(of: valid, options: .regularExpression) != nil,
          args[4].range(of: valid, options: .regularExpression) != nil else { return 2 }
    var output = stat()
    guard fstat(3, &output) == 0,
          (output.st_mode & S_IFMT == S_IFIFO || output.st_mode & S_IFMT == S_IFSOCK) else { return 2 }
    // Legacy login-keychain ACL UI and modern authentication UI both fail closed.
    guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { return 2 }
    let context = LAContext()
    context.interactionNotAllowed = true
    var keychain: SecKeychain?
    let path = NSHomeDirectory() + "/Library/Keychains/login.keychain-db"
    guard SecKeychainOpen(path, &keychain) == errSecSuccess, let login = keychain else { return 2 }
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: args[2], kSecAttrAccount as String: args[4],
        kSecMatchSearchList as String: [login], kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true, kSecUseAuthenticationContext as String: context
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          var data = result as? Data, data.count >= 32, data.count <= 256 else { return 2 }
    defer { data.resetBytes(in: 0..<data.count) }
    guard data.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 46 || $0 == 95 }),
          !data.starts(with: [109, 102, 97, 46]) else { return 2 }
    // Broken pipes terminate only this helper; no raw Security error is printed.
    return data.withUnsafeBytes { buffer in
        guard let base = buffer.baseAddress else { return 2 }
        var sent = 0
        while sent < buffer.count {
            let count = Darwin.write(3, base.advanced(by: sent), buffer.count - sent)
            if count <= 0 { return 2 }
            sent += count
        }
        return 0
    }
}
exit(readCredential())
