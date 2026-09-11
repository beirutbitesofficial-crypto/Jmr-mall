import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./strong.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "By JMR Mall — Audit System",
    description: "نظام إدارة الأقسام والتدقيق الشهري والتحصيل والصلاحيات لـ JMR Mall",
    icons: { icon: "/favicon.svg" },
    openGraph: { title: "By JMR Mall", description: "Mall Audit System", images: [{ url: image, width: 1000, height: 667 }] },
    twitter: { card: "summary_large_image", title: "By JMR Mall", description: "Mall Audit System", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>
    {children}
    <a href="/import" style={{ position: "fixed", left: 18, bottom: 18, zIndex: 80, textDecoration: "none", background: "#173a6d", color: "white", borderRadius: 999, padding: "11px 16px", fontWeight: 900, boxShadow: "0 8px 28px #071b3d44" }}>استيراد Excel</a>
  </body></html>;
}
