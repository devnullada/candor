// `import start from '../docs/start.md' with { type: 'text' }`: Bun gives the file's text.
declare module '*.md' {
  const text: string;
  export default text;
}
