import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';

const geist = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
export const metadata: Metadata = {
  metadataBase: new URL('https://atlas-educa-periodicos.bouncy-pond-7076.chatgpt.site'),
  title: 'Atlas Educ@ — Metadados dos periódicos ativos',
  description: 'Painel de auditoria com fascículos e artigos dos periódicos ativos indexados no Educ@.',
  openGraph: {
    title: 'Atlas Educ@',
    description: 'Metadados, fascículos e artigos dos periódicos ativos.',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Atlas Educ@',
    description: 'Metadados, fascículos e artigos dos periódicos ativos.',
    images: ['/og.png'],
  },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body className={`${geist.variable} antialiased`}>{children}</body></html>; }
