import { renderMemorySection } from './memory-context.js';

export const MEMORY_SESSION_START_MATCHER = 'startup|clear|compact';

export type MemorySessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';

/** Return memory only when a provider is establishing a new context window. */
export function memoryContextForSessionStart(source: MemorySessionStartSource, baseDir?: string): string | undefined {
  if (source === 'startup' || source === 'clear' || source === 'compact') {
    return renderMemorySection(baseDir);
  }
  return undefined;
}
