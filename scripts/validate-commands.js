#!/usr/bin/env node
/**
 * validate-commands.js
 *
 * Guards the slash-command surface of this fork:
 *   .claude/commands/  (.md — Claude Code format, loaded by omp)
 *
 * Checks (errors block CI):
 *   - Every command has a top-level 'description' in its frontmatter
 *   - Command frontmatter is valid YAML, not merely splittable
 *
 * Exit codes: 0 = all clear, 1 = one or more errors
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// The same frontmatter-validity rules validate-skills applies to SKILL.md.
// Description extraction shares the top-level frontmatter reader with skills.
// YAML validity is checked separately because the host parses frontmatter
// when the command is loaded.
const { frontmatterYamlErrors, parseFrontmatter } = require(path.join(__dirname, 'lib', 'skill-lint.js'));

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, '.claude', 'commands');

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const stems = fs.existsSync(COMMANDS_DIR)
    ? fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md')).map(f => path.basename(f, '.md')).sort()
    : [];

  let errors = 0;

  console.log('Checking command descriptions and frontmatter...');

  for (const stem of stems) {
    const full = path.join(COMMANDS_DIR, `${stem}.md`);
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch (e) {
      console.log(`  ✗  ${stem} — cannot read file: ${e.message}`);
      errors++;
      continue;
    }

    const problems = [];
    if (parseFrontmatter(content)?.description == null) {
      problems.push('.claude/commands/' + stem + ' — missing or malformed description');
    }
    problems.push(...frontmatterYamlErrors(content));

    if (problems.length === 0) {
      console.log(`  ✓  ${stem}`);
      continue;
    }
    console.log(`  ✗  ${stem}`);
    for (const message of problems) {
      console.log(`       ${message}`);
      errors++;
    }
  }

  const status = errors > 0 ? 'FAILED' : 'PASSED';
  console.log(`\n${stems.length} commands checked — ${errors} error(s) — ${status}`);

  if (errors > 0) process.exit(1);
}

main();
