import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Find answers to common questions about InsightArena, cryptocurrency basics, tournaments, and how to get started on the platform.",
  openGraph: {
    title: "FAQ | InsightArena",
    description:
      "Find answers to common questions about InsightArena, cryptocurrency basics, tournaments, and how to get started on the platform.",
    type: "website",
  },
};

export default function FaqLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
