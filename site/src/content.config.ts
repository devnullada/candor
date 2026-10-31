import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

// The repo's docs, rendered as they are: the site never keeps a copy, so the examples the tests
// check are the ones on the page.
const docs = defineCollection({
  loader: glob({ base: '../docs', pattern: ['start.md', 'reference.md', 'design.md', 'trials.md'] }),
});

export const collections = { docs };
