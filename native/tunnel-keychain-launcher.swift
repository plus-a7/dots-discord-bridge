import Foundation
import Security
import LocalAuthentication
import Darwin

// User-started only. FD 3 is a parent-liveness/control pipe, never a secret
// channel. Credential bytes go directly to the client's inherited OS pipe FD 4.
// stdout/stderr are discarded by the parent. This helper registers no service.
var stopping: Int32 = 0
func stopSignal(_ number: Int32) { stopping = 1 }
func controlClosed() -> Bool {
    var p = pollfd(fd: 3, events: Int16(POLLIN | POLLHUP), revents: 0)
    if poll(&p, 1, 0) > 0 {
        var byte: UInt8 = 0
        return Darwin.read(3, &byte, 1) <= 0 || byte != 0
    }
    return stopping != 0
}
func waitForChild(_ pid: pid_t, terminate: Bool) -> Int32 {
    if terminate { _ = kill(-pid, SIGTERM) }
    let deadline = Date().addingTimeInterval(3)
    var status: Int32 = 0
    while waitpid(pid, &status, WNOHANG) == 0 {
        if Date() >= deadline { _ = kill(-pid, SIGKILL); _ = waitpid(pid, &status, 0); return terminate ? 0 : 2 }
        usleep(20_000)
    }
    // A client may exit before a descendant; stop the entire owned group.
    _ = kill(-pid, SIGKILL)
    return terminate ? 0 : (status == 0 ? 0 : 2)
}
func run() -> Int32 {
    let args = CommandLine.arguments
    guard args.count == 5, args[1] == "--client", args[3] == "--config",
          args[2].hasPrefix("/"), args[4].hasPrefix("/") else { return 2 }
    var controlStat = stat()
    guard fstat(3, &controlStat) == 0,
          (controlStat.st_mode & S_IFMT == S_IFIFO || controlStat.st_mode & S_IFMT == S_IFSOCK) else { return 2 }
    var hello = [UInt8](repeating: 0, count: 6)
    var count = 0
    while count < hello.count {
        let remaining = hello.count - count
        let got = hello.withUnsafeMutableBytes { Darwin.read(3, $0.baseAddress!.advanced(by: count), remaining) }
        if got <= 0 { return 2 }; count += got
    }
    guard hello == Array("START\n".utf8), !controlClosed() else { return 2 }
    var coreLimit = rlimit(rlim_cur: 0, rlim_max: 0)
    guard setrlimit(RLIMIT_CORE, &coreLimit) == 0 else { return 2 }
    signal(SIGTERM, stopSignal); signal(SIGINT, stopSignal); signal(SIGHUP, stopSignal); signal(SIGPIPE, SIG_IGN)
    // Bounds a stuck Keychain dialog too. The client is spawned only after read.
    alarm(900)
    var data: Data
    #if TUNNEL_MOCK
    data = Data("sk-MOCK-ONLY-PIPE-CREDENTIAL-0123456789abcdef".utf8)
    #else
    // Public template: set dedicated reference names locally, rebuild, and
    // regenerate the reviewed plan pins before any production activation.
    let keychainService = "__TUNNEL_KEYCHAIN_SERVICE__"
    let keychainAccount = "__TUNNEL_KEYCHAIN_ACCOUNT__"
    guard !keychainService.hasPrefix("__"), !keychainAccount.hasPrefix("__") else { return 2 }
    guard isatty(STDIN_FILENO) == 1 else { return 2 }
    var keychain: SecKeychain?
    guard SecKeychainOpen(NSHomeDirectory() + "/Library/Keychains/login.keychain-db", &keychain) == errSecSuccess,
          let login = keychain else { return 2 }
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
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let credential = result as? Data else { return 2 }
    data = credential
    #endif
    defer { data.resetBytes(in: 0..<data.count) }
    guard data.count >= 32, data.count <= 1024,
          data.starts(with: Array("sk-".utf8)),
          data.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95 }),
          !controlClosed() else { return 2 }
    // After Keychain completes, cleanup is controlled by the loop below;
    // an asynchronous alarm must never kill this guardian after child spawn.
    alarm(0)
    var secretPipe: [Int32] = [0, 0]
    guard pipe(&secretPipe) == 0 else { return 2 }
    defer { close(secretPipe[0]); close(secretPipe[1]) }
    var actions: posix_spawn_file_actions_t?
    var attributes: posix_spawnattr_t?
    guard posix_spawn_file_actions_init(&actions) == 0,
          posix_spawnattr_init(&attributes) == 0 else { return 2 }
    defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
    posix_spawn_file_actions_adddup2(&actions, secretPipe[0], 4)
    if secretPipe[0] != 4 { posix_spawn_file_actions_addclose(&actions, secretPipe[0]) }
    posix_spawn_file_actions_addclose(&actions, secretPipe[1])
    posix_spawn_file_actions_addclose(&actions, 3)
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
    posix_spawnattr_setpgroup(&attributes, 0)
    let command = [args[2], "run", "--config", args[4], "--control-plane.api-key", "file:/dev/fd/4"]
    let strings = command.map { strdup($0)! }
    let environment = ["PATH=/usr/bin:/bin", "HOME=" + NSHomeDirectory()].map { strdup($0)! }
    defer { strings.forEach { free($0) }; environment.forEach { free($0) } }
    var argv: [UnsafeMutablePointer<CChar>?] = strings.map { $0 } + [nil]
    var env: [UnsafeMutablePointer<CChar>?] = environment.map { $0 } + [nil]
    var pid: pid_t = 0
    guard posix_spawn(&pid, args[2], &actions, &attributes, &argv, &env) == 0 else { return 2 }
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
    alarm(0)
    if !sent { _ = waitForChild(pid, terminate: true); return 2 }
    let deadline = Date().addingTimeInterval(900)
    var status: Int32 = 0
    while true {
        let result = waitpid(pid, &status, WNOHANG)
        if result == pid { _ = kill(-pid, SIGKILL); return status == 0 ? 0 : 2 }
        if result < 0 { _ = kill(-pid, SIGKILL); return 2 }
        if controlClosed() || Date() >= deadline { return waitForChild(pid, terminate: true) }
        usleep(20_000)
    }
}
exit(run())
