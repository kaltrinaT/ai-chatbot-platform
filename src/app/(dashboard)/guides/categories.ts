import { Rocket, Cloud, Box, ShieldCheck, ShieldAlert, Wrench, HelpCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type GuideTone = "green" | "blue" | "purple" | "amber" | "red" | "teal" | "gray";

export type GuideCategory = {
  title: string;
  description: string;
  icon: LucideIcon;
  tone: GuideTone;
  // Only set once a category has a real guide page behind it — the rest
  // stay plain (non-clickable) cards on the index, and are unreachable from
  // the article-page nav, rather than pointing at content that isn't there.
  href?: string;
};

// Shared with GuideHeader (the icon tile at the top of each article) so a
// category's color stays the same whether it's shown as an index card or as
// that article's own page header.
export const GUIDE_TONE_STYLES: Record<GuideTone, string> = {
  green: "bg-green-100 text-green-600",
  blue: "bg-blue-100 text-blue-600",
  purple: "bg-purple-100 text-purple-600",
  amber: "bg-amber-100 text-amber-600",
  red: "bg-red-100 text-red-600",
  teal: "bg-teal-100 text-teal-600",
  gray: "bg-gray-100 text-gray-600",
};

export const GUIDE_CATEGORIES: GuideCategory[] = [
  {
    title: "Getting Started",
    description: "Learn the basics of the platform and deploy your first AI chatbot in a few simple steps.",
    icon: Rocket,
    tone: "green",
    href: "/guides/getting-started",
  },
  {
    title: "Cloud Prerequisites",
    description: "Prepare your AWS or Azure account with the required permissions and access.",
    icon: Cloud,
    tone: "blue",
    href: "/guides/cloud-prerequisites",
  },
  {
    title: "Deployment Guide",
    description: "Step-by-step guide to create, configure and deploy your chatbot to your cloud account.",
    icon: Box,
    tone: "purple",
    href: "/guides/deployment-guide",
  },
  {
    title: "Secure Document Handling & RAG",
    description: "Upload documents, manage indexing and understand how RAG works in your chatbot.",
    icon: ShieldCheck,
    tone: "amber",
    href: "/guides/secure-document-handling-rag",
  },
  {
    title: "Security & Isolation",
    description: "Understand the security model, secret handling, and tenant isolation in the platform.",
    icon: ShieldAlert,
    tone: "red",
    href: "/guides/security-isolation",
  },
  {
    title: "Troubleshooting",
    description: "Resolve common issues and errors that may occur during deployment or usage.",
    icon: Wrench,
    tone: "teal",
  },
  {
    title: "FAQ",
    description: "Answers to frequently asked questions about the platform and deployments.",
    icon: HelpCircle,
    tone: "gray",
  },
];
