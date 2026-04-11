/**
 * OneCLI secrets facade.
 *
 * @onecli-sh/sdk 0.3.1 does not yet expose secret management. This module wraps
 * the `onecli secrets create` CLI so the rest of the codebase can call
 * `createSecret(...)` with the same shape we expect the SDK to ship with.
 *
 * When the SDK adds secret management, replace the body of `createSecret()`
 * with the SDK call and delete the CLI plumbing below. Nothing else in
 * NanoClaw should need to change — the public types here mirror the
 * anticipated SDK surface.
 */
import { execFile } from 'child_process';

export interface CreateSecretInput {
  name: string;
  type: 'generic' | 'anthropic';
  value: string;
  hostPattern: string;
  pathPattern?: string;
  headerName?: string;
  valueFormat?: string;
  /**
   * Agent scoping. Not supported by current OneCLI CLI — included here so
   * callers can pass it today and it becomes live when the SDK adds scoping.
   */
  agentId?: string;
}

export interface CreateSecretResponse {
  id: string;
  name: string;
  hostPattern: string;
}

export class OneCLISecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OneCLISecretError';
  }
}

export async function createSecret(input: CreateSecretInput): Promise<CreateSecretResponse> {
  const payload: Record<string, unknown> = {
    name: input.name,
    type: input.type,
    value: input.value,
    hostPattern: input.hostPattern,
  };
  if (input.pathPattern) payload.pathPattern = input.pathPattern;
  if (input.headerName || input.valueFormat) {
    payload.injectionConfig = {
      ...(input.headerName && { headerName: input.headerName }),
      ...(input.valueFormat && { valueFormat: input.valueFormat }),
    };
  }

  const stdout = await runOnecli(['secrets', 'create', '--json', JSON.stringify(payload)]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OneCLISecretError(`onecli returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  const result = parsed as { id?: string; name?: string; hostPattern?: string; error?: string };
  if (result.error) throw new OneCLISecretError(result.error);
  return {
    id: result.id ?? '',
    name: result.name ?? input.name,
    hostPattern: result.hostPattern ?? input.hostPattern,
  };
}

function runOnecli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('onecli', args, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new OneCLISecretError(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
