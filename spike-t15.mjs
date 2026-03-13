import { chromium } from 'playwright';

const TARGET_URL = 'https://docs.stripe.com/api/charges';
const PRIMARY_SELECTOR = 'main, article, [role="main"]';
const FALLBACK_SELECTOR = 'body';

async function run() {
  console.log('=== T15 Spike: innerText Selector Extraction ===\n');
  console.log(`Target URL: ${TARGET_URL}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating to page...');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Give JS-rendered content a moment to settle
  await page.waitForTimeout(2000);

  let selectorUsed = PRIMARY_SELECTOR;
  let matched = false;
  let text = '';

  // Try primary selector
  try {
    const el = await page.$(PRIMARY_SELECTOR.split(',')[0].trim());
    if (el) {
      text = await page.innerText(PRIMARY_SELECTOR);
      matched = true;
      console.log(`\nSelector matched: "${PRIMARY_SELECTOR}"`);
    } else {
      console.log(`\nPrimary selector did not match, falling back to "${FALLBACK_SELECTOR}"`);
    }
  } catch (err) {
    console.log(`\nPrimary selector error: ${err.message}`);
  }

  if (!matched) {
    selectorUsed = FALLBACK_SELECTOR;
    text = await page.innerText(FALLBACK_SELECTOR);
    console.log(`Using fallback selector: "${FALLBACK_SELECTOR}"`);
  }

  await browser.close();

  // --- Analysis ---
  const totalChars = text.length;
  const approxTokens = Math.round(totalChars / 4);
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const totalLines = lines.length;

  // Signal detection: look for API method signatures
  const apiSignaturePatterns = [
    /POST|GET|DELETE|PUT|PATCH/,
    /\.(create|retrieve|list|update|delete)\(/i,
    /curl\s+https/i,
    /application\/json/i,
    /stripe\.charges/i,
    /\{[^}]{5,}\}/,  // JSON-like objects
    /charge\.(id|amount|currency|status)/i,
  ];

  const signalLines = lines.filter(line =>
    apiSignaturePatterns.some(pattern => pattern.test(line))
  );
  const signalCount = signalLines.length;

  // Noise detection: nav/footer patterns
  const noisePatterns = [
    /^(Home|Products|Pricing|Docs|Blog|Sign in|Log in|Get started)$/i,
    /cookie/i,
    /privacy policy/i,
    /terms of service/i,
    /©\s*\d{4}/i,
    /all rights reserved/i,
    /subscribe to our newsletter/i,
  ];

  const noiseLines = lines.filter(line =>
    noisePatterns.some(pattern => pattern.test(line.trim()))
  );
  const noiseCount = noiseLines.length;

  const signalToNoiseRatio = noiseCount > 0 ? (signalCount / noiseCount).toFixed(2) : 'infinite (no noise detected)';

  console.log('\n=== RESULTS ===\n');
  console.log(`Selector used: ${selectorUsed}`);
  console.log(`Matched primary: ${matched}`);
  console.log(`Total characters: ${totalChars}`);
  console.log(`Approx tokens (chars/4): ${approxTokens}`);
  console.log(`Non-empty lines: ${totalLines}`);
  console.log(`Signal lines (API patterns): ${signalCount}`);
  console.log(`Noise lines (nav/footer): ${noiseCount}`);
  console.log(`Signal-to-noise ratio: ${signalToNoiseRatio}`);

  const sample = text.slice(0, 500);
  console.log('\n--- First 500 chars of extracted content ---');
  console.log(sample);
  console.log('--- End sample ---');

  console.log('\n--- Sample signal lines (up to 5) ---');
  signalLines.slice(0, 5).forEach((l, i) => console.log(`  [${i+1}] ${l.trim().slice(0, 120)}`));

  console.log('\n--- Sample noise lines (up to 5) ---');
  noiseLines.slice(0, 5).forEach((l, i) => console.log(`  [${i+1}] ${l.trim().slice(0, 120)}`));

  // Conclusion
  const pass = matched && signalCount > 5 && noiseCount < 10 && approxTokens < 20000;
  console.log(`\n=== CONCLUSION: ${pass ? 'PASS' : 'FAIL'} ===`);
  console.log(`  - Primary selector matched: ${matched}`);
  console.log(`  - Sufficient API signal: ${signalCount > 5} (${signalCount} signal lines)`);
  console.log(`  - Low noise: ${noiseCount < 10} (${noiseCount} noise lines)`);
  console.log(`  - Token budget ok (<20k): ${approxTokens < 20000} (${approxTokens} tokens)`);

  // Return data for the experiment file writer
  return {
    selectorUsed,
    matched,
    totalChars,
    approxTokens,
    totalLines,
    signalCount,
    noiseCount,
    signalToNoiseRatio,
    sample,
    signalLines: signalLines.slice(0, 5),
    noiseLines: noiseLines.slice(0, 5),
    pass,
  };
}

run().then(results => {
  // Write a machine-readable JSON summary for the experiment file generator
  console.log('\n__RESULTS_JSON__');
  console.log(JSON.stringify(results, null, 2));
}).catch(err => {
  console.error('SPIKE FAILED:', err);
  process.exit(1);
});
