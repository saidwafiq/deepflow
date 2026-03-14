---
name: browse-fetch
description: Fetches live web content using headless Chromium via Playwright. Use when you need to read documentation, articles, or any public URL that requires JavaScript rendering. Falls back to WebFetch for simple HTML pages.
---

# Browse-Fetch

Retrieve live web content with a headless browser. Handles JavaScript-rendered pages, SPAs, and dynamic content that WebFetch cannot reach.

## When to Use

- Reading documentation sites that require JavaScript to render (e.g., React-based docs, Vite, Next.js portals)
- Fetching the current content of a specific URL provided by the user
- Extracting article or reference content from a known page before implementing code against it

## Skip When

- The URL is a plain HTML page or GitHub raw file — use WebFetch instead (faster, no overhead)
- The target requires authentication (login wall) or CAPTCHA — browser cannot bypass; note the block and continue

---

## Browser Core Protocol

This protocol is the reusable foundation for all browser-based skills (browse-fetch, browse-verify, etc.).

### 1. Install Check

Before launching, verify Playwright is available:

```bash
# Prefer Node.js; fall back to Bun
if which node > /dev/null 2>&1; then RUNTIME=node; elif which bun > /dev/null 2>&1; then RUNTIME=bun; else echo "Error: neither node nor bun found" && exit 1; fi

$RUNTIME -e "require('playwright')" 2>/dev/null \
  || npx --yes playwright install chromium --with-deps 2>&1 | tail -5
```

If installation fails, fall back to WebFetch (see Fallback section below).

### 2. Launch Command

```bash
# Detect runtime — prefer Node.js per decision
if which node > /dev/null 2>&1; then RUNTIME=node; elif which bun > /dev/null 2>&1; then RUNTIME=bun; else echo "Error: neither node nor bun found" && exit 1; fi

$RUNTIME -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // --- navigation + extraction (see sections 3–4) ---

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
"
```

### 3. Navigation

```js
// Inside the async IIFE above
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
// Allow JS to settle
await page.waitForTimeout(1500);
```

- Use `waitUntil: 'domcontentloaded'` for speed; upgrade to `'networkidle'` only if content is missing.
- Set `timeout: 30000` (30 s). On timeout, treat as graceful failure (see section 5).

### 4. Content Extraction

Extract content as **structured Markdown** optimized for LLM consumption (not raw HTML or flat text).

```js
// Convert DOM to Markdown inside the browser context — zero dependencies
let text = await page.evaluate(() => {
  // Remove noise elements
  const noise = 'nav, footer, header, aside, script, style, noscript, svg, [role="navigation"], [role="banner"], [role="contentinfo"], .cookie-banner, #cookie-consent';
  document.querySelectorAll(noise).forEach(el => el.remove());

  // Pick main content container
  const root = document.querySelector('main, article, [role="main"]') || document.body;

  function md(node, listDepth = 0) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes).map(c => md(c, listDepth)).join('');

    // Skip hidden elements
    if (node.getAttribute('aria-hidden') === 'true' || node.hidden) return '';

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = '#'.repeat(parseInt(tag[1]));
        const text = node.textContent.trim();
        return text ? '\n\n' + level + ' ' + text + '\n\n' : '';
      }
      case 'p': return '\n\n' + children().trim() + '\n\n';
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'strong': case 'b': { const t = children().trim(); return t ? '**' + t + '**' : ''; }
      case 'em': case 'i': { const t = children().trim(); return t ? '*' + t + '*' : ''; }
      case 'code': {
        const t = node.textContent;
        return node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre' ? t : '`' + t + '`';
      }
      case 'pre': {
        const code = node.querySelector('code');
        const lang = code ? (code.className.match(/language-(\w+)/)||[])[1] || '' : '';
        const t = (code || node).textContent.trim();
        return '\n\n```' + lang + '\n' + t + '\n```\n\n';
      }
      case 'a': {
        const href = node.getAttribute('href');
        const t = children().trim();
        return (href && t && !href.startsWith('#')) ? '[' + t + '](' + href + ')' : t;
      }
      case 'img': {
        const alt = node.getAttribute('alt') || '';
        return alt ? '[image: ' + alt + ']' : '';
      }
      case 'ul': case 'ol': return '\n\n' + children() + '\n';
      case 'li': {
        const indent = '  '.repeat(listDepth);
        const bullet = node.parentElement && node.parentElement.tagName.toLowerCase() === 'ol'
          ? (Array.from(node.parentElement.children).indexOf(node) + 1) + '. '
          : '- ';
        const content = Array.from(node.childNodes).map(c => {
          const t = c.tagName && (c.tagName.toLowerCase() === 'ul' || c.tagName.toLowerCase() === 'ol')
            ? md(c, listDepth + 1) : md(c, listDepth);
          return t;
        }).join('').trim();
        return indent + bullet + content + '\n';
      }
      case 'table': {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (!rows.length) return '';
        const matrix = rows.map(r => Array.from(r.querySelectorAll('th, td')).map(c => c.textContent.trim()));
        const cols = Math.max(...matrix.map(r => r.length));
        const widths = Array.from({length: cols}, (_, i) => Math.max(...matrix.map(r => (r[i]||'').length), 3));
        let out = '\n\n';
        matrix.forEach((row, ri) => {
          out += '| ' + Array.from({length: cols}, (_, i) => (row[i]||'').padEnd(widths[i])).join(' | ') + ' |\n';
          if (ri === 0) out += '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |\n';
        });
        return out + '\n';
      }
      case 'blockquote': return '\n\n> ' + children().trim().replace(/\n/g, '\n> ') + '\n\n';
      case 'dl': return '\n\n' + children() + '\n';
      case 'dt': return '**' + children().trim() + '**\n';
      case 'dd': return ': ' + children().trim() + '\n';
      case 'div': case 'section': case 'span': case 'figure': case 'figcaption':
        return children();
      default: return children();
    }
  }

  let result = md(root);
  // Collapse excessive whitespace
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
});

// Fallback if extraction is too short
if (!text || text.trim().length < 100) {
  text = await page.innerText('body').catch(() => '');
}

// Truncate to ~4000 tokens (~16000 chars) to stay within context budget
const MAX_CHARS = 16000;
if (text.length > MAX_CHARS) {
  text = text.slice(0, MAX_CHARS) + '\n\n[content truncated — use a more specific selector or paginate]';
}

console.log(text);
```

