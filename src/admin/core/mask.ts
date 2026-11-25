/**
 * PII masking helpers per 03 A-17:
 * - phone: +8801*******89
 * - email: r***@d***.ai
 * - name:  Rafi A.
 */

export function maskPhone(phone?: string | null): string {
  if (!phone) return "";
  const clean = phone.trim();
  if (clean.length < 6) return "****";
  const start = clean.slice(0, 5);
  const end = clean.slice(-2);
  return `${start}${"*".repeat(Math.max(2, clean.length - 7))}${end}`;
}

export function maskEmail(email?: string | null): string {
  if (!email) return "";
  const parts = email.trim().split("@");
  if (parts.length !== 2) return "***@***";
  const [user, domain] = parts;
  const maskedUser = user.length <= 1 ? `${user}***` : `${user[0]}***`;
  const domainParts = domain.split(".");
  const maskedDomain = domainParts
    .map((dp, i) => (i === domainParts.length - 1 ? dp : `${dp[0]}***`))
    .join(".");
  return `${maskedUser}@${maskedDomain}`;
}

export function maskName(fullName?: string | null): string {
  if (!fullName) return "";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0].toUpperCase();
  return `${first} ${lastInitial}.`;
}
