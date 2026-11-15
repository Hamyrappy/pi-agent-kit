import { loadEnvironment, loadConfig } from './common.mjs';
import { configureOpenRouterModel } from './model-config.mjs';
await loadEnvironment();
const changed = await configureOpenRouterModel(await loadConfig(), process.env.PI_CODING_AGENT_DIR);
console.log(changed ? 'OpenRouter: лимит ответа 8192 tokens сохранён в models.json.' : 'Изменений нет: лимит уже задан или выбран другой провайдер.');
