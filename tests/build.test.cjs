'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
const outputPath = path.join(projectRoot, 'dist/yuketang-quiz-notifier.user.js');

test('build produces a syntactically valid installable userscript', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: projectRoot, stdio: 'pipe' });
  const output = fs.readFileSync(outputPath, 'utf8');

  assert.ok(output.startsWith('// ==UserScript=='));
  assert.match(output, /\/\/ @version\s+3\.7\.0/);
  assert.match(output, /\/\/ ==\/UserScript==/);
  assert.doesNotThrow(() => new vm.Script(output));
});
