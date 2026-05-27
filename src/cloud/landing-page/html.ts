/**
 * Clawd Landing Page HTML — static marketing page served as a template literal.
 * No build step required. Uses embedded CSS, inline SVGs, and vanilla JS
 * for scroll-triggered animations.
 *
 * Visual aesthetic: "Premium Stationery" — warm oatmeal backgrounds,
 * chunky serif typography (Playfair Display), hand-drawn SVG doodle animations,
 * single-column bullet-journal layout constrained to ~720px.
 *
 * Requirements: 2.1–2.4, 3.1–3.6, 4.1–4.3, 5.1–5.2, 6.1–6.4, 7.1–7.4,
 *              8.1–8.2, 9.1–9.7, 10.1–10.4, 11.1–11.3, 12.1–12.4, 13.1–13.5, 14.1–14.3
 */

import {
    HERO_HEADLINE,
    HERO_SUBHEADLINE,
    FEATURES,
    HOW_IT_WORKS_STEPS,
    PRICING_TIERS,
    FOOTER_LINKS,
} from './content.js';

/**
 * Returns the complete landing page HTML string.
 * Includes embedded CSS, inline SVGs, and vanilla JS for scroll animations.
 */
export function getLandingPageHtml(opts?: { waPhone?: string; waConnected?: boolean }): string {
    const DEFAULT_PHONE = '6581234567';
    const phone = opts?.waPhone ?? DEFAULT_PHONE;
    const waConnected = opts?.waConnected ?? false;
    const waLink = `https://wa.me/${phone}?text=Hi%20Clawd!`;
    const ctaLabel = waConnected ? 'Chat with Clawd on WhatsApp' : 'Get Early Access';
    const heroBadge = waConnected
        ? `<span class="status-badge status-live">● Live</span>`
        : `<span class="status-badge status-coming-soon">Coming Soon</span>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Clawd — Your AI Assistant That Gets to Know You</title>
    <meta name="description" content="Meet Clawd: the AI assistant that actually gets to know you. Organizing your life and learning your vibe with every interaction. Available on WhatsApp.">
    <meta property="og:title" content="Clawd — Your AI Assistant That Gets to Know You">
    <meta property="og:description" content="The AI assistant that actually gets to know you — organizing your life and learning your vibe with every interaction.">
    <meta property="og:image" content="/og-image.png">
    <meta property="og:url" content="https://clawd.ai">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg-oatmeal: #F5F0E8;
            --text-espresso: #3D2B1F;
            --accent-mustard: #C4A35A;
            --font-heading: 'Playfair Display', serif;
            --font-body: 'Inter', sans-serif;
            --max-width: 720px;
        }

        body {
            font-family: var(--font-body);
            background: var(--bg-oatmeal);
            color: var(--text-espresso);
            line-height: 1.7;
            min-height: 100vh;
            -webkit-font-smoothing: antialiased;
        }

        .container {
            max-width: var(--max-width);
            margin: 0 auto;
            padding: 0 24px;
        }

        /* ─── Typography ─────────────────────────────────────── */
        h1, h2, h3 {
            font-family: var(--font-heading);
            font-weight: 800;
            line-height: 1.2;
        }

        h1 { font-size: 3rem; }
        h2 { font-size: 2rem; margin-bottom: 1rem; }
        h3 { font-size: 1.25rem; }

        p { margin-bottom: 1rem; }

        /* ─── Header / Nav ───────────────────────────────────── */
        header {
            padding: 20px 0;
            border-bottom: 1px solid rgba(61, 43, 31, 0.1);
        }

        nav {
            display: flex;
            align-items: center;
            justify-content: space-between;
            max-width: var(--max-width);
            margin: 0 auto;
            padding: 0 24px;
        }

        .nav-brand {
            font-family: var(--font-heading);
            font-size: 1.5rem;
            font-weight: 900;
            color: var(--text-espresso);
            text-decoration: none;
        }

        .nav-login {
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-espresso);
            text-decoration: none;
            padding: 8px 16px;
            border: 1.5px solid var(--text-espresso);
            border-radius: 4px;
            transition: background 0.2s, color 0.2s;
        }

        .nav-login:hover {
            background: var(--text-espresso);
            color: var(--bg-oatmeal);
        }

        /* ─── Sections ───────────────────────────────────────── */
        section {
            padding: 80px 0;
        }

        /* ─── Hero ───────────────────────────────────────────── */
        .hero {
            text-align: center;
            padding: 100px 0 80px;
        }

        .hero h1 {
            margin-bottom: 1.5rem;
            position: relative;
            display: inline-block;
        }

        .hero-subheadline {
            font-size: 1.125rem;
            color: rgba(61, 43, 31, 0.8);
            max-width: 560px;
            margin: 0 auto 2.5rem;
        }

        /* ─── CTA Buttons ────────────────────────────────────── */
        .cta-btn {
            display: inline-block;
            padding: 16px 36px;
            background: var(--accent-mustard);
            color: #fff;
            font-family: var(--font-body);
            font-size: 1rem;
            font-weight: 600;
            text-decoration: none;
            border-radius: 4px;
            border: none;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            position: relative;
        }

        .cta-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(196, 163, 90, 0.4);
        }

        .cta-btn-outline {
            background: transparent;
            color: var(--accent-mustard);
            border: 2px solid var(--accent-mustard);
        }

        .cta-btn-outline:hover {
            background: var(--accent-mustard);
            color: #fff;
        }

        /* ─── Washi-tape decoration on CTA ───────────────────── */
        .washi-tape {
            position: relative;
        }

        .washi-tape::before {
            content: '';
            position: absolute;
            top: -6px;
            left: -10px;
            right: -10px;
            bottom: -6px;
            border: 2px dashed var(--accent-mustard);
            border-radius: 2px;
            opacity: 0;
            transform: rotate(-1deg);
            transition: opacity 0.6s ease;
            pointer-events: none;
        }

        .washi-tape.visible::before {
            opacity: 0.6;
        }

        /* ─── Highlighter swipe animation ────────────────────── */
        .highlight-swipe {
            position: relative;
            display: inline;
        }

        .highlight-swipe::after {
            content: '';
            position: absolute;
            left: -4px;
            right: -4px;
            bottom: 0.1em;
            height: 0.35em;
            background: var(--accent-mustard);
            opacity: 0.3;
            transform: scaleX(0);
            transform-origin: left;
            transition: transform 0.8s cubic-bezier(0.22, 1, 0.36, 1);
            z-index: -1;
            border-radius: 2px;
        }

        .highlight-swipe.visible::after {
            transform: scaleX(1);
        }

        /* ─── Features ───────────────────────────────────────── */
        .features-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 32px;
        }

        .feature-item {
            padding: 24px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.5);
            border: 1px solid rgba(61, 43, 31, 0.08);
            transition: transform 0.2s;
        }

        .feature-item:hover {
            transform: translateY(-2px);
        }

        .feature-icon {
            color: var(--accent-mustard);
            margin-bottom: 12px;
        }

        .feature-item h3 {
            margin-bottom: 8px;
        }

        .feature-item p {
            font-size: 0.9rem;
            color: rgba(61, 43, 31, 0.75);
            margin-bottom: 0;
        }

        /* ─── How It Works ───────────────────────────────────── */
        .steps-container {
            display: flex;
            flex-direction: column;
            gap: 48px;
            position: relative;
        }

        .step {
            display: flex;
            align-items: flex-start;
            gap: 24px;
            position: relative;
        }

        .step-number {
            flex-shrink: 0;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: var(--accent-mustard);
            color: #fff;
            font-family: var(--font-heading);
            font-size: 1.25rem;
            font-weight: 800;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .step-content h3 {
            margin-bottom: 4px;
        }

        .step-content p {
            font-size: 0.9rem;
            color: rgba(61, 43, 31, 0.75);
            margin-bottom: 0;
        }

        /* Doodle arrow connector */
        .doodle-arrow {
            position: absolute;
            left: 23px;
            top: 56px;
            width: 2px;
            height: calc(100% - 8px);
            opacity: 0;
            transition: opacity 0.6s ease;
        }

        .doodle-arrow.visible {
            opacity: 1;
        }

        .doodle-arrow svg {
            width: 100%;
            height: 100%;
        }

        /* ─── Social Proof ───────────────────────────────────── */
        .testimonials {
            text-align: center;
        }

        .testimonial-card {
            background: rgba(255, 255, 255, 0.6);
            border: 1px solid rgba(61, 43, 31, 0.08);
            border-radius: 8px;
            padding: 32px;
            margin-top: 24px;
            font-style: italic;
            position: relative;
        }

        .testimonial-card::before {
            content: '\\201C';
            font-family: var(--font-heading);
            font-size: 4rem;
            color: var(--accent-mustard);
            opacity: 0.4;
            position: absolute;
            top: 8px;
            left: 20px;
            line-height: 1;
        }

        .testimonial-quote {
            font-size: 1.05rem;
            margin-bottom: 16px;
            color: rgba(61, 43, 31, 0.85);
        }

        .testimonial-author {
            font-style: normal;
            font-weight: 600;
            font-size: 0.875rem;
            color: var(--text-espresso);
        }

        /* ─── Pricing ────────────────────────────────────────── */
        .pricing-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            margin-top: 32px;
        }

        .pricing-card {
            background: rgba(255, 255, 255, 0.6);
            border: 1px solid rgba(61, 43, 31, 0.1);
            border-radius: 8px;
            padding: 32px;
            text-align: center;
            transition: transform 0.2s;
        }

        .pricing-card:hover {
            transform: translateY(-2px);
        }

        .pricing-card.highlighted {
            border-color: var(--accent-mustard);
            box-shadow: 0 4px 20px rgba(196, 163, 90, 0.2);
        }

        .pricing-name {
            font-family: var(--font-heading);
            font-size: 1.25rem;
            font-weight: 800;
            margin-bottom: 4px;
        }

        .pricing-price {
            font-size: 2rem;
            font-weight: 700;
            color: var(--accent-mustard);
            margin-bottom: 8px;
        }

        .pricing-desc {
            font-size: 0.875rem;
            color: rgba(61, 43, 31, 0.7);
            margin-bottom: 16px;
        }

        .pricing-features {
            list-style: none;
            text-align: left;
            margin-bottom: 24px;
        }

        .pricing-features li {
            font-size: 0.875rem;
            padding: 6px 0;
            border-bottom: 1px solid rgba(61, 43, 31, 0.06);
            position: relative;
            padding-left: 20px;
        }

        .pricing-features li::before {
            content: '\\2713';
            position: absolute;
            left: 0;
            color: var(--accent-mustard);
            font-weight: 700;
        }

        /* ─── SVG Dividers ───────────────────────────────────── */
        .section-divider {
            display: block;
            width: 100%;
            max-width: 200px;
            margin: 0 auto;
            height: 24px;
            opacity: 0.4;
        }

        /* ─── Footer ─────────────────────────────────────────── */
        footer {
            padding: 48px 0 32px;
            border-top: 1px solid rgba(61, 43, 31, 0.1);
            text-align: center;
        }

        .footer-links {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 24px;
            margin-bottom: 24px;
        }

        .footer-links a {
            font-size: 0.875rem;
            color: rgba(61, 43, 31, 0.7);
            text-decoration: none;
            transition: color 0.2s;
        }

        .footer-links a:hover {
            color: var(--accent-mustard);
        }

        .footer-copy {
            font-size: 0.75rem;
            color: rgba(61, 43, 31, 0.5);
        }

        /* ─── Responsive ─────────────────────────────────────── */
        @media (max-width: 768px) {
            h1 { font-size: 2.25rem; }
            h2 { font-size: 1.5rem; }

            section { padding: 56px 0; }

            .hero { padding: 64px 0 56px; }

            .features-grid {
                grid-template-columns: 1fr;
                gap: 20px;
            }

            .pricing-grid {
                grid-template-columns: 1fr;
                gap: 20px;
            }

            .step { gap: 16px; }

            .cta-btn {
                padding: 14px 28px;
                font-size: 0.9rem;
            }

            .nav-brand { font-size: 1.25rem; }
        }
    
        /* ─── Section heading centering ─────────────────────── */
        .section-heading {
            text-align: center;
            margin-bottom: 2rem;
        }

        /* ─── Status badge ────────────────────────────────────── */
        .status-badge {
            display: inline-block;
            font-family: var(--font-body);
            font-size: 0.75rem;
            font-weight: 600;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            padding: 4px 12px;
            border-radius: 100px;
            margin-bottom: 1rem;
        }
        .status-live {
            background: rgba(34, 197, 94, 0.12);
            color: #16a34a;
            border: 1px solid rgba(34, 197, 94, 0.3);
        }
        .status-coming-soon {
            background: rgba(196, 163, 90, 0.12);
            color: var(--accent-mustard);
            border: 1px solid rgba(196, 163, 90, 0.3);
        }

        </style>
</head>
<body>
    <header>
        <nav>
            <a href="/" class="nav-brand">Clawd</a>
            <a href="/admin" class="nav-login">Login</a>
        </nav>
    </header>

    <main>
        <!-- Hero Section -->
        <section class="hero" id="hero">
            <div class="container">
                ${heroBadge}
                <h1 class="highlight-swipe">${HERO_HEADLINE}</h1>
                <p class="hero-subheadline">${HERO_SUBHEADLINE}</p>
                <a href="${waLink}" class="cta-btn washi-tape">${ctaLabel}</a>
            </div>
        </section>

        <!-- Hand-drawn divider -->
        <svg class="section-divider" viewBox="0 0 200 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 12 C 30 4, 50 20, 80 12 S 130 4, 160 12 S 185 20, 198 12" stroke="#3D2B1F" stroke-width="1.5" stroke-linecap="round" fill="none" opacity="0.3"/>
        </svg>

        <!-- Features Section -->
        <section id="features">
            <div class="container">
                <h2 class="highlight-swipe section-heading">What Clawd Does For You</h2>
                <div class="features-grid">
                    ${FEATURES.map(
        (f) => `<div class="feature-item">
                        <div class="feature-icon">${f.icon}</div>
                        <h3>${f.title}</h3>
                        <p>${f.description}</p>
                    </div>`,
    ).join('\n                    ')}
                </div>
            </div>
        </section>

        <!-- Hand-drawn divider -->
        <svg class="section-divider" viewBox="0 0 200 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 16 C 40 8, 60 20, 100 12 S 150 6, 198 14" stroke="#3D2B1F" stroke-width="1.5" stroke-linecap="round" fill="none" opacity="0.3"/>
        </svg>

        <!-- How It Works Section -->
        <section id="how-it-works">
            <div class="container">
                <h2 class="highlight-swipe section-heading">How It Works</h2>
                <div class="steps-container">
                    ${HOW_IT_WORKS_STEPS.map(
        (step, i) => `<div class="step">
                        <div class="step-number">${step.number}</div>
                        <div class="step-content">
                            <h3>${step.title}</h3>
                            <p>${step.description}</p>
                        </div>
                        ${i < HOW_IT_WORKS_STEPS.length - 1
                ? `<div class="doodle-arrow">
                            <svg viewBox="0 0 2 60" xmlns="http://www.w3.org/2000/svg">
                                <path d="M1 0 C 1 15, 1 20, 1 30 S 1 45, 1 60" stroke="#C4A35A" stroke-width="1.5" stroke-dasharray="4 3" fill="none" stroke-linecap="round"/>
                            </svg>
                        </div>`
                : ''
            }
                    </div>`,
    ).join('\n                    ')}
                </div>
            </div>
        </section>

        <!-- Hand-drawn divider -->
        <svg class="section-divider" viewBox="0 0 200 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 10 C 50 18, 70 6, 100 12 S 160 18, 198 10" stroke="#3D2B1F" stroke-width="1.5" stroke-linecap="round" fill="none" opacity="0.3"/>
        </svg>

        <!-- Social Proof Section -->
        <section id="social-proof">
            <div class="container testimonials">
                <h2 class="highlight-swipe">What People Are Saying</h2>
                <div class="testimonial-card">
                    <p class="testimonial-quote">Clawd remembers everything I tell it — my meeting notes, my preferences, even my coffee order. It's like having a personal assistant who actually pays attention.</p>
                    <p class="testimonial-author">— Early Beta User</p>
                </div>
            </div>
        </section>

        <!-- Hand-drawn divider -->
        <svg class="section-divider" viewBox="0 0 200 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 14 C 35 6, 65 20, 100 12 S 140 4, 198 14" stroke="#3D2B1F" stroke-width="1.5" stroke-linecap="round" fill="none" opacity="0.3"/>
        </svg>

        <!-- Pricing Section -->
        <section id="pricing">
            <div class="container">
                <h2 class="highlight-swipe section-heading">Simple, Transparent Pricing</h2>
                <div class="pricing-grid">
                    ${PRICING_TIERS.map(
        (tier) => `<div class="pricing-card${tier.highlighted ? ' highlighted' : ''}">
                        <div class="pricing-name">${tier.name}</div>
                        <div class="pricing-price">${tier.price}</div>
                        <p class="pricing-desc">${tier.description}</p>
                        <ul class="pricing-features">
                            ${tier.features.map((f) => `<li>${f}</li>`).join('\n                            ')}
                        </ul>
                        <a href="${waLink}" class="cta-btn${tier.highlighted ? '' : ' cta-btn-outline'} washi-tape">${tier.ctaLabel}</a>
                    </div>`,
    ).join('\n                    ')}
                </div>
            </div>
        </section>
    </main>

    <!-- Footer -->
    <footer>
        <div class="container">
            <div class="footer-links">
                ${FOOTER_LINKS.map((link) => `<a href="${link.href}">${link.label}</a>`).join('\n                ')}
            </div>
            <p class="footer-copy">&copy; ${new Date().getFullYear()} Clawd. All rights reserved.</p>
        </div>
    </footer>

    <!-- Scroll-triggered animations (vanilla JS, IntersectionObserver) -->
    <script>
        (function() {
            // Feature detection
            if (!('IntersectionObserver' in window)) return;

            // Highlighter-swipe animation on headings
            const headings = document.querySelectorAll('.highlight-swipe');
            const headingObserver = new IntersectionObserver(function(entries) {
                entries.forEach(function(entry) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('visible');
                        headingObserver.unobserve(entry.target);
                    }
                });
            }, { threshold: 0.3 });

            headings.forEach(function(el) { headingObserver.observe(el); });

            // Doodle arrow animations in How It Works
            const arrows = document.querySelectorAll('.doodle-arrow');
            const arrowObserver = new IntersectionObserver(function(entries) {
                entries.forEach(function(entry) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('visible');
                        arrowObserver.unobserve(entry.target);
                    }
                });
            }, { threshold: 0.2 });

            arrows.forEach(function(el) { arrowObserver.observe(el); });

            // Washi-tape accent decoration on CTA buttons
            const ctas = document.querySelectorAll('.washi-tape');
            const ctaObserver = new IntersectionObserver(function(entries) {
                entries.forEach(function(entry) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('visible');
                        ctaObserver.unobserve(entry.target);
                    }
                });
            }, { threshold: 0.5 });

            ctas.forEach(function(el) { ctaObserver.observe(el); });
        })();
    </script>
</body>
</html>`;
}
