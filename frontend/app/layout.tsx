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
  title: 'Paper to WeChat Studio',
  description: 'Upload a research paper PDF and generate WeChat-ready thread drafts, HTML exports, and Word documents.'
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
