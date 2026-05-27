# Requirements Document

## Introduction

Clawd is the public-facing brand for the NanoClaw cloud system — a multi-user WhatsApp AI assistant deployed on AWS. This feature introduces a public marketing landing page served at the root path (`/`) of the orchestrator, positioned before any authentication gate. The page communicates Clawd's value proposition to working professionals in Singapore using a "Premium Stationery" visual aesthetic: warm oatmeal backgrounds, chunky serif typography, hand-drawn doodle animations, and a single-column bullet-journal layout. The existing admin dashboard at `/admin` remains unchanged and protected by Basic Auth.

## Glossary

- **Orchestrator**: The Node.js HTTP server (`src/index.ts`) that handles all inbound requests on port 3000, routing to the landing page, admin dashboard, health check, or 404 responses.
- **Landing_Page**: The public-facing static HTML page served at the root path `/` without authentication, presenting Clawd's brand, features, and calls to action.
- **Admin_Dashboard**: The existing authenticated dashboard served at `/admin` requiring Bearer token authentication, used for system monitoring and management.
- **CTA**: Call To Action — a prominent interactive element (button or link) that directs visitors toward a conversion goal (e.g., opening WhatsApp or navigating to login).
- **Hero_Section**: The first visible section of the Landing_Page containing the primary headline, subheadline, and main CTA.
- **WhatsApp_Link**: A `wa.me` URL that opens a WhatsApp conversation with the Clawd assistant.
- **Scroll_Animation**: A CSS or JavaScript animation triggered when a page element enters the browser viewport during scrolling.
- **Semantic_HTML**: HTML markup that uses elements according to their meaning (e.g., `<nav>`, `<section>`, `<footer>`, `<h1>`) rather than generic `<div>` elements.

## Requirements

### Requirement 1: Public Route Serving

**User Story:** As a visitor, I want to access the Clawd landing page at the root URL without logging in, so that I can learn about the product before committing to sign up.

#### Acceptance Criteria

1. WHEN a GET request is received at path `/`, THE Orchestrator SHALL respond with the Landing_Page HTML content and HTTP status 200.
2. THE Orchestrator SHALL serve the Landing_Page without requiring any authentication headers or credentials.
3. WHEN a GET request is received at path `/admin`, THE Orchestrator SHALL require Bearer token authentication before serving the Admin_Dashboard.
4. WHEN a GET request is received at path `/health`, THE Orchestrator SHALL respond with a JSON health-check payload and HTTP status 200 without requiring authentication.
5. WHEN a request is received at any path not matching `/`, `/health`, `/admin`, or `/admin/**`, THE Orchestrator SHALL respond with HTTP status 404 and a JSON error body.

### Requirement 2: Hero Section

**User Story:** As a visitor, I want to immediately understand what Clawd does when I land on the page, so that I can decide whether to explore further.

#### Acceptance Criteria

1. THE Landing_Page SHALL display a Hero_Section as the first visible content area containing a primary headline, a subheadline, and a primary CTA.
2. THE Hero_Section SHALL display the product name "Clawd" in the primary headline.
3. THE Hero_Section SHALL display the value proposition "The AI assistant that actually gets to know you—organizing your life and learning your vibe with every interaction." as the subheadline.
4. THE Hero_Section SHALL display a primary CTA button labeled "Get Started" that links to the WhatsApp_Link.

### Requirement 3: Features Section

**User Story:** As a visitor, I want to see what Clawd can do for me, so that I understand the product's capabilities before signing up.

#### Acceptance Criteria

1. THE Landing_Page SHALL display a Features section containing exactly four feature items below the Hero_Section.
2. THE Features section SHALL include a feature titled "Remembers Everything" describing a personal knowledge base that grows with the user.
3. THE Features section SHALL include a feature titled "Document Intelligence" describing the ability to upload PDFs, ask questions, and receive cited answers.
4. THE Features section SHALL include a feature titled "Daily Briefings" describing morning summaries of information relevant to the user.
5. THE Features section SHALL include a feature titled "Always Available" describing WhatsApp-native access with no app download required.
6. WHEN the Features section is rendered, THE Landing_Page SHALL display an icon or illustration alongside each feature item.

### Requirement 4: How It Works Section

**User Story:** As a visitor, I want to understand how simple it is to use Clawd, so that I feel confident the onboarding process is easy.

#### Acceptance Criteria

1. THE Landing_Page SHALL display a "How It Works" section containing exactly three sequential steps.
2. THE "How It Works" section SHALL present the steps in this order: "Send a message", "Clawd learns", "Ask anything".
3. WHEN the "How It Works" section is rendered, THE Landing_Page SHALL visually indicate the sequential progression between steps using numbered indicators or connecting elements.

### Requirement 5: Social Proof Section

**User Story:** As a visitor, I want to see that other people trust and use Clawd, so that I feel more confident about trying it.

#### Acceptance Criteria

1. THE Landing_Page SHALL display a testimonials or social proof section below the "How It Works" section.
2. THE social proof section SHALL contain placeholder content structured to accommodate future testimonial quotes with attribution.

### Requirement 6: Pricing Section

**User Story:** As a visitor, I want to understand the cost of using Clawd, so that I can decide whether it fits my budget.

#### Acceptance Criteria

1. THE Landing_Page SHALL display a Pricing section presenting available tiers.
2. THE Pricing section SHALL present a "Free Trial" tier describing the no-cost introductory offering.
3. THE Pricing section SHALL present a "Pro" tier describing the paid plan with expanded capabilities.
4. WHEN a visitor interacts with a pricing tier CTA, THE Landing_Page SHALL direct the visitor to the WhatsApp_Link or a sign-up flow.

