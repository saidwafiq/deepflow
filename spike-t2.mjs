import { chromium } from 'playwright';

const startTime = Date.now();

const browser = await chromium.launch({ headless: true });
const browserLaunchTime = Date.now();

const page = await browser.newPage();
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
const pageLoadTime = Date.now();

// Get the a11y tree snapshot using modern Playwright API (v1.35+)
// page.accessibility.snapshot() was removed; use locator.ariaSnapshot() instead
const a11ySnapshot = await page.locator('body').ariaSnapshot();

// Get bounding boxes for key elements using locators
const elementSelectors = [
  { selector: 'h1', label: 'h1' },
  { selector: 'p', label: 'p' },
  { selector: 'a', label: 'a' },
];

const boundingBoxes = [];

for (const { selector, label } of elementSelectors) {
  const locators = page.locator(selector);
  const count = await locators.count();
  for (let i = 0; i < count; i++) {
    const el = locators.nth(i);
    const text = (await el.textContent()).trim().slice(0, 80);
    const bbox = await el.boundingBox();
    boundingBoxes.push({ tag: label, index: i, text, bbox });
  }
}

const endTime = Date.now();

console.log('=== A11Y SNAPSHOT (ARIA) ===');
console.log(a11ySnapshot);

console.log('\n=== BOUNDING BOXES ===');
console.log(JSON.stringify(boundingBoxes, null, 2));

console.log('\n=== TIMING ===');
console.log(JSON.stringify({
  browserLaunchMs: browserLaunchTime - startTime,
  pageLoadMs: pageLoadTime - browserLaunchTime,
  a11yAndBboxMs: endTime - pageLoadTime,
  totalMs: endTime - startTime,
}, null, 2));

await browser.close();
