// What every page shares: links and the version.
import pkg from '../../package.json';

export const repo = 'https://github.com/devnullada/candor';
export const blob = `${repo}/blob/master`;
export const version: string = pkg.version;

/** The docs pages, in sidebar order. */
export const docPages = [
  { slug: 'start', name: 'Start', what: 'One page on writing a service, every block of code checked.' },
  { slug: 'reference', name: 'Reference', what: 'Every built-in method and effect operation, with an example that runs.' },
  { slug: 'design', name: 'Design', what: 'The principles, and every decision with its reasons.' },
  { slug: 'trials', name: 'Trials', what: 'Candor against Go, written and changed by AI coders.' },
];

/** Plain Markdown for agents, served beside the pages (scripts/prepare.ts). */
export const agentFiles = [
  { href: '/llms.txt', name: 'llms.txt' },
  { href: '/agent.md', name: 'agent.md' },
  { href: '/agent-service.md', name: 'agent-service.md' },
  { href: '/agent-more.md', name: 'agent-more.md' },
];