For interactive element inspection (e.g., browse-verify), use `locator.ariaSnapshot()` instead of `innerText`.

### 5. Graceful Failure

Detect and handle blocks without crashing:

```js
const title = await page.title();
const url   = page.url();

// Login wall
if (/sign.?in|log.?in|auth/i.test(title) || url.includes('/login')) {
  console.log(`[browse-fetch] Blocked by login wall at ${url}. Skipping.`);
  await browser.close();
  process.exit(0);
}

// CAPTCHA
const bodyText = await page.innerText('body').catch(() => '');
if (/captcha|robot|human verification/i.test(bodyText)) {
  console.log(`[browse-fetch] CAPTCHA detected at ${url}. Skipping.`);
  await browser.close();
  process.exit(0);
}
```

On graceful failure: return the URL and a short explanation, then continue with the task using available context.

### 6. Cleanup

Always close the browser in a `finally` block or after use:

```js
await browser.close();
```

---

## Fetch Workflow

**Goal:** retrieve and return structured Markdown content of a single URL.

The full inline script uses `page.evaluate()` to convert DOM → Markdown inside the browser (zero Node dependencies). Adapt the URL per query.

```bash
# Full inline script — adapt URL per query
if which node > /dev/null 2>&1; then RUNTIME=node; elif which bun > /dev/null 2>&1; then RUNTIME=bun; else echo "Error: neither node nor bun found" && exit 1; fi

$RUNTIME -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto('https://example.com/docs/page', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(1500);

    const title = await page.title();
    const url = page.url();

    if (/sign.?in|log.?in|auth/i.test(title) || url.includes('/login')) {
      console.log('[browse-fetch] Blocked by login wall at ' + url);
      return;
    }

    let text = await page.evaluate(() => {
      const noise = 'nav, footer, header, aside, script, style, noscript, svg, [role=\"navigation\"], [role=\"banner\"], [role=\"contentinfo\"], .cookie-banner, #cookie-consent';
      document.querySelectorAll(noise).forEach(el => el.remove());
      const root = document.querySelector('main, article, [role=\"main\"]') || document.body;

      function md(node, listDepth) {
        listDepth = listDepth || 0;
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType !== 1) return '';
        var tag = node.tagName.toLowerCase();
        var kids = function() { return Array.from(node.childNodes).map(function(c) { return md(c, listDepth); }).join(''); };
        if (node.getAttribute('aria-hidden') === 'true' || node.hidden) return '';
        switch (tag) {
          case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
            var level = '#'.repeat(parseInt(tag[1]));
            var t = node.textContent.trim();
            return t ? '\\n\\n' + level + ' ' + t + '\\n\\n' : '';
          case 'p': return '\\n\\n' + kids().trim() + '\\n\\n';
          case 'br': return '\\n';
          case 'hr': return '\\n\\n---\\n\\n';
          case 'strong': case 'b': var s = kids().trim(); return s ? '**' + s + '**' : '';
          case 'em': case 'i': var e = kids().trim(); return e ? '*' + e + '*' : '';
          case 'code':
            var ct = node.textContent;
            return node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre' ? ct : '\`' + ct + '\`';
          case 'pre':
            var codeEl = node.querySelector('code');
            var lang = codeEl ? ((codeEl.className.match(/language-(\\w+)/) || [])[1] || '') : '';
            var pt = (codeEl || node).textContent.trim();
            return '\\n\\n\`\`\`' + lang + '\\n' + pt + '\\n\`\`\`\\n\\n';
          case 'a':
            var href = node.getAttribute('href');
            var at = kids().trim();
            return (href && at && !href.startsWith('#')) ? '[' + at + '](' + href + ')' : at;
          case 'img':
            var alt = node.getAttribute('alt') || '';
            return alt ? '[image: ' + alt + ']' : '';
          case 'ul': case 'ol': return '\\n\\n' + kids() + '\\n';
          case 'li':
            var indent = '  '.repeat(listDepth);
            var bullet = node.parentElement && node.parentElement.tagName.toLowerCase() === 'ol'
              ? (Array.from(node.parentElement.children).indexOf(node) + 1) + '. ' : '- ';
            var content = Array.from(node.childNodes).map(function(c) {
              var tg = c.tagName && c.tagName.toLowerCase();
              return (tg === 'ul' || tg === 'ol') ? md(c, listDepth + 1) : md(c, listDepth);
            }).join('').trim();
            return indent + bullet + content + '\\n';
          case 'table':
            var rows = Array.from(node.querySelectorAll('tr'));
            if (!rows.length) return '';
            var matrix = rows.map(function(r) { return Array.from(r.querySelectorAll('th, td')).map(function(c) { return c.textContent.trim(); }); });
            var cols = Math.max.apply(null, matrix.map(function(r) { return r.length; }));
            var widths = Array.from({length: cols}, function(_, i) { return Math.max.apply(null, matrix.map(function(r) { return (r[i]||'').length; }).concat([3])); });
            var out = '\\n\\n';
            matrix.forEach(function(row, ri) {
              out += '| ' + Array.from({length: cols}, function(_, i) { return (row[i]||'').padEnd(widths[i]); }).join(' | ') + ' |\\n';
              if (ri === 0) out += '| ' + widths.map(function(w) { return '-'.repeat(w); }).join(' | ') + ' |\\n';
            });
            return out + '\\n';
          case 'blockquote': return '\\n\\n> ' + kids().trim().replace(/\\n/g, '\\n> ') + '\\n\\n';
          case 'dt': return '**' + kids().trim() + '**\\n';
          case 'dd': return ': ' + kids().trim() + '\\n';
          default: return kids();
        }
      }

      var result = md(root);
      return result.replace(/\\n{3,}/g, '\\n\\n').trim();
    });

    if (!text || text.trim().length < 100) {
      text = await page.innerText('body').catch(() => '');
    }

    const MAX_CHARS = 16000;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + '\n\n[content truncated]';
    }

    console.log('=== ' + title + ' ===\n' + text);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
"
```

