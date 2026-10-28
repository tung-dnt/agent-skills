#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const VALIDATOR = path.join(__dirname, 'validate-commands.js');
// The validator shares the frontmatter-validity rules with validate-skills, so
// the sandbox needs the lib alongside it, not just the script.
const SKILL_LINT = path.join(__dirname, 'lib', 'skill-lint.js');
const sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-validate-commands-test-'));
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(VALIDATOR, path.join(scriptsDir, 'validate-commands.js'));
  fs.mkdirSync(path.join(scriptsDir, 'lib'), { recursive: true });
  fs.copyFileSync(SKILL_LINT, path.join(scriptsDir, 'lib', 'skill-lint.js'));
  sandboxes.push(root);
  return root;
}

function writeFile(root, relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeClaudeCommand(root, stem, descriptionLine) {
  writeFile(
    root,
    path.join('.claude', 'commands', `${stem}.md`),
    `---\n${descriptionLine}\n---\n\n# Command\n`,
  );
}

function writeMatchingCommands(root, stem, description) {
  writeClaudeCommand(root, stem, `description: ${description}`);
}

function run(root) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'validate-commands.js')], {
    cwd: root,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('passes a command with a description', () => {
  const root = makeSandbox();
  writeClaudeCommand(root, 'plan', 'description: Break work into ordered tasks');

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓  plan/);
  assert.match(result.stdout, /1 commands checked — 0 error\(s\) — PASSED/);
});

test('fails with an actionable error for a missing description', () => {
  const root = makeSandbox();
  writeFile(root, path.join('.claude', 'commands', 'review.md'), '---\nargument-hint: x\n---\n\n# Command\n');

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /review — missing or malformed description/);
  assert.match(result.stdout, /1 commands checked — 1 error\(s\) — FAILED/);
});

// Claude parses a command's frontmatter as YAML when the command is loaded, and
// `descriptionFromMd` splits each line on its first colon — so a command whose
// frontmatter is not valid YAML passed every check here. Same class as the
// SKILL.md gap, on the other set of files the #494 thread checked by hand.

test('a command whose frontmatter is valid YAML passes', () => {
  const root = makeSandbox();
  writeMatchingCommands(root, 'build', 'Build the thing');
  const result = run(root);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Checking command descriptions and frontmatter/);
});

test('an unquoted colon in a command description is rejected', () => {
  const root = makeSandbox();
  // Valid to the splitter, rejected by a real YAML parser: it reads a nested
  // mapping.
  writeClaudeCommand(root, 'build', 'description: Build the thing: quickly');

  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /unquoted value containing/);
});

test('quoting the same description makes it pass', () => {
  const root = makeSandbox();
  writeClaudeCommand(root, 'build', 'description: "Build the thing: quickly"');

  const result = run(root);
  assert.equal(result.status, 0, result.stdout);
});

test('a tab-indented command frontmatter is rejected', () => {
  const root = makeSandbox();
  writeFile(
    root,
    path.join('.claude', 'commands', 'build.md'),
    '---\ndescription: Build the thing\nmeta:\n\tlevel: core\n---\n\n# Command\n',
  );

  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /indents with a tab/);
});

test('a top-level description passes despite nested metadata', () => {
  const root = makeSandbox();
  writeClaudeCommand(root, 'review', 'metadata:\n  description: Internal metadata\ndescription: Review a change');
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a nested description does not supply a missing command description', () => {
  const root = makeSandbox();
  writeClaudeCommand(root, 'review', 'metadata:\n  description: Review a change');
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /missing or malformed description/);
});
