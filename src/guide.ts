import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import agent from '../docs/agent.md' with { type: 'text' };
import more from '../docs/agent-more.md' with { type: 'text' };
import service from '../docs/agent-service.md' with { type: 'text' };
import start from '../docs/start.md' with { type: 'text' };
import { candorHome, version } from './home';

// How an AI coder learns Candor in a user's project: `candor guide` prints
// docs/agent.md for the installed version, the short page every agent integration shares,
// `candor guide start` the long one, and `candor init` writes the files coding agents read on
// their own (AGENTS.md, and CLAUDE.md importing it) pointing at it.

/** What to do, before the guide: the loop that works. */
const checklist = `Working in Candor:

1. Read this guide once before writing code; \`candor guide service\` has a whole service to
   start a new one from; \`candor guide more\` concurrency, tests and the standard modules;
   \`candor guide start\` is the long one. \`candor doc
   <name>\` gives a type's or effect's methods (\`candor doc string\`, \`candor doc tasks\`) or
   every method of a name (\`candor doc split\`). In existing code, \`candor outline [file]\`
   gives each type, the pub signatures and every function's lines: read those lines, not whole
   files.
2. After every edit, \`candor check <file>\`. Each error has a \`help\` line with the fix; follow it.
3. Tests go in \`x_test.candor\` beside \`x.candor\` (same \`module x\` line), as \`test "name" { ... }\`
   blocks; every effect is a fake there. \`candor test x.candor\` runs them, \`x_test.candor:42\` the
   one holding line 42; \`candor test\` alone runs every file's under the current folder.
4. \`candor run <file>\` runs it; \`candor build <file>\` makes a binary.
5. Effects go in the signature (\`uses io, http\`); errors are values (\`Result\`, \`?\`).
6. Where Candor lacks something you need or gets in your way, work around it and tell the user
   what was missing and what you did instead. If the project says where Candor gaps go (its
   CLAUDE.md or AGENTS.md), put them there too.`;

/**
 * The guide: the checklist, then docs/agent.md (`more`: docs/agent-more.md, its second half;
 * `service`: docs/agent-service.md, a whole service, split from it;
 * `start`: docs/start.md), its links made to work outside the repo.
 */
export function guide(page: 'agent' | 'more' | 'service' | 'start' = 'agent'): string {
  const std = path.join(candorHome(), 'std');
  const body = { agent, more, service, start }[page]
    .replaceAll('[`docs/agent-more.md`](agent-more.md)', '`candor guide more`')
    .replaceAll('agent-more.md', '`candor guide more`')
    .replaceAll('[`docs/agent-service.md`](agent-service.md)', '`candor guide service`')
    .replaceAll('agent-service.md', '`candor guide service`')
    .replace('[`docs/agent.md`](agent.md)', '`candor guide`')
    .replace('[`docs/reference.md`](reference.md)', '`candor doc` (also docs/reference.md in the repo)')
    .replace('[`docs/start.md`](start.md)', '`candor guide start`')
    .replaceAll('`std/<name>.candor`', `\`${path.join(std, '<name>.candor')}\``)
    .replaceAll(/\[`std\/(\w+)\.candor`\]\(\.\.\/std\/\w+\.candor\)/g, (_m, name) => `\`${path.join(std, `${name}.candor`)}\``)
    .replace('[`docs/design.md`](design.md)', 'docs/design.md in the repo (github.com/devnullada/candor)')
    .replaceAll(/`(examples\/\w+\.candor)`/g, '`$1` (in the repo)');
  return `candor ${version}\n\n${checklist}\n\n${body}`;
}

const agents = `# Candor project

This project is written in Candor, a backend language that compiles to Go. It is new, so you
won't know it from training:

1. Run \`candor guide\` before writing any Candor: the language, the standard modules and
   testing, for the installed version. \`candor doc <name>\` for a type's methods.
   \`candor outline\` maps the existing code (signatures and line ranges) before you read it.
2. After every edit, run \`candor check <file>\`. Each error's \`help\` line gives the fix.
3. Tests go in \`x_test.candor\` beside \`x.candor\` (same \`module\` line), as \`test "..." { }\`
   blocks: \`candor test x.candor\`, or \`candor test\` for every file.
4. \`candor run main.candor\` runs the program.
5. Where Candor lacks something or gets in the way, work around it and tell the user what was
   missing and what you did instead.
`;

/** `candor init [dir]`: a project an agent can start on. Leaves files that exist alone. */
export function init(dir: string): number {
  // Resolved first: Bun's recursive mkdir throws EEXIST on '.' (Windows), where Node's doesn't.
  dir = path.resolve(dir);
  mkdirSync(dir, { recursive: true });
  const name = path.basename(path.resolve(dir)).replace(/[^A-Za-z0-9]/g, '').replace(/^[^a-z]+/i, '') || 'app';
  const module = name[0].toLowerCase() + name.slice(1);
  const files: Record<string, string> = {
    'AGENTS.md': agents,
    // Claude Code reads CLAUDE.md, not AGENTS.md; this imports it.
    'CLAUDE.md': '@AGENTS.md\n',
    // `candor build`'s binary, beside main.candor; the build itself is in ~/.candor/cache.
    '.gitignore': `/${module}\n/${module}.exe\n`,
    'main.candor': `module ${module}\n\nfn greeting(name: string) -> string {\n  return "Hello, \${name}"\n}\n\nfn main() uses io {\n  io.println(greeting("world"))\n}\n`,
    // Tests beside the module, in a file of their own.
    'main_test.candor': `module ${module}\n\ntest "greets" {\n  assert greeting("Ada") == "Hello, Ada"\n}\n`,
  };
  for (const [file, text] of Object.entries(files)) {
    const at = path.join(dir, file);
    if (existsSync(at)) {
      console.log(`kept ${at}: it exists`);
      continue;
    }
    writeFileSync(at, text);
    console.log(`wrote ${at}`);
  }
  console.log('next: `candor run main.candor`, and tell your coding agent to read AGENTS.md');
  return 0;
}
