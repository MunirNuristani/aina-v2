import type { ReactNode } from "react";

export const metadata = { title: "AINA" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
