import { DjiMqttAdapter, LedgerClient, type DjiAdapterConfig } from '@ledger/adapters';

let adapter: DjiMqttAdapter | undefined;
process.on(
  'message',
  async (message: {
    id: number;
    action: string;
    config?: Omit<DjiAdapterConfig, 'ledger'> & { apiUrl: string; ledgerToken: string };
  }) => {
    try {
      let result: unknown;
      if (message.action === 'configure' && message.config) {
        const { apiUrl, ledgerToken, ...config } = message.config;
        adapter = new DjiMqttAdapter({ ...config, ledger: new LedgerClient(apiUrl, ledgerToken), onError: () => {} });
        await adapter.start();
        result = adapter.stats;
      } else if (message.action === 'stats') result = adapter!.stats;
      else if (message.action === 'seal') result = await adapter!.seal();
      else throw new Error('Unsupported capture child action');
      process.send?.({ id: message.id, result });
    } catch {
      process.send?.({ id: message.id, error: 'Local capture child operation failed' });
    }
  },
);
