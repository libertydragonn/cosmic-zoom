import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#02030a" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function HydrateFallback() {
  return (
    <div className="flex h-dvh items-center justify-center text-sm tracking-widest text-slate-400">載入中…</div>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "發生錯誤";
  let details = "發生未預期的錯誤。";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "錯誤";
    details = error.status === 404 ? "找不到這個頁面。" : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-2xl p-6 pt-16">
      <h1 className="mb-2 text-xl">{message}</h1>
      <p className="text-slate-300">{details}</p>
      {stack && (
        <pre className="mt-4 w-full overflow-x-auto rounded bg-black/40 p-4 text-xs">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
