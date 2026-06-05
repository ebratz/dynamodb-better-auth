import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DynamoDB + Better Auth",
  description: "Next.js example with DynamoDB adapter for Better Auth",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={styles.body}>{children}</body>
    </html>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: 480,
    margin: "60px auto",
    padding: "0 20px",
    lineHeight: 1.6,
  },
};
