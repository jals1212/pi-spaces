#!/usr/bin/env node
import { main, processIo } from "../dist/cli.js";

await main(process.argv.slice(2), processIo());
