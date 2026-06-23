import * as cheerio from 'cheerio';

export interface PageData {
  url: string;
  status: number;
  title: string;
  titleLength: number;
  metaDescription: string;
  metaDescriptionLength: number;
  canonical: string;
  robotsMeta: string;
  viewportMeta: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  h1s: string[];
  h2s: string[];
  h3s: string[];
  images: { src: string; alt: string }[];
  internalLinks: string[];
  externalLinks: string[];
  tracking: { ga4: string; pixel: string; gtm: string };
  bodyText: string;
  error?: string;
}

export interface CrawlResult {
  pages: PageData[];
  robotsTxt: string;
  sitemapUrls: string[];
}

const BODY_TEXT_LIMIT = 3000;
const MAX_PAGES = 30;
const FETCH_TIMEOUT = 12000;

function normalise(href: string, base: URL): string | null {
  try {
    const u = new URL(href, base.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.hostname !== base.hostname) return null;
    return u.origin + u.pathname.replace(/\/$/, '') || '/';
  } catch {
    return null;
  }
}

async function fetchHtml(url: string): Promise<{ html: string; status: number }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditor/1.0)',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    redirect: 'follow',
  });
  const html = await res.text();
  return { html, status: res.status };
}

async function parsePage(url: string, base: URL): Promise<PageData> {
  let html = '';
  let status = 0;

  try {
    const result = await fetchHtml(url);
    html = result.html;
    status = result.status;
  } catch (err) {
    return {
      url, status: 0, title: '', titleLength: 0,
      metaDescription: '', metaDescriptionLength: 0,
      canonical: '', robotsMeta: '', viewportMeta: '',
      ogTitle: '', ogDescription: '', ogImage: '',
      h1s: [], h2s: [], h3s: [], images: [],
      internalLinks: [], externalLinks: [],
      tracking: { ga4: 'fetch-error', pixel: 'fetch-error', gtm: 'fetch-error' },
      bodyText: '', error: String(err),
    };
  }

  const $ = cheerio.load(html);

  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? '';
  const canonical = $('link[rel="canonical"]').attr('href')?.trim() ?? '';
  const robotsMeta = $('meta[name="robots"]').attr('content')?.trim() ?? '';
  const viewportMeta = $('meta[name="viewport"]').attr('content')?.trim() ?? '';
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() ?? '';
  const ogDescription = $('meta[property="og:description"]').attr('content')?.trim() ?? '';
  const ogImage = $('meta[property="og:image"]').attr('content')?.trim() ?? '';

  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h3s = $('h3').map((_, el) => $(el).text().trim()).get().filter(Boolean);

  const images = $('img').map((_, el) => ({
    src: $(el).attr('src') ?? '',
    alt: $(el).attr('alt') ?? '[MISSING]',
  })).get();

  // Tracking detection — check both inline scripts and src attributes
  const allScripts = $('script').map((_, el) => ($(el).html() ?? '') + ' ' + ($(el).attr('src') ?? '')).get().join(' ');
  const ga4 = /G-[A-Z0-9]{6,}/.test(allScripts) || /gtag\s*\(/.test(allScripts) ? 'Found' : 'Not found';
  const pixel = /fbq\s*\(/.test(allScripts) || /facebook\.net\/en_US\/fbevents/.test(allScripts) ? 'Found' : 'Not found';
  const gtm = /GTM-[A-Z0-9]+/.test(allScripts) || /googletagmanager\.com\/gtm\.js/.test(allScripts) ? 'Found' : 'Not found';

  const internalLinks: string[] = [];
  const externalLinks: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const resolved = normalise(href, base);
    if (resolved) {
      if (!internalLinks.includes(resolved)) internalLinks.push(resolved);
    } else {
      try {
        const u = new URL(href, base.href);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== base.hostname) {
          if (!externalLinks.includes(u.href)) externalLinks.push(u.href);
        }
      } catch { /* skip */ }
    }
  });

  $('script, style, noscript, nav, footer, header').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, BODY_TEXT_LIMIT);

  return {
    url, status, title, titleLength: title.length,
    metaDescription, metaDescriptionLength: metaDescription.length,
    canonical, robotsMeta, viewportMeta,
    ogTitle, ogDescription, ogImage,
    h1s, h2s, h3s, images,
    internalLinks, externalLinks,
    tracking: { ga4, pixel, gtm },
    bodyText,
  };
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditor/1.0)' },
    });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

function parseSitemap(xml: string, base: URL): string[] {
  const urls: string[] = [];
  const matches = xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi);
  for (const m of matches) {
    const resolved = normalise(m[1], base);
    if (resolved) urls.push(resolved);
  }
  return [...new Set(urls)];
}

export async function crawlSite(
  startUrl: string,
  onProgress: (msg: string) => void,
): Promise<CrawlResult> {
  const base = new URL(startUrl);
  const origin = base.origin;
  const rootUrl = origin + (base.pathname.replace(/\/$/, '') || '');

  onProgress('Fetching robots.txt and sitemap...');
  const [robotsTxt, sitemapXml] = await Promise.all([
    fetchText(`${origin}/robots.txt`),
    fetchText(`${origin}/sitemap.xml`),
  ]);

  const sitemapUrls = parseSitemap(sitemapXml, base);

  // Seed queue with root + sitemap URLs
  const seen = new Set<string>();
  const queue: string[] = [rootUrl, ...sitemapUrls].filter(u => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  const pages: PageData[] = [];

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const url = queue.shift()!;
    onProgress(`Crawling page ${pages.length + 1}: ${url}`);

    const page = await parsePage(url, base);
    pages.push(page);

    // Enqueue new internal links found on this page
    for (const link of page.internalLinks) {
      if (!seen.has(link)) {
        seen.add(link);
        queue.push(link);
      }
    }
  }

  onProgress(`Done — crawled ${pages.length} pages.`);
  return { pages, robotsTxt, sitemapUrls };
}
