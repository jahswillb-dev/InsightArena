import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Learn how InsightArena collects, uses, and protects your data. Read our privacy policy covering blockchain data, cookies, and GDPR compliance.",
  openGraph: {
    title: "Privacy Policy | InsightArena",
    description:
      "Learn how InsightArena collects, uses, and protects your data. Read our privacy policy covering blockchain data, cookies, and GDPR compliance.",
    type: "website",
  },
};

export default function PrivacyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
