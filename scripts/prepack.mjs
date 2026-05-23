#!/usr/bin/env node

/**
 * Copies studio-plugin/ into the package directory before npm pack/publish.
 * Run from a publishable package directory via its "prepack" script.
 */

import { cpSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const packageDir = process.cwd();
const rootDir = join(packageDir, '..', '..');
const source = join(rootDir, 'studio-plugin');
const dest = join(packageDir, 'studio-plugin');

if (!existsSync(source)) {
  console.error('studio-plugin/ not found at project root, skipping copy');
  process.exit(0);
}

if (existsSync(dest)) {
  console.log('studio-plugin/ already exists in package, skipping copy');
  process.exit(0);
}

console.log(`Copying studio-plugin/ into ${packageDir}`);
cpSync(source, dest, { recursive: true });
