import type { LogEntry, SimState } from './types';

/** Append a line to the operator log, newest first. */
export function pushLog(state: SimState, text: string, kind: LogEntry['kind']): void {
  state.log.unshift({ t: state.minutes, text, kind });
  if (state.log.length > 30) state.log.length = 30;
}
