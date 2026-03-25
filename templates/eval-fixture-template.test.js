const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_DIR = path.join(__dirname, 'eval-fixture-template');
const FIXTURE_DIR = path.join(TEMPLATE_DIR, 'fixture');

// ---------------------------------------------------------------------------
// AC-4: Template directory exists with expected structure
// ---------------------------------------------------------------------------

describe('eval-fixture-template structure', () => {
  it('template root directory exists', () => {
    assert.ok(fs.existsSync(TEMPLATE_DIR));
    assert.ok(fs.statSync(TEMPLATE_DIR).isDirectory());
  });

  it('has benchmark root files: spec.md, config.yaml, hypotheses.md', () => {
    for (const file of ['spec.md', 'config.yaml', 'hypotheses.md']) {
      const filePath = path.join(TEMPLATE_DIR, file);
      assert.ok(fs.existsSync(filePath), `missing ${file}`);
    }
  });

  it('has tests/ directory with test files', () => {
    const testsDir = path.join(TEMPLATE_DIR, 'tests');
    assert.ok(fs.existsSync(testsDir));
    assert.ok(fs.statSync(testsDir).isDirectory());

    const testFiles = fs.readdirSync(testsDir);
    assert.ok(testFiles.includes('guard.test.js'), 'missing guard.test.js');
    assert.ok(testFiles.includes('behavior.test.js'), 'missing behavior.test.js');
  });

  it('has fixture/ directory', () => {
    assert.ok(fs.existsSync(FIXTURE_DIR));
    assert.ok(fs.statSync(FIXTURE_DIR).isDirectory());
  });
});

// ---------------------------------------------------------------------------
// fixture/ contains 10-15+ skeleton files
// ---------------------------------------------------------------------------

describe('fixture/ skeleton file count', () => {
  it('contains at least 10 files', () => {
    const files = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    }
    walk(FIXTURE_DIR);
    assert.ok(
      files.length >= 10,
      `expected >= 10 fixture files, got ${files.length}`
    );
  });

  it('contains expected subdirectories: src/, specs/, hooks/, .deepflow/', () => {
    for (const sub of ['src', 'specs', 'hooks', '.deepflow']) {
      const subPath = path.join(FIXTURE_DIR, sub);
      assert.ok(fs.existsSync(subPath), `missing fixture/${sub}/`);
      assert.ok(fs.statSync(subPath).isDirectory(), `fixture/${sub} is not a directory`);
    }
  });
});

// ---------------------------------------------------------------------------
// spec.md exists and has content
// ---------------------------------------------------------------------------

describe('spec.md', () => {
  const specPath = path.join(TEMPLATE_DIR, 'spec.md');

  it('exists and is non-empty', () => {
    assert.ok(fs.existsSync(specPath));
    const content = fs.readFileSync(specPath, 'utf8');
    assert.ok(content.trim().length > 0, 'spec.md is empty');
  });

  it('contains an Objective section', () => {
    const content = fs.readFileSync(specPath, 'utf8');
    assert.ok(content.includes('## Objective'), 'spec.md missing ## Objective');
  });

  it('contains a Target Metric section', () => {
    const content = fs.readFileSync(specPath, 'utf8');
    assert.ok(content.includes('## Target Metric'), 'spec.md missing ## Target Metric');
  });

  it('contains Acceptance Criteria section', () => {
    const content = fs.readFileSync(specPath, 'utf8');
    assert.ok(content.includes('## Acceptance Criteria'), 'spec.md missing ## Acceptance Criteria');
  });
});

// ---------------------------------------------------------------------------
// config.yaml exists and has valid structure
// ---------------------------------------------------------------------------

describe('config.yaml', () => {
  const configPath = path.join(TEMPLATE_DIR, 'config.yaml');

  it('exists and is non-empty', () => {
    assert.ok(fs.existsSync(configPath));
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.trim().length > 0, 'config.yaml is empty');
  });

  it('contains benchmark name field', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('name:'), 'config.yaml missing name field');
  });

  it('contains metrics section with target', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('metrics:'), 'config.yaml missing metrics section');
    assert.ok(content.includes('target:'), 'config.yaml missing target metric');
  });

  it('contains guard_command', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('guard_command:'), 'config.yaml missing guard_command');
  });

  it('contains fixture section with run_command', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('fixture:'), 'config.yaml missing fixture section');
    assert.ok(content.includes('run_command:'), 'config.yaml missing run_command');
  });

  it('contains loop section with default_iterations', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('loop:'), 'config.yaml missing loop section');
    assert.ok(content.includes('default_iterations:'), 'config.yaml missing default_iterations');
  });
});

// ---------------------------------------------------------------------------
// fixture/package.json has build/test scripts
// ---------------------------------------------------------------------------

