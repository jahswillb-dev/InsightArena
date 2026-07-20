import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Explore the InsightArena documentation for guides on wallet setup, trading, smart contracts, and platform API integration.",
  openGraph: {
    title: "Documentation | InsightArena",
    description:
      "Explore the InsightArena documentation for guides on wallet setup, trading, smart contracts, and platform API integration.",
    type: "website",
  },
};

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
