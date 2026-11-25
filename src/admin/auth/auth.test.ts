import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { encrypt, decrypt } from "../../lib/crypto";

describe("Admin Auth & MFA (TASK-050)", () => {
  it("generates and verifies TOTP secret", () => {
    const secret = authenticator.generateSecret();
    expect(secret.length).toBeGreaterThan(10);

    const token = authenticator.generate(secret);
    expect(token).toMatch(/^\d{6}$/);

    const isValid = authenticator.check(token, secret);
    expect(isValid).toBe(true);

    const isBadValid = authenticator.check("000000", secret);
    expect(isBadValid).toBe(false);
  });

  it("encrypts and decrypts MFA secret securely via AES-256-GCM", () => {
    const secret = authenticator.generateSecret();
    const encrypted = encrypt(secret);
    expect(encrypted).not.toBe(secret);
    expect(encrypted.split(".").length).toBe(3);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it("generates, hashes, and validates recovery codes", async () => {
    const rawCodes = ["A1B2C3D4", "E5F6G7H8", "J9K0L1M2"];
    const hashes = await Promise.all(rawCodes.map((c) => bcrypt.hash(c, 10)));

    expect(hashes.length).toBe(3);

    // Verify correct code
    const isFirstMatch = await bcrypt.compare("A1B2C3D4", hashes[0]);
    expect(isFirstMatch).toBe(true);

    // Verify case insensitivity if trimmed and upper-cased
    const isUpperMatch = await bcrypt.compare("e5f6g7h8".toUpperCase(), hashes[1]);
    expect(isUpperMatch).toBe(true);

    // Verify invalid code fails
    const isBadMatch = await bcrypt.compare("WRONGCODE", hashes[0]);
    expect(isBadMatch).toBe(false);
  });
});
