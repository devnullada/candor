// Before a build: the logo files from assets/, the docs as plain Markdown for agents, and
// /llms.txt, all into public/ (gitignored there). The page itself reads
// trial-numbers/numbers.json and the examples at build time.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const site = path.join(import.meta.dir, '..');
const root = path.join(site, '..');
const pub = path.join(site, 'public');
mkdirSync(pub, { recursive: true });

for (const f of ['logo.svg', 'favicon.ico', 'apple-touch-icon.png', 'logo-512.png']) {
  copyFileSync(path.join(root, 'assets', f), path.join(pub, f));
}

const docs = [
  ['start.md', 'The guide: writing a service in Candor, every block of code checked.'],
  ['agent.md', 'The short guide an AI coder starts on (`candor guide`).'],
  ['agent-service.md', 'A whole service: HTTP, JSON, SQLite, its test (`candor guide service`).'],
  ['agent-more.md', 'Concurrency, tests and the standard modules (`candor guide more`).'],
  ['reference.md', 'Every built-in method and effect operation, with an example that runs.'],
];
for (const [f] of docs) copyFileSync(path.join(root, 'docs', f), path.join(pub, f));

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
writeFileSync(
  path.join(pub, 'llms.txt'),
  `# Candor

> A backend language designed for AI coders. TypeScript-shaped syntax, Rust's discipline, compiles to Go. Every function says openly what it does: the effects it may perform are part of its signature. Version ${pkg.version}.

Install: \`curl -fsSL https://raw.githubusercontent.com/devnullada/candor/master/install.sh | sh\` (macOS, Linux) or \`irm https://raw.githubusercontent.com/devnullada/candor/master/install.ps1 | iex\` (Windows). Programs build with Go 1.22+. The installed compiler teaches the language: \`candor guide\`, \`candor doc <name>\`, and every error from \`candor check\` carries its fix.

## Docs

${docs.map(([f, what]) => `- [${f}](https://candorlanguage.org/${f}): ${what}`).join('\n')}

## Source

- [GitHub](https://github.com/devnullada/candor): the compiler, standard modules, examples and the design log (docs/design.md).
- [Trials](https://github.com/devnullada/candor/blob/master/docs/trials.md): Candor against Go, written and changed by AI coders, with every catch.
`,
);
console.log('public/: logo, docs, llms.txt');
