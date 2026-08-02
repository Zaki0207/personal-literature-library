import Foundation
import Security

private let arguments = CommandLine.arguments

private func exitWithStatus(_ status: OSStatus) -> Never {
    if status == errSecItemNotFound {
        exit(44)
    }
    fputs("macOS Keychain error: \(status)\n", stderr)
    exit(1)
}

guard arguments.count == 4 else {
    fputs("Usage: keychain-helper <has|get|set|delete> <service> <account>\n", stderr)
    exit(2)
}

let action = arguments[1]
let service = arguments[2]
let account = arguments[3]

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

switch action {
case "has":
    let status = SecItemCopyMatching(query as CFDictionary, nil)
    if status == errSecSuccess {
        exit(0)
    }
    exitWithStatus(status)

case "get":
    var getQuery = query
    getQuery[kSecReturnData as String] = true
    getQuery[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(getQuery as CFDictionary, &result)
    guard status == errSecSuccess else {
        exitWithStatus(status)
    }
    guard let data = result as? Data else {
        fputs("macOS Keychain returned invalid data\n", stderr)
        exit(3)
    }
    FileHandle.standardOutput.write(data)

case "set":
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    guard !secret.isEmpty else {
        fputs("Secret cannot be empty\n", stderr)
        exit(2)
    }
    let updateStatus = SecItemUpdate(
        query as CFDictionary,
        [kSecValueData as String: secret] as CFDictionary
    )
    if updateStatus == errSecSuccess {
        exit(0)
    }
    guard updateStatus == errSecItemNotFound else {
        exitWithStatus(updateStatus)
    }
    var addQuery = query
    addQuery[kSecValueData as String] = secret
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
        exitWithStatus(addStatus)
    }

case "delete":
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound {
        exit(0)
    }
    exitWithStatus(status)

default:
    fputs("Unsupported action\n", stderr)
    exit(2)
}
