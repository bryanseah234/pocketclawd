/**
 * Clawd Landing Page — content constants and copy.
 *
 * Centralizes all text, links, and structured data for the landing page
 * so layout code (html.ts) stays free of editorial content.
 *
 * Requirements: 2.1–2.4, 3.1–3.6, 4.1–4.3, 5.1–5.2, 6.1–6.4, 7.1–7.4
 */

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface FeatureItem {
    title: string;
    description: string;
    icon: string; // inline SVG string
}

export interface HowItWorksStep {
    number: number;
    title: string;
    description: string;
}

export interface PricingTier {
    name: string;
    price: string;
    description: string;
    features: string[];
    ctaLabel: string;
    ctaHref: string;
    highlighted?: boolean;
}

// ─── Hero Section ────────────────────────────────────────────────────────────

export const HERO_HEADLINE = 'Meet Clawd';

export const HERO_SUBHEADLINE =
    'The AI assistant that actually gets to know you\u2014organizing your life and learning your vibe with every interaction.';

export const HERO_CTA_LABEL = 'Get Started';

export const WHATSAPP_LINK = 'https://wa.me/6581234567?text=Hi%20Clawd!';

// ─── Features Section ────────────────────────────────────────────────────────

export const FEATURES: FeatureItem[] = [
    {
        title: 'Remembers Everything',
        description:
            'A personal knowledge base that grows with you. Clawd recalls your preferences, notes, and conversations so you never lose a thought.',
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.2 6H8.2C6.3 13.7 5 11.5 5 9a7 7 0 0 1 7-7z"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`,
    },
    {
        title: 'Document Intelligence',
        description:
            'Upload PDFs, ask questions, and get cited answers. Clawd reads your documents so you don\u2019t have to dig through pages.',
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    },
    {
        title: 'Daily Briefings',
        description:
            'Start your morning with a personalized summary of what matters to you\u2014meetings, reminders, and insights delivered to your chat.',
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    },
    {
        title: 'Always Available',
        description:
            'WhatsApp-native access means no app to download, no new interface to learn. Just message Clawd like you would a friend.',
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
    },
];

// ─── How It Works Section ────────────────────────────────────────────────────

export const HOW_IT_WORKS_STEPS: HowItWorksStep[] = [
    {
        number: 1,
        title: 'Send a message',
        description:
            'Open WhatsApp and say hello to Clawd. No sign-up forms, no downloads\u2014just start chatting.',
    },
    {
        number: 2,
        title: 'Clawd learns',
        description:
            'Every conversation helps Clawd understand your preferences, schedule, and priorities.',
    },
    {
        number: 3,
        title: 'Ask anything',
        description:
            'Need a recap? A document summary? A reminder? Clawd has your back with instant, personalized answers.',
    },
];

// ─── Pricing Section ─────────────────────────────────────────────────────────

export const PRICING_TIERS: PricingTier[] = [
    {
        name: 'Free Trial',
        price: '$0',
        description: 'Try Clawd free for 14 days. No credit card required.',
        features: [
            'Unlimited messages',
            'Document uploads (up to 5)',
            'Daily briefings',
            'Personal knowledge base',
        ],
        ctaLabel: 'Start Free Trial',
        ctaHref: WHATSAPP_LINK,
        highlighted: false,
    },
    {
        name: 'Pro',
        price: '$19/mo',
        description: 'Everything in Free Trial, plus unlimited power for professionals.',
        features: [
            'Unlimited document uploads',
            'Priority response times',
            'Advanced document analysis',
            'Calendar integration',
            'Custom daily briefing schedule',
        ],
        ctaLabel: 'Go Pro',
        ctaHref: WHATSAPP_LINK,
        highlighted: true,
    },
];

// ─── Footer Links ────────────────────────────────────────────────────────────

export const FOOTER_LINKS: { label: string; href: string }[] = [
    { label: 'Privacy Policy', href: '/privacy' },
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Features', href: '#features' },
    { label: 'How It Works', href: '#how-it-works' },
    { label: 'Pricing', href: '#pricing' },
];
