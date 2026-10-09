import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Catalyst | Stock research desk',
  description: 'Evidence-first stock research for independent swing traders.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
