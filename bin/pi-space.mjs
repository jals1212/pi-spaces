#!/usr/bin/env node
import { main, processIo } from "../src/cli.ts";

await main(process.argv.slice(2), processIo());
