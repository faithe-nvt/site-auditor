import { NextRequest } from 'next/server';
import Groq from 'groq-sdk';
import { crawlSite, type PageData } from '@/lib/crawler';

export const maxDuration = 120;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are a senior website QA analyst and SEO auditor. You will receive crawled data from a website and must produce a structured, direct audit report. No hedging, no filler — be specific and quote actual page copy as evidence.

BRAND RULES TO ENFORCE (these are specific to NVT — Neta Virtual Team):
- Australian English always: "colour" not "color", "labour" not "labor", "favour" not "favor", etc.
- No em dashes (—) anywhere in copy — flag every instance
- Tone must be punchy, direct, founder-benefit focused — flag any drift into generic corporate language
- NEVER use "hire" or "hiring" — must say "place", "placement", or "build a team" — flag every instance with exact quote
- NEVER call staff "virtual assistants" or "VA" — always "virtual professionals" — flag every instance with exact quote

OUTPUT FORMAT — use these exact section headings:

## Executive Summary
3–5 sentences. What's working, what's broken, single highest-impact fix. Be direct.

## Site Map Found
List every URL crawled, its HTTP status, and one-line status note.

## Findings by Category

### 1. Technical QA
Cover: tracking (GA4/Meta Pixel/GTM), heading hierarchy (only 1 H1 per page is correct), canonical tags, meta viewport, robots meta, sitemap coverage, broken pages (non-200 status), Open Graph tags.

### 2. SEO Audit
Cover: title tags (unique per page, under 60 chars, keyword-targeted), meta descriptions (unique per page, under 155 chars, includes CTA), H1 relevance to search intent, internal linking between pages, image alt text, sitemap completeness.

### 3. Conversion / Funnel QA
Cover: CTA clarity and hierarchy, form field count and friction, trust signals, value proposition placement, competing CTAs.

### 4. Voice & Brand Compliance
For EVERY violation found, quote the exact offending text and its URL. Check for: "hire/hiring", "virtual assistant/VA", em dashes, American spellings. Also flag tone drift.

Use severity labels: **[SEVERITY: Critical]**, **[SEVERITY: High]**, **[SEVERITY: Medium]**, **[SEVERITY: Low]**

## Actionable Steps

| Priority | Task | Page/Element | Why it matters | Effort |
|----------|------|--------------|----------------|--------|

Sort by impact. Label each row "2-Minute Task" or "Project" in the Effort column.

## What I Couldn't Verify
List what the crawl data doesn't cover and what tool/action would get it.`;

function formatSiteData(pages: PageData[], robotsTxt: string, sitemapUrls: string[]): string {
  const lines: string[] = [];

  lines.push(`=== ROBOTS.TXT ===\n${robotsTxt || '(not found)'}\n`);
  lines.push(`=== SITEMAP.XML URLS (${sitemapUrls.length} found) ===\n${sitemapUrls.join('\n') || '(not found)'}\n`);

  for (const p of pages) {
    lines.push(`
=== PAGE: ${p.url} (HTTP ${p.status}) ===
${p.error ? `ERROR: ${p.error}\n` : ''}
TITLE: "${p.title}" (${p.titleLength} chars) ${p.title ? '' : '[MISSING]'}
META DESCRIPTION: "${p.metaDescription}" (${p.metaDescriptionLength} chars) ${p.metaDescription ? '' : '[MISSING]'}
CANONICAL: ${p.canonical || '[MISSING]'}
ROBOTS META: ${p.robotsMeta || '[none — defaults to index/follow]'}
VIEWPORT META: ${p.viewportMeta || '[MISSING]'}
OG TITLE: ${p.ogTitle || '[MISSING]'}
OG DESCRIPTION: ${p.ogDescription || '[MISSING]'}
OG IMAGE: ${p.ogImage || '[MISSING]'}

TRACKING:
  GA4: ${p.tracking.ga4}
  Meta Pixel: ${p.tracking.pixel}
  GTM: ${p.tracking.gtm}

H1 TAGS (${p.h1s.length}): ${p.h1s.map(h => `"${h}"`).join(' | ') || '[NONE]'}
H2 TAGS (${p.h2s.length}): ${p.h2s.map(h => `"${h}"`).join(' | ') || '[NONE]'}
H3 TAGS (${p.h3s.length}): ${p.h3s.slice(0, 8).map(h => `"${h}"`).join(' | ') || '[NONE]'}

IMAGES (${p.images.length}):
${p.images.slice(0, 15).map(img => `  src="${img.src}" alt="${img.alt}"`).join('\n') || '  [none]'}

INTERNAL LINKS FOUND (${p.internalLinks.length}):
${p.internalLinks.slice(0, 20).join('\n') || '  [none]'}

BODY TEXT SAMPLE:
${p.bodyText}
`);
  }

  return lines.join('\n');
}

export async function POST(req: NextRequest) {
  const { url } = await req.json();

  if (!url || typeof url !== 'string') {
    return new Response('Missing url', { status: 400 });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));

      try {
        const { pages, robotsTxt, sitemapUrls } = await crawlSite(
          parsedUrl.href,
          (msg) => send(`[PROGRESS]${msg}\n`),
        );

        send(`[PROGRESS]Crawl complete. ${pages.length} pages found. Running AI audit...\n`);
        send('[REPORT_START]\n');

        const siteData = formatSiteData(pages, robotsTxt, sitemapUrls);

        const groqStream = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Audit this website: ${parsedUrl.href}\n\nHere is the crawled data:\n\n${siteData}`,
            },
          ],
          stream: true,
          max_tokens: 8000,
          temperature: 0.2,
        });

        for await (const chunk of groqStream) {
          const text = chunk.choices[0]?.delta?.content ?? '';
          if (text) send(text);
        }
      } catch (err) {
        send(`\n\n**Error:** ${String(err)}`);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
