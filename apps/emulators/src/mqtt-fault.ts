import { createServer, createConnection, type Socket } from 'node:net';

const mqttPublish = 3;
const mqttPuback = 4;

export async function qos1ReconnectFault(targetPort = 1883) {
  let droppedAck = false;
  const sockets = new Set<Socket>();
  const publishes: Array<{ duplicateHeader: boolean; messageId: number }> = [];
  const server = createServer((downstream) => {
    const upstream = createConnection({ host: '127.0.0.1', port: targetPort });
    sockets.add(downstream);
    sockets.add(upstream);
    const stop = () => {
      downstream.destroy();
      upstream.destroy();
      sockets.delete(downstream);
      sockets.delete(upstream);
    };
    downstream.on('error', stop);
    upstream.on('error', stop);
    downstream.on('close', stop);
    upstream.on('close', stop);
    function pump(source: Socket, destination: Socket, fromBroker: boolean) {
      let buffered = Buffer.alloc(0);
      source.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 2) {
          let length = 0,
            multiplier = 1,
            header = 1,
            complete = false;
          for (let index = 1; index < Math.min(5, buffered.length); index++) {
            const byte = buffered[index]!;
            length += (byte & 127) * multiplier;
            header++;
            if (!(byte & 128)) {
              complete = true;
              break;
            }
            multiplier *= 128;
          }
          if (!complete) {
            if (buffered.length >= 5) stop();
            return;
          }
          if (length > 40000) {
            stop();
            return;
          }
          if (buffered.length < header + length) return;
          const packet = buffered.subarray(0, header + length);
          buffered = buffered.subarray(header + length);
          const type = packet[0]! >> 4;
          if (!fromBroker && type === mqttPublish && (packet[0]! & 6) === 2) {
            const topicBytes = packet.readUInt16BE(header);
            publishes.push({
              duplicateHeader: Boolean(packet[0]! & 8),
              messageId: packet.readUInt16BE(header + 2 + topicBytes),
            });
          }
          if (fromBroker && type === mqttPuback && !droppedAck) {
            droppedAck = true;
            setImmediate(stop);
            continue;
          }
          destination.write(packet);
        }
      });
    }
    pump(downstream, upstream, false);
    pump(upstream, downstream, true);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MQTT fault proxy did not bind');
  return {
    url: `mqtt://127.0.0.1:${address.port}`,
    publishes,
    get droppedAck() {
      return droppedAck;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
