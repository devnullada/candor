/** Generated Go without its `//line` directives, for checking how statements are lowered. */
export function plain(go: string | null): string {
  return (go ?? '').replace(/^\s*\/\/line .*\n/gm, '');
}
