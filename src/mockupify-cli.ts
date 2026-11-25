import { mockupifyReadOnly } from './mockupify-readonly.js';
import { WorkerError } from './model.js';

export const mockupifyCommands = {
  'mockupify-auth': {},
  'mockupify-batches': {},
  'mockupify-designs': {},
  'mockupify-products': {},
  'mockupify-exports': {},
  'mockupify-export': {},
} as const;

export async function runMockupifyCommand(command: keyof typeof mockupifyCommands, args: string[]) {
  const id = args[0];
  const takesId = command === 'mockupify-designs' || command === 'mockupify-export';
  if (args.length > (takesId ? 1 : 0) || (command === 'mockupify-export' && id === undefined)) {
    throw new WorkerError('CLI_USAGE', 'Wrong number of arguments. Run worker help for usage.');
  }
  if (id !== undefined && !/^[1-9][0-9]*$/.test(id)) {
    throw new WorkerError('MOCKUPIFY_INVALID_ID', 'Supply a positive integer Mockupify ID.');
  }

  const client = mockupifyReadOnly();
  switch (command) {
    case 'mockupify-auth':
      await client.listBatches();
      return { authenticated: true };
    case 'mockupify-batches': return client.listBatches();
    case 'mockupify-designs': return client.listDesigns(id === undefined ? undefined : Number(id));
    case 'mockupify-products': return client.listProducts();
    case 'mockupify-exports': return client.listExports();
    case 'mockupify-export': return client.getExport(Number(id));
  }
}
