export interface Pos {
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units. */
  col: number;
}

export interface Span {
  start: Pos;
  end: Pos;
}

/** Stable codes: tools and prompts can match on these, messages may change. */
export const Codes = {
  SyntaxError: 'CAN0001',
  UnknownName: 'CAN0002',
  UnknownEffect: 'CAN0003',
  UndeclaredEffect: 'CAN0004',
  TypeMismatch: 'CAN0005',
  ArgCount: 'CAN0006',
  NoMain: 'CAN0007',
  NoSuchMember: 'CAN0008',
  NotCallable: 'CAN0009',
  MainSignature: 'CAN0010',
  MissingReturn: 'CAN0011',
  UnusedValue: 'CAN0012',
  UnusedVariable: 'CAN0013',
  UnusedEffect: 'CAN0014',
  UnknownType: 'CAN0015',
  Duplicate: 'CAN0016',
  IntegerOverflow: 'CAN0017',
  DivisionByZero: 'CAN0018',
  InvalidOperands: 'CAN0019',
  MethodNotCalled: 'CAN0020',
  ConditionNotBool: 'CAN0021',
  MissingElse: 'CAN0022',
  BranchMismatch: 'CAN0023',
  NoValue: 'CAN0024',
  NotAValue: 'CAN0025',
  MissingField: 'CAN0026',
  NonExhaustive: 'CAN0027',
  UnreachableArm: 'CAN0028',
  RecursiveType: 'CAN0029',
  Naming: 'CAN0030',
  EmptyEnum: 'CAN0031',
  NeedsAnnotation: 'CAN0032',
  BadTry: 'CAN0033',
  AssertOutsideTest: 'CAN0034',
  FakeOnly: 'CAN0035',
  NotMutable: 'CAN0036',
  MutCapture: 'CAN0037',
  OutsideLoop: 'CAN0038',
  NeedlessMut: 'CAN0039',
  NotIterable: 'CAN0040',
  BadImport: 'CAN0041',
  ExternUnsupported: 'CAN0042',
  BadEffect: 'CAN0043',
  Unvetted: 'CAN0044',
  GoMismatch: 'CAN0045',
  TypeArgs: 'CAN0046',
  Bound: 'CAN0047',
  BadImpl: 'CAN0048',
  UnusedResult: 'CAN0049',
  NeedlessVoid: 'CAN0050',
  GoTypeOutside: 'CAN0051',
  EffectUnderLock: 'CAN0052',
  BadContract: 'CAN0053',
  Private: 'CAN0054',
  Exposed: 'CAN0055',
  SqlSchema: 'CAN0056',
  SqlUnchecked: 'CAN0057',
  BadDefer: 'CAN0058',
  NotConstant: 'CAN0059',
  ConstCycle: 'CAN0060',
  OrBindings: 'CAN0061',
  EmbedFile: 'CAN0062',
  TestFile: 'CAN0063',
} as const;

export type Code = (typeof Codes)[keyof typeof Codes];

export interface Diagnostic {
  code: Code;
  /** A `note` is information, shown by `candor check` only: a query not checked against the schema. */
  severity: 'error' | 'warning' | 'note';
  message: string;
  file: string;
  span: Span;
  /** A concrete fix, when there is an obvious one. */
  help?: string;
}

/** Thrown when compilation cannot continue (syntax errors). */
export class CandorError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('\n'));
    this.name = 'CandorError';
  }
}

export function formatHuman(d: Diagnostic, source: string): string {
  const { start, end } = d.span;
  const lineText = (source.split('\n')[start.line - 1] ?? '').replace(/\r$/, '').replace(/\t/g, ' ');
  const width =
    end.line === start.line ? Math.max(1, end.col - start.col) : Math.max(1, lineText.length - start.col + 1);
  const pad = ' '.repeat(String(start.line).length);
  const lines = [
    `${d.file}:${start.line}:${start.col}: ${d.severity}[${d.code}]: ${d.message}`,
    `${pad} |`,
    `${start.line} | ${lineText}`,
    `${pad} | ${' '.repeat(start.col - 1)}${'^'.repeat(width)}`,
  ];
  if (d.help) lines.push(`${pad} = help: ${d.help}`);
  return lines.join('\n');
}
