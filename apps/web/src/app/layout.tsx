import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { BRAND } from '../design-system/brand';
import { bodyFont, headingFont, monoFont } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: BRAND.name,
  description: 'Portal del cliente para consultar sus documentos electrónicos SIFEN.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es" className={`${headingFont.variable} ${bodyFont.variable} ${monoFont.variable}`}>
      <body className="bg-surface font-body-md text-body-md text-on-surface antialiased">
        {children}
      </body>
    </html>
  );
}
