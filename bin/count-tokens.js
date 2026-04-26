#!/usr/bin/env node
// count-tokens.js — count cl100k_base tokens in a file or stdin
// Usage:
//   node bin/count-tokens.js <path>   reads file at <path>
//   node bin/count-tokens.js -        reads stdin
// Prints a single integer (token count) to stdout.

'use strict';

const fs = require('fs');
const { countTokens } = require('gpt-tokenizer/cjs/encoding/cl100k_base');

const arg = process.argv[2];

if (!arg) {
  process.stderr.write('Usage: count-tokens.js <path|->\n');
  process.exit(1);
}

function run(text) {
  process.stdout.write(String(countTokens(text)) + '\n');
}

if (arg === '-') {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => run(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', (err) => {
    process.stderr.write('Error reading stdin: ' + err.message + '\n');
    process.exit(1);
  });
} else {
  let text;
  try {
    text = fs.readFileSync(arg, 'utf8');
  } catch (err) {
    process.stderr.write('Error reading file: ' + err.message + '\n');
    process.exit(1);
  }
  run(text);
}
