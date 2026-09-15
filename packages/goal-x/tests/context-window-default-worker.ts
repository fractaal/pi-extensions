import contextWindowExtension from '../../context-window/extensions/context-window.ts';
import { fixtureModel, installModelHarness } from './context-window-harness.ts';

const [root, provider, modelId, rawValue] = process.argv.slice(2);
if (!root || !provider || !modelId || !rawValue) {
  throw new Error('Expected root, provider, model id, and context-window value.');
}

const { harness } = installModelHarness(root, [fixtureModel(provider, modelId)]);
contextWindowExtension(harness.pi);
await harness.run('session_start', { reason: 'startup' });
await harness.commands.get('context-window-default')!.handler(rawValue, harness.ctx as never);
