import { loadEnvironment, loadConfig } from './common.mjs';
import { configureOpenRouterModel } from './model-config.mjs';
await loadEnvironment();
const changed = await configureOpenRouterModel(await loadConfig(), process.env.PI_CODING_AGENT_DIR);
console.log(changed ? 'OpenRouter: an 8192-token output limit was saved to models.json.' : 'No changes: a limit is already set, or another provider is selected.');
