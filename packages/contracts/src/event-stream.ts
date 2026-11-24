export interface EventStreamFrame {
  event: string;
  id?: string;
  data: string;
}
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<EventStreamFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    data = '',
    event = '',
    id: string | undefined;
  const max = 64 * 1024;
  const line = (value: string): EventStreamFrame | undefined => {
    if (value === '') {
      const frame =
        data === ''
          ? undefined
          : { event: event || 'message', ...(id !== undefined ? { id } : {}), data: data.slice(0, -1) };
      data = '';
      event = '';
      return frame;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let valuePart = colon < 0 ? '' : value.slice(colon + 1);
    if (valuePart.startsWith(' ')) valuePart = valuePart.slice(1);
    if (field === 'data') data += `${valuePart}\n`;
    else if (field === 'event') event = valuePart;
    else if (field === 'id' && !valuePart.includes('\0')) id = valuePart;
    if (data.length > max || event.length > 200 || (id?.length ?? 0) > 2048)
      throw new Error('Live frame exceeds its bounded size');
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        if (text.endsWith('\r')) {
          const frame = line(text.slice(0, -1));
          if (frame) yield frame;
        }
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
      let consumed = 0;
      for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (character !== '\n' && character !== '\r') continue;
        // A CR at a chunk boundary may be the beginning of a CRLF delimiter.
        if (character === '\r' && i === text.length - 1) break;
        const frame = line(text.slice(consumed, i));
        if (character === '\r' && text[i + 1] === '\n') i++;
        consumed = i + 1;
        if (frame) yield frame;
      }
      text = text.slice(consumed);
      if (text.length > max) throw new Error('Live line exceeds its bounded size');
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Fetch may already have been aborted. */
    }
    reader.releaseLock();
  }
}
