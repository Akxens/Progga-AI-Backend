/**
 * Minimal, standard PDF-1.4 generator for single-page Training Certificates.
 * Pure TypeScript with zero native dependencies.
 */
export function buildCertificatePdf(data: {
  certificateCode: string;
  teacherName: string;
  programmeTitle: string;
  issueDate: string;
}): Buffer {
  const safeTeacher = data.teacherName.replace(/[()\\]/g, "");
  const safeProgramme = data.programmeTitle.replace(/[()\\]/g, "");
  const safeCode = data.certificateCode.replace(/[()\\]/g, "");
  const safeDate = data.issueDate.replace(/[()\\]/g, "");

  const streamContent = `
q
0.12 0.23 0.54 rg
30 30 535 782 re
S
0.95 0.97 1.0 rg
35 35 525 772 re
f
0 0 0 rg
BT
/F1 26 Tf
60 720 Td
(PROGGA EDUCATION INITIATIVE) Tj
/F2 14 Tf
0 -25 Td
(Teacher Training & Professional Development Certification) Tj
0 -50 Td
(This is to certify that) Tj
/F1 22 Tf
0 -35 Td
(${safeTeacher}) Tj
/F2 13 Tf
0 -35 Td
(has successfully fulfilled all requirements and completed the programme:) Tj
/F1 16 Tf
0 -30 Td
(${safeProgramme}) Tj
/F2 12 Tf
0 -60 Td
(Certificate Number: ${safeCode}) Tj
0 -22 Td
(Issue Date: ${safeDate}) Tj
0 -22 Td
(Authority: Progga AI Academy Academic Council) Tj
ET
Q
`.trim();

  const streamLength = Buffer.byteLength(streamContent, "utf-8");

  const objects = [
    // 1: Catalog
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`,
    // 2: Pages
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj`,
    // 3: Page
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\nendobj`,
    // 4: Font Bold
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj`,
    // 5: Font Regular
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`,
    // 6: Stream
    `6 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj`,
  ];

  let header = "%PDF-1.4\n";
  let body = "";
  const xrefOffsets: number[] = [0];

  let currentOffset = Buffer.byteLength(header, "utf-8");
  for (const obj of objects) {
    xrefOffsets.push(currentOffset);
    const objStr = obj + "\n";
    body += objStr;
    currentOffset += Buffer.byteLength(objStr, "utf-8");
  }

  const startXref = currentOffset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += String(xrefOffsets[i]).padStart(10, "0") + " 00000 n \n";
  }

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return Buffer.from(header + body + xref + trailer, "utf-8");
}
