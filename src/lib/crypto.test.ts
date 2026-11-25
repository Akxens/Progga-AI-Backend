import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto";

describe("crypto AES-256-GCM", () => {
  it("encrypts and decrypts roundtrip with default key", () => {
    const secret = "Sensitive information for MFA secret 123456";
    const encrypted = encrypt(secret);
    expect(encrypted).not.toBe(secret);
    expect(encrypted.split(".").length).toBe(3);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it("encrypts and decrypts roundtrip with explicit 32-byte key", () => {
    const key = Buffer.from("custom-32-byte-key-for-test-0001").toString("base64");
    const secret = "Another secret";
    const encrypted = encrypt(secret, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(secret);
  });

  it("throws when ciphertext or tag is tampered", () => {
    const encrypted = encrypt("secret text");
    const [iv, tag, ciphertext] = encrypted.split(".");

    // Tamper with ciphertext
    const tamperedCiphertext = Buffer.from(ciphertext, "base64");
    tamperedCiphertext[0] ^= 1;
    const tamperedBlob1 = `${iv}.${tag}.${tamperedCiphertext.toString("base64")}`;
    expect(() => decrypt(tamperedBlob1)).toThrow();

    // Tamper with tag
    const tamperedTag = Buffer.from(tag, "base64");
    tamperedTag[0] ^= 1;
    const tamperedBlob2 = `${iv}.${tamperedTag.toString("base64")}.${ciphertext}`;
    expect(() => decrypt(tamperedBlob2)).toThrow();
  });

  it("throws on invalid format or key length", () => {
    expect(() => decrypt("invalid-blob")).toThrow("Invalid encrypted blob format");
    const shortKey = Buffer.from("too-short").toString("base64");
    expect(() => encrypt("test", shortKey)).toThrow("Invalid encryption key length");
  });
});
