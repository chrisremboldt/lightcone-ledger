import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';
import type { OperatorRecordDefinition } from './observations/operator-records/define.js';
import { loadRecordMapping, type RecordMapping, type RecordMappingLines } from './operator-record-mapping.js';

/**
 * Reads a column mapping file (YAML, in the style of a pack's pack.yaml) against the record type it is for. Kept apart
 * from the package's main entry so that only the command line and the API load the YAML library.
 */
export function readRecordMappingFile(
  definition: OperatorRecordDefinition,
  text: string,
): { mapping: RecordMapping; problems: readonly [] } | { problems: readonly string[] } {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: true });
  const lineAt = (offset: number | undefined) => (offset === undefined ? undefined : lineCounter.linePos(offset).line);
  if (document.errors.length)
    return {
      problems: document.errors.map(
        (error) =>
          `Line ${lineAt(error.pos[0]) ?? '?'}: the mapping is not valid YAML: ${error.message.split('\n')[0]}`,
      ),
    };
  const lineOf: RecordMappingLines = (path) => {
    let node: unknown = document.contents;
    let line: number | undefined;
    for (const segment of path) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(segment));
        if (!pair) break;
        line = lineAt((pair.key as Node).range?.[0]) ?? line;
        node = pair.value;
      } else if (isSeq(node) && typeof segment === 'number') {
        const item = node.items[segment] as Node | undefined;
        if (!item) break;
        line = lineAt(item.range?.[0]) ?? line;
        node = item;
      } else break;
    }
    return line;
  };
  return loadRecordMapping(definition, document.toJS(), lineOf);
}
