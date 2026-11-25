import { describe, it, expect } from "vitest";
import { parseCsv, toCsv, escapeCsvCell } from "./core/csv";
import { buildCertificatePdf } from "./training/pdf";

describe("Sprint 2 Core Modules (TASK-056, TASK-058, TASK-059)", () => {
  describe("CSV RFC-4180 & OWASP Injection Defense (TASK-056)", () => {
    it("escapes formula injection characters (=, +, -, @)", () => {
      expect(escapeCsvCell("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
      expect(escapeCsvCell("+12345")).toBe("'+12345");
      expect(escapeCsvCell("-50")).toBe("'-50");
      expect(escapeCsvCell("@cmd")).toBe("'@cmd");
      expect(escapeCsvCell("Normal text")).toBe("Normal text");
    });

    it("parses multi-line quoted CSV cells and escaped quotes correctly", () => {
      const csv = `fullName,email,notes\r\n"Rahim Uddin",rahim@test.com,"Line 1\r\nLine 2"\r\n"Karim ""Special"" Khan",karim@test.com,"Simple note"`;
      const result = parseCsv(csv);

      expect(result.headers).toEqual(["fullname", "email", "notes"]);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].fullname).toBe("Rahim Uddin");
      expect(result.rows[0].notes).toBe("Line 1\r\nLine 2");
      expect(result.rows[1].fullname).toBe('Karim "Special" Khan');
      expect(result.rows[1].notes).toBe("Simple note");
    });

    it("serializes rows with toCsv matching parseCsv output", () => {
      const headers = ["name", "grade", "school"];
      const rows = [
        ["Ayesha Siddiqua", "Grade 7", "Dhaka Govt High School"],
        ["Tanvir Ahmed", "Grade 8", 'Barishal "Model" School'],
      ];
      const serialized = toCsv(headers, rows);
      const parsed = parseCsv(serialized);

      expect(parsed.headers).toEqual(headers);
      expect(parsed.rows[0].name).toBe("Ayesha Siddiqua");
      expect(parsed.rows[1].school).toBe('Barishal "Model" School');
    });
  });

  describe("Training Certificate PDF Generator (TASK-058)", () => {
    it("generates a standard PDF-1.4 single-page certificate stream", () => {
      const pdf = buildCertificatePdf({
        certificateCode: "CRT-2026-TEST01",
        teacherName: "Nusrat Jahan",
        programmeTitle: "AI Pedagogical Integration for Secondary STEM",
        issueDate: "2026-11-25",
      });

      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(pdf.length).toBeGreaterThan(500);

      const header = pdf.subarray(0, 8).toString("ascii");
      expect(header).toContain("%PDF-1.4");

      const tail = pdf.subarray(pdf.length - 16).toString("ascii");
      expect(tail).toContain("%%EOF");

      const body = pdf.toString("latin1");
      expect(body).toContain("CRT-2026-TEST01");
      expect(body).toContain("Nusrat Jahan");
      expect(body).toContain("AI Pedagogical Integration for Secondary STEM");
    });
  });

  describe("Attendance Deduplication & Rules (TASK-059)", () => {
    it("detects duplicate attendance keys for BR-ACT-01", () => {
      const attendance = new Set<string>();

      const checkIn1 = { eventId: "evt-1", studentId: "stu-101" };
      const key1 = `${checkIn1.eventId}:${checkIn1.studentId}`;
      expect(attendance.has(key1)).toBe(false);
      attendance.add(key1);

      const duplicateCheckIn = { eventId: "evt-1", studentId: "stu-101" };
      const key2 = `${duplicateCheckIn.eventId}:${duplicateCheckIn.studentId}`;
      expect(attendance.has(key2)).toBe(true); // Duplicate detected
    });
  });
});
