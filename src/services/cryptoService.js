/**
 * Encryption service for user passwords and SSH credentials
 */

const CryptoJS = require('crypto-js');
const config = require('../../config');

class CryptoService {
    constructor() {
        this.key = config.ENCRYPTION_KEY;
    }

    /**
     * Generate deterministic password from userId
     */
    generatePassword(userId) {
        const hash = CryptoJS.HmacSHA256(String(userId), this.key);
        return hash.toString(CryptoJS.enc.Hex).substring(0, 24);
    }

    /**
     * Encrypt data
     */
    encrypt(data) {
        return CryptoJS.AES.encrypt(String(data), this.key).toString();
    }

    /**
     * Decrypt data
     */
    decrypt(encryptedData) {
        const bytes = CryptoJS.AES.decrypt(encryptedData, this.key);
        return bytes.toString(CryptoJS.enc.Utf8);
    }

    /**
     * Decrypt with backwards-compatible plaintext fallback.
     * Returns original value if decryption fails (legacy unencrypted data).
     */
    decryptSafe(value) {
        if (!value) return '';
        try {
            const d = this.decrypt(value);
            if (d) return d;
        } catch (_) {}
        return value;
    }

    /**
     * Decrypt a stored SSH private key.
     * Validates that the result looks like a PEM key; falls back to raw value.
     */
    decryptPrivateKey(key) {
        if (!key) return '';
        try {
            const decrypted = this.decryptSafe(key);
            if (decrypted && decrypted.includes('-----BEGIN')) return decrypted;
        } catch (_) {}
        return key;
    }

    /**
     * Encrypt SSH password and privateKey fields before saving to DB.
     */
    encryptSshCredentials(ssh) {
        if (!ssh) return ssh;
        const result = { ...ssh };
        if (result.password) result.password = this.encrypt(result.password);
        if (result.privateKey) result.privateKey = this.encrypt(result.privateKey);
        return result;
    }

    /**
     * Decrypt SSH credentials with backwards-compatible plaintext fallback.
     */
    decryptSshCredentials(ssh) {
        if (!ssh) return {};
        return {
            ...ssh,
            password: this.decryptSafe(ssh.password),
            privateKey: this.decryptPrivateKey(ssh.privateKey),
        };
    }

    /**
     * Generate random secret for node stats API
     */
    generateNodeSecret() {
        return CryptoJS.lib.WordArray.random(16).toString();
    }
}

module.exports = new CryptoService();
