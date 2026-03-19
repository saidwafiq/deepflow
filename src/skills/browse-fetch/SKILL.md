---
name: browse-fetch
description: Fetches live web content using headless Chromium via Playwright. Use when you need to read documentation, articles, or any public URL that requires JavaScript rendering. Falls back to WebFetch for simple HTML pages.
context: fork
allowed-tools: [Bash, WebFetch, WebSearch, Read]
---

# Browse-Fetch

Retrieve live web content with a headless browser. Handles JS-rendered pages, SPAs, and dynamic content that WebFetch cannot reach.

**Use when:** URL requires JavaScript rendering (React-based docs, SPAs, portals).
**Skip when:** Plain HTML / GitHub raw file (use WebFetch) or auth-walled / CAPTCHA-blocked page.

---

## Browser Core Protocol

The fetch script below implements all steps. Summary of what each phase does:

1. **Runtime detection** — prefer `node`, fall back to `bun`.
2. **Install check** — `require('playwright')` or auto-install chromium via npx.
3. **Launch** — headless Chromium with desktop Chrome user-agent.
4. **Navigate** — `goto` with `domcontentloaded` (upgrade to `networkidle` if content missing), 30s timeout, 1.5s settle delay.
5. **Block detection** — check title/URL for login walls, body for CAPTCHA. On detection: log, skip, continue task.
6. **Extract** — `page.evaluate()` converts DOM → Markdown in-browser (zero deps). Strips noise elements (nav/footer/header/aside/scripts/cookies), picks `main|article|[role=main]|body`, recursive `md()` handles headings, lists, tables, code blocks, links, images, blockquotes, definition lists. Falls back to `page.innerText('body')` if extraction < 100 chars.
7. **Truncate** — cap at 16000 chars (~4000 tokens). Append `[content truncated]` marker.
8. **Cleanup** — always `browser.close()` in `finally`.

## Fetch Script

Inline via `$RUNTIME -e`. Adapt URL per query.

```bash
if which node > /dev/null 2>&1; then RUNTIME=node; elif which bun > /dev/null 2>&1; then RUNTIME=bun; else echo "Error: neither node nor bun found" && exit 1; fi

$RUNTIME -e "require('playwright')" 2>/dev/null \
  || npx --yes playwright install chromium --with-deps 2>&1 | tail -5

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

For interactive element inspection (e.g., browse-verify), use `locator.ariaSnapshot()` instead of DOM extraction.

---

## Search + Navigation Protocol

**Time-box:** 60s. **Page cap:** 5 pages per query.

Do NOT use Playwright for Google/DuckDuckGo (CAPTCHA). Instead:

| Strategy | When |
|----------|------|
| Direct URL construction | Domain is known (e.g., `docs.stripe.com/api/charges`) |
| WebSearch tool | General keyword search before fetching |
| Site-specific search | Site exposes `/search?q=term` |

Navigation loop: construct URL → fetch → if info missing, find next-page or sub-URL → repeat (max 5 pages) → summarize within 60s.

---

## Session Cache

Context window is the cache. For extractions > ~4000 tokens, write to temp file (`mktemp /tmp/browse-fetch-XXXXXX.txt`) and read relevant sections with grep/head.

---

## Fallback Without Playwright

| Condition | Action |
|-----------|--------|
| Playwright install fails | Use WebFetch |
| Known static domain (github raw, pastebin, wikipedia) | Use WebFetch directly, skip Playwright |
| Playwright times out twice | Use WebFetch as fallback |
| WebFetch also fails | Return URL with explanation, continue task |

---

## Rules

- Never navigate to Google/DuckDuckGo with Playwright — use WebSearch or direct URLs.
- On login wall or CAPTCHA: log, skip, continue. Never retry infinitely.
- Close browser in every code path (`finally` block).
- Do not persist browser sessions across unrelated tasks.
