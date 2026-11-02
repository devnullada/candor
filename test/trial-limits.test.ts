// Trial runs on a subscription (#5971a848): what a transcript says about its limits, and sam's
// word on whether a render is running.

import { expect, test } from 'bun:test';
import { inTrialHours, limits, samStopped, stoppedByLimit } from '../trials/agent';

test('runs start from 02:00 until 04:45 local time', () => {
  const at = (h: number, m: number) => inTrialHours(new Date(2026, 10, 3, h, m));
  expect(at(1, 59)).toBe(false);
  expect(at(2, 0)).toBe(true);
  expect(at(4, 44)).toBe(true);
  expect(at(4, 45)).toBe(false);
  expect(at(5, 0)).toBe(false);
  expect(at(14, 30)).toBe(false);
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

const list = `  CIP - Signalling         RUNNING    27832    08:45:56   PixelStreaming2 signalling
  CIP - ComfyUI            STOPPED    -        -          ComfyUI node-based Stable Diffusion
image generation
`;

test('samStopped reads the named service, not its neighbours', () => {
  expect(samStopped(list, 'CIP - ComfyUI')).toBe(true);
  expect(samStopped(list, 'CIP - Signalling')).toBe(false);
});

test('samStopped treats any other status as not stopped', () => {
  expect(samStopped('  CIP - ComfyUI   STARTING  -', 'CIP - ComfyUI')).toBe(false);
  expect(samStopped('\x1b[32m  CIP - ComfyUI   RUNNING  1\x1b[0m', 'CIP - ComfyUI')).toBe(false);
});

test('samStopped is null when sam does not list the service', () => {
  expect(samStopped(list, 'CIP - Hunyuan3D')).toBeNull();
  expect(samStopped('', 'CIP - ComfyUI')).toBeNull();
});
