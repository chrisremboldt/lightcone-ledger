/** One XML element: its name, its child elements in order, and its own text with entities decoded. */
export interface XmlElement {
  readonly name: string;
  readonly children: XmlElement[];
  text: string;
  /** Where the element starts and ends in the source string, from its opening < to after its closing >. */
  readonly start: number;
  end: number;
}

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;
const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const MAX_DEPTH = 64;
const MAX_ELEMENTS = 100_000;

export class XmlRefusal extends Error {}

function decodeText(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]{1,6}|#\d{1,7}|[A-Za-z]+);|&/g, (whole, entity: string | undefined) => {
    if (entity === undefined) throw new XmlRefusal('A bare & in text is not well-formed XML');
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (code > 0x10ffff) throw new XmlRefusal(`The character reference ${whole} is not a character`);
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(ENTITIES, entity)) throw new XmlRefusal(`The entity ${whole} is not one XML defines`);
    return ENTITIES[entity]!;
  });
}

/**
 * Reads well-formed XML into elements, deterministically and without fetching anything: attributes are checked and
 * dropped, comments and processing instructions skipped, and a document type declaration refused, so no entity is
 * ever expanded. Throws XmlRefusal on anything else.
 */
export function readXmlElements(source: string): XmlElement {
  const text = source;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let count = 0;
  let at = source.startsWith('\ufeff') ? 1 : 0;
  const appendText = (raw: string) => {
    const top = stack.at(-1);
    if (top) top.text += raw;
    else if (raw.trim()) throw new XmlRefusal('Text stands outside the root element');
  };
  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open === -1) {
      appendText(decodeText(text.slice(at)));
      break;
    }
    if (open > at) appendText(decodeText(text.slice(at, open)));
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end === -1) throw new XmlRefusal('A comment is not closed');
      at = end + 3;
    } else if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end === -1 || !stack.length) throw new XmlRefusal('A CDATA section is not closed or stands outside the root');
      appendText(text.slice(open + 9, end));
      at = end + 3;
    } else if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end === -1) throw new XmlRefusal('A processing instruction is not closed');
      at = end + 2;
    } else if (text.startsWith('<!', open)) {
      throw new XmlRefusal('A document type declaration is not read');
    } else if (text[open + 1] === '/') {
      const end = text.indexOf('>', open);
      const name = text.slice(open + 2, end === -1 ? undefined : end).trim();
      const top = stack.pop();
      if (end === -1 || !top || top.name !== name) throw new XmlRefusal(`The closing tag ${name} does not match`);
      at = end + 1;
      top.end = at;
    } else {
      const name = NAME.exec(text.slice(open + 1))?.[0];
      if (!name) throw new XmlRefusal('A tag has no name');
      let cursor = open + 1 + name.length;
      // Attributes: name="value" or name='value', checked for shape and not kept.
      for (;;) {
        const rest = /^\s*/.exec(text.slice(cursor))![0].length;
        cursor += rest;
        if (text[cursor] === '>' || text.startsWith('/>', cursor)) break;
        const attribute = /^[A-Za-z_][\w.:-]*\s*=\s*("[^"<]*"|'[^'<]*')/.exec(text.slice(cursor));
        if (!attribute || !rest) throw new XmlRefusal(`The tag ${name} has an attribute that is not well-formed`);
        decodeText(attribute[1]!.slice(1, -1));
        cursor += attribute[0].length;
      }
      const element: XmlElement = { name, children: [], text: '', start: open, end: open };
      if (++count > MAX_ELEMENTS) throw new XmlRefusal(`The document has more than ${MAX_ELEMENTS} elements`);
      const parent = stack.at(-1);
      if (parent) parent.children.push(element);
      else if (root) throw new XmlRefusal('The document has more than one root element');
      else root = element;
      const selfClosing = text.startsWith('/>', cursor);
      if (!selfClosing) {
        stack.push(element);
        if (stack.length > MAX_DEPTH) throw new XmlRefusal(`The document nests deeper than ${MAX_DEPTH} elements`);
      }
      at = cursor + (selfClosing ? 2 : 1);
      if (selfClosing) element.end = at;
    }
  }
  if (stack.length) throw new XmlRefusal(`The element ${stack.at(-1)!.name} is not closed`);
  if (!root) throw new XmlRefusal('The document has no root element');
  return root;
}

/** An element's place in the UTF-8 bytes of the source it was read from. */
export function byteRangeOf(source: string, element: XmlElement): { offsetBytes: number; lengthBytes: number } {
  const encoder = new TextEncoder();
  const offsetBytes = encoder.encode(source.slice(0, element.start)).byteLength;
  return { offsetBytes, lengthBytes: encoder.encode(source.slice(element.start, element.end)).byteLength };
}

/** The child elements of `element` with the given name. */
export const childrenNamed = (element: XmlElement, name: string): XmlElement[] =>
  element.children.filter((child) => child.name === name);

/** The text of the only child with the given name, trimmed, or undefined when there is none. */
export function childText(element: XmlElement, name: string): string | undefined {
  const found = childrenNamed(element, name);
  if (found.length > 1) throw new XmlRefusal(`${element.name} has ${found.length} ${name} elements, not one`);
  return found[0]?.text.trim() || undefined;
}
