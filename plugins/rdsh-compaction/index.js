import z from '@deepseek-ai/schemastery';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import { withInstructions } from './engine.mjs';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';

// The upstream basic backend with one extra option: `instructions`, the text
// sent as the final user message of the summarization request.
const RdshCompactionEngine = withInstructions(BasicCompactionEngine, {
  balanced: toolPairingBalancedBefore,
  prices(provider, model) {
    try { return getBuiltinModels(provider).find(m => m.id === model)?.cost; }
    catch { return undefined; }
  },
});

RdshCompactionEngine.Config = z.intersect([
  BasicCompactionEngine.Config,
  z.object({ instructions: z.string(), rdshRoutes: z.array(z.object({
    provider: z.string(), model: z.string(), method: z.string(),
  })), rdshEarly: z.object({ expected_turns: z.number(), min_tokens: z.number() }).default(null), rdshBinary: z.string() }),
]);

export { RdshCompactionEngine };
export default RdshCompactionEngine;
