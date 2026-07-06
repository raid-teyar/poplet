//! Local secrets vault crypto core.
//!
//! Security model: the master passphrase is the only secret and is NEVER
//! stored. A memory-hard KDF (Argon2id) turns it into a 256-bit key held only
//! in process memory while unlocked (zeroized on lock). Each secret is sealed
//! with XChaCha20-Poly1305 (authenticated encryption, random 192-bit nonce).
//! The database only ever holds: a random salt, KDF params, an encrypted
//! verifier token, and the encrypted secrets — so a stolen DB reveals nothing
//! without the passphrase, and open-sourcing the code changes nothing
//! (Kerckhoffs's principle).

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use std::sync::Mutex;
use zeroize::Zeroizing;

const VERIFIER_TOKEN: &[u8] = b"poplet-vault-v1";
// Argon2id cost: 64 MiB, 3 passes, 1 lane. Tuned to make offline guessing of a
// stolen DB expensive while staying snappy on unlock.
const MEM_KIB: u32 = 65_536;
const ITERS: u32 = 3;
const PARALLELISM: u32 = 1;

/// Holds the derived key in memory only while the vault is unlocked.
#[derive(Default)]
pub struct VaultState {
    key: Mutex<Option<Zeroizing<[u8; 32]>>>,
}

/// Public metadata persisted by the frontend (contains no secret).
#[derive(serde::Serialize)]
pub struct VaultMeta {
    salt: String,
    verifier: String,
    mem_kib: u32,
    iters: u32,
    parallelism: u32,
}

fn derive_key(
    passphrase: &str,
    salt: &[u8],
    mem_kib: u32,
    iters: u32,
    parallelism: u32,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let params =
        Params::new(mem_kib, iters, parallelism, Some(32)).map_err(|e| e.to_string())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut_slice())
        .map_err(|e| e.to_string())?;
    Ok(key)
}

fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<String, String> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| "encryption failed".to_string())?;
    let mut out = Vec::with_capacity(24 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(general_purpose::STANDARD.encode(out))
}

fn open(key: &[u8; 32], b64: &str) -> Result<Vec<u8>, String> {
    let data = general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    if data.len() < 24 {
        return Err("ciphertext too short".to_string());
    }
    let (nonce, ct) = data.split_at(24);
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|e| e.to_string())?;
    cipher
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| "wrong passphrase or corrupt data".to_string())
}

fn b64(bytes: &[u8]) -> String {
    general_purpose::STANDARD.encode(bytes)
}

/// Initialize a brand-new vault: derive a key from a fresh salt, hold it in
/// memory (unlocked), and return the metadata the frontend must persist.
#[tauri::command]
pub fn vault_setup(
    state: tauri::State<'_, VaultState>,
    passphrase: String,
) -> Result<VaultMeta, String> {
    if passphrase.chars().count() < 8 {
        return Err("Passphrase must be at least 8 characters".to_string());
    }
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let key = derive_key(&passphrase, &salt, MEM_KIB, ITERS, PARALLELISM)?;
    let verifier = seal(&key, VERIFIER_TOKEN)?;
    *state.key.lock().unwrap() = Some(key);
    Ok(VaultMeta {
        salt: b64(&salt),
        verifier,
        mem_kib: MEM_KIB,
        iters: ITERS,
        parallelism: PARALLELISM,
    })
}

/// Unlock an existing vault: re-derive the key and verify it against the stored
/// verifier token before accepting it.
#[tauri::command]
pub fn vault_unlock(
    state: tauri::State<'_, VaultState>,
    passphrase: String,
    salt: String,
    verifier: String,
    mem_kib: u32,
    iters: u32,
    parallelism: u32,
) -> Result<(), String> {
    let salt = general_purpose::STANDARD
        .decode(&salt)
        .map_err(|e| e.to_string())?;
    let key = derive_key(&passphrase, &salt, mem_kib, iters, parallelism)?;
    let token = open(&key, &verifier)?;
    if token != VERIFIER_TOKEN {
        return Err("Wrong passphrase".to_string());
    }
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}

#[tauri::command]
pub fn vault_lock(state: tauri::State<'_, VaultState>) {
    *state.key.lock().unwrap() = None;
}

#[tauri::command]
pub fn vault_is_unlocked(state: tauri::State<'_, VaultState>) -> bool {
    state.key.lock().unwrap().is_some()
}

#[tauri::command]
pub fn vault_encrypt(
    state: tauri::State<'_, VaultState>,
    plaintext: String,
) -> Result<String, String> {
    let guard = state.key.lock().unwrap();
    let key = guard.as_ref().ok_or("Vault is locked")?;
    seal(key, plaintext.as_bytes())
}

#[tauri::command]
pub fn vault_decrypt(
    state: tauri::State<'_, VaultState>,
    ciphertext: String,
) -> Result<String, String> {
    let guard = state.key.lock().unwrap();
    let key = guard.as_ref().ok_or("Vault is locked")?;
    let bytes = open(key, &ciphertext)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// Seal an arbitrary bundle under a standalone backup passphrase. The salt is
/// embedded in the blob so `backup_open` needs only the passphrase — this is
/// independent of the vault's in-memory key.
#[tauri::command]
pub fn backup_seal(passphrase: String, plaintext: String) -> Result<String, String> {
    if passphrase.chars().count() < 8 {
        return Err("Backup passphrase must be at least 8 characters".to_string());
    }
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let key = derive_key(&passphrase, &salt, MEM_KIB, ITERS, PARALLELISM)?;
    // seal() prepends the nonce; we prepend the salt so the whole thing is
    // salt(16) ‖ nonce(24) ‖ ciphertext, base64 once.
    let sealed = seal(&key, plaintext.as_bytes())?;
    let inner = general_purpose::STANDARD
        .decode(&sealed)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(16 + inner.len());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&inner);
    Ok(general_purpose::STANDARD.encode(out))
}

#[tauri::command]
pub fn backup_open(passphrase: String, blob: String) -> Result<String, String> {
    let data = general_purpose::STANDARD
        .decode(&blob)
        .map_err(|e| e.to_string())?;
    if data.len() < 16 + 24 {
        return Err("backup file is corrupt".to_string());
    }
    let (salt, inner) = data.split_at(16);
    let key = derive_key(&passphrase, salt, MEM_KIB, ITERS, PARALLELISM)?;
    let bytes = open(&key, &general_purpose::STANDARD.encode(inner))?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}
