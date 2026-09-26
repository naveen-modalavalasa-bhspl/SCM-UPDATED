/**
 * Utility for exporting data to CSV with UTF-8 BOM for Excel compatibility.
 */

export interface CSVExportOptions {
  filename: string;
  headers: string[];
  rows: (string | number | boolean | null | undefined)[][];
}

export function exportToCSV({ filename, headers, rows }: CSVExportOptions): void {
  const sanitizeCell = (val: string | number | boolean | null | undefined): string => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headerLine = headers.map(sanitizeCell).join(",");
  const rowLines = rows.map((row) => row.map(sanitizeCell).join(","));
  
  // UTF-8 BOM (\uFEFF) ensures Excel opens non-ASCII characters and UTF-8 cleanly
  const csvContent = "\uFEFF" + [headerLine, ...rowLines].join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename.endsWith(".csv") ? filename : `${filename}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
