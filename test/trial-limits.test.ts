// Trial runs on a subscription: when a run may start, and what a transcript says about its limits.

import { expect, test } from 'bun:test';
import { inTrialHours, limits, stoppedByLimit } from '../trials/agent';

const at = (h: number, m: number, window: string) => inTrialHours(new Date(2026, 10, 3, h, m), window);

test('runs start inside the window, up to its end', () => {
  expect(at(1, 59, '02:00-04:45')).toBe(false);
  expect(at(2, 0, '02:00-04:45')).toBe(true);
  expect(at(4, 44, '02:00-04:45')).toBe(true);
  expect(at(4, 45, '02:00-04:45')).toBe(false);
  expect(at(14, 30, '02:00-04:45')).toBe(false);
});

test('a window may wrap past midnight', () => {
  expect(at(23, 30, '23:00-01:00')).toBe(true);
  expect(at(0, 30, '23:00-01:00')).toBe(true);
  expect(at(1, 0, '23:00-01:00')).toBe(false);
});

test('no window is any time, and a malformed one is refused', () => {
  expect(inTrialHours(new Date(2026, 10, 3, 14, 30), '')).toBe(true);
  expect(() => at(2, 0, '2-5')).toThrow('HH:MM-HH:MM');
});

const event = (status: string, fiveHour: number, sevenDay: number) =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      resetsAt: 1793462400,
      rateLimitType: 'seven_day',
      // A real run has this field set to rejected while it carries on: it is about overage only.
      overageStatus: 'rejected',
      unifiedWindows: { five_hour: { utilization: fiveHour }, seven_day: { utilization: sevenDay } },
    },
  });
const result = (fields: object) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...fields });

test('limits takes the last reading', () => {
  expect(limits([event('allowed', 0.07, 0.8), 'not json', event('allowed', 0.08, 0.81)])).toEqual({ fiveHour: 0.08, sevenDay: 0.81 });
});

test('limits is null when a run reports none', () => {
  expect(limits([result({})])).toBeNull();
});

test('a warning, or overage being off, does not stop a run', () => {
  expect(stoppedByLimit([event('allowed_warning', 0.1, 0.8), result({})])).toBeNull();
});

test('a rejected status stops a run and says when it resets', () => {
  expect(stoppedByLimit([event('rejected', 1, 0.8)])).toBe('seven_day limit reached, resets 2026-10-31T16:00:00.000Z');
});

test('a failed result about a limit stops a run', () => {
  expect(stoppedByLimit([result({ is_error: true, result: "You've hit your session limit" })])).toContain('limit');
});

test('an assistant rate limit error stops a run', () => {
  expect(stoppedByLimit([JSON.stringify({ type: 'assistant', error: 'rate_limit' })])).toBe('rate limit reached');
});

test('a run that merely mentions limits is not stopped', () => {
  expect(stoppedByLimit([result({ result: 'Added a rate limit per user.' })])).toBeNull();
  expect(stoppedByLimit([result({ is_error: true, result: 'Reached maximum budget' })])).toBeNull();
});
