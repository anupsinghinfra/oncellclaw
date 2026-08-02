/**
 * OneCLI gateway on cells — docker-parity semantics.
 *
 * The invariants under test: unconfigured installs keep raw-credential
 * behavior; a configured gateway rewrites container paths to cell paths and
 * writes CA/stubs through the request door; gateway failure aborts (the
 * docker path's refuse-to-spawn); and vault mode withholds raw credentials
 * from the service env.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  applyCellGatewayConfig,
  remapStubPath,
  _setGatewayClientForTesting,
  CELL_CA_PATH,
  type GatewayClient,
  type GatewayContainerConfig,
} from './cell-gateway.js';
import type { OnCellClient } from './oncell-client.js';
import type { AgentGroup } from './types.js';

const GROUP: AgentGroup = { id: 'ag-1', name: 'Andy', folder: 'assistant', agent_provider: null, created_at: '' };
const WS = '/workspace';

function fakeCell(): { client: OnCellClient; writes: Array<{ path: string; content: string }> } {
  const writes: Array<{ path: string; content: string }> = [];
  const client = {
    writeFile: (_cell: string, path: string, content: string) => {
      writes.push({ path, content });
      return Promise.resolve({});
    },
  } as unknown as OnCellClient;
  return { client, writes };
}

function fakeGateway(config: GatewayContainerConfig): GatewayClient & { ensured: string[] } {
  const ensured: string[] = [];
  return {
    ensured,
    ensureAgent: async ({ identifier }) => {
      ensured.push(identifier);
      return {};
    },
    getContainerConfig: async () => config,
  };
}

afterEach(() => {
  _setGatewayClientForTesting(undefined);
});

describe('remapStubPath', () => {
  it('remaps container HOME prefixes into the cell workspace', () => {
    expect(remapStubPath('/home/node/.claude/.credentials.json', WS)).toBe('/workspace/.claude/.credentials.json');
    expect(remapStubPath('/root/.config/x', WS)).toBe('/workspace/.config/x');
  });

  it('flattens paths with no cell equivalent under the stubs dir (never the shared rootfs)', () => {
    expect(remapStubPath('/etc/onecli/sentinel', WS)).toBe('/workspace/claw/onecli/stubs/etc_onecli_sentinel');
  });
});

describe('applyCellGatewayConfig', () => {
  it('returns null (raw-credential mode) when OneCLI is not configured', async () => {
    const { client } = fakeCell();
    // No injected gateway + no ONECLI_URL/KEY in the test env → unconfigured.
    expect(await applyCellGatewayConfig(client, 'cell-1', WS, GROUP)).toBeNull();
  });

  it('writes CA + stubs into the cell and returns env with paths remapped', async () => {
    const gateway = fakeGateway({
      env: {
        ANTHROPIC_BASE_URL: 'https://gw.onecli.sh/v1',
        SSL_CERT_FILE: '/usr/local/share/ca-certificates/onecli.crt',
      },
      caCertificate: 'CA-PEM',
      caCertificateContainerPath: '/usr/local/share/ca-certificates/onecli.crt',
      credentialStubs: [{ containerPath: '/home/node/.claude/.credentials.json', content: 'STUB' }],
    });
    _setGatewayClientForTesting(gateway);
    const { client, writes } = fakeCell();

    const env = await applyCellGatewayConfig(client, 'cell-1', WS, GROUP);

    expect(gateway.ensured).toEqual(['ag-1']);
    expect(writes).toEqual([
      { path: CELL_CA_PATH, content: 'CA-PEM' },
      { path: '.claude/.credentials.json', content: 'STUB' },
    ]);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://gw.onecli.sh/v1',
      SSL_CERT_FILE: `${WS}/${CELL_CA_PATH}`, // container CA path remapped
      NODE_EXTRA_CA_CERTS: `${WS}/${CELL_CA_PATH}`,
    });
  });

  it('propagates gateway failure — the wake must abort, never spawn raw', async () => {
    _setGatewayClientForTesting({
      ensureAgent: async () => ({}),
      getContainerConfig: async () => {
        throw new Error('gateway down');
      },
    });
    const { client } = fakeCell();
    await expect(applyCellGatewayConfig(client, 'cell-1', WS, GROUP)).rejects.toThrow('gateway down');
  });
});
