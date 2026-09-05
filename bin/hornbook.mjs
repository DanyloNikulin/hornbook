#!/usr/bin/env node
// Run in one process so Windows console signals reach the awaited server shutdown.
import { cli } from '../dist/node/server/cli.js';

cli(process.argv.slice(2)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
