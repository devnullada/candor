// A rehype plugin for docs/*.md on the site. The docs link to each other and into the repo with
// GitHub-relative paths; here a link to a page the site has goes to that page, and anything else
// in the repo goes to GitHub.
export const pages = ['start', 'reference', 'design', 'trials'];
const blob = 'https://github.com/devnullada/candor/blob/master';

/** The site's href for a link written in docs/<file>.md. */
export function rewrite(href) {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href;
  const [file, hash] = href.split('#');
  const m = /^(?:\.\/)?([\w-]+)\.md$/.exec(file);
  if (m && pages.includes(m[1])) return `/docs/${m[1]}/${hash ? `#${hash}` : ''}`;
  const repoPath = new URL(file, 'https://x/docs/').pathname.slice(1);
  return `${blob}/${repoPath}${hash ? `#${hash}` : ''}`;
}

export function docLinks() {
  const walk = (node) => {
    if (node.type === 'element' && node.tagName === 'a' && typeof node.properties?.href === 'string') {
      node.properties.href = rewrite(node.properties.href);
    }
    for (const child of node.children ?? []) walk(child);
  };
  return walk;
}
