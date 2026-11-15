import { loadEnvironment, loadConfig, configPath } from './common.mjs';
await loadEnvironment();
try {
  const { main, normalizeConfig } = await import('../src/bridge.mjs');
  const config = normalizeConfig(await loadConfig());
  process.env.PI_KIT_STATE_DIR = config.stateDir;
  await main({ argv: ['--config', configPath] });
} catch (error) {
  console.error(`Запуск не удался: ${error.message}`);
  process.exitCode = 1;
}
