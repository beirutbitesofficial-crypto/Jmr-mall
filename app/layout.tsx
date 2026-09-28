import type { Metadata } from "next";
import { headers } from "next/headers";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "./globals.css";
import { prefsBootScript } from "@/lib/prefs-boot";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "By JMR Mall — Audit System",
    description: "Monthly audit, invoicing, collections and user permissions for JMR Mall",
    icons: { icon: "/favicon.svg" },
    openGraph: { title: "By JMR Mall", description: "Mall Audit System", images: [{ url: image, width: 1000, height: 667 }] },
    twitter: { card: "summary_large_image", title: "By JMR Mall", description: "Mall Audit System", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Defaults are English, left-to-right, light; the boot script swaps in the saved choice
  // before paint, so the html attributes can differ from the server render.
  return (
    <html lang="en" dir="ltr" data-theme="light" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: prefsBootScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
