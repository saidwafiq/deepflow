#!/usr/bin/env node
'use strict';
// Minimal JSON Schema validator — covers ONLY the constructs we use in
// validate-result.schema.json: type, properties, required, additionalProperties.
// Returns { valid: boolean, errors: string[] }.
const fs = require('node:fs');
const path = require('node:path');

function loadSchema() {
  const p = path.join(__dirname, 'validate-result.schema.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function typeOk(value, expected) {
  if (expected === 'number') return typeof value === 'number' && !Number.isNaN(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'string') return typeof value === 'string';
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'null') return value === null;
  return true;
}

function validate(node, schema, pathStr, errors) {
  if (schema.type && !typeOk(node, schema.type)) {
    errors.push(`${pathStr || '<root>'}: expected type ${schema.type}, got ${Array.isArray(node) ? 'array' : typeof node}`);
    return;
  }
  if (schema.required && schema.type === 'object' && node && typeof node === 'object') {
    for (const key of schema.required) {
      if (!(key in node)) errors.push(`${pathStr ? pathStr + '.' : ''}${key}: missing required key`);
    }
  }
  if (schema.properties && schema.type === 'object' && node && typeof node === 'object') {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in node) validate(node[k], sub, pathStr ? `${pathStr}.${k}` : k, errors);
    }
  }
}

function validateResult(value) {
  const schema = loadSchema();
  const errors = [];
  validate(value, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

module.exports = { validateResult, loadSchema };
