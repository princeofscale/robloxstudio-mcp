#!/usr/bin/env node

/**
 * Removes the copied studio-plugin/ from the package directory after npm pack/publish.
 * Run from a publishable package directory via its "postpack" script.
 */

import { rmSync, existsSync } from 'fs';
import { join } from 'path';

const packageDir = process.cwd();
const dest = join(packageDir, 'studio-plugin');

if (existsSync(dest)) {
  console.log(`Cleaning up studio-plugin/ from ${packageDir}`);
  rmSync(dest, { recursive: true, force: true });
}
