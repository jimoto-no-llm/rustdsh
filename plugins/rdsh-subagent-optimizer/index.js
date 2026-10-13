import { captureDelegatedPolicyOverrides, parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { createOptimizer } from './optimizer.js';

export const name = 'rdsh-subagent-optimizer';
export const inject = ['subagents'];

export function apply(ctx, config = {}) {
  return ctx.effect(() => {
    const optimizer = createOptimizer({
      getBackend: () => ctx.subagents.getProvider('spawn'),
      config,
      snapshotContext(parent) {
        const options = parentAgentOptionsForDelegation(parent);
        return {
          agentOptions: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens },
          cwd: parent.session.header?.cwd,
          policy: captureDelegatedPolicyOverrides(parent),
        };
      },
    });
    const unregister = ctx.subagents.registerProvider(optimizer.provider);
    return async () => { unregister(); await optimizer.close(); };
  });
}
