import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with the InsightArena team for technical support, account issues, trading questions, or general feedback.",
  openGraph: {
    title: "Contact | InsightArena",
    description:
      "Get in touch with the InsightArena team for technical support, account issues, trading questions, or general feedback.",
    type: "website",
  },
};

export default function ContactLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
