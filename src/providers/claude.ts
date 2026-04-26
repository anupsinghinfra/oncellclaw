import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    const host = new URL(dotenv.ANTHROPIC_BASE_URL).hostname;
    env.NO_PROXY = host;
    env.no_proxy = host;
  }
  if (dotenv.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_AUTH_TOKEN = dotenv.ANTHROPIC_AUTH_TOKEN;
  if (dotenv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = dotenv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  return { env };
});
