import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "AccessibilityOS",
  description: "Evidence-first accessibility debugging",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
