-- Finding packets are issued in version 2, which carries original source bytes. Version 1 records issued earlier stay
-- valid; the version and the number of sources left out live in the record's format and metadata, not new columns.
ALTER TABLE finding_packet_records DROP CONSTRAINT finding_packet_records_format_check;
ALTER TABLE finding_packet_records ADD CONSTRAINT finding_packet_records_format_check
 CHECK(format IN ('ledger.finding-packet.1','ledger.finding-packet.2'));
