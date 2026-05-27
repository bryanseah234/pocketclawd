# Implementation Plan: Clawd Landing Page

## Overview

Implement a public marketing landing page for Clawd served at `GET /` on the orchestrator. The page uses a "Premium Stationery" visual aesthetic (oatmeal background, chunky serif typography, hand-drawn SVG doodles, single-column bullet-journal layout). It is built as a static HTML template literal in TypeScript — matching the existing admin dashboard pattern — with embedded CSS and vanilla JS for scroll animations. No frontend framework or additional build step.

## Tasks

- [x] 1. Create landing page module structure and content data
  - [x] 1.1 Create `src/cloud/landing-page/content.ts` with all copy and content constants
    - Define and export `HERO_HEADLINE`, `HERO_SUBHEADLINE`, `HERO_CTA_LABEL`, `WHATSAPP_LINK`
    - Define and export `FEATURES` array (4 items: "Remembers Everything", "Document Intelligence", "Daily Briefings", "Always Available") with inline SVG icons
    - Define and export `HOW_IT_WORKS_STEPS` array (3 steps: "Send a message", "Clawd learns", "Ask anything")
    - Define and export `PRICING_TIERS` array (2 tiers: "Free Trial" and "Pro") with CTA links to WhatsApp
    - Define and export `FOOTER_LINKS` array (Privacy Policy, Terms of Service, section anchors)
    - Export TypeScript interfaces: `FeatureItem`, `HowItWorksStep`, `PricingTier`
    - _Requirements: 2.1–2.4, 3.1–3.6, 4.1–4.3, 5.1–5.2, 6.1–6.4, 7.1–7.4_

  - [x] 1.2 Create `src/cloud/landing-page/html.ts` with the full HTML template literal
    - Export `getLandingPageHtml(): string` function returning the complete HTML document
    - Include `<head>` with viewport meta, title containing "Clawd", meta description, Open Graph tags (`og:title`, `og:description`, `og:image`, `og:url`)
    - Use semantic HTML: `<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`, single `<h1>`
    - Include "Login" link in the `<nav>` area with `href="/admin"`
    - Embed CSS custom properties: `--bg-oatmeal: #F5F0E8`, `--text-espresso: #3D2B1F`, `--accent-mustard: #C4A35A`, `--font-heading: 'Playfair Display', serif`, `--font-body: 'Inter', sans-serif`, `--max-width: 720px`
    - Load Google Fonts (Playfair Display, Inter) with `font-display: swap`
    - Implement single-column layout constrained to ~720px centered
    - Include responsive media query for viewport < 768px
    - Render Hero section with headline, subheadline, and "Get Started" CTA button linking to WhatsApp
    - Render Features section with 4 feature items and inline SVG icons
    - Render "How It Works" section with 3 numbered steps and connecting visual elements
    - Render Social Proof section with placeholder testimonial structure
    - Render Pricing section with "Free Trial" and "Pro" tiers and CTA buttons
    - Render Footer with Privacy Policy link, Terms of Service link, and section navigation links
    - Include inline hand-drawn SVG dividers between major sections
    - Include vanilla JS for scroll-triggered animations using `IntersectionObserver`:
      - Highlighter-swipe animation on headings using mustard accent
      - Hand-drawn doodle arrow animations in "How It Works" section
      - Washi-tape accent decoration on CTA buttons
    - Ensure total HTML output stays under 500KB
    - _Requirements: 2.1–2.4, 3.1–3.6, 4.1–4.3, 5.1–5.2, 6.1–6.4, 7.1–7.4, 8.1–8.2, 9.1–9.7, 10.1–10.4, 11.1–11.3, 12.1–12.4, 13.1–13.5, 14.1–14.3_

  - [x] 1.3 Create `src/cloud/landing-page/index.ts` with the request handler
    - Export `handleLandingPageRequest(req, res): boolean` function
    - Check that `req.url === '/'` and `req.method === 'GET'`
    - If matched: call `getLandingPageHtml()`, respond with status 200 and `Content-Type: text/html`, return `true`
    - If not matched: return `false`
    - No authentication required
    - _Requirements: 1.1, 1.2, 12.1–12.3_

- [x] 2. Integrate landing page route into the orchestrator
  - [x] 2.1 Modify `src/index.ts` to add the `GET /` route before existing routes
    - In the `http.createServer` callback, add a check for `GET /` as the first route (before `/health` and admin)
    - Dynamically import `./cloud/landing-page/index.js` and call `handleLandingPageRequest`
    - If handled, return early; otherwise fall through to existing routes
    - Ensure `/health`, `/admin`, and 404 routes remain unchanged
    - _Requirements: 1.1–1.5_

- [x] 3. Checkpoint - Verify route integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Write tests for the landing page
  - [x] 4.1 Create `src/cloud/landing-page/landing-page.test.ts` with HTML structure and route handler tests
    - Test `getLandingPageHtml()` output contains semantic elements: `<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`
    - Test exactly one `<h1>` element exists
    - Test hero section contains "Clawd" in headline, value proposition subheadline, and "Get Started" CTA
    - Test features section contains exactly 4 items with correct titles
    - Test "How It Works" section has 3 steps in correct order
    - Test pricing section has "Free Trial" and "Pro" tiers
    - Test footer contains Privacy Policy and Terms of Service links
    - Test Login link with `href="/admin"` exists in nav area
    - Test viewport meta tag is set to `width=device-width, initial-scale=1`
    - Test Open Graph meta tags are present (`og:title`, `og:description`, `og:image`, `og:url`)
    - Test `<title>` contains "Clawd"
    - Test CSS contains design tokens: `#F5F0E8`, `#3D2B1F`, `#C4A35A`, `720px`, `font-display: swap`
    - Test media query for viewport < 768px exists
    - Test HTML output byte length < 500KB
    - Test `handleLandingPageRequest` returns true and responds 200 with `text/html` for `GET /`
    - Test `handleLandingPageRequest` returns false for `POST /`
    - Test `GET /` does not require authentication headers
    - _Requirements: 1.1–1.2, 2.1–2.4, 3.1–3.5, 4.1–4.2, 6.1–6.3, 7.1–7.3, 8.1–8.2, 9.1–9.6, 11.3, 13.1–13.5, 14.1, 14.3_

  - [x] 4.2 Write property-based test for unknown route 404 behavior
    - **Property 1: Unknown routes return 404**
    - Generate random URL path strings (excluding `/`, `/health`, and paths starting with `/admin`)
    - Verify all generated paths return HTTP 404 with a JSON body containing an `error` field
    - Use `fast-check` with minimum 100 iterations
    - **Validates: Requirements 1.5**

- [x] 5. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- The landing page follows the same template-literal pattern as `src/cloud/admin-dashboard/html.ts`
- Property test validates the universal routing correctness property from the design
- Unit tests validate specific HTML structure and content requirements
- All code is TypeScript, matching the existing project

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["4.1", "4.2"] }
  ]
}
```
