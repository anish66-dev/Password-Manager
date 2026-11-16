package com.personal.passwordmanager.core

enum class CryptoErrorCode(val message: String) {
    INVALID_INPUT("Invalid input."),
    INVALID_FORMAT("Invalid data format."),
    AUTH_FAILED("Authentication failed."),
    KDF_FAILED("Key derivation failed."),
}

/** Crypto failures. Messages are fixed and never include keys, passwords, plaintext or nonces. */
class VaultCryptoException(val code: CryptoErrorCode) : Exception(code.message)

enum class VaultErrorCode(val message: String) {
    ALREADY_EXISTS("A vault already exists."),
    NOT_FOUND("Entry not found."),
    NO_VAULT("No vault has been created yet."),
    BAD_PASSWORD("Incorrect master password."),
}

class VaultException(val code: VaultErrorCode) : Exception(code.message)

enum class SyncErrorCode(val message: String) {
    NO_VAULT("There is no local vault to sync."),
    NO_REMOTE_VAULT("No vault was found in the cloud folder."),
    NO_PENDING_HEADER("There is no newer master password to apply."),
    ALREADY_EXISTS("A vault already exists on this device."),
    VAULT_MISMATCH("The cloud folder holds a different vault than this device. Nothing was merged."),
}

class SyncException(val code: SyncErrorCode) : Exception(code.message)

enum class StorageErrorCode(val message: String) {
    AUTH("Cloud sign-in is required."),
    NETWORK("The cloud storage could not be reached."),
    NOT_FOUND("A cloud file was not found."),
    RATE_LIMITED("The cloud storage is busy. Try again later."),
    SERVER("The cloud storage reported an error."),
}

/** Fixed-message storage failures. Never includes tokens or file contents. */
class StorageException(val code: StorageErrorCode) : Exception(code.message)
