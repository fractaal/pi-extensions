import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { createHarness } from './harness.ts';

export type FixtureModel = Model<Api>;

export function fixtureModel(provider = 'fixture', id = 'fixture-model', contextWindow = 200_000): FixtureModel {
  return {
    provider,
    id,
    name: `${provider}/${id}`,
    api: 'fixture-api',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8_192,
  } as FixtureModel;
}

export function installModelHarness(
  root: string,
  models: FixtureModel[] = [fixtureModel()],
  initialEntries: Array<Record<string, unknown>> = [],
) {
  const harness = createHarness(initialEntries, root);
  let current = models[0]!;
  const providers = new Map<string, FixtureModel[]>();
  for (const model of models) {
    providers.set(model.provider, [...(providers.get(model.provider) ?? []), model]);
  }
  Object.assign(harness.ctx, {
    model: current,
    sessionManager: {
      ...harness.ctx.sessionManager,
      getSessionFile: () => join(root, 'sessions', 'fixture.jsonl'),
    },
    modelRegistry: {
      getProvider: (provider: string) => {
        const registered = providers.get(provider);
        return registered ? { getModels: () => registered } : undefined;
      },
      find: (provider: string, modelId: string) => providers.get(provider)?.find((model) => model.id === modelId),
      getAvailable: () => [...providers.values()].flat(),
    },
  });
  Object.assign(harness.pi, {
    registerProvider: (provider: string, config: { models?: FixtureModel[] }) => {
      if (!config.models?.length) throw new Error('fixture provider registration was empty');
      const registered = config.models.map((model) => ({ ...model, provider } as FixtureModel));
      providers.set(provider, registered);
      const replacement = current.provider === provider
        ? registered.find((model) => model.id === current.id)
        : undefined;
      if (replacement) {
        current = replacement;
        Object.assign(harness.ctx, { model: replacement });
      }
    },
    setModel: async (next: FixtureModel) => {
      current = next;
      Object.assign(harness.ctx, { model: next });
      return true;
    },
  });
  mkdirSync(join(root, 'sessions'), { recursive: true });
  if (!existsSync(join(root, 'models.json'))) writeFileSync(join(root, 'models.json'), '{}\n');
  return {
    harness,
    getModel: () => current,
    selectModel(provider: string, modelId: string): FixtureModel {
      const selected = providers.get(provider)?.find((model) => model.id === modelId);
      if (!selected) throw new Error(`Unknown fixture model ${provider}/${modelId}`);
      current = selected;
      Object.assign(harness.ctx, { model: selected });
      return selected;
    },
  };
}
