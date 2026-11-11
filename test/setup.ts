import { tmpdir } from 'node:os';
import path from 'node:path';

// The tests' builds go to a cache of their own, not the user's ~/.candor/cache.
process.env.CANDOR_CACHE ??= path.join(tmpdir(), 'candor-test-cache');
