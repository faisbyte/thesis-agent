import type { ReactNode } from "react";

export const metadata = { title: "thesis-agent" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
