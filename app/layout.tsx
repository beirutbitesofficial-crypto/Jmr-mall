import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "By JMR Mall — Audit System",
    description: "نظام إدارة الأقسام والتدقيق الشهري للعدادات والإيجارات والخدمات",
    icons: { icon: "/favicon.svg" },
    openGraph: { title: "By JMR Mall", description: "Mall Audit System", images: [{ url: image, width: 1000, height: 667 }] },
    twitter: { card: "summary_large_image", title: "By JMR Mall", description: "Mall Audit System", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
