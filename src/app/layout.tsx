import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'TB → Tutorial Converter',
  description: 'Convert textbook PDFs into chapter-by-chapter tutorials with quizzes and SRS flashcards.',
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-background font-sans antialiased">
        <main className="container mx-auto px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
