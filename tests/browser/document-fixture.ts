const pdfString = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');

export function twoPageManualPdf(identity: string, revision = '4'): Buffer {
  const page = (heading: string, text: string[]) => {
    const lines = ['Fictional Aircraft Company', `OEM Revision ${revision}`, heading, ...text];
    return `BT\n/F1 16 Tf\n72 720 Td\n${lines.map((line, index) => `${index ? '0 -32 Td\n' : ''}(${pdfString(line)}) Tj`).join('\n')}\nET\n`;
  };
  const first = page('Before flight', [
    `Preflight inspection marker ${identity}`,
    'Inspect each arm before flight.',
    'Confirm the battery is secured.',
  ]);
  const second = page('After landing', [
    `Rotor brake inspection marker ${identity}`,
    'Secure the aircraft after landing.',
    'Record the inspection with the line crew.',
  ]);
  const stream = (content: string) => `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    stream(first),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream(second),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 2 >>',
    '<< /Title (Before flight) /Parent 8 0 R /Next 10 0 R /Dest [3 0 R /Fit] >>',
    '<< /Title (After landing) /Parent 8 0 R /Prev 9 0 R /Dest [5 0 R /Fit] >>',
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`)
    .join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}
