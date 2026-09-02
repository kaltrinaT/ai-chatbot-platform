// Plain <img>, not next/image: these are local vector icons served from
// /public/logos, so there's no raster optimization to gain, and next/image's
// optimizer refuses to process SVGs at all unless `images.dangerouslyAllowSVG`
// is turned on in next.config.ts — a site-wide security setting not worth
// flipping just for a handful of known-safe decorative logos.
type LogoSpec = { src: string; alt: string };

const CLOUD_LOGOS: Record<"aws" | "azure", LogoSpec> = {
  aws: { src: "/logos/aws.svg", alt: "AWS" },
  azure: { src: "/logos/azure.svg", alt: "Azure" },
};

const LLM_LOGOS: Record<"openai" | "anthropic" | "openrouter", LogoSpec> = {
  openai: { src: "/logos/openai.svg", alt: "OpenAI" },
  anthropic: { src: "/logos/anthropic.svg", alt: "Anthropic" },
  openrouter: { src: "/logos/openrouter.svg", alt: "OpenRouter" },
};

const VECTOR_STORE_LOGOS: Record<"pinecone" | "pgvector", LogoSpec> = {
  pinecone: { src: "/logos/pinecone.svg", alt: "Pinecone" },
  // pgvector is a Postgres extension, not its own brand — the elephant is
  // Postgres's mark, used here to represent "pgvector" at a glance.
  pgvector: { src: "/logos/pgvector.svg", alt: "PostgreSQL / pgvector" },
};

// alt="" on all three: every call site already renders the same provider
// name as adjacent visible text, so the logo is purely decorative — a real
// alt would double-announce it to screen readers (e.g. "AWS AWS").
export function CloudLogo({ provider, className = "h-4 w-auto" }: { provider: "aws" | "azure"; className?: string }) {
  const logo = CLOUD_LOGOS[provider];
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={logo.src} alt="" className={className} />;
}

export function LlmLogo({
  provider,
  className = "h-4 w-auto",
}: {
  provider: "openai" | "anthropic" | "openrouter";
  className?: string;
}) {
  const logo = LLM_LOGOS[provider];
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={logo.src} alt="" className={className} />;
}

export function VectorStoreLogo({
  store,
  className = "h-4 w-auto",
}: {
  store: "pinecone" | "pgvector";
  className?: string;
}) {
  const logo = VECTOR_STORE_LOGOS[store];
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={logo.src} alt="" className={className} />;
}

// Reuses the same "alt" text as the display label so there's one source of
// truth for "what do we call this provider" instead of a second map.
export function llmProviderLabel(provider: "openai" | "anthropic" | "openrouter"): string {
  return LLM_LOGOS[provider].alt;
}
