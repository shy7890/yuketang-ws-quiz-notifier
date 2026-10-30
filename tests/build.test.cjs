'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
const outputPath = path.join(projectRoot, 'dist/yuketang-quiz-notifier.user.js');
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
).version;

test('build produces a syntactically valid installable userscript', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: projectRoot, stdio: 'pipe' });
  const output = fs.readFileSync(outputPath, 'utf8');

  assert.ok(output.startsWith('// ==UserScript=='));
  assert.match(output, new RegExp(`// @version\\s+${packageVersion.replace(/\./g, '\\.')}`));
  assert.match(output, /\/\/ ==\/UserScript==/);
  assert.doesNotThrow(() => new vm.Script(output));
});