describe('fixture/package.json', () => {
  const pkgPath = path.join(FIXTURE_DIR, 'package.json');

  it('exists and is valid JSON', () => {
    assert.ok(fs.existsSync(pkgPath));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(pkgPath, 'utf8')));
  });

  it('has a test script', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.ok(pkg.scripts, 'package.json missing scripts');
    assert.equal(typeof pkg.scripts.test, 'string', 'missing test script');
    assert.ok(pkg.scripts.test.length > 0, 'test script is empty');
  });

  it('has a build script', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.equal(typeof pkg.scripts.build, 'string', 'missing build script');
    assert.ok(pkg.scripts.build.length > 0, 'build script is empty');
  });

  it('has a name field', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.equal(typeof pkg.name, 'string');
    assert.ok(pkg.name.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Template files are non-empty
// ---------------------------------------------------------------------------

describe('all template files are non-empty', () => {
  const allFiles = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else allFiles.push(full);
    }
  }
  walk(TEMPLATE_DIR);

  for (const filePath of allFiles) {
    const rel = path.relative(TEMPLATE_DIR, filePath);
    it(`${rel} is non-empty`, () => {
      const stat = fs.statSync(filePath);
      assert.ok(stat.size > 0, `${rel} is empty (0 bytes)`);
    });
  }
});

// ---------------------------------------------------------------------------
// hypotheses.md has seeded hypotheses
// ---------------------------------------------------------------------------

describe('hypotheses.md', () => {
  const hypPath = path.join(TEMPLATE_DIR, 'hypotheses.md');

  it('exists and is non-empty', () => {
    assert.ok(fs.existsSync(hypPath));
    const content = fs.readFileSync(hypPath, 'utf8');
    assert.ok(content.trim().length > 0);
  });

  it('contains at least 3 hypothesis entries', () => {
    const content = fs.readFileSync(hypPath, 'utf8');
    // Hypotheses are lines after the --- separator, non-empty
    const afterSeparator = content.split('---').slice(1).join('---');
    const hypotheses = afterSeparator
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    assert.ok(
      hypotheses.length >= 3,
      `expected >= 3 hypotheses, got ${hypotheses.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// Fixture source files exist and have meaningful content
// ---------------------------------------------------------------------------

describe('fixture source files', () => {
  const expectedSrcFiles = [
    'src/index.js',
    'src/config.js',
    'src/pipeline.js',
    'src/spec-loader.js',
    'src/task-runner.js',
    'src/verifier.js',
  ];

  for (const rel of expectedSrcFiles) {
    it(`fixture/${rel} exists and is non-empty`, () => {
      const filePath = path.join(FIXTURE_DIR, rel);
      assert.ok(fs.existsSync(filePath), `missing fixture/${rel}`);
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.trim().length > 0, `fixture/${rel} is empty`);
    });
  }

  it('fixture/src/skills/example-skill/SKILL.md has YAML frontmatter', () => {
    const skillPath = path.join(FIXTURE_DIR, 'src', 'skills', 'example-skill', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath));
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(content.startsWith('---'), 'SKILL.md should start with YAML frontmatter');
    assert.ok(content.includes('allowed-tools'), 'SKILL.md missing allowed-tools');
  });

  it('fixture/src/commands/df/example.md exists with frontmatter', () => {
    const cmdPath = path.join(FIXTURE_DIR, 'src', 'commands', 'df', 'example.md');
    assert.ok(fs.existsSync(cmdPath));
    const content = fs.readFileSync(cmdPath, 'utf8');
    assert.ok(content.startsWith('---'), 'example.md should start with YAML frontmatter');
  });

  it('fixture/hooks/invariant.js exists and is non-empty', () => {
    const hookPath = path.join(FIXTURE_DIR, 'hooks', 'invariant.js');
    assert.ok(fs.existsSync(hookPath));
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(content.trim().length > 0);
  });

  it('fixture/specs/ contains a doing-*.md file', () => {
    const specFiles = fs.readdirSync(path.join(FIXTURE_DIR, 'specs'));
    const doingSpecs = specFiles.filter(
      (f) => f.startsWith('doing-') && f.endsWith('.md')
    );
    assert.ok(doingSpecs.length >= 1, 'no doing-*.md spec found in fixture/specs/');
  });

  it('fixture/.deepflow/decisions.md exists', () => {
    const decPath = path.join(FIXTURE_DIR, '.deepflow', 'decisions.md');
    assert.ok(fs.existsSync(decPath));
    const content = fs.readFileSync(decPath, 'utf8');
    assert.ok(content.trim().length > 0);
  });
});

// ---------------------------------------------------------------------------
// Guard test file is executable / valid node script
// ---------------------------------------------------------------------------

describe('tests/ are valid node scripts', () => {
  it('guard.test.js uses fs and path modules', () => {
    const content = fs.readFileSync(
      path.join(TEMPLATE_DIR, 'tests', 'guard.test.js'),
      'utf8'
    );
    assert.ok(content.includes("require('fs')") || content.includes("require('node:fs')"));
    assert.ok(content.includes("require('path')") || content.includes("require('node:path')"));
  });

  it('behavior.test.js uses fs and path modules', () => {
    const content = fs.readFileSync(
      path.join(TEMPLATE_DIR, 'tests', 'behavior.test.js'),
      'utf8'
    );
    assert.ok(content.includes("require('fs')") || content.includes("require('node:fs')"));
    assert.ok(content.includes("require('path')") || content.includes("require('node:path')"));
  });

  it('guard.test.js references fixture dir', () => {
    const content = fs.readFileSync(
      path.join(TEMPLATE_DIR, 'tests', 'guard.test.js'),
      'utf8'
    );
    assert.ok(content.includes('fixture'), 'guard.test.js should reference fixture directory');
  });
});
