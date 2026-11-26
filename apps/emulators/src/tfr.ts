import { existsSync, readFileSync } from 'node:fs';

/**
 * Temporary flight restrictions recorded from the FAA TFR service (tfr.faa.gov) on 2026-11-26 between 04:34 and 04:35
 * UTC: six of the nine detail documents fetched (GET /download/detail_{year}_{number}.xml), and the entries of the list
 * (GET /tfrapi/exportTfrList) that name them. They are not byte for byte as sent: contact names, organizations,
 * telephone numbers and radio frequencies, and the names of agencies and of a company's venue, were replaced before
 * they were committed (see the folder's README). The list held 50 entries; only those whose document was recorded
 * are served. Published government airspace notices, kept as reference data.
 */
export const RECORDED_TFR_DIRECTORY = new URL('../recordings/published-tfr-2026-11-26/', import.meta.url);

export interface TfrAnswer {
  readonly status: 200 | 404;
  readonly contentType?: string;
  readonly body: Buffer | string;
}

/**
 * Answers GET /tfrapi/exportTfrList with the recorded list, and GET /download/detail_{year}_{number}.xml with the
 * recorded document; 404 for a document that was not recorded. Undefined for any other path.
 */
export function answerTfrRequest(path: string): TfrAnswer | undefined {
  if (path === '/tfrapi/exportTfrList')
    return {
      status: 200,
      contentType: 'application/json',
      body: readFileSync(new URL('list.json', RECORDED_TFR_DIRECTORY)),
    };
  const detail = /^\/download\/(detail_\d_\d{1,5}\.xml)$/.exec(path);
  if (!detail) return undefined;
  const file = new URL(detail[1]!, RECORDED_TFR_DIRECTORY);
  return existsSync(file)
    ? { status: 200, contentType: 'application/xml', body: readFileSync(file) }
    : { status: 404, body: 'Not found' };
}
