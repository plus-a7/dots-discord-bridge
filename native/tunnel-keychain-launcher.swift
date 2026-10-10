import Foundation
import Security
import LocalAuthentication
import Darwin

// FD3: bounded fixed diagnostics + parent liveness. FD4: credential to client.
// The real client never inherits FD3. No stdout/stderr or localized error text.
var stopping: Int32 = 0
func stopSignal(_ number: Int32) { stopping = 1 }
func diagnostic(_ code: String) {
    let bytes = Array((code + "\n").utf8)
    // Best effort only: O_NONBLOCK + ignored SIGPIPE cannot delay cleanup.
    bytes.withUnsafeBytes { _ = Darwin.write(3, $0.baseAddress!, bytes.count) }
}
func failure(_ code: String) -> Int32 { diagnostic(code); return 2 }
func securityFailure(_ status: OSStatus, _ stage: String) -> Int32 {
    let category: String
    switch status {
    case errSecItemNotFound: category = "item_not_found"
    case errSecAuthFailed: category = "auth_failed"
    case errSecUserCanceled: category = "user_cancelled"
    case errSecInteractionNotAllowed: category = "interaction_not_allowed"
    case errSecNotAvailable: category = "not_available"
    case errSecParam: category = "invalid_parameter"
    default: category = "other"
    }
    return failure("tunnel_keychain_" + stage + "_failed_" + category)
}
func controlClosed() -> Bool {
    var p = pollfd(fd: 3, events: Int16(POLLIN | POLLHUP), revents: 0)
    if poll(&p, 1, 0) > 0 {
        var byte: UInt8 = 0
        return Darwin.read(3, &byte, 1) <= 0 || byte != 0
    }
    return stopping != 0
}
func childResult(_ status: Int32) {
    let signal = status & 0x7f
    if signal == 0 { diagnostic("tunnel_client_exit_code_" + String((status >> 8) & 0xff)) }
    else { diagnostic("tunnel_client_exit_signal_" + String(signal)) }
}
func waitForChild(_ pid: pid_t, terminate: Bool) -> Int32 {
    diagnostic("tunnel_client_cleanup_started")
    if terminate { _ = kill(-pid, SIGTERM) }
    let deadline = Date().addingTimeInterval(3)
    var status: Int32 = 0
    while true {
        let result = waitpid(pid, &status, WNOHANG)
        if result == pid { childResult(status); break }
        if result < 0 && errno != EINTR { diagnostic("tunnel_client_wait_failed"); break }
        if Date() >= deadline {
            diagnostic("tunnel_client_cleanup_forced")
            _ = kill(-pid, SIGKILL)
            while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
            childResult(status); break
        }
        usleep(20_000)
    }
    _ = kill(-pid, SIGKILL)
    diagnostic("tunnel_client_cleanup_complete")
    return terminate ? 0 : (status == 0 ? 0 : 2)
}
func run() -> Int32 {
    let args = CommandLine.arguments
    guard args.count == 5, args[1] == "--client", args[3] == "--config",
          args[2].hasPrefix("/"), args[4].hasPrefix("/") else { return 2 }
    var controlStat = stat()
    guard fstat(3, &controlStat) == 0,
          (controlStat.st_mode & S_IFMT == S_IFIFO || controlStat.st_mode & S_IFMT == S_IFSOCK) else { return 2 }
    signal(SIGTERM, stopSignal); signal(SIGINT, stopSignal); signal(SIGHUP, stopSignal); signal(SIGPIPE, SIG_IGN)
    var hello = [UInt8](repeating: 0, count: 6)
    var count = 0
    while count < hello.count {
        let remaining = hello.count - count
        let got = hello.withUnsafeMutableBytes { Darwin.read(3, $0.baseAddress!.advanced(by: count), remaining) }
        if got <= 0 { return 2 }; count += got
    }
    guard hello == Array("START\n".utf8), !controlClosed() else { return 2 }
    let flags = fcntl(3, F_GETFL)
    guard flags >= 0, fcntl(3, F_SETFL, flags | O_NONBLOCK) == 0 else { return 2 }
    diagnostic("tunnel_helper_started")
    var coreLimit = rlimit(rlim_cur: 0, rlim_max: 0)
    guard setrlimit(RLIMIT_CORE, &coreLimit) == 0 else { return failure("tunnel_helper_core_limit_failed") }
    // Bounds a stuck dialog before any real client is spawned.
    alarm(900)
    var data: Data
    diagnostic("tunnel_keychain_lookup_started")
    #if TUNNEL_MOCK
    // Test-only compile branch. These filenames are inert in production.
    switch URL(fileURLWithPath: args[2]).lastPathComponent {
    case "mock-keychain-notfound": return securityFailure(errSecItemNotFound, "lookup")
    case "mock-keychain-denied": return securityFailure(errSecAuthFailed, "lookup")
    case "mock-keychain-cancelled": return securityFailure(errSecUserCanceled, "lookup")
    case "mock-keychain-interaction": return securityFailure(errSecInteractionNotAllowed, "lookup")
    case "mock-keychain-other": return securityFailure(OSStatus(-1), "lookup")
    default: break
    }
    data = Data("sk-MOCK-ONLY-PIPE-CREDENTIAL-0123456789abcdef".utf8)
    #else
    // Public template: configure dedicated references locally, rebuild and repin.
    let keychainService = "__TUNNEL_KEYCHAIN_SERVICE__"
    let keychainAccount = "__TUNNEL_KEYCHAIN_ACCOUNT__"
    guard !keychainService.hasPrefix("__"), !keychainAccount.hasPrefix("__") else { return failure("tunnel_helper_reference_unconfigured") }
    guard isatty(STDIN_FILENO) == 1 else { return failure("tunnel_helper_terminal_required") }
    var keychain: SecKeychain?
    let opened = SecKeychainOpen(NSHomeDirectory() + "/Library/Keychains/login.keychain-db", &keychain)
    guard opened == errSecSuccess else { return securityFailure(opened, "open") }
    guard let login = keychain else { return failure("tunnel_keychain_open_failed_other") }
    let context = LAContext()
    context.localizedReason = "Start the approved metadata-only Secure MCP Tunnel"
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: keychainAccount,
        kSecMatchSearchList as String: [login], kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true, kSecUseAuthenticationContext as String: context
    ]
    var result: CFTypeRef?
    let matched = SecItemCopyMatching(query as CFDictionary, &result)
    guard matched == errSecSuccess else { return securityFailure(matched, "lookup") }
    guard let credential = result as? Data else { return failure("tunnel_keychain_data_type_invalid") }
    data = credential
    #endif
    defer { data.resetBytes(in: 0..<data.count) }
    diagnostic("tunnel_keychain_lookup_complete")
    guard data.count >= 32, data.count <= 1024,
          data.starts(with: Array("sk-".utf8)),
          data.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95 }) else { return failure("tunnel_credential_format_invalid") }
    if controlClosed() { return failure("tunnel_start_cancelled_before_client") }
    alarm(0)
    var secretPipe: [Int32] = [0, 0]
    guard pipe(&secretPipe) == 0 else { return failure("tunnel_credential_pipe_failed") }
    defer { close(secretPipe[0]); close(secretPipe[1]) }
    var actions: posix_spawn_file_actions_t?
    var attributes: posix_spawnattr_t?
    guard posix_spawn_file_actions_init(&actions) == 0 else { return failure("tunnel_client_spawn_setup_failed") }
    defer { posix_spawn_file_actions_destroy(&actions) }
    guard posix_spawnattr_init(&attributes) == 0 else { return failure("tunnel_client_spawn_setup_failed") }
    defer { posix_spawnattr_destroy(&attributes) }
    guard posix_spawn_file_actions_adddup2(&actions, secretPipe[0], 4) == 0,
          secretPipe[0] == 4 || posix_spawn_file_actions_addclose(&actions, secretPipe[0]) == 0,
          posix_spawn_file_actions_addclose(&actions, secretPipe[1]) == 0,
          posix_spawn_file_actions_addclose(&actions, 3) == 0,
          posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0) == 0,
          posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0,
          posix_spawnattr_setpgroup(&attributes, 0) == 0 else { return failure("tunnel_client_spawn_setup_failed") }
    let command = [args[2], "run", "--config", args[4], "--control-plane.api-key", "file:/dev/fd/4"]
    let strings = command.map { strdup($0)! }
    let environment = ["PATH=/usr/bin:/bin", "HOME=" + NSHomeDirectory()].map { strdup($0)! }
    defer { strings.forEach { free($0) }; environment.forEach { free($0) } }
    var argv: [UnsafeMutablePointer<CChar>?] = strings.map { $0 } + [nil]
    var env: [UnsafeMutablePointer<CChar>?] = environment.map { $0 } + [nil]
    var pid: pid_t = 0
    diagnostic("tunnel_client_spawn_started")
    let spawned = posix_spawn(&pid, args[2], &actions, &attributes, &argv, &env)
    if spawned != 0 {
        switch spawned {
        case ENOENT: return failure("tunnel_client_spawn_failed_not_found")
        case EACCES: return failure("tunnel_client_spawn_failed_permission")
        case ENOEXEC: return failure("tunnel_client_spawn_failed_executable")
        default: return failure("tunnel_client_spawn_failed_other")
        }
    }
    diagnostic("tunnel_client_pid_" + String(pid))
    let sent = data.withUnsafeBytes { bytes -> Bool in
        var offset = 0
        while offset < bytes.count {
            let n = Darwin.write(secretPipe[1], bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if n <= 0 { return false }; offset += n
        }
        return true
    }
    close(secretPipe[1]); secretPipe[1] = -1
    data.resetBytes(in: 0..<data.count)
    if !sent { diagnostic("tunnel_credential_handoff_failed"); _ = waitForChild(pid, terminate: true); return 2 }
    diagnostic("tunnel_credential_handoff_complete")
    let deadline = Date().addingTimeInterval(900)
    var status: Int32 = 0
    while true {
        let result = waitpid(pid, &status, WNOHANG)
        if result == pid {
            childResult(status); _ = kill(-pid, SIGKILL); diagnostic("tunnel_client_cleanup_complete")
            return status == 0 ? 0 : 2
        }
        if result < 0 && errno != EINTR { diagnostic("tunnel_client_wait_failed"); _ = kill(-pid, SIGKILL); return 2 }
        if controlClosed() || Date() >= deadline { return waitForChild(pid, terminate: true) }
        usleep(20_000)
    }
}
exit(run())
