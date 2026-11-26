# Recorded temporary flight restrictions

Fetched from the FAA TFR service (tfr.faa.gov) on 2026-11-26 between 04:34 and 04:35 UTC: `list.json` from `GET /tfrapi/exportTfrList` and each `detail_<year>_<number>.xml` from `GET /download/detail_<year>_<number>.xml`. Published government airspace notices, kept as reference data.

These files are not byte for byte what the service sent. Before they were committed:

- contact names, contact organizations, telephone numbers and contact radio frequencies were replaced with `Contact removed` (or `CONTACT REMOVED`), `000-000-0000` and `000.000`, in their own elements and wherever the notice text repeats them;
- the names of agencies other than the FAA and its own facilities, and of a company's venue, were replaced with a neutral description (`FEDERAL AGENCY`, `a theme park`), and an agency's web address with `HTTPS://EXAMPLE.ORG`;
- three of the nine documents fetched were left out, with their list entries; the list itself held 50 entries, of which only those of the documents kept are here.

Everything the adapter reads (the notice identifier, the issue, effective and expiry times, schedules, altitudes and area corners) is as published on the date fetched. The adapter's comparison of those times with the notice text, and its tests over all nine documents, were run on the unedited documents before the edit, and agreed.
