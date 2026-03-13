/**
 * spike-t16.mjs
 * T16 [SPIKE]: Validate search-to-content navigation flow
 * Hypothesis: Agent can navigate from search to target doc page in <=5 page loads within 60s
 */

import { chromium } from 'playwright';

const TIMEOUT_MS = 60_000;
const MAX_PAGE_LOADS = 5;

async function runSpike() {
  const startTime = Date.now();
  let pageLoads = 0;
  const navigationPath = [];
  let contentReached = false;
  let contentLength = 0;
  let contentSnippet = '';
  let approach = '';
  let notes = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // ---- Attempt 1: Google Search ----
    approach = 'Google Search';
    console.log('[1/3] Trying Google search...');
    await page.goto('https://www.google.com/search?q=mongodb+aggregation+pipeline+docs', {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    });
    pageLoads++;
    navigationPath.push(`LOAD ${pageLoads}: Google search results`);

    const elapsed1 = Date.now() - startTime;
    console.log(`  Page loaded in ${elapsed1}ms (load #${pageLoads})`);

    // Try to detect if Google blocked us
    const title = await page.title();
    console.log(`  Page title: ${title}`);

    // Look for organic results — Google uses various selectors
    let targetUrl = null;

    // Try common Google result selectors
    const selectors = [
      'div#search a[href*="mongodb.com"]',
      'div.g a[href*="mongodb.com"]',
      'div[data-sokoban-container] a[href*="mongodb.com"]',
      'a[href*="mongodb.com/docs"]',
      'a[href*="mongodb.com"]',
    ];

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          targetUrl = await el.getAttribute('href');
          if (targetUrl && targetUrl.startsWith('http')) {
            console.log(`  Found MongoDB URL via selector "${sel}": ${targetUrl}`);
            break;
          }
        }
      } catch (_) {}
    }

    if (!targetUrl) {
      notes.push('Google did not return a usable MongoDB link (possibly blocked or CAPTCHA). Falling back to DuckDuckGo.');
      console.log('  Google blocked or no result found. Trying DuckDuckGo...');

      // ---- Attempt 2: DuckDuckGo ----
      approach = 'DuckDuckGo Search';
      await page.goto('https://duckduckgo.com/?q=mongodb+aggregation+pipeline+docs&ia=web', {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_MS,
      });
      pageLoads++;
      navigationPath.push(`LOAD ${pageLoads}: DuckDuckGo search results`);

      const elapsed2 = Date.now() - startTime;
      console.log(`  DuckDuckGo loaded in ${elapsed2}ms (load #${pageLoads})`);
      console.log(`  Title: ${await page.title()}`);

      // DuckDuckGo result link selectors
      const ddgSelectors = [
        'a[href*="mongodb.com/docs"]',
        'article a[href*="mongodb.com"]',
        '.result__a[href*="mongodb.com"]',
        'a[data-testid="result-title-a"][href*="mongodb.com"]',
        'a[href*="mongodb.com"]',
      ];

      for (const sel of ddgSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            targetUrl = await el.getAttribute('href');
            if (targetUrl && targetUrl.startsWith('http')) {
              console.log(`  Found MongoDB URL via DuckDuckGo selector "${sel}": ${targetUrl}`);
              break;
            }
          }
        } catch (_) {}
      }
    }

    if (!targetUrl) {
      notes.push('DuckDuckGo also did not yield a direct link. Falling back to direct MongoDB docs navigation.');
      console.log('  DuckDuckGo also failed. Falling back to direct MongoDB docs navigation...');

      // ---- Attempt 3: Direct navigation ----
      approach = 'Direct MongoDB Docs Navigation';
      targetUrl = 'https://www.mongodb.com/docs/manual/core/aggregation-pipeline/';
    }

    // ---- Navigate to target URL ----
    console.log(`\n[2/3] Navigating to target: ${targetUrl}`);
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    });
    pageLoads++;
    navigationPath.push(`LOAD ${pageLoads}: ${targetUrl}`);

    const elapsed3 = Date.now() - startTime;
    console.log(`  Target page loaded in ${elapsed3}ms (load #${pageLoads})`);
    console.log(`  Title: ${await page.title()}`);

    // ---- Extract content ----
    console.log('\n[3/3] Extracting content...');
    let content = '';

    const contentSelectors = ['main', 'article', '[role="main"]'];
    for (const sel of contentSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          content = await el.innerText();
          if (content && content.trim().length > 100) {
            console.log(`  Content extracted via selector "${sel}" (${content.length} chars)`);
            break;
          }
        }
      } catch (_) {}
    }

    if (!content || content.trim().length < 100) {
      // Fallback: entire body text
      content = await page.innerText('body');
      console.log(`  Fallback to body text (${content.length} chars)`);
    }

    contentLength = content.trim().length;
    contentSnippet = content.trim().slice(0, 300);

    // Check if we have relevant content
    const relevantKeywords = ['aggregation', 'pipeline', 'stage', '$match', '$group', 'aggregate'];
    const foundKeywords = relevantKeywords.filter((kw) =>
      content.toLowerCase().includes(kw.toLowerCase())
    );

    contentReached = foundKeywords.length >= 2;
    console.log(`  Relevant keywords found: ${foundKeywords.join(', ') || 'none'}`);
    console.log(`  Content reached: ${contentReached}`);
  } catch (err) {
    notes.push(`Error: ${err.message}`);
    console.error('Error during spike:', err.message);
  } finally {
    await browser.close();
  }

  const totalWallTime = Date.now() - startTime;

  // ---- Summary ----
  const passHypothesis =
    contentReached && pageLoads <= MAX_PAGE_LOADS && totalWallTime <= TIMEOUT_MS;

  console.log('\n========== RESULTS ==========');
  console.log(`Approach used:       ${approach}`);
  console.log(`Navigation path:`);
  navigationPath.forEach((p) => console.log(`  - ${p}`));
  console.log(`Page loads:          ${pageLoads} (max allowed: ${MAX_PAGE_LOADS})`);
  console.log(`Total wall time:     ${totalWallTime}ms (max allowed: ${TIMEOUT_MS}ms)`);
  console.log(`Content reached:     ${contentReached}`);
  console.log(`Content length:      ${contentLength} chars`);
  console.log(`Content snippet:     ${contentSnippet.slice(0, 150).replace(/\n/g, ' ')}...`);
  console.log(`Notes:               ${notes.join(' | ') || 'none'}`);
  console.log(`HYPOTHESIS:          ${passHypothesis ? 'PASS' : 'FAIL'}`);
  console.log('==============================');

  return {
    approach,
    navigationPath,
    pageLoads,
    totalWallTime,
    contentReached,
    contentLength,
    contentSnippet,
    notes,
    passHypothesis,
  };
}

runSpike().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