The agent inlines the full script via `node -e` or `bun -e` so no temp files are needed for extractions under ~4000 tokens.

---

## Search + Navigation Protocol

**Time-box:** 60 seconds total. **Page cap:** 5 pages per query.

> Search engines (Google, DuckDuckGo) block headless browsers with CAPTCHAs. Do NOT use Playwright to search them.

Instead, use one of these strategies:

| Strategy | When to use |
|----------|-------------|
| Direct URL construction | You know the domain (e.g., `docs.stripe.com/api/charges`) |
| WebSearch tool | General keyword search before fetching pages |
| Site-specific search | Navigate to `site.com/search?q=term` if the site exposes it |

**Navigation loop** (up to 5 pages):

1. Construct or obtain the target URL.
2. Run the fetch workflow above.
3. If the page lacks the needed information, look for a next-page link or a more specific sub-URL.
4. Repeat up to 4 more times (5 total).
5. Stop and summarize what was found within the 60 s window.

---

## Session Cache

The context window is the cache. Extracted content lives in the conversation until it is no longer needed.

For extractions larger than ~4000 tokens, write to a temp file and reference it:

```bash
# Write large extraction to temp file
TMPFILE=$(mktemp /tmp/browse-fetch-XXXXXX.txt)
$RUNTIME -e "...script..." > "$TMPFILE"
echo "Content saved to $TMPFILE"
# Read relevant sections with grep or head rather than loading all at once
```

---

## Fallback Without Playwright

When Playwright is unavailable or fails to install, fall back to the WebFetch tool for:

- Static HTML sites (GitHub README, raw docs, Wikipedia)
- Any URL the user provides where JavaScript rendering is not required

| Condition | Action |
|-----------|--------|
| `playwright` not installed, install fails | Use WebFetch |
| Page is a known static domain (github.com/raw, pastebin, etc.) | Use WebFetch directly — skip Playwright |
| Playwright times out twice | Use WebFetch as fallback attempt |

```
WebFetch: { url: "https://example.com/page", prompt: "Extract the main content" }
```

If WebFetch also fails, return the URL with an explanation and continue the task.

---

## Rules

- Always run the install check before the first browser launch in a session.
- Detect runtime with `which bun` first; use `node` if bun is absent.
- Never navigate to Google or DuckDuckGo with Playwright — use WebSearch tool or direct URLs.
- Truncate output at ~4000 tokens (~16 000 chars) to protect context budget.
- On login wall or CAPTCHA, log the block, skip, and continue — never retry infinitely.
- Close the browser in every code path (use `finally`).
- Do not persist browser sessions across unrelated tasks.
