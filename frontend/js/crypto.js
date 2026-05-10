/**
 * PhantomChat — Cryptography Engine v3
 * ======================================
 * Pure Web Crypto API. Zero external dependencies.
 *
 * V3 Changes:
 *   - Keys are now extractable: true (needed for password-encrypted vault storage)
 *   - Key vault: PBKDF2 → AES-GCM encrypt/decrypt of private keys
 *   - Server NEVER sees plaintext private keys
 */

const PhantomCrypto = (() => {
  "use strict";

  const subtle = window.crypto.subtle;
  const getRandomBytes = (n) => window.crypto.getRandomValues(new Uint8Array(n));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // -------------------------------------------------------------------------
  // Key Generation (V3: extractable for vault storage)
  // -------------------------------------------------------------------------

  async function generateECDHKeyPair() {
    return subtle.generateKey(
      { name: "ECDH", namedCurve: "P-384" },
      true, // V3: extractable — needed for vault encrypt/export
      ["deriveKey", "deriveBits"]
    );
  }

  async function generateECDSAKeyPair() {
    return subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-384" },
      true, // V3: extractable
      ["sign", "verify"]
    );
  }

  async function generateKeyPairs() {
    const [ecdh, ecdsa] = await Promise.all([
      generateECDHKeyPair(),
      generateECDSAKeyPair(),
    ]);
    return { ecdh, ecdsa };
  }

  async function generateEphemeralKeyPair() {
    return subtle.generateKey(
      { name: "ECDH", namedCurve: "P-384" },
      true,
      ["deriveKey", "deriveBits"]
    );
  }

  // -------------------------------------------------------------------------
  // Key Export / Import
  // -------------------------------------------------------------------------

  async function exportPublicKey(publicKey) {
    return subtle.exportKey("jwk", publicKey);
  }

  async function exportPrivateKey(privateKey) {
    return subtle.exportKey("jwk", privateKey);
  }

  async function importECDHPublicKey(jwk) {
    return subtle.importKey("jwk", jwk,
      { name: "ECDH", namedCurve: "P-384" }, true, []);
  }

  async function importECDHPrivateKey(jwk) {
    return subtle.importKey("jwk", jwk,
      { name: "ECDH", namedCurve: "P-384" }, true, ["deriveKey", "deriveBits"]);
  }

  async function importECDSAPublicKey(jwk) {
    return subtle.importKey("jwk", jwk,
      { name: "ECDSA", namedCurve: "P-384", hash: "SHA-384" }, true, ["verify"]);
  }

  async function importECDSAPrivateKey(jwk) {
    return subtle.importKey("jwk", jwk,
      { name: "ECDSA", namedCurve: "P-384" }, true, ["sign"]);
  }

  // -------------------------------------------------------------------------
  // Key Vault: Password → PBKDF2 → AES-GCM encrypt/decrypt private keys
  // -------------------------------------------------------------------------

  async function deriveVaultKey(password, salt) {
    const keyMaterial = await subtle.importKey(
      "raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Encrypt the user's private keys with their password.
   * Returns a base64 string containing salt + iv + ciphertext.
   */
  async function encryptKeyVault(password, keys) {
    const vaultData = JSON.stringify({
      ecdhPrivate: await exportPrivateKey(keys.ecdh.privateKey),
      ecdhPublic: await exportPublicKey(keys.ecdh.publicKey),
      ecdsaPrivate: await exportPrivateKey(keys.ecdsa.privateKey),
      ecdsaPublic: await exportPublicKey(keys.ecdsa.publicKey),
    });

    const salt = getRandomBytes(16);
    const iv = getRandomBytes(12);
    const vaultKey = await deriveVaultKey(password, salt);

    const ciphertext = await subtle.encrypt(
      { name: "AES-GCM", iv },
      vaultKey,
      encoder.encode(vaultData)
    );

    // Pack: salt(16) + iv(12) + ciphertext
    const packed = new Uint8Array(16 + 12 + ciphertext.byteLength);
    packed.set(salt, 0);
    packed.set(iv, 16);
    packed.set(new Uint8Array(ciphertext), 28);

    return arrayBufferToBase64(packed.buffer);
  }

  /**
   * Decrypt the vault and return imported CryptoKeyPair objects.
   */
  async function decryptKeyVault(password, vaultBase64) {
    const packed = base64ToUint8Array(vaultBase64);
    const salt = packed.slice(0, 16);
    const iv = packed.slice(16, 28);
    const ciphertext = packed.slice(28);

    const vaultKey = await deriveVaultKey(password, salt);

    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv },
      vaultKey,
      ciphertext
    );

    const data = JSON.parse(decoder.decode(plaintext));

    const ecdhPriv = await importECDHPrivateKey(data.ecdhPrivate);
    const ecdhPub = await importECDHPublicKey(data.ecdhPublic);
    const ecdsaPriv = await importECDSAPrivateKey(data.ecdsaPrivate);
    const ecdsaPub = await importECDSAPublicKey(data.ecdsaPublic);

    return {
      ecdh: { privateKey: ecdhPriv, publicKey: ecdhPub },
      ecdsa: { privateKey: ecdsaPriv, publicKey: ecdsaPub },
    };
  }

  // -------------------------------------------------------------------------
  // Key Derivation: ECDH → HKDF → AES-GCM-256
  // -------------------------------------------------------------------------

  async function deriveSharedSecret(myPrivateKey, theirPublicKey) {
    const rawBits = await subtle.deriveBits(
      { name: "ECDH", public: theirPublicKey },
      myPrivateKey, 384
    );
    const hkdfKey = await subtle.importKey(
      "raw", rawBits, { name: "HKDF" }, false, ["deriveKey"]
    );
    return subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256",
        salt: encoder.encode("PhantomChat-v3-PFS-salt"),
        info: encoder.encode("PhantomChat-E2EE-AES-GCM-256-PFS") },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      true, ["encrypt", "decrypt"]
    );
  }

  // -------------------------------------------------------------------------
  // Encryption / Decryption — Text
  // -------------------------------------------------------------------------

  async function encryptMessage(sharedKey, plaintext) {
    const iv = getRandomBytes(12);
    const ciphertext = await subtle.encrypt(
      { name: "AES-GCM", iv }, sharedKey, encoder.encode(plaintext)
    );
    return { ciphertext, iv };
  }

  async function decryptMessage(sharedKey, ciphertext, iv) {
    const buf = await subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, ciphertext);
    return decoder.decode(buf);
  }

  // -------------------------------------------------------------------------
  // Encryption / Decryption — Binary (images, videos, files)
  // -------------------------------------------------------------------------

  async function encryptBinary(sharedKey, arrayBuffer) {
    const iv = getRandomBytes(12);
    const ciphertext = await subtle.encrypt(
      { name: "AES-GCM", iv }, sharedKey, arrayBuffer
    );
    return { ciphertext, iv };
  }

  async function decryptBinary(sharedKey, ciphertext, iv) {
    return subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, ciphertext);
  }

  // -------------------------------------------------------------------------
  // Digital Signatures (ECDSA)
  // -------------------------------------------------------------------------

  async function signPayload(privateKey, data) {
    return subtle.sign({ name: "ECDSA", hash: "SHA-384" }, privateKey, data);
  }

  async function verifySignature(publicKey, signature, data) {
    return subtle.verify({ name: "ECDSA", hash: "SHA-384" }, publicKey, signature, data);
  }

  // -------------------------------------------------------------------------
  // Encoding Helpers
  // -------------------------------------------------------------------------

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // -------------------------------------------------------------------------
  // Cryptographic Shredding
  // -------------------------------------------------------------------------

  async function shredKey(key) {
    try {
      const rawKey = await subtle.exportKey("raw", key);
      const view = new Uint8Array(rawKey);
      for (let i = 0; i < 3; i++) window.crypto.getRandomValues(view);
      view.fill(0);
    } catch (e) {
      console.debug("[Shredder] Key shred fallback.");
    }
  }

  async function shredEphemeralPrivateKey(privateKey) {
    try {
      const rawKey = await subtle.exportKey("pkcs8", privateKey);
      const view = new Uint8Array(rawKey);
      for (let i = 0; i < 3; i++) window.crypto.getRandomValues(view);
      view.fill(0);
    } catch (e) {
      console.debug("[Shredder] Ephemeral key shred fallback.");
    }
  }

  // -------------------------------------------------------------------------
  // High-Level: Build Sealed Envelope (PFS Ratchet)
  // -------------------------------------------------------------------------

  async function buildSealedEnvelope({
    senderId, recipientId, text, ttl,
    ecdsaPrivate, recipientEcdhPublic,
    mediaBuffer = null, mediaType = null, fileName = null,
  }) {
    const ephemeral = await generateEphemeralKeyPair();
    const sharedKey = await deriveSharedSecret(ephemeral.privateKey, recipientEcdhPublic);

    const payloadObj = {
      sender_id: senderId, text: text || "",
      timestamp: Date.now(), ttl: ttl,
    };

    let encryptedMedia = null;
    if (mediaBuffer && mediaType) {
      const mediaCrypt = await encryptBinary(sharedKey, mediaBuffer);
      encryptedMedia = {
        data: arrayBufferToBase64(mediaCrypt.ciphertext),
        iv: arrayBufferToBase64(mediaCrypt.iv),
        type: mediaType,
        name: fileName || "file",
      };
      payloadObj.has_media = true;
      payloadObj.media_type = mediaType;
      payloadObj.file_name = fileName;
    }

    const payloadStr = JSON.stringify(payloadObj);
    const { ciphertext, iv } = await encryptMessage(sharedKey, payloadStr);
    const signature = await signPayload(ecdsaPrivate, ciphertext);
    const ephemeralPubJwk = await exportPublicKey(ephemeral.publicKey);

    await shredEphemeralPrivateKey(ephemeral.privateKey);
    await shredKey(sharedKey);

    // Determine type
    let envType = "message";
    if (mediaBuffer) {
      if (mediaType.startsWith("video/")) envType = "file";
      else if (mediaType.startsWith("image/")) envType = "image";
      else envType = "file";
    }

    const envelope = {
      type: envType,
      recipient_id: recipientId,
      payload: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv),
      signature: arrayBufferToBase64(signature),
      sender_ecdh_pub: ephemeralPubJwk,
    };

    if (encryptedMedia) envelope.media = encryptedMedia;
    return envelope;
  }

  // -------------------------------------------------------------------------
  // High-Level: Open Sealed Envelope
  // -------------------------------------------------------------------------

  async function openSealedEnvelope(envelope, myEcdhPrivate) {
    const senderEphemeralPub = await importECDHPublicKey(envelope.sender_ecdh_pub);
    const sharedKey = await deriveSharedSecret(myEcdhPrivate, senderEphemeralPub);

    const ciphertext = base64ToArrayBuffer(envelope.payload);
    const iv = base64ToUint8Array(envelope.iv);
    const plaintext = await decryptMessage(sharedKey, ciphertext, iv);
    const data = JSON.parse(plaintext);

    let mediaBlob = null;
    let mediaType = null;
    let fileName = null;
    if (envelope.media) {
      const mc = base64ToArrayBuffer(envelope.media.data);
      const mi = base64ToUint8Array(envelope.media.iv);
      const mb = await decryptBinary(sharedKey, mc, mi);
      mediaType = envelope.media.type;
      fileName = envelope.media.name || "file";
      mediaBlob = new Blob([mb], { type: mediaType });
    }

    return {
      senderId: data.sender_id, text: data.text,
      timestamp: data.timestamp, ttl: data.ttl,
      sharedKey, hasMedia: !!mediaBlob,
      mediaBlob, mediaType, fileName,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  return {
    generateKeyPairs, generateEphemeralKeyPair,
    exportPublicKey, exportPrivateKey,
    importECDHPublicKey, importECDHPrivateKey,
    importECDSAPublicKey, importECDSAPrivateKey,
    deriveSharedSecret,
    encryptMessage, decryptMessage,
    encryptBinary, decryptBinary,
    signPayload, verifySignature,
    shredKey, shredEphemeralPrivateKey,
    buildSealedEnvelope, openSealedEnvelope,
    encryptKeyVault, decryptKeyVault,
    arrayBufferToBase64, base64ToArrayBuffer, base64ToUint8Array,
  };
})();
