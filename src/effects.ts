import { T, effect, fn, signalType, type EffectType, type FnType } from './types';

/**
 * Effects are capabilities. A function that says `uses io` receives an `io` value as a hidden
 * parameter; `main` gets the real one, tests get fakes. The Go runtime defines one interface
 * per effect (see runtime/go).
 */
export interface EffectDef {
  type: EffectType;
  go: {
    /** Go type of the capability parameter. */
    type: string;
    /** Expression that builds the real capability, used by the generated `main`. */
    construct: string;
  };
  /** What a `test` block gets instead: the same methods, plus a few to steer and inspect it. */
  fake: {
    /** Only on the fake, like `io.output()`. */
    methods: [string, FnType][];
    /** Builds the fake. Its Go type satisfies `go.type`. */
    construct: string;
  };
}

export const builtinEffects = new Map<string, EffectDef>([
  [
    'io',
    {
      type: effect('io', [
        ['println', fn([T.string], T.unit)],
        ['print', fn([T.string], T.unit)],
        ['eprintln', fn([T.string], T.unit)],
        ['eprint', fn([T.string], T.unit)],
        ['readLine', fn([], { kind: 'option', inner: T.string })],
        ['readAll', fn([], T.string)],
      ]),
      go: { type: 'candor.IO', construct: 'candor.StdIO()' },
      fake: {
        // Everything printed so far, as one string (stdout and stderr apart); the input to read,
        // empty until set.
        methods: [
          ['output', fn([], T.string)],
          ['errorOutput', fn([], T.string)],
          ['setInput', fn([T.string], T.unit)],
        ],
        construct: '&candor.RecordingIO{}',
      },
    },
  ],
  [
    'clock',
    {
      // Milliseconds since the Unix epoch. Proper time types come later.
      type: effect('clock', [
        ['now', fn([], T.int)],
        ['sleep', fn([T.int], T.unit)],
        ['nanos', fn([], T.int)],
      ]),
      go: { type: 'candor.Clock', construct: 'candor.SystemClock()' },
      fake: {
        // The test scheduler's virtual time: starts at 0, moves when told to or when every task sleeps.
        methods: [
          ['set', fn([T.int], T.unit)],
          ['advance', fn([T.int], T.unit)],
        ],
        construct: '&candor.FakeClock{}',
      },
    },
  ],
  [
    'env',
    {
      // Read only: setting a variable would change it for every task at once. `env.load(path)`
      // is the exception, for a .env file at start; the checker sends it to `loadEnv` in std/fs.
      // `signals` and `sendSignal` take a Scope and the built-in `Signal`, so the checker types
      // them itself (see `envSignals`); the types here are for listings.
      type: effect('env', [
        ['get', fn([T.string], { kind: 'option', inner: T.string })],
        ['args', fn([], { kind: 'list', elem: T.string })],
        ['pid', fn([], T.int)],
        ['signals', fn([{ kind: 'scope', id: -1 }, { kind: 'list', elem: signalType }], { kind: 'handle', handle: 'Channel', arg: signalType })],
      ]),
      go: { type: 'candor.Env', construct: 'candor.OSEnv()' },
      fake: {
        // No variables, no arguments and no signals, until the test sets or sends them; pid 1000.
        methods: [
          ['set', fn([T.string, T.string], T.unit)],
          ['setArgs', fn([{ kind: 'list', elem: T.string }], T.unit)],
          ['setPid', fn([T.int], T.unit)],
          ['sendSignal', fn([signalType], T.unit)],
        ],
        construct: '&candor.FakeEnv{}',
      },
    },
  ],
  [
    'random',
    {
      // `shuffle` and `pick` are generic, so the checker types them itself (see `randomCall`).
      type: effect('random', [
        ['int', fn([T.int, T.int], T.int)],
        ['uuid', fn([], T.string)],
        ['uuid4', fn([], T.string)],
        ['token', fn([T.int], T.string)],
        ['bytes', fn([T.int], T.bytes)],
      ]),
      go: { type: 'candor.Random', construct: 'candor.SystemRandom()' },
      fake: {
        // Seeded with 0 in every test, so a test sees the same values each run.
        methods: [['seed', fn([T.int], T.unit)]],
        construct: '&candor.FakeRandom{}',
      },
    },
  ],
  [
    'tasks',
    {
      // Its methods are generic, so the checker types them itself (see `taskMethods`).
      type: effect('tasks', []),
      go: { type: 'candor.Tasks', construct: 'candor.RealTasks()' },
      fake: {
        // Tests run tasks one at a time, in an order picked by a seed.
        methods: [],
        construct: '&candor.FakeTasks{}',
      },
    },
  ],
]);

/** The effect as a `test` block sees it: real methods plus the fake's. */
export function fakeType(def: EffectDef): EffectType {
  return effect(def.type.name, [...def.type.methods, ...def.fake.methods]);
}
