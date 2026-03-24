import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Sans, Oxanium } from 'next/font/google';
import './globals.css';

const bodyFont = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body'
});

const displayFont = Oxanium({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-display'
});

export const metadata: Metadata = {
  title: '科研论文转公众号推文',
  description: '上传科研论文 PDF，生成适合中文公众号发布的推文线程、HTML 排版稿和 Word 文档。'
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${bodyFont.variable} ${displayFont.variable}`}>
        {children}
      </body>
    </html>
  );
}
