import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "我的文献库",
  description: "用于收集、分类、阅读和沉淀论文知识的个人文献管理工具。",
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