### Requirement 7: Footer

**User Story:** As a visitor, I want to access legal and navigational links from any scroll position, so that I can find privacy policies, terms, and other pages.

#### Acceptance Criteria

1. THE Landing_Page SHALL display a footer section at the bottom of the page.
2. THE footer SHALL contain a link to a Privacy Policy page.
3. THE footer SHALL contain a link to a Terms of Service page.
4. THE footer SHALL contain navigational links to the major sections of the Landing_Page.

### Requirement 8: Secondary Navigation CTA

**User Story:** As an existing user, I want a clear path from the landing page to the admin dashboard, so that I can log in without memorizing the `/admin` URL.

#### Acceptance Criteria

1. THE Landing_Page SHALL display a "Login" button or link that navigates to the `/admin` path.
2. THE "Login" navigation element SHALL be visible in the page header or navigation area without requiring scrolling.

### Requirement 9: Visual Design — Premium Stationery Aesthetic

**User Story:** As a visitor, I want the page to feel warm, personal, and tactile, so that I associate Clawd with a cozy, premium experience rather than a cold tech product.

#### Acceptance Criteria

1. THE Landing_Page SHALL use a warm oatmeal or parchment background color (hex value in the range of `#F5F0E8`).
2. THE Landing_Page SHALL use a chunky serif typeface (such as Playfair Display or Lora) for all heading elements.
3. THE Landing_Page SHALL use a clean sans-serif typeface (such as Inter or DM Sans) for all body text.
4. THE Landing_Page SHALL use a deep espresso color (hex value in the range of `#3D2B1F`) for primary text.
5. THE Landing_Page SHALL use a dusty mustard accent color (hex value in the range of `#C4A35A`) for highlights, CTA buttons, and interactive elements.
6. THE Landing_Page SHALL constrain content to a single-column layout with a maximum width of approximately 720 pixels, centered horizontally.
7. THE Landing_Page SHALL display hand-drawn SVG dividers between major content sections.

### Requirement 10: Scroll-Triggered Animations

**User Story:** As a visitor, I want subtle playful animations as I scroll, so that the page feels alive and engaging without being distracting.

#### Acceptance Criteria

1. WHEN a heading element scrolls into the viewport, THE Landing_Page SHALL trigger a highlighter-swipe animation over key text using the dusty mustard accent color.
2. WHEN the "How It Works" section scrolls into the viewport, THE Landing_Page SHALL trigger hand-drawn doodle arrow animations connecting the steps.
3. WHEN a CTA button scrolls into the viewport, THE Landing_Page SHALL display a washi-tape accent decoration on or around the button.
4. THE Landing_Page SHALL implement all Scroll_Animations using CSS transitions or lightweight vanilla JavaScript without requiring a heavy animation framework.

### Requirement 11: Mobile Responsiveness

**User Story:** As a mobile user (the primary WhatsApp audience), I want the landing page to render correctly on my phone, so that I can read and interact with it comfortably.

#### Acceptance Criteria

1. THE Landing_Page SHALL render correctly on viewport widths from 320 pixels to 1440 pixels.
2. WHEN the viewport width is below 768 pixels, THE Landing_Page SHALL adjust typography, spacing, and interactive element sizes for comfortable touch interaction.
3. THE Landing_Page SHALL set the viewport meta tag to `width=device-width, initial-scale=1`.

### Requirement 12: Technical Implementation Constraints

**User Story:** As a developer, I want the landing page to be lightweight and dependency-free, so that it loads fast and does not complicate the build pipeline.

#### Acceptance Criteria

1. THE Landing_Page SHALL be implemented as static HTML, CSS, and JavaScript files served directly by the Orchestrator.
2. THE Landing_Page SHALL NOT depend on a frontend framework (React, Vue, Angular, or similar).
3. THE Landing_Page SHALL load without requiring any build step beyond the existing TypeScript compilation of the Orchestrator.
4. WHERE Tailwind CSS is used, THE Landing_Page SHALL include it via CDN or pre-compiled stylesheet without adding a build-time dependency to the Orchestrator.

### Requirement 13: SEO and Metadata

**User Story:** As a marketer, I want the landing page to be discoverable by search engines and render rich previews when shared, so that organic traffic and social sharing drive sign-ups.

#### Acceptance Criteria

1. THE Landing_Page SHALL include a `<title>` element containing the product name "Clawd" and a concise description.
2. THE Landing_Page SHALL include `<meta name="description">` with a summary of the product value proposition.
3. THE Landing_Page SHALL include Open Graph meta tags (`og:title`, `og:description`, `og:image`, `og:url`).
4. THE Landing_Page SHALL use Semantic_HTML elements including `<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`, and appropriate heading hierarchy (`<h1>` through `<h3>`).
5. THE Landing_Page SHALL contain exactly one `<h1>` element.

### Requirement 14: Performance

**User Story:** As a visitor on a mobile connection, I want the page to load quickly, so that I do not abandon it before seeing the content.

#### Acceptance Criteria

1. THE Landing_Page SHALL achieve a total page weight (HTML + CSS + JS + fonts + images) below 500 KB on initial load.
2. THE Landing_Page SHALL NOT load any JavaScript framework exceeding 50 KB gzipped.
3. WHEN web fonts are used, THE Landing_Page SHALL load them with `font-display: swap` to prevent invisible text during font loading.
