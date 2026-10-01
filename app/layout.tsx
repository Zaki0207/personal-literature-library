import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://personal-literature-library-zhaozizyu.taxable-orbital-9dke.chatgpt.site"),
  title: "我的文献库",
  description: "用于收集、分类、阅读和沉淀论文知识的个人文献管理工具。",
  openGraph: {
    title: "我的文献库",
    description: "收集 · 阅读 · 沉淀",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "我的文献库：收集 · 阅读 · 沉淀" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "我的文献库",
    description: "收集 · 阅读 · 沉淀",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
