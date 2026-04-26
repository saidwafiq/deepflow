// Simulated verify.md runner importing shared predicates
const predicates = require('./hooks/lib/artifact-predicates.js');

console.log('df:verify importing predicates:', Object.keys(predicates).join(', '));

// Simulate L0 check
const l0 = predicates.checkBuildPasses('npm run build');
console.log('L0 (build):', l0.pass ? 'PASS' : 'FAIL');

// Simulate L1 check
const l1 = predicates.checkScopeCoverage(['src/test.js'], process.cwd());
console.log('L1 (scope):', l1.pass ? 'PASS' : 'FAIL', '- missing:', l1.missing);

console.log('\nVerify command can import shared predicates.');
