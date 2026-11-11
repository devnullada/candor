// `bun run reference`: writes docs/reference.md from src/reference.ts.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderReference } from './reference';

writeFileSync(path.join(import.meta.dir, '..', 'docs', 'reference.md'), renderReference());
