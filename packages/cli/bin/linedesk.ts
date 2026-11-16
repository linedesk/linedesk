#!/usr/bin/env node
// The `linedesk` command (packages/cli/README.md). Node runs this TypeScript file as it is (type stripping).
import { main } from '../src/index.ts'

process.exitCode = await main(process.argv.slice(2))
